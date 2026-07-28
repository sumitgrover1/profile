import { browser } from '@wdio/globals';
import { BaseScreen } from './base.screen';
import { homeScreen } from '../support/elements';
import { resolveAndroidOptional } from '../support/resolver';
import { safeTap } from '../support/guard';
import { scrollUntil } from '../support/device';
import { CATEGORIES, category, type BillCategory } from '../../shared/data/catalog';

export class HomeScreen extends BaseScreen {
  readonly name = 'Home';

  async waitUntilLoaded(timeout = 30_000): Promise<void> {
    await this.settle();
    await this.find(homeScreen.root, { timeout });
  }

  async isLoaded(timeout = 10_000): Promise<boolean> {
    return this.has(homeScreen.root, timeout);
  }

  /**
   * Open a bill category. Tries the on-screen tile, scrolls to find it, and
   * falls back to in-app search — the same three routes a user would take.
   */
  async openCategory(id: BillCategory): Promise<void> {
    const spec = category(id);

    for (const label of spec.labels) {
      const tile = await resolveAndroidOptional(homeScreen.serviceTile(label), { timeout: 2_000 });
      if (tile) {
        await safeTap(tile);
        await browser.pause(1_500);
        await this.settle();
        return;
      }
    }

    // Not above the fold — scroll the home grid looking for it.
    const firstLabel = spec.labels[0];
    if (firstLabel === undefined) throw new Error(`Category ${id} has no labels configured`);

    const found = await scrollUntil(async () => {
      for (const label of spec.labels) {
        if (await resolveAndroidOptional(homeScreen.serviceTile(label), { timeout: 800 })) return true;
      }
      return false;
    }, 6);

    if (found) {
      for (const label of spec.labels) {
        const tile = await resolveAndroidOptional(homeScreen.serviceTile(label), { timeout: 1_500 });
        if (tile) {
          await safeTap(tile);
          await browser.pause(1_500);
          await this.settle();
          return;
        }
      }
    }

    await this.openCategoryViaSearch(firstLabel);
  }

  private async openCategoryViaSearch(label: string): Promise<void> {
    await this.tap(homeScreen.searchEntry);
    await browser.pause(600);

    const field = await this.find(homeScreen.searchEntry);
    await field.setValue(label);
    await browser.pause(1_500);

    const result = await resolveAndroidOptional(homeScreen.serviceTile(label), { timeout: 6_000 });
    if (!result) {
      throw new Error(
        `Could not reach "${label}" from the home screen: no tile found after scrolling, ` +
          'and search returned no matching result.',
      );
    }

    await safeTap(result);
    await browser.pause(1_500);
    await this.settle();
  }

  /** Which known categories are reachable from the home screen right now. */
  async visibleCategories(): Promise<BillCategory[]> {
    const found: BillCategory[] = [];

    for (const spec of CATEGORIES) {
      for (const label of spec.labels) {
        if (await resolveAndroidOptional(homeScreen.serviceTile(label), { timeout: 600 })) {
          found.push(spec.id);
          break;
        }
      }
    }

    return found;
  }

  async openTab(label: string): Promise<void> {
    const tab = await resolveAndroidOptional(homeScreen.navTab(label), { timeout: 5_000 });
    if (!tab) throw new Error(`Bottom-nav tab "${label}" not found`);
    await safeTap(tab);
    await browser.pause(1_200);
  }

  async hasBottomNav(): Promise<boolean> {
    return this.has(homeScreen.bottomNav, 5_000);
  }

  async search(term: string): Promise<void> {
    await this.tap(homeScreen.searchEntry);
    await browser.pause(500);
    const field = await this.find(homeScreen.searchEntry);
    await field.setValue(term);
    await browser.pause(1_500);
  }
}
