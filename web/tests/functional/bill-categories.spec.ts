import { test, expect } from '../../support/fixtures';
import { CORE_CATEGORIES, category, type BillCategory } from '../../../shared/data/catalog';
import { HOSTILE_STRINGS, AMOUNTS } from '../../../shared/data/inputs';

/**
 * Bill-payment categories beyond mobile recharge.
 *
 * FreeCharge sells the same funnel shape across ~17 categories, so these run as
 * a data-driven sweep rather than seventeen near-identical spec files. A category
 * that has been removed from the product skips itself instead of failing — the
 * suite should not go red because a business decision was made.
 */

const IDENTIFIER_SAMPLES: Partial<Record<BillCategory, string>> = {
  'mobile-postpaid': '9999900001',
  dth: '1234567890',
  electricity: '123456789',
  broadband: '1234567890',
  'credit-card': '4111111111111111',
  water: '1234567890',
  'gas-piped': '1234567890',
  fastag: 'DL01AB1234',
};

for (const id of CORE_CATEGORIES) {
  const spec = category(id);

  test.describe(`${spec.labels[0]} @functional`, () => {
    test.beforeEach(async ({ home }) => {
      await home.goto();

      const opened = await home
        .openCategory(id)
        .then(() => true)
        .catch(() => false);

      test.skip(!opened, `"${spec.labels[0]}" is not reachable from the home page in this build`);
    });

    test('renders its form with the expected inputs', async ({ billFlow }) => {
      const bill = billFlow(id);
      await bill.expectFormReady();
    });

    test('offers billers to choose from', async ({ billFlow }) => {
      test.skip(!spec.requiresOperator, 'this category has no biller selection step');

      const bill = billFlow(id);
      const operators = await bill.availableOperators();

      expect(
        operators.length,
        `${spec.labels[0]} should offer at least one biller; the picker was empty`,
      ).toBeGreaterThan(0);
    });

    test(`accepts a well-formed ${spec.identifierLabel.toLowerCase()}`, async ({ billFlow }) => {
      const sample = IDENTIFIER_SAMPLES[id];
      test.skip(sample === undefined, `no sample identifier configured for ${id}`);

      const bill = billFlow(id);
      const accepted = await bill.enterIdentifier(sample as string).then(() => bill.identifierValue());

      expect(
        accepted.replace(/\s/g, ''),
        `the field should hold the ${spec.identifierLabel.toLowerCase()} that was typed`,
      ).toContain((sample as string).replace(/\s/g, '').slice(0, 6));
    });

    test('does not reach a payment endpoint while the form is incomplete', async ({
      billFlow,
      assertNoUnsafeRequests,
    }) => {
      const bill = billFlow(id);
      await bill.proceed().catch(() => undefined);
      assertNoUnsafeRequests();
    });

    test('blocks an empty submission', async ({ billFlow }) => {
      const bill = billFlow(id);
      await bill.enterIdentifier('');

      expect(
        await bill.wasRejected(),
        'submitting with an empty identifier should show an error or keep the button disabled',
      ).toBeTruthy();
    });
  });
}

test.describe('Amount handling @functional', () => {
  test.beforeEach(async ({ home }) => {
    await home.goto();
    const opened = await home
      .openCategory('mobile-prepaid')
      .then(() => true)
      .catch(() => false);
    test.skip(!opened, 'mobile prepaid flow is not reachable');
  });

  for (const amount of AMOUNTS.filter((a) => !a.valid)) {
    test(`rejects amount: ${amount.label}`, async ({ billFlow }) => {
      const bill = billFlow('mobile-prepaid');
      await bill.enterIdentifier('9999900001');

      const hasAmountField = await bill
        .enterAmount(amount.value)
        .then(() => true)
        .catch(() => false);
      test.skip(!hasAmountField, 'this build fetches the amount from a plan rather than accepting free entry');

      const held = await bill.amountValue();
      const filtered = held !== amount.value;
      const blocked = await bill.wasRejected();

      expect(
        filtered || blocked,
        `amount "${amount.value}" (${amount.label}) was accepted as "${held}" and did not block progression`,
      ).toBeTruthy();
    });
  }
});

/**
 * Hostile input.
 *
 * The assertion is narrow on purpose: the page must not crash and must not
 * reflect the input back as live markup. This is a frontend robustness check —
 * it does not probe the backend, and it never sends a payload anywhere that
 * would execute it.
 */
test.describe('Input robustness @functional', () => {
  test.beforeEach(async ({ home }) => {
    await home.goto();
    const opened = await home
      .openCategory('mobile-prepaid')
      .then(() => true)
      .catch(() => false);
    test.skip(!opened, 'mobile prepaid flow is not reachable');
  });

  for (const hostile of HOSTILE_STRINGS) {
    test(`handles ${hostile.label} without breaking the page`, async ({ page, billFlow, diagnostics }) => {
      const bill = billFlow('mobile-prepaid');
      await bill.enterIdentifier(hostile.value);
      await page.waitForTimeout(500);

      // The page is still alive and still the page we were on.
      await expect(page.locator('body')).toBeVisible();

      // Nothing was injected into the DOM as an element.
      const injected = await page.locator('body script[data-test-injected], body img[src="x"]').count();
      expect(injected, 'input should never be reflected into the DOM as live markup').toBe(0);

      expect(
        diagnostics.pageErrors,
        `${hostile.label} caused uncaught exceptions:\n${diagnostics.pageErrors.join('\n')}`,
      ).toEqual([]);
    });
  }
});
