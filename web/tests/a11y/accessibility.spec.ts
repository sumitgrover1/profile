import { test, expect } from '../../support/fixtures';
import { scan, tabOrder, focusIsVisible, formatViolations } from '../../support/a11y';
import { CORE_CATEGORIES, category } from '../../../shared/data/catalog';

/**
 * Accessibility.
 *
 * A payments app is infrastructure — people who cannot see the screen still need
 * to pay their electricity bill. These specs gate on critical and serious axe
 * violations, and report moderate/minor ones as annotations so the backlog is
 * visible without the build being permanently red.
 */

test.describe('Accessibility @a11y', () => {
  test('home page has no critical or serious violations', async ({ home, page }, testInfo) => {
    await home.goto();
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);

    const report = await scan(page);

    await testInfo.attach('axe-report.txt', {
      body: report.summary,
      contentType: 'text/plain',
    });

    if (report.moderate.length + report.minor.length > 0) {
      testInfo.annotations.push({
        type: 'a11y-backlog',
        description: `${report.moderate.length} moderate, ${report.minor.length} minor violation(s) — see attachment`,
      });
    }

    const blocking = [...report.critical, ...report.serious];
    expect(blocking, `blocking accessibility violations:\n${formatViolations(blocking)}`).toEqual([]);
  });

  for (const id of CORE_CATEGORIES) {
    const spec = category(id);

    test(`${spec.labels[0]} flow has no critical or serious violations`, async ({ home, page }, testInfo) => {
      await home.goto();

      const opened = await home
        .openCategory(id)
        .then(() => true)
        .catch(() => false);
      test.skip(!opened, `${spec.labels[0]} is not reachable in this build`);

      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
      const report = await scan(page);

      await testInfo.attach(`axe-${id}.txt`, { body: report.summary, contentType: 'text/plain' });

      const blocking = [...report.critical, ...report.serious];
      expect(blocking, `blocking violations in ${spec.labels[0]}:\n${formatViolations(blocking)}`).toEqual([]);
    });
  }

  test('every form field has an accessible name', async ({ home, page }) => {
    await home.goto();
    await home.openCategory('mobile-prepaid').catch(() => undefined);

    const unnamed = await page.evaluate(() => {
      const fields = Array.from(document.querySelectorAll('input, select, textarea')) as HTMLElement[];
      return fields
        .filter((field) => {
          const el = field as HTMLInputElement;
          if (el.type === 'hidden') return false;
          if (el.offsetParent === null) return false; // not rendered

          const hasAriaLabel = !!el.getAttribute('aria-label')?.trim();
          const labelledBy = el.getAttribute('aria-labelledby');
          const hasLabelledBy = !!labelledBy && !!document.getElementById(labelledBy);
          const hasLabel = !!el.id && !!document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          const hasWrappingLabel = !!el.closest('label');
          const hasTitle = !!el.getAttribute('title')?.trim();

          return !(hasAriaLabel || hasLabelledBy || hasLabel || hasWrappingLabel || hasTitle);
        })
        .map((el) => {
          const input = el as HTMLInputElement;
          return `${input.tagName.toLowerCase()}[type=${input.type ?? 'n/a'}, name=${input.name || 'n/a'}, placeholder=${input.placeholder || 'n/a'}]`;
        });
    });

    expect(
      unnamed,
      `form fields with no accessible name (a placeholder alone is not one):\n  ${unnamed.join('\n  ')}`,
    ).toEqual([]);
  });

  test('the recharge form is operable by keyboard', async ({ home, page }) => {
    await home.goto();
    const opened = await home
      .openCategory('mobile-prepaid')
      .then(() => true)
      .catch(() => false);
    test.skip(!opened, 'mobile prepaid flow is not reachable');

    const stops = await tabOrder(page, 40);

    expect(stops.length, 'tabbing should reach at least a handful of controls').toBeGreaterThan(3);

    const reachedAnInput = stops.some((s) => s.startsWith('input') || s.startsWith('select') || s.startsWith('button'));
    expect(reachedAnInput, `tab order never reached a form control. Stops: ${stops.join(' → ')}`).toBeTruthy();
  });

  test('focused controls show a visible focus indicator', async ({ home, page }) => {
    await home.goto();

    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');

    expect(
      await focusIsVisible(page),
      'the focused element had no outline, box-shadow or border change — keyboard users cannot tell where they are',
    ).toBeTruthy();
  });

  test('page has exactly one h1 and a sane heading order', async ({ home, page }) => {
    await home.goto();

    const headings = await page.evaluate(() =>
      Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
        .filter((h) => (h as HTMLElement).offsetParent !== null)
        .map((h) => ({ level: Number(h.tagName[1]), text: h.textContent?.trim().slice(0, 60) ?? '' })),
    );

    const h1s = headings.filter((h) => h.level === 1);
    expect(h1s.length, `expected exactly one visible <h1>, found ${h1s.length}`).toBe(1);

    const skips: string[] = [];
    for (let i = 1; i < headings.length; i += 1) {
      const prev = headings[i - 1];
      const curr = headings[i];
      if (prev && curr && curr.level - prev.level > 1) {
        skips.push(`h${prev.level} "${prev.text}" → h${curr.level} "${curr.text}"`);
      }
    }

    expect(skips, `heading levels skip a rank, which breaks screen-reader navigation:\n  ${skips.join('\n  ')}`).toEqual(
      [],
    );
  });

  test('images carry alt text', async ({ home, page }) => {
    await home.goto();

    const missing = await page.evaluate(() =>
      Array.from(document.querySelectorAll('img'))
        .filter((img) => (img as HTMLElement).offsetParent !== null)
        .filter((img) => !img.hasAttribute('alt') && img.getAttribute('role') !== 'presentation')
        .map((img) => img.getAttribute('src')?.slice(0, 90) ?? '(no src)'),
    );

    expect(
      missing,
      `images with no alt attribute (decorative images need alt="" explicitly):\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });
});
