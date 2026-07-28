import type { Page, Locator, Response } from '@playwright/test';
import { chrome } from '../support/elements';
import { resolve, resolveOptional, isPresent, type ElementSpec, type ResolveOptions } from '../support/locators';

/**
 * Shared behaviour for every page object: navigation, the interstitial cleanup
 * that a consumer site inevitably throws at you, and thin wrappers over the
 * resilient resolver so specs never touch raw selectors.
 */
export abstract class BasePage {
  constructor(protected readonly page: Page) {}

  /** Path this page lives at, relative to BASE_URL. */
  abstract readonly path: string;

  async goto(options: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' } = {}): Promise<Response | null> {
    const response = await this.page.goto(this.path, {
      waitUntil: options.waitUntil ?? 'domcontentloaded',
    });
    await this.settle();
    return response;
  }

  /**
   * Dismiss the chrome that gets between a test and the page. Consumer sites
   * show cookie banners, app-install interstitials and promo modals on first
   * paint; none of them are the subject of a test unless a test says so.
   */
  async settle(): Promise<void> {
    await this.dismissConsent();
    await this.dismissModals();
  }

  async dismissConsent(): Promise<void> {
    const accept = await resolveOptional(this.page, chrome.cookieAccept, { timeout: 2_000 });
    if (accept) {
      await accept.click({ timeout: 5_000 }).catch(() => undefined);
    }
  }

  /** Close up to three stacked interstitials; more than that is a bug worth failing on elsewhere. */
  async dismissModals(): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
      const close = await resolveOptional(this.page, chrome.modalDismiss, { timeout: 1_500 });
      if (!close) return;
      await close.click({ timeout: 3_000 }).catch(() => undefined);
      await this.page.waitForTimeout(300);
    }
  }

  // -- resolver wrappers ----------------------------------------------------

  protected find(spec: ElementSpec, opts?: ResolveOptions): Promise<Locator> {
    return resolve(this.page, spec, opts);
  }

  protected findOptional(spec: ElementSpec, opts?: ResolveOptions): Promise<Locator | null> {
    return resolveOptional(this.page, spec, opts);
  }

  protected has(spec: ElementSpec, timeout?: number): Promise<boolean> {
    return isPresent(this.page, spec, timeout);
  }

  /** Fill a field, clearing whatever was there. Mirrors how a user retypes. */
  protected async fillField(spec: ElementSpec, value: string): Promise<Locator> {
    const field = await this.find(spec);
    await field.click();
    await field.fill('');
    await field.fill(value);
    return field;
  }

  protected async clickElement(spec: ElementSpec): Promise<void> {
    const target = await this.find(spec);
    await target.click();
  }

  // -- shared chrome --------------------------------------------------------

  async isLoggedIn(): Promise<boolean> {
    return this.has(chrome.accountMenu, 3_000);
  }

  async openLogin(): Promise<void> {
    await this.clickElement(chrome.loginEntry);
  }

  async search(term: string): Promise<void> {
    const box = await this.find(chrome.searchEntry);
    await box.click();
    await box.fill(term);
  }

  /**
   * Wait for the page to stop making requests, with a ceiling. Consumer sites
   * poll and stream, so a bare networkidle can hang forever — treat a timeout
   * as "settled enough" rather than a failure.
   */
  async waitForQuiet(timeout = 8_000): Promise<void> {
    await this.page.waitForLoadState('networkidle', { timeout }).catch(() => undefined);
  }

  title(): Promise<string> {
    return this.page.title();
  }

  url(): string {
    return this.page.url();
  }
}
