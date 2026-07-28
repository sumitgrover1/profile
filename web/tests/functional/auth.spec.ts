import { test, expect } from '../../support/fixtures';
import { chrome } from '../../support/elements';
import { isPresent } from '../../support/locators';
import { env } from '../../../shared/env';
import { otpAvailable, unavailableReason } from '../../../shared/otp';
import { MOBILE_NUMBERS } from '../../../shared/data/inputs';

/**
 * Authentication.
 *
 * Split into two halves by what they need:
 *
 *   - Signed-out behaviour (the login sheet, client-side validation, the OTP
 *     challenge appearing) runs anywhere, because it stops before a code is
 *     ever requested for a real number.
 *   - Completing a login needs a dedicated test account *and* a configured OTP
 *     strategy, so those specs skip with an explanatory message unless both are
 *     present. See shared/otp.ts.
 *
 * Nothing here requests an OTP for a number the operator has not designated as a
 * test number: sending real SMS to arbitrary numbers is spam, and repeatedly
 * requesting codes is indistinguishable from an attack.
 */

test.describe('Login — signed out @functional', () => {
  test.beforeEach(async ({ home, page }) => {
    await home.goto();
    const loggedIn = await home.isLoggedIn();
    test.skip(loggedIn, 'session is already authenticated');

    const hasLogin = await isPresent(page, chrome.loginEntry, 5_000);
    test.skip(!hasLogin, 'no login entry point found on this build');
  });

  test('opens the login sheet', async ({ login }) => {
    await login.open();
  });

  test('validates the mobile number before requesting a code', async ({ login }) => {
    await login.open();

    for (const bad of MOBILE_NUMBERS.filter((m) => !m.valid && m.value.length > 0).slice(0, 4)) {
      await login.enterMobile(bad.value);

      const challengeAppeared = await login.otpChallengeShown(2_000);
      expect(
        challengeAppeared,
        `login accepted "${bad.value}" (${bad.label}) and moved to the OTP step — ` +
          'invalid numbers should be caught client-side before an SMS is sent',
      ).toBeFalsy();
    }
  });

  test('does not send an OTP for an empty number', async ({ login }) => {
    await login.open();
    await login.enterMobile('');
    await login.requestOtp().catch(() => undefined);

    expect(await login.otpChallengeShown(3_000), 'empty number should not reach the OTP step').toBeFalsy();
  });
});

test.describe('Login — full journey @functional', () => {
  test.skip(
    () => !env.account.mobile,
    'TEST_MOBILE is not set. Configure a dedicated automation account before running authenticated specs.',
  );
  test.skip(() => !otpAvailable(), unavailableReason());

  test('signs in and reaches the account menu', async ({ login, page }) => {
    await login.login(env.account.mobile);
    expect(await isPresent(page, chrome.accountMenu, 10_000)).toBeTruthy();
  });

  test('rejects an incorrect OTP', async ({ login }) => {
    await login.open();
    await login.enterMobile(env.account.mobile);
    await login.requestOtp();

    expect(await login.otpChallengeShown(), 'OTP challenge should appear').toBeTruthy();

    // One deliberately wrong code, once. Never loop — that is a brute-force
    // pattern regardless of intent, and it will lock the test account out.
    await login.enterOtp('000000');
    await login.submitOtp();

    const error = await login.errorText();
    expect(error, 'an incorrect OTP should produce a visible error').not.toBeNull();
  });

  test('signs out cleanly', async ({ login, page }) => {
    await login.login(env.account.mobile);
    await login.logout();

    expect(
      await isPresent(page, chrome.loginEntry, 10_000),
      'after logout the login entry point should return',
    ).toBeTruthy();
  });

  test('session survives a page reload', async ({ login, page }) => {
    await login.login(env.account.mobile);
    await page.reload({ waitUntil: 'domcontentloaded' });

    expect(
      await isPresent(page, chrome.accountMenu, 15_000),
      'a reload should not sign the user out',
    ).toBeTruthy();
  });
});
