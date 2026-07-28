import { test as base, expect, type Page, type ConsoleMessage, type Request } from '@playwright/test';
import { env } from '../../shared/env';
import { evaluateRequest, defaultAllowedHosts, type BlockReason } from '../../shared/safety';
import { HomePage } from '../pages/home.page';
import { LoginPage } from '../pages/login.page';
import { BillFlowPage } from '../pages/bill-flow.page';
import type { BillCategory } from '../../shared/data/catalog';

export interface BlockedRequest {
  url: string;
  reason: BlockReason;
  detail: string;
}

export interface PageDiagnostics {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: { url: string; failure: string }[];
  httpErrors: { url: string; status: number }[];
  blocked: BlockedRequest[];
}

interface Fixtures {
  home: HomePage;
  login: LoginPage;
  billFlow: (category: BillCategory) => BillFlowPage;
  diagnostics: PageDiagnostics;
  /** Fail the current test if the safety guard blocked a transactional request. */
  assertNoUnsafeRequests: () => void;
}

/**
 * Console noise that is not worth failing a test over. Third-party embeds on a
 * consumer site produce a steady trickle of these regardless of product health.
 */
const IGNORED_CONSOLE = [
  /favicon/i,
  /net::ERR_BLOCKED_BY_CLIENT/i,
  /Failed to load resource.*(analytics|gtm|doubleclick|facebook|clarity|hotjar)/i,
  /\[GSI_LOGGER\]/i,
  /Content Security Policy.*(analytics|tagmanager)/i,
  /ResizeObserver loop/i,
];

function isIgnorable(text: string): boolean {
  return IGNORED_CONSOLE.some((re) => re.test(text));
}

export const test = base.extend<Fixtures>({
  /**
   * Every page gets the safety guard installed before the first navigation.
   * The guard aborts requests rather than letting them through, so a stray click
   * deep in a funnel cannot place a real order against production.
   */
  page: async ({ page }, use) => {
    /**
     * Host allow-listing is opt-in: an empty ALLOWED_HOSTS means "don't restrict",
     * because the site legitimately pulls fonts, images and bundles from CDNs we
     * have no reason to enumerate. Setting ALLOWED_HOSTS switches the guard into
     * strict mode, and the app's own hosts are added automatically so the caller
     * only has to name the extras.
     */
    const allowedHosts =
      env.web.allowedHosts.length > 0 ? defaultAllowedHosts(env.web.baseURL, env.web.allowedHosts) : [];
    const blocked: BlockedRequest[] = [];

    await page.route('**/*', async (route) => {
      const request = route.request();
      const decision = evaluateRequest(request.url(), {
        allowedHosts,
        readonly: !env.allowMutations,
        blockThirdParty: env.web.blockThirdParty,
      });

      if (decision.blocked) {
        if (decision.reason === 'transactional' || decision.reason === 'payment-gateway') {
          blocked.push({
            url: request.url(),
            reason: decision.reason,
            detail: decision.detail ?? '',
          });
        }
        await route.abort('blockedbyclient');
        return;
      }

      await route.continue();
    });

    // Expose the collected blocks to the diagnostics fixture.
    (page as Page & { __blocked?: BlockedRequest[] }).__blocked = blocked;

    await use(page);
  },

  diagnostics: async ({ page }, use) => {
    const diagnostics: PageDiagnostics = {
      consoleErrors: [],
      pageErrors: [],
      failedRequests: [],
      httpErrors: [],
      blocked: (page as Page & { __blocked?: BlockedRequest[] }).__blocked ?? [],
    };

    page.on('console', (message: ConsoleMessage) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (!isIgnorable(text)) diagnostics.consoleErrors.push(text);
    });

    page.on('pageerror', (error: Error) => {
      diagnostics.pageErrors.push(`${error.name}: ${error.message}`);
    });

    page.on('requestfailed', (request: Request) => {
      const failure = request.failure()?.errorText ?? 'unknown';
      // Requests the guard aborted on purpose are not product failures.
      if (failure.includes('BLOCKED')) return;
      diagnostics.failedRequests.push({ url: request.url(), failure });
    });

    page.on('response', (response) => {
      const status = response.status();
      if (status >= 500) {
        diagnostics.httpErrors.push({ url: response.url(), status });
      }
    });

    await use(diagnostics);
  },

  assertNoUnsafeRequests: async ({ diagnostics }, use) => {
    await use(() => {
      if (!env.strictSafety) return;
      const unsafe = diagnostics.blocked;
      expect(
        unsafe,
        `The test triggered ${unsafe.length} transactional request(s) that the safety guard blocked:\n` +
          unsafe.map((b) => `  - [${b.reason}] ${b.detail}`).join('\n') +
          '\nA read-only spec should never reach a payment or order endpoint. ' +
          'Move this assertion to a staging-only spec, or stop the flow earlier.',
      ).toEqual([]);
    });
  },

  home: async ({ page }, use) => {
    await use(new HomePage(page));
  },

  login: async ({ page }, use) => {
    await use(new LoginPage(page));
  },

  billFlow: async ({ page }, use) => {
    await use((category: BillCategory) => new BillFlowPage(page, category));
  },
});

export { expect };
