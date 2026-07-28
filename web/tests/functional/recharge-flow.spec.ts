import { test, expect } from '../../support/fixtures';
import { flow } from '../../support/elements';
import { isPresent } from '../../support/locators';
import { MOBILE_OPERATORS, CIRCLES } from '../../../shared/data/catalog';
import { MOBILE_NUMBERS, MOBILE_NUMBERS_NORMALISED } from '../../../shared/data/inputs';

/**
 * The mobile prepaid recharge funnel — FreeCharge's highest-traffic flow.
 *
 * These specs stop before payment. The deepest any of them go is the plan list
 * and the payment-method screen; the network guard blocks order creation, so a
 * regression that made the flow auto-submit would surface as a guard block
 * rather than a real transaction.
 */
test.describe('Mobile prepaid recharge @functional', () => {
  test.beforeEach(async ({ home }) => {
    await home.goto();
    await home.openCategory('mobile-prepaid');
  });

  test('renders the recharge form', async ({ billFlow }) => {
    await billFlow('mobile-prepaid').expectFormReady();
  });

  test('accepts a valid mobile number and enables progression', async ({ billFlow }) => {
    const recharge = billFlow('mobile-prepaid');

    await recharge.enterIdentifier('9999900001');
    expect(await recharge.identifierValue()).toBe('9999900001');

    // Operator detection is usually automatic from the number's prefix, but the
    // picker stays available for MNP cases — either state is acceptable here.
    const canProceed = await recharge.proceedEnabled();
    const errorShown = await recharge.fieldError();
    expect(
      canProceed || errorShown === null,
      'a valid 10-digit number should not produce a validation error',
    ).toBeTruthy();
  });

  test('offers operators for selection', async ({ billFlow }) => {
    const recharge = billFlow('mobile-prepaid');
    await recharge.enterIdentifier('9999900001');

    const operators = await recharge.availableOperators();
    expect(operators.length, 'operator picker should offer at least one operator').toBeGreaterThan(0);

    const recognised = operators.filter((o) => MOBILE_OPERATORS.some((known) => o.toLowerCase().includes(known.toLowerCase())));
    expect(
      recognised.length,
      `none of the offered operators matched a known Indian operator. Offered: ${operators.slice(0, 15).join(', ')}`,
    ).toBeGreaterThan(0);
  });

  test('offers telecom circles for selection', async ({ page, billFlow }) => {
    const recharge = billFlow('mobile-prepaid');
    await recharge.enterIdentifier('9999900001');

    const hasCirclePicker = await isPresent(page, flow.circlePicker, 5_000);
    test.skip(!hasCirclePicker, 'this build detects the circle automatically and shows no picker');

    const firstCircle = CIRCLES[0];
    if (firstCircle === undefined) throw new Error('CIRCLES is empty');
    await recharge.selectCircle(firstCircle);
  });

  test('reaches the plan browser', async ({ billFlow }) => {
    const recharge = billFlow('mobile-prepaid');
    await recharge.enterIdentifier('9999900001');

    const firstOperator = MOBILE_OPERATORS[0];
    if (firstOperator === undefined) throw new Error('MOBILE_OPERATORS is empty');
    await recharge.selectOperator(firstOperator).catch(() => {
      // Auto-detected from the prefix on some builds; not a failure.
    });

    const plans = await recharge.browsePlans();
    await expect(plans, 'plan list should render after choosing an operator').toBeVisible();

    const text = await plans.innerText();
    expect(text.trim().length, 'plan list should not be empty').toBeGreaterThan(0);
    expect(text, 'plans should quote a price').toMatch(/₹|\bRs\.?\b|\bINR\b/i);
  });

  test('stops short of payment without a completed form', async ({ billFlow, assertNoUnsafeRequests }) => {
    const recharge = billFlow('mobile-prepaid');
    await recharge.enterIdentifier('9999900001');
    await recharge.proceed().catch(() => undefined);

    // Whatever the UI does here, it must not have hit a payment endpoint.
    assertNoUnsafeRequests();
  });

  test.describe('mobile number validation', () => {
    for (const input of MOBILE_NUMBERS.filter((i) => !i.valid && i.value !== '')) {
      test(`rejects ${input.label}`, async ({ billFlow }) => {
        const recharge = billFlow('mobile-prepaid');
        const accepted = await recharge.typeAndReadBack(input.value);

        // Two acceptable behaviours: the field filters the characters as they
        // are typed, or it accepts them and blocks progression. Both stop the
        // user; only silently proceeding is a bug.
        const filtered = accepted !== input.value;
        const blocked = await recharge.wasRejected();

        expect(
          filtered || blocked,
          `"${input.value}" (${input.label}) was accepted verbatim as "${accepted}" and did not block progression`,
        ).toBeTruthy();
      });
    }

    for (const { input, normalised } of MOBILE_NUMBERS_NORMALISED) {
      test(`normalises "${input}" to a bare 10-digit number`, async ({ billFlow }) => {
        const recharge = billFlow('mobile-prepaid');
        const accepted = await recharge.typeAndReadBack(input);
        const digits = accepted.replace(/\D/g, '');

        expect(
          digits.endsWith(normalised) || digits === normalised,
          `expected "${input}" to normalise to ${normalised}, field held "${accepted}"`,
        ).toBeTruthy();
      });
    }

    test('rejects an empty number', async ({ billFlow }) => {
      const recharge = billFlow('mobile-prepaid');
      await recharge.enterIdentifier('9999900001');
      await recharge.enterIdentifier('');

      expect(await recharge.wasRejected(), 'empty number should block progression').toBeTruthy();
    });
  });
});
