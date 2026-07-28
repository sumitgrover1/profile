import { expect, type Locator } from '@playwright/test';
import { BasePage } from './base.page';
import { chrome, home } from '../support/elements';
import { resolve, resolveOptional } from '../support/locators';
import { CATEGORIES, type BillCategory, category } from '../../shared/data/catalog';

export class HomePage extends BasePage {
  readonly path = '/';

  async expectLoaded(): Promise<void> {
    await expect(await this.find(chrome.header)).toBeVisible();
    await expect(await this.find(home.hero)).toBeVisible();
  }

  /**
   * Open a bill category from the home page. Tries the on-page tile first and
   * falls back to search, because consumer home pages reshuffle their tile grid
   * for A/B tests and a test that only knows one route is a flaky test.
   */
  async openCategory(id: BillCategory): Promise<void> {
    const spec = category(id);

    for (const label of spec.labels) {
      const tile = await resolveOptional(this.page, home.categoryTile(label), { timeout: 2_500 });
      if (tile) {
        await tile.click();
        await this.settle();
        return;
      }
    }

    const firstLabel = spec.labels[0];
    if (firstLabel === undefined) throw new Error(`Category ${id} has no labels configured`);
    await this.openCategoryViaSearch(firstLabel);
  }

  private async openCategoryViaSearch(label: string): Promise<void> {
    await this.search(label);
    const results = await resolve(this.page, chrome.searchResults, { timeout: 8_000 });
    await results.getByText(new RegExp(label, 'i')).first().click();
    await this.settle();
  }

  /** Which of the known categories are reachable from the home page right now. */
  async visibleCategories(): Promise<BillCategory[]> {
    const found: BillCategory[] = [];
    for (const spec of CATEGORIES) {
      for (const label of spec.labels) {
        const tile = await resolveOptional(this.page, home.categoryTile(label), { timeout: 800 });
        if (tile) {
          found.push(spec.id);
          break;
        }
      }
    }
    return found;
  }

  async searchSuggestions(term: string): Promise<Locator> {
    await this.search(term);
    return resolve(this.page, chrome.searchResults, { timeout: 8_000 });
  }

  async hasSearchSuggestions(term: string): Promise<boolean> {
    await this.search(term);
    const results = await resolveOptional(this.page, chrome.searchResults, { timeout: 5_000 });
    if (!results) return false;
    const text = (await results.innerText().catch(() => '')).trim();
    return text.length > 0;
  }
}
