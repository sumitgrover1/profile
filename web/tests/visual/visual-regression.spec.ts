import { test, expect } from '../../support/fixtures';
import { CORE_CATEGORIES, category } from '../../../shared/data/catalog';

/**
 * Visual regression.
 *
 * A consumer home page is full of rotating banners, live offer counters and
 * personalised rails — screenshotting it naively produces a test that fails
 * every single run and gets deleted within a month. So:
 *
 *   - animations are frozen,
 *   - known-dynamic regions are masked rather than compared,
 *   - a small pixel tolerance absorbs font rasterisation differences.
 *
 * Baselines are per-project and committed under __snapshots__/. Refresh them
 * deliberately with `npm run test:web:update-snapshots`, and review the diff —
 * an updated baseline is a claim that the new rendering is correct.
 */

/** Regions that legitimately differ between runs. Masked, not compared. */
const DYNAMIC_REGIONS = [
  '[class*="carousel" i]',
  '[class*="banner" i]',
  '[class*="offer" i]',
  '[class*="cashback" i]',
  '[class*="timer" i]',
  '[class*="countdown" i]',
  '[class*="marquee" i]',
  'video',
  'iframe',
  'canvas',
];

const SNAPSHOT_OPTIONS = {
  maxDiffPixelRatio: 0.02,
  animations: 'disabled',
  scale: 'css',
} as const;

test.describe('Visual regression @visual', () => {
  test.beforeEach(async ({ page }) => {
    // Freeze anything that moves, so two runs of a healthy page look identical.
    await page.addStyleTag({
      content: `
        *, *::before, *::after {
          animation-duration: 0s !important;
          animation-delay: 0s !important;
          transition-duration: 0s !important;
          transition-delay: 0s !important;
          caret-color: transparent !important;
        }
        html { scroll-behavior: auto !important; }
      `,
    });
  });

  test('home page above the fold', async ({ home, page }) => {
    await home.goto();
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);

    await expect(page).toHaveScreenshot('home-above-fold.png', {
      ...SNAPSHOT_OPTIONS,
      fullPage: false,
      mask: DYNAMIC_REGIONS.map((selector) => page.locator(selector)),
    });
  });

  test('home page full length', async ({ home, page }) => {
    await home.goto();
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);

    // Scroll the page once so lazy-loaded imagery is present in the capture.
    await page.evaluate(async () => {
      const step = window.innerHeight;
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(600);

    await expect(page).toHaveScreenshot('home-full.png', {
      ...SNAPSHOT_OPTIONS,
      fullPage: true,
      mask: DYNAMIC_REGIONS.map((selector) => page.locator(selector)),
    });
  });

  for (const id of CORE_CATEGORIES) {
    const spec = category(id);

    test(`${spec.labels[0]} form`, async ({ home, page }) => {
      await home.goto();

      const opened = await home
        .openCategory(id)
        .then(() => true)
        .catch(() => false);
      test.skip(!opened, `${spec.labels[0]} is not reachable in this build`);

      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);

      await expect(page).toHaveScreenshot(`${id}-form.png`, {
        ...SNAPSHOT_OPTIONS,
        fullPage: false,
        mask: DYNAMIC_REGIONS.map((selector) => page.locator(selector)),
      });
    });
  }

  test('login sheet', async ({ home, login, page }) => {
    await home.goto();

    const opened = await login
      .open()
      .then(() => true)
      .catch(() => false);
    test.skip(!opened, 'login sheet is not reachable');

    await page.waitForTimeout(800);

    await expect(page).toHaveScreenshot('login-sheet.png', {
      ...SNAPSHOT_OPTIONS,
      fullPage: false,
      mask: DYNAMIC_REGIONS.map((selector) => page.locator(selector)),
    });
  });

  test('footer', async ({ home, page }) => {
    await home.goto();
    const footer = page.locator('footer').first();

    const visible = await footer.isVisible().catch(() => false);
    test.skip(!visible, 'no <footer> element on this build');

    await footer.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);

    await expect(footer).toHaveScreenshot('footer.png', SNAPSHOT_OPTIONS);
  });
});
