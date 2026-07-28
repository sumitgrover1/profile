import { test, expect } from '../../support/fixtures';
import { chrome } from '../../support/elements';
import { isPresent } from '../../support/locators';

/**
 * Responsive behaviour.
 *
 * The majority of FreeCharge's web traffic is a phone browser, so layout bugs at
 * 360px are not an edge case — they are the main case. These specs check the
 * things that actually break at narrow widths: horizontal overflow, tap targets
 * too small to hit, and text that has been shrunk into illegibility.
 */

const VIEWPORTS = [
  { name: 'small phone', width: 320, height: 568 },
  { name: 'common phone', width: 360, height: 800 },
  { name: 'large phone', width: 414, height: 896 },
  { name: 'tablet portrait', width: 768, height: 1024 },
  { name: 'small laptop', width: 1280, height: 800 },
  { name: 'desktop', width: 1920, height: 1080 },
] as const;

test.describe('Responsive layout @responsive', () => {
  for (const viewport of VIEWPORTS) {
    test.describe(`${viewport.name} (${viewport.width}×${viewport.height})`, () => {
      test.beforeEach(async ({ page, home }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await home.goto();
      });

      test('does not scroll horizontally', async ({ page }) => {
        const overflow = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));

        // A couple of pixels is rounding; anything more is a layout bug.
        expect(
          overflow.scrollWidth - overflow.clientWidth,
          `page overflows horizontally by ${overflow.scrollWidth - overflow.clientWidth}px — ` +
            'something inside is wider than the viewport',
        ).toBeLessThanOrEqual(2);
      });

      test('names the element causing any overflow', async ({ page }) => {
        const culprits = await page.evaluate(() => {
          const docWidth = document.documentElement.clientWidth;
          return Array.from(document.querySelectorAll<HTMLElement>('body *'))
            .filter((el) => {
              const rect = el.getBoundingClientRect();
              return rect.width > 0 && (rect.right > docWidth + 2 || rect.left < -2);
            })
            .slice(0, 5)
            .map((el) => {
              const rect = el.getBoundingClientRect();
              return `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(' ')[0]}` : ''} ` +
                `(left ${Math.round(rect.left)}, right ${Math.round(rect.right)}, viewport ${docWidth})`;
            });
        });

        expect(culprits, `elements extending past the viewport:\n  ${culprits.join('\n  ')}`).toEqual([]);
      });

      test('header remains visible', async ({ page }) => {
        expect(await isPresent(page, chrome.header, 8_000), 'the header should render at every width').toBeTruthy();
      });

      test('interactive controls meet the 44px minimum tap target', async ({ page }) => {
        test.skip(viewport.width > 768, 'tap-target sizing applies to touch viewports');

        const tooSmall = await page.evaluate(() => {
          const MIN = 44;
          const interactive = Array.from(
            document.querySelectorAll<HTMLElement>('a, button, [role="button"], input[type="submit"]'),
          );

          return interactive
            .filter((el) => {
              const rect = el.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) return false; // hidden
              if (rect.top > window.innerHeight * 2) return false; // far below the fold
              return rect.width < MIN || rect.height < MIN;
            })
            .slice(0, 10)
            .map((el) => {
              const rect = el.getBoundingClientRect();
              const label = el.textContent?.trim().slice(0, 30) || el.getAttribute('aria-label') || '(no label)';
              return `${el.tagName.toLowerCase()} "${label}" — ${Math.round(rect.width)}×${Math.round(rect.height)}px`;
            });
        });

        expect(
          tooSmall,
          `controls below the 44×44px tap target minimum (WCAG 2.5.5):\n  ${tooSmall.join('\n  ')}`,
        ).toEqual([]);
      });

      test('body text is at least 12px', async ({ page }) => {
        const tiny = await page.evaluate(() => {
          return Array.from(document.querySelectorAll<HTMLElement>('p, span, li, td, label, div'))
            .filter((el) => {
              const text = el.childNodes.length === 1 && el.firstChild?.nodeType === Node.TEXT_NODE;
              if (!text) return false;
              if ((el.textContent?.trim().length ?? 0) < 4) return false;
              if (el.offsetParent === null) return false;
              return Number.parseFloat(window.getComputedStyle(el).fontSize) < 12;
            })
            .slice(0, 8)
            .map((el) => `"${el.textContent?.trim().slice(0, 40)}" at ${window.getComputedStyle(el).fontSize}`);
        });

        expect(tiny, `text rendered below 12px is not readable on a phone:\n  ${tiny.join('\n  ')}`).toEqual([]);
      });
    });
  }

  test('mobile navigation is reachable @smoke', async ({ page, home }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await home.goto();

    const hamburger = page
      .getByRole('button', { name: /menu|navigation|hamburger/i })
      .or(page.locator('[class*="hamburger" i], [class*="menuToggle" i], [aria-label*="menu" i]'))
      .first();

    const hasHamburger = await hamburger.isVisible().catch(() => false);
    const hasVisibleNav = await isPresent(page, chrome.loginEntry, 3_000);

    expect(
      hasHamburger || hasVisibleNav,
      'at 360px there should be either a menu toggle or directly visible navigation',
    ).toBeTruthy();
  });
});
