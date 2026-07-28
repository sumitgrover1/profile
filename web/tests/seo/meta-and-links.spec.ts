import { test, expect } from '../../support/fixtures';

/**
 * Document-level correctness: metadata, crawlability and link health.
 *
 * These are cheap checks that catch a class of regression which is invisible in
 * the UI but expensive commercially — a stray `noindex` shipped to production,
 * a canonical pointing at staging, or a nav full of dead links.
 */

test.describe('Document metadata @seo', () => {
  test.beforeEach(async ({ home }) => {
    await home.goto();
  });

  test('declares a character encoding and a mobile viewport', async ({ page }) => {
    const charset = await page.locator('meta[charset]').getAttribute('charset').catch(() => null);
    const httpEquiv = await page
      .locator('meta[http-equiv="Content-Type" i]')
      .getAttribute('content')
      .catch(() => null);

    expect(charset ?? httpEquiv, 'the document should declare its encoding').not.toBeNull();

    const viewport = await page.locator('meta[name="viewport" i]').first().getAttribute('content');
    expect(viewport, 'a mobile viewport meta tag is required for a mobile-first site').toBeTruthy();
    expect(viewport ?? '', 'viewport should set width=device-width').toContain('width=device-width');

    // Blocking zoom is an accessibility failure, not just an SEO one.
    expect(viewport ?? '', 'viewport must not disable user scaling').not.toMatch(/user-scalable\s*=\s*no/i);
    expect(viewport ?? '', 'viewport must not cap zoom below 2×').not.toMatch(/maximum-scale\s*=\s*1(\.0)?\b/i);
  });

  test('sets a language on the html element', async ({ page }) => {
    const lang = await page.locator('html').getAttribute('lang');
    expect(lang, '<html> should carry a lang attribute so screen readers pick the right voice').toBeTruthy();
  });

  test('has a meta description of a usable length', async ({ page }) => {
    const description = await page
      .locator('meta[name="description" i]')
      .first()
      .getAttribute('content')
      .catch(() => null);

    expect(description, 'the home page should have a meta description').toBeTruthy();
    expect((description ?? '').trim().length, 'meta description is too short to be useful').toBeGreaterThan(50);
  });

  test('is not accidentally blocked from indexing', async ({ page }) => {
    const robots = await page
      .locator('meta[name="robots" i]')
      .first()
      .getAttribute('content')
      .catch(() => null);

    if (robots) {
      expect(
        robots.toLowerCase(),
        `production home page carries robots="${robots}" — a noindex here removes the site from search`,
      ).not.toContain('noindex');
    }
  });

  test('canonical URL points at production, not an internal host', async ({ page }) => {
    const canonical = await page
      .locator('link[rel="canonical" i]')
      .first()
      .getAttribute('href')
      .catch(() => null);

    test.skip(canonical === null, 'no canonical link on this page');

    expect(canonical ?? '', 'canonical must not leak a staging or localhost URL').not.toMatch(
      /localhost|127\.0\.0\.1|staging|\.dev\b|\.test\b|preprod/i,
    );
  });

  test('declares Open Graph tags for link previews', async ({ page }) => {
    const required = ['og:title', 'og:description', 'og:image', 'og:url'];
    const missing: string[] = [];

    for (const property of required) {
      const content = await page
        .locator(`meta[property="${property}" i]`)
        .first()
        .getAttribute('content')
        .catch(() => null);
      if (!content?.trim()) missing.push(property);
    }

    expect(missing, `missing Open Graph tags — shared links will render without a preview: ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  test('serves a favicon', async ({ page }) => {
    const icon = await page.locator('link[rel~="icon" i]').first().getAttribute('href').catch(() => null);
    expect(icon, 'the site should declare a favicon').toBeTruthy();
  });
});

test.describe('Link health @seo', () => {
  test('no anchor points nowhere', async ({ home, page }) => {
    await home.goto();

    const dead = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a'))
        .filter((a) => (a as HTMLElement).offsetParent !== null)
        .filter((a) => {
          const href = a.getAttribute('href');
          return href === null || href.trim() === '' || href.trim() === '#';
        })
        .slice(0, 15)
        .map((a) => `"${a.textContent?.trim().slice(0, 40) || '(no text)'}"`),
    );

    expect(dead, `anchors with no destination (use a <button> for JS-only actions):\n  ${dead.join('\n  ')}`).toEqual([]);
  });

  test('external links that open a new tab are safe', async ({ home, page }) => {
    await home.goto();

    const unsafe = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[target="_blank"]'))
        .filter((a) => {
          const rel = (a.getAttribute('rel') ?? '').toLowerCase();
          const href = a.getAttribute('href') ?? '';
          const isExternal = href.startsWith('http') && !href.includes(window.location.hostname);
          return isExternal && !rel.includes('noopener');
        })
        .slice(0, 10)
        .map((a) => a.getAttribute('href') ?? ''),
    );

    expect(
      unsafe,
      `external target="_blank" links without rel="noopener" — these give the opened page ` +
        `a handle on this one:\n  ${unsafe.join('\n  ')}`,
    ).toEqual([]);
  });

  test('primary navigation links resolve', async ({ home, page, request }) => {
    await home.goto();

    const hrefs = await page.evaluate(() => {
      const origin = window.location.origin;
      return Array.from(document.querySelectorAll('header a, nav a, footer a'))
        .map((a) => (a as HTMLAnchorElement).href)
        .filter((href) => href.startsWith(origin))
        .filter((href, i, all) => all.indexOf(href) === i)
        .slice(0, 25);
    });

    test.skip(hrefs.length === 0, 'no first-party navigation links found');

    const broken: string[] = [];
    for (const href of hrefs) {
      // HEAD first; some CDNs reject it, so fall back to a ranged GET rather
      // than downloading whole pages.
      const response = await request
        .head(href, { timeout: 20_000, failOnStatusCode: false })
        .catch(() => null);

      const status =
        response?.status() ??
        (await request
          .get(href, { timeout: 20_000, failOnStatusCode: false, headers: { range: 'bytes=0-1023' } })
          .then((r) => r.status())
          .catch(() => 0));

      if (status >= 400) broken.push(`${status} ${href}`);
    }

    expect(broken, `navigation links returning an error status:\n  ${broken.join('\n  ')}`).toEqual([]);
  });
});
