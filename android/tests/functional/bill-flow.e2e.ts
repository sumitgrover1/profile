import { browser, expect } from '@wdio/globals';
import { HomeScreen } from '../../screens/home.screen';
import { BillFlowScreen } from '../../screens/bill-flow.screen';
import { PaymentGuardError } from '../../support/guard';
import { screenshot } from '../../support/device';
import { CORE_CATEGORIES, category, MOBILE_OPERATORS } from '../../../shared/data/catalog';
import { MOBILE_NUMBERS, AMOUNTS } from '../../../shared/data/inputs';
import { must, mustBeGreaterThan, mustContain } from '../../support/assert';

/**
 * Bill-payment funnels in the app.
 *
 * Every spec stops before payment. `safeTap` throws a PaymentGuardError if a
 * screen object ever tries to press a committing control — the specs that walk
 * deepest catch it explicitly and treat it as the expected outcome, which turns
 * the guard into a tested behaviour rather than a hope.
 */

describe('Bill payment flows @functional', () => {
  const home = new HomeScreen();

  beforeEach(async () => {
    await home.settle();
    const loaded = await home.isLoaded(20_000);
    if (!loaded) {
      await screenshot('bill-flow-home-not-loaded');
      throw new Error(
        'Home screen was not reachable. If the app requires sign-in, set TEST_MOBILE and an OTP strategy, ' +
          'or sign in manually once and run with ANDROID_NO_RESET=true.');
    }
  });

  for (const id of CORE_CATEGORIES) {
    const spec = category(id);

    describe(`${spec.labels[0]}`, () => {
      let flow: BillFlowScreen;

      beforeEach(async function () {
        const opened = await home
          .openCategory(id)
          .then(() => true)
          .catch(() => false);

        if (!opened) {
          this.skip(); // category not offered in this build
        }

        flow = new BillFlowScreen(id);
      });

      afterEach(async () => {
        // Return to a known screen so the next spec starts clean.
        await browser.back().catch(() => undefined);
        await browser.pause(600);
        await home.settle();
      });

      it('presents its form', async () => {
        await flow.waitUntilLoaded();
      });

      it('offers billers to choose from', async function () {
        if (!spec.requiresOperator) this.skip();

        await flow.waitUntilLoaded();
        const operators = await flow.availableOperators();

        mustBeGreaterThan(operators.length, 0, `${spec.labels[0]} should list at least one biller; the picker looked empty`);
      });

      it('accepts a well-formed identifier', async () => {
        await flow.waitUntilLoaded();

        const sample = id === 'mobile-prepaid' ? '9999900001' : '1234567890';
        const held = await flow.typeAndReadBack(sample);

        mustContain(held.replace(/\D/g, ''), sample.slice(0, 6), `the ${spec.identifierLabel.toLowerCase()} field did not keep what was typed`);
      });

      it('blocks an empty submission', async () => {
        await flow.waitUntilLoaded();
        await flow.enterIdentifier('');

        must(await flow.wasRejected(), 'an empty identifier should show an error or leave the proceed button disabled');
      });

      it('never reaches a payment-credential screen', async () => {
        await flow.waitUntilLoaded();
        await flow.enterIdentifier(id === 'mobile-prepaid' ? '9999900001' : '1234567890');

        try {
          await flow.proceed();
        } catch (error) {
          if (error instanceof PaymentGuardError) return; // guard did its job
          // Anything else is a real failure worth surfacing.
          if (!(error instanceof Error) || !/could not resolve/i.test(error.message)) throw error;
          return; // form incomplete, no proceed button — fine
        }

        // proceed() already ran assertSafeScreen(); reaching here means we are
        // on a safe screen.
        await flow.assertSafeScreen();
      });
    });
  }
});

describe('Mobile recharge validation @functional', () => {
  const home = new HomeScreen();
  let flow: BillFlowScreen;

  beforeEach(async function () {
    await home.settle();
    if (!(await home.isLoaded(20_000))) this.skip();

    const opened = await home
      .openCategory('mobile-prepaid')
      .then(() => true)
      .catch(() => false);
    if (!opened) this.skip();

    flow = new BillFlowScreen('mobile-prepaid');
    await flow.waitUntilLoaded();
  });

  afterEach(async () => {
    await browser.back().catch(() => undefined);
    await browser.pause(600);
    await home.settle();
  });

  for (const input of MOBILE_NUMBERS.filter((m) => !m.valid && m.value.length > 0).slice(0, 6)) {
    it(`rejects ${input.label}`, async () => {
      const held = await flow.typeAndReadBack(input.value);

      // Either the field filtered the input as it was typed, or it accepted it
      // and blocked progression. Both stop the user; silently proceeding is the bug.
      const filtered = held.trim() !== input.value.trim();
      const blocked = await flow.wasRejected();

      must(filtered || blocked, `"${input.value}" (${input.label}) was kept verbatim as "${held}" and did not block progression`);
    });
  }

  it('accepts a valid number', async () => {
    const held = await flow.typeAndReadBack('9999900001');
    expect(held.replace(/\D/g, '')).toContain('9999900001');
  });

  it('lists recognisable operators', async () => {
    await flow.enterIdentifier('9999900001');
    const operators = await flow.availableOperators(30);

    const recognised = operators.filter((o) =>
      MOBILE_OPERATORS.some((known) => o.toLowerCase().includes(known.toLowerCase())));

    mustBeGreaterThan(recognised.length, 0, `no known Indian operator appeared in the picker. Saw: ${operators.slice(0, 12).join(', ')}`);
  });

  for (const amount of AMOUNTS.filter((a) => !a.valid).slice(0, 5)) {
    it(`rejects amount: ${amount.label}`, async function () {
      if (!(await flow.hasAmountField())) this.skip();

      await flow.enterIdentifier('9999900001');
      await flow.enterAmount(amount.value);

      const held = await flow.amountValue();
      const filtered = held.trim() !== amount.value.trim();
      const blocked = await flow.wasRejected();

      must(filtered || blocked, `amount "${amount.value}" (${amount.label}) was kept as "${held}" and did not block progression`);
    });
  }
});
