import { expect } from '@playwright/test';
import { BasePage } from './base.page';
import { auth, chrome } from '../support/elements';
import { resolveOptional, isPresent } from '../support/locators';
import { resolveOtp, maskMobile } from '../../shared/otp';

export class LoginPage extends BasePage {
  readonly path = '/';

  async open(): Promise<void> {
    if (!(await this.has(auth.mobileInput, 2_000))) {
      await this.openLogin();
    }
    await expect(await this.find(auth.mobileInput)).toBeVisible();
  }

  async enterMobile(mobile: string): Promise<void> {
    await this.fillField(auth.mobileInput, mobile);
  }

  async requestOtp(): Promise<void> {
    await this.clickElement(auth.requestOtpButton);
  }

  async otpChallengeShown(timeout = 15_000): Promise<boolean> {
    if (await isPresent(this.page, auth.otpInput, timeout)) return true;
    return isPresent(this.page, auth.otpDigitBoxes, 2_000);
  }

  /** Handles both the single-input and one-box-per-digit OTP layouts. */
  async enterOtp(code: string): Promise<void> {
    const single = await resolveOptional(this.page, auth.otpInput, { timeout: 5_000 });
    if (single) {
      await single.click();
      await single.fill(code);
      return;
    }

    const boxes = await resolveOptional(this.page, auth.otpDigitBoxes, { timeout: 5_000 });
    if (!boxes) throw new Error('No OTP input found — neither a single field nor per-digit boxes.');

    const inputs = this.page.locator('input[maxlength="1"]');
    const count = await inputs.count();
    for (let i = 0; i < Math.min(count, code.length); i += 1) {
      await inputs.nth(i).fill(code[i] ?? '');
    }
  }

  async submitOtp(): Promise<void> {
    const verify = await resolveOptional(this.page, auth.verifyButton, { timeout: 5_000 });
    if (verify && (await verify.isEnabled())) {
      await verify.click();
      return;
    }
    // Many OTP fields auto-submit on the last digit.
    await this.page.keyboard.press('Enter').catch(() => undefined);
  }

  async errorText(): Promise<string | null> {
    const error = await resolveOptional(this.page, auth.authError, { timeout: 8_000 });
    return error ? (await error.innerText()).trim() : null;
  }

  /** Full login using whichever OTP strategy is configured. Throws if none is. */
  async login(mobile: string): Promise<void> {
    await this.open();
    await this.enterMobile(mobile);
    await this.requestOtp();

    if (!(await this.otpChallengeShown())) {
      throw new Error(`OTP challenge never appeared for ${maskMobile(mobile)}`);
    }

    const code = await resolveOtp({ mobile });
    await this.enterOtp(code);
    await this.submitOtp();

    await expect(await this.find(chrome.accountMenu, { timeout: 25_000 })).toBeVisible();
  }

  async logout(): Promise<void> {
    const menu = await resolveOptional(this.page, chrome.accountMenu, { timeout: 5_000 });
    if (menu) await menu.click();
    await this.clickElement(auth.logout);
  }
}
