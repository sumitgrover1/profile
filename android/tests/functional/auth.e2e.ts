import { browser, expect } from '@wdio/globals';
import { LoginScreen } from '../../screens/login.screen';
import { HomeScreen } from '../../screens/home.screen';
import { clearAppData, restartApp } from '../../support/device';
import { env } from '../../../shared/env';
import { otpAvailable, unavailableReason } from '../../../shared/otp';
import { MOBILE_NUMBERS } from '../../../shared/data/inputs';
import { must, mustNot } from '../../support/assert';

/**
 * In-app authentication.
 *
 * Same posture as the web auth specs: client-side validation is exercised
 * anywhere, but no OTP is ever requested for a number that is not a designated
 * test number, and a wrong code is submitted exactly once — never in a loop,
 * which would be a brute-force pattern and would lock the account.
 */

describe('Login — client-side validation @functional', () => {
  const login = new LoginScreen();

  beforeEach(async function () {
    await login.settle();
    if (!(await login.isShown(8_000))) {
      this.skip(); // already signed in; nothing to validate here
    }
  });

  it('presents a mobile number field', async () => {
    expect(await login.isShown(10_000)).toBe(true);
  });

  for (const bad of MOBILE_NUMBERS.filter((m) => !m.valid && m.value.length > 0).slice(0, 4)) {
    it(`does not send an OTP for ${bad.label}`, async () => {
      await login.enterMobile(bad.value);
      await login.requestOtp().catch(() => undefined);

      mustNot(await login.otpChallengeShown(3_000), `the app accepted "${bad.value}" (${bad.label}) and moved to the OTP step — ` +
          'invalid numbers should be caught before an SMS is sent');
    });
  }

  it('does not send an OTP for an empty number', async () => {
    await login.enterMobile('');
    await login.requestOtp().catch(() => undefined);

    mustNot(await login.otpChallengeShown(3_000), 'an empty number should not reach the OTP step');
  });
});

describe('Login — full journey @functional', () => {
  const login = new LoginScreen();
  const home = new HomeScreen();

  before(function () {
    if (!env.account.mobile) {
      console.log('Skipping authenticated specs: TEST_MOBILE is not set.');
      this.skip();
    }
    if (!otpAvailable()) {
      console.log(`Skipping authenticated specs: ${unavailableReason()}`);
      this.skip();
    }
  });

  it('signs in and reaches the home screen', async () => {
    await clearAppData();
    await restartApp();
    await login.settle();

    await login.login(env.account.mobile);

    must(await home.isLoaded(25_000), 'after signing in the app should land on the home screen');
  });

  it('rejects an incorrect OTP', async () => {
    await clearAppData();
    await restartApp();
    await login.settle();

    if (!(await login.isShown(10_000))) return;

    await login.enterMobile(env.account.mobile);
    await login.requestOtp();

    must(await login.otpChallengeShown(), 'the OTP challenge should appear');

    // Exactly one wrong code. Never retry — that is a brute-force pattern.
    await login.enterOtp('000000');
    await login.submitOtp();

    const stillOnOtp = await login.otpChallengeShown(5_000);
    const error = await login.errorText();

    must(Boolean(error) || stillOnOtp, 'an incorrect OTP should show an error or keep the user on the OTP screen');
  });

  it('keeps the session across a cold restart', async () => {
    await login.settle();

    if (!(await home.isLoaded(10_000))) {
      await login.login(env.account.mobile);
    }

    await restartApp();
    await home.settle();

    must(await home.isLoaded(30_000), 'a signed-in session should survive the app being killed and relaunched');
  });
});

describe('First-run experience @functional', () => {
  const home = new HomeScreen();
  const login = new LoginScreen();

  it('a cleared install presents onboarding or login, not a broken screen', async () => {
    await clearAppData();
    await restartApp();
    await browser.pause(3_000);
    await home.settle();

    const usable = (await login.isShown(15_000)) || (await home.isLoaded(15_000));

    must(usable, 'after clearing app data the app should present login or home. ' +
        `Visible text: ${(await home.visibleText()).slice(0, 300)}`);
  });
});
