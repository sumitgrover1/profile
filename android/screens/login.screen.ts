import { browser } from '@wdio/globals';
import { BaseScreen } from './base.screen';
import { authScreen, homeScreen } from '../support/elements';
import { androidPresent } from '../support/resolver';
import { resolveOtp, maskMobile } from '../../shared/otp';

export class LoginScreen extends BaseScreen {
  readonly name = 'Login';

  async isShown(timeout = 10_000): Promise<boolean> {
    return androidPresent(authScreen.mobileInput, timeout);
  }

  async enterMobile(mobile: string): Promise<void> {
    await this.type(authScreen.mobileInput, mobile);
  }

  async requestOtp(): Promise<void> {
    await this.tap(authScreen.requestOtp);
    await browser.pause(1_500);
  }

  async otpChallengeShown(timeout = 20_000): Promise<boolean> {
    return androidPresent(authScreen.otpInput, timeout);
  }

  async enterOtp(code: string): Promise<void> {
    await this.type(authScreen.otpInput, code);
  }

  async submitOtp(): Promise<void> {
    const verify = await this.findOptional(authScreen.verifyOtp, { timeout: 4_000 });
    if (verify && (await verify.isEnabled().catch(() => false))) {
      await verify.click();
    }
    await browser.pause(2_500);
  }

  async errorText(): Promise<string | null> {
    const error = await this.findOptional(authScreen.authError, { timeout: 8_000 });
    if (!error) return null;
    const text = await error.getText().catch(() => '');
    return text.trim() || null;
  }

  /**
   * Full sign-in. Requires a configured OTP strategy; see shared/otp.ts for why
   * this suite never tries to read SMS off a real handset.
   */
  async login(mobile: string): Promise<void> {
    await this.settle();

    if (!(await this.isShown(8_000))) {
      throw new Error('Login screen was not presented — the app may already be signed in.');
    }

    await this.enterMobile(mobile);
    await this.requestOtp();

    if (!(await this.otpChallengeShown())) {
      throw new Error(`OTP challenge never appeared for ${maskMobile(mobile)}`);
    }

    const code = await resolveOtp({ mobile });
    await this.enterOtp(code);
    await this.submitOtp();
    await this.settle();

    const landed = await androidPresent(homeScreen.root, 25_000);
    if (!landed) {
      throw new Error(
        `Sign-in did not reach the home screen for ${maskMobile(mobile)}. ` +
          `Screen text: ${(await this.visibleText()).slice(0, 300)}`,
      );
    }
  }
}
