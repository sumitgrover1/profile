import { browser } from '@wdio/globals';
import { BaseScreen } from './base.screen';
import { billScreen } from '../support/elements';
import { resolveAndroidOptional, androidPresent } from '../support/resolver';
import { safeTap } from '../support/guard';
import { scrollUntil } from '../support/device';
import { category, type BillCategory } from '../../shared/data/catalog';

/**
 * The bill-payment funnel inside the app.
 *
 * Mirrors web/pages/bill-flow.page.ts so a behaviour can be asserted on both
 * platforms from the same mental model. As on the web, the deepest this goes is
 * the payment-method screen — and here the payment guard enforces it at the tap
 * level rather than the network level.
 */
export class BillFlowScreen extends BaseScreen {
  readonly name: string;

  constructor(private readonly categoryId: BillCategory) {
    super();
    this.name = category(categoryId).labels[0] ?? categoryId;
  }

  get spec() {
    return category(this.categoryId);
  }

  async isLoaded(timeout = 15_000): Promise<boolean> {
    if (await androidPresent(billScreen.identifierInput, timeout)) return true;
    return androidPresent(billScreen.operatorPicker, 3_000);
  }

  async waitUntilLoaded(timeout = 20_000): Promise<void> {
    await this.settle();
    const loaded = await this.isLoaded(timeout);
    if (!loaded) {
      throw new Error(
        `${this.name} flow did not present a form within ${timeout}ms. ` +
          `Screen text was: ${(await this.visibleText()).slice(0, 300)}`,
      );
    }
  }

  // -- identifier -----------------------------------------------------------

  async enterIdentifier(value: string): Promise<void> {
    await this.type(billScreen.identifierInput, value);
  }

  async identifierValue(): Promise<string> {
    return this.readValue(billScreen.identifierInput);
  }

  /** Type a value and report what the field actually kept. */
  async typeAndReadBack(value: string): Promise<string> {
    await this.enterIdentifier(value);
    return this.identifierValue();
  }

  // -- operator -------------------------------------------------------------

  async selectOperator(name: string): Promise<void> {
    await this.tap(billScreen.operatorPicker);
    await browser.pause(1_000);

    // Biller lists are long; use the search box when the app offers one.
    const search = await resolveAndroidOptional(billScreen.operatorSearch, { timeout: 2_000 });
    if (search) {
      await search.setValue(name);
      await browser.pause(1_200);
    }

    const found = await scrollUntil(
      async () => (await resolveAndroidOptional(billScreen.operatorOption(name), { timeout: 800 })) !== null,
      6,
    );

    if (!found) {
      throw new Error(`Operator "${name}" not found in the ${this.name} biller list`);
    }

    const option = await this.find(billScreen.operatorOption(name));
    await safeTap(option);
    await browser.pause(1_200);
  }

  /** Biller names currently listed. Used to assert the list is populated. */
  async availableOperators(limit = 20): Promise<string[]> {
    await this.tap(billScreen.operatorPicker);
    await browser.pause(1_200);

    const source = await browser.getPageSource();
    const names = Array.from(source.matchAll(/text="([^"]{2,60})"/g))
      .map((m) => (m[1] ?? '').trim())
      .filter((t) => t.length > 1)
      .filter((t, i, all) => all.indexOf(t) === i)
      .slice(0, limit);

    await browser.back().catch(() => undefined);
    await browser.pause(800);

    return names;
  }

  async selectCircle(name: string): Promise<void> {
    const picker = await resolveAndroidOptional(billScreen.circlePicker, { timeout: 3_000 });
    if (!picker) return; // several categories have no circle step

    await safeTap(picker);
    await browser.pause(1_000);

    const option = await resolveAndroidOptional(billScreen.operatorOption(name), { timeout: 5_000 });
    if (option) {
      await safeTap(option);
      await browser.pause(800);
    }
  }

  // -- amount ---------------------------------------------------------------

  async enterAmount(value: string): Promise<void> {
    await this.type(billScreen.amountInput, value);
  }

  async amountValue(): Promise<string> {
    return this.readValue(billScreen.amountInput);
  }

  async hasAmountField(): Promise<boolean> {
    return this.has(billScreen.amountInput, 3_000);
  }

  // -- progression ----------------------------------------------------------

  async proceed(): Promise<void> {
    await this.tap(billScreen.proceed);
    await browser.pause(1_500);
    await this.assertSafeScreen();
  }

  async proceedEnabled(): Promise<boolean> {
    const button = await resolveAndroidOptional(billScreen.proceed, { timeout: 4_000 });
    if (!button) return false;
    return button.isEnabled().catch(() => false);
  }

  async fieldError(): Promise<string | null> {
    const error = await resolveAndroidOptional(billScreen.fieldError, { timeout: 4_000 });
    if (!error) return null;
    const text = await error.getText().catch(() => '');
    return text.trim() || null;
  }

  /** The user was stopped — by an error, a disabled button, or no navigation. */
  async wasRejected(): Promise<boolean> {
    if (await this.fieldError()) return true;
    return !(await this.proceedEnabled());
  }

  async planListShown(): Promise<boolean> {
    return this.has(billScreen.planList, 15_000);
  }

  async billSummaryShown(): Promise<boolean> {
    return this.has(billScreen.billSummary, 20_000);
  }

  /** Reached the payment-method list — the deepest a read-only run goes. */
  async reachedPaymentScreen(): Promise<boolean> {
    return this.has(billScreen.paymentScreen, 12_000);
  }
}
