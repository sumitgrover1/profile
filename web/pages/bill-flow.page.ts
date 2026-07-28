import { expect, type Locator } from '@playwright/test';
import { BasePage } from './base.page';
import { flow } from '../support/elements';
import { resolve, resolveOptional, isPresent } from '../support/locators';
import { category, type BillCategory } from '../../shared/data/catalog';
import { env } from '../../shared/env';

/**
 * The recharge / bill-payment funnel.
 *
 * Every category on FreeCharge follows the same shape — pick a biller, enter an
 * identifier, either type or fetch an amount, then proceed — so one page object
 * covers all of them, parameterised by category.
 *
 * The object deliberately stops at the payment-method screen. `reachPaymentStep`
 * is the deepest any spec goes; there is no method here that submits a payment,
 * and the network guard in the fixtures blocks it even if someone adds one.
 */
export class BillFlowPage extends BasePage {
  readonly path = '/';

  constructor(page: import('@playwright/test').Page, private readonly categoryId: BillCategory) {
    super(page);
  }

  get spec() {
    return category(this.categoryId);
  }

  async expectFormReady(): Promise<void> {
    const form = await this.find(flow.form);
    await expect(form).toBeVisible();
  }

  // -- identifier -----------------------------------------------------------

  /** The identifier field for this category: a phone number, or an account id. */
  private identifierSpec() {
    const usesPhone = this.categoryId === 'mobile-prepaid' || this.categoryId === 'mobile-postpaid';
    return usesPhone ? flow.mobileNumberInput : flow.accountIdentifierInput;
  }

  async enterIdentifier(value: string): Promise<Locator> {
    return this.fillField(this.identifierSpec(), value);
  }

  async identifierValue(): Promise<string> {
    const field = await this.find(this.identifierSpec());
    return field.inputValue();
  }

  /**
   * What the field actually accepted. Numeric inputs commonly drop disallowed
   * characters silently rather than showing an error, and a test that only looks
   * for an error message would call that a pass.
   */
  async typeAndReadBack(value: string): Promise<string> {
    await this.enterIdentifier(value);
    return this.identifierValue();
  }

  // -- operator / circle ----------------------------------------------------

  async selectOperator(name: string): Promise<void> {
    const picker = await this.find(flow.operatorPicker);
    await this.choose(picker, name);
  }

  async selectCircle(name: string): Promise<void> {
    const picker = await resolveOptional(this.page, flow.circlePicker, { timeout: 4_000 });
    if (!picker) return; // several categories have no circle step
    await this.choose(picker, name);
  }

  /**
   * Pick a value from either a native <select> or a custom combobox. Consumer
   * sites mix both, sometimes on the same page.
   */
  private async choose(picker: Locator, value: string): Promise<void> {
    const tag = await picker.evaluate((node) => node.tagName.toLowerCase()).catch(() => '');

    if (tag === 'select') {
      await picker.selectOption({ label: value }).catch(async () => {
        await picker.selectOption(value);
      });
      return;
    }

    await picker.click();
    const typed = await picker.evaluate((node) => node.tagName.toLowerCase() === 'input').catch(() => false);
    if (typed) {
      await picker.fill(value);
    }
    const option = await resolve(this.page, flow.option(value), { timeout: 8_000 });
    await option.click();
  }

  /** Operator names the picker is currently offering. */
  async availableOperators(): Promise<string[]> {
    const picker = await this.find(flow.operatorPicker);
    const tag = await picker.evaluate((node) => node.tagName.toLowerCase()).catch(() => '');

    if (tag === 'select') {
      return picker.locator('option').allInnerTexts();
    }

    await picker.click();
    const options = this.page.getByRole('option');
    await options.first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined);
    const texts = await options.allInnerTexts();
    await this.page.keyboard.press('Escape').catch(() => undefined);
    return texts.map((t) => t.trim()).filter(Boolean);
  }

  // -- amount ---------------------------------------------------------------

  async enterAmount(value: string): Promise<Locator> {
    return this.fillField(flow.amountInput, value);
  }

  async amountValue(): Promise<string> {
    const field = await this.find(flow.amountInput);
    return field.inputValue();
  }

  // -- progression ----------------------------------------------------------

  async proceed(): Promise<void> {
    await this.clickElement(flow.proceedButton);
  }

  async proceedEnabled(): Promise<boolean> {
    const button = await resolveOptional(this.page, flow.proceedButton, { timeout: 5_000 });
    if (!button) return false;
    return button.isEnabled();
  }

  async fieldError(): Promise<string | null> {
    const error = await resolveOptional(this.page, flow.fieldError, { timeout: 5_000 });
    if (!error) return null;
    return (await error.innerText()).trim();
  }

  /**
   * A field is "rejected" if the UI shows an error, keeps the proceed button
   * disabled, or refuses to advance. Any of the three is a valid product choice;
   * the test asserts the user is stopped, not how.
   */
  async wasRejected(): Promise<boolean> {
    const error = await this.fieldError();
    if (error) return true;
    return !(await this.proceedEnabled());
  }

  async browsePlans(): Promise<Locator> {
    const link = await resolveOptional(this.page, flow.browsePlansLink, { timeout: 5_000 });
    if (link) await link.click();
    return resolve(this.page, flow.planList, { timeout: 15_000 });
  }

  async billSummaryText(): Promise<string | null> {
    const summary = await resolveOptional(this.page, flow.billSummary, { timeout: 20_000 });
    return summary ? (await summary.innerText()).trim() : null;
  }

  /**
   * Drive the funnel as deep as it is safe to go and report whether the payment
   * screen was reached. Never submits a payment.
   *
   * In prod-readonly mode the network guard will have blocked the call that
   * creates an order, so reaching the screen is not guaranteed — the caller
   * should treat `false` as "stopped safely", not as a product failure, unless
   * running against staging.
   */
  async reachPaymentStep(): Promise<boolean> {
    await this.proceed();
    await this.waitForQuiet(10_000);
    return isPresent(this.page, flow.paymentScreen, 12_000);
  }

  /** Guard used by transactional specs so they refuse to run against production. */
  static assertMutationsAllowed(): void {
    if (!env.allowMutations) {
      throw new Error(
        'This spec performs a mutating action and requires TEST_ENV=staging with a non-production BASE_URL.',
      );
    }
  }
}
