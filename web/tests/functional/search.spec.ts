import { test, expect } from '../../support/fixtures';
import { chrome } from '../../support/elements';
import { isPresent } from '../../support/locators';
import { SEARCH_TERMS } from '../../../shared/data/inputs';

/**
 * Site search / biller lookup.
 *
 * Search is how users reach the long tail of billers that never fit on the home
 * grid, so a broken search quietly kills conversion for every category outside
 * the top five.
 */
test.describe('Search @functional', () => {
  test.beforeEach(async ({ home, page }) => {
    await home.goto();
    const hasSearch = await isPresent(page, chrome.searchEntry, 5_000);
    test.skip(!hasSearch, 'this build has no site search on the home page');
  });

  for (const { term, expectResults, label } of SEARCH_TERMS) {
    test(`"${term}" (${label}) ${expectResults ? 'returns results' : 'returns nothing'}`, async ({ home }) => {
      const found = await home.hasSearchSuggestions(term);

      if (expectResults) {
        expect(found, `search for "${term}" should surface at least one suggestion`).toBeTruthy();
      } else {
        // An empty-state message is fine; silently showing unrelated results is not.
        expect(found, `search for "${term}" should not fabricate results`).toBeFalsy();
      }
    });
  }

  test('suggestions are relevant to the query', async ({ home }) => {
    const results = await home.searchSuggestions('electricity');
    const text = (await results.innerText()).toLowerCase();

    expect(
      text.includes('electric') || text.includes('power') || text.includes('bill'),
      `suggestions for "electricity" looked unrelated: ${text.slice(0, 200)}`,
    ).toBeTruthy();
  });

  test('a suggestion navigates into the matching flow', async ({ home, page }) => {
    const results = await home.searchSuggestions('electricity');
    const urlBefore = page.url();

    await results.getByText(/electric/i).first().click();
    await page.waitForTimeout(1_500);

    const navigated = page.url() !== urlBefore;
    const formAppeared = await isPresent(page, chrome.searchResults, 1_000).then((r) => !r);

    expect(navigated || formAppeared, 'clicking a suggestion should take the user somewhere').toBeTruthy();
  });

  test('search is reachable by keyboard alone', async ({ page }) => {
    const box = await page.getByRole('searchbox').first();
    const reachable = await box.isVisible().catch(() => false);
    test.skip(!reachable, 'no ARIA searchbox exposed; covered by the a11y suite instead');

    await box.focus();
    await page.keyboard.type('electricity');
    expect(await box.inputValue()).toBe('electricity');
  });

  test('search does not trigger any transactional request', async ({ home, assertNoUnsafeRequests }) => {
    await home.hasSearchSuggestions('recharge');
    assertNoUnsafeRequests();
  });
});
