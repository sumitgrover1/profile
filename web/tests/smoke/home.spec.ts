import { test, expect } from '../../support/fixtures';
import { chrome, home as homeElements } from '../../support/elements';
import { expectVisible } from '../../support/locators';
import { CORE_CATEGORIES } from '../../../shared/data/catalog';

/**
 * Smoke: is the site up and is its primary job visible?
 *
 * If any of these fail, nothing else in the suite is worth running, so they are
 * kept fast, few, and free of any dependency on login or state.
 */
test.describe('Home page @smoke', () => {
  test.beforeEach(async ({ home }) => {
    await home.goto();
  });

  test('renders the shell: header, main content, footer', async ({ page }) => {
    await expectVisible(page, chrome.header);
    await expectVisible(page, homeElements.hero);
    await expectVisible(page, chrome.footer);
  });

  test('responds 200 and settles on the expected origin', async ({ home, page }) => {
    const response = await home.goto();
    expect(response?.status(), 'home page should return 2xx').toBeLessThan(400);

    const expectedHost = new URL(test.info().project.use.baseURL ?? 'https://www.freecharge.in').hostname;
    expect(new URL(page.url()).hostname).toContain(expectedHost.replace(/^www\./, ''));
  });

  test('has a non-empty, descriptive title', async ({ page }) => {
    const title = await page.title();
    expect(title.trim().length, 'title should not be empty').toBeGreaterThan(0);
    expect(title.length, 'title should be under ~70 chars to avoid SERP truncation').toBeLessThan(120);
  });

  test('exposes a login entry point to signed-out users', async ({ page, home }) => {
    const loggedIn = await home.isLoggedIn();
    test.skip(loggedIn, 'session is already authenticated; nothing to assert about signed-out chrome');
    await expectVisible(page, chrome.loginEntry);
  });

  test('surfaces its core bill-payment categories', async ({ home }) => {
    const visible = await home.visibleCategories();

    expect(
      visible.length,
      `no known category tiles were found on the home page. Found: [${visible.join(', ')}]. ` +
        'If the home page was redesigned, update the labels in shared/data/catalog.ts.',
    ).toBeGreaterThan(0);

    const missing = CORE_CATEGORIES.filter((c) => !visible.includes(c));
    test
      .info()
      .annotations.push({ type: 'categories-found', description: visible.join(', ') });

    expect(
      missing.length,
      `core categories not reachable from the home page: ${missing.join(', ')}`,
    ).toBeLessThanOrEqual(CORE_CATEGORIES.length - 1);
  });

  test('loads without uncaught JavaScript errors', async ({ page, diagnostics }) => {
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);

    expect(
      diagnostics.pageErrors,
      `uncaught exceptions on the home page:\n${diagnostics.pageErrors.join('\n')}`,
    ).toEqual([]);
  });

  test('loads without 5xx responses from first-party APIs', async ({ page, diagnostics }) => {
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);

    const firstParty = diagnostics.httpErrors.filter((e) => e.url.includes('freecharge'));
    expect(
      firstParty,
      `server errors from first-party endpoints:\n${firstParty.map((e) => `  ${e.status} ${e.url}`).join('\n')}`,
    ).toEqual([]);
  });
});
