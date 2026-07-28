import { browser } from '@wdio/globals';
import { onboarding } from '../support/elements';
import {
  resolveAndroid,
  resolveAndroidOptional,
  androidPresent,
  type AndroidResolveOptions,
} from '../support/resolver';
import type { AndroidElementSpec } from '../support/selectors';
import { safeTap, assertNotCommittingScreen } from '../support/guard';
import { hideKeyboard } from '../support/device';

/**
 * Shared behaviour for every screen object.
 *
 * The `settle()` step matters more on Android than on the web: a consumer app
 * greets you with a permission dialog, a forced-update prompt, a rate-us sheet
 * and a promo interstitial, in an order that varies by build and install state.
 * Every screen clears them before asserting anything.
 */
export abstract class BaseScreen {
  abstract readonly name: string;

  protected find(spec: AndroidElementSpec, opts?: AndroidResolveOptions): Promise<WebdriverIO.Element> {
    return resolveAndroid(spec, opts);
  }

  protected findOptional(
    spec: AndroidElementSpec,
    opts?: AndroidResolveOptions,
  ): Promise<WebdriverIO.Element | null> {
    return resolveAndroidOptional(spec, opts);
  }

  protected has(spec: AndroidElementSpec, timeout?: number): Promise<boolean> {
    return androidPresent(spec, timeout);
  }

  /** Tap through the payment guard. Screens must never call `.click()` directly. */
  protected async tap(spec: AndroidElementSpec): Promise<void> {
    const element = await this.find(spec);
    await safeTap(element);
  }

  protected async type(spec: AndroidElementSpec, value: string): Promise<WebdriverIO.Element> {
    const field = await this.find(spec);
    await field.click();
    await field.clearValue().catch(() => undefined);
    await field.setValue(value);
    await hideKeyboard();
    return field;
  }

  async readValue(spec: AndroidElementSpec): Promise<string> {
    const field = await this.find(spec);
    const text = await field.getText().catch(() => '');
    if (text) return text;
    return (await field.getAttribute('text').catch(() => '')) ?? '';
  }

  /**
   * Clear the interstitials that stand between a fresh launch and the screen a
   * test cares about. Bounded, so a permanently-stuck dialog fails loudly
   * instead of looping.
   */
  async settle(): Promise<void> {
    for (let round = 0; round < 5; round += 1) {
      const permission = await this.findOptional(onboarding.allowPermission, { timeout: 1_200 });
      if (permission) {
        await permission.click();
        await browser.pause(400);
        continue;
      }

      const skip = await this.findOptional(onboarding.skip, { timeout: 1_000 });
      if (skip) {
        await skip.click();
        await browser.pause(400);
        continue;
      }

      const dismiss = await this.findOptional(onboarding.dismissDialog, { timeout: 1_000 });
      if (dismiss) {
        await dismiss.click();
        await browser.pause(400);
        continue;
      }

      return;
    }
  }

  /** Guard check: fail if the app drifted onto a credential-collecting screen. */
  async assertSafeScreen(): Promise<void> {
    const source = await browser.getPageSource();
    assertNotCommittingScreen(source);
  }

  async currentActivity(): Promise<string> {
    return browser.getCurrentActivity();
  }

  /** All visible text on screen — used for coarse assertions and guard checks. */
  async visibleText(): Promise<string> {
    const source = await browser.getPageSource();
    const texts = Array.from(source.matchAll(/text="([^"]*)"/g))
      .map((m) => m[1] ?? '')
      .filter((t) => t.trim().length > 0);
    return texts.join(' | ');
  }
}
