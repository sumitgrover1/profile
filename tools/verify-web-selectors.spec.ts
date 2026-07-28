import { test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ALL_ELEMENTS, chrome, home as homeElements } from '../web/support/elements';
import { auditCandidates, type ElementSpec } from '../web/support/locators';
import { HomePage } from '../web/pages/home.page';
import { env } from '../shared/env';

/**
 * Selector verification.
 *
 * The element map in web/support/elements.ts declares each element as a chain of
 * candidate locators. This tool visits the live site and reports, for every
 * element, which candidates actually match and how many nodes each one hits.
 *
 * Run it before trusting the suite against a build you have not tested before,
 * and again whenever a redesign lands:
 *
 *     npm run verify:selectors:web
 *
 * Reading the output:
 *   OK      at least one candidate matched exactly one node — the chain is healthy
 *   AMBIG   a candidate matched several nodes — the spec will take the first one,
 *           which may not be the one you meant; consider tightening the chain
 *   MISS    nothing matched — the chain is stale and specs using it will fail
 *
 * A MISS on an element marked optional is expected and harmless.
 */

interface ElementResult {
  element: string;
  optional: boolean;
  status: 'OK' | 'AMBIG' | 'MISS';
  candidates: { candidate: string; matches: number }[];
}

function classify(results: { matches: number }[], optional: boolean): ElementResult['status'] {
  if (results.some((r) => r.matches === 1)) return 'OK';
  if (results.some((r) => r.matches > 1)) return 'AMBIG';
  return optional ? 'OK' : 'MISS';
}

async function auditAll(
  page: import('@playwright/test').Page,
  specs: Record<string, ElementSpec>,
  context: string,
): Promise<ElementResult[]> {
  const out: ElementResult[] = [];

  for (const [name, spec] of Object.entries(specs)) {
    const candidates = await auditCandidates(page, spec);
    out.push({
      element: `${context}::${name}`,
      optional: spec.optional ?? false,
      status: classify(candidates, spec.optional ?? false),
      candidates,
    });
  }

  return out;
}

function render(results: ElementResult[]): string {
  const lines: string[] = [];

  for (const result of results) {
    const flag = result.optional ? ' (optional)' : '';
    lines.push(`${result.status.padEnd(6)} ${result.element}${flag}`);

    for (const c of result.candidates) {
      const verdict =
        c.matches === -1 ? 'invalid for this DOM' : c.matches === 0 ? 'no match' : `${c.matches} node(s)`;
      const marker = c.matches === 1 ? '✔' : c.matches > 1 ? '~' : ' ';
      lines.push(`         ${marker} ${c.candidate.padEnd(52)} ${verdict}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

test('audit every selector chain against the live site', async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  const results: ElementResult[] = [];
  const homePage = new HomePage(page);

  await test.step('home page', async () => {
    await homePage.goto();
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);

    const homeScope: Record<string, ElementSpec> = {
      ...Object.fromEntries(Object.entries(chrome).map(([k, v]) => [`chrome.${k}`, v])),
      ...Object.fromEntries(
        Object.entries(homeElements)
          .filter(([, v]) => typeof v !== 'function')
          .map(([k, v]) => [`home.${k}`, v as ElementSpec]),
      ),
    };

    results.push(...(await auditAll(page, homeScope, 'home')));
  });

  await test.step('mobile recharge flow', async () => {
    const opened = await homePage
      .openCategory('mobile-prepaid')
      .then(() => true)
      .catch(() => false);

    if (!opened) {
      results.push({
        element: 'recharge::(flow unreachable)',
        optional: false,
        status: 'MISS',
        candidates: [{ candidate: 'could not open the mobile prepaid category from the home page', matches: 0 }],
      });
      return;
    }

    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);

    const flowScope = Object.fromEntries(
      Object.entries(ALL_ELEMENTS).filter(([k]) => k.startsWith('flow.')),
    ) as Record<string, ElementSpec>;

    results.push(...(await auditAll(page, flowScope, 'recharge')));
  });

  await test.step('login sheet', async () => {
    await homePage.goto();
    const opened = await homePage
      .openLogin()
      .then(() => true)
      .catch(() => false);

    if (!opened) {
      results.push({
        element: 'login::(sheet unreachable)',
        optional: false,
        status: 'MISS',
        candidates: [{ candidate: 'could not open the login sheet from the header', matches: 0 }],
      });
      return;
    }

    await page.waitForTimeout(1_500);

    const authScope = Object.fromEntries(
      Object.entries(ALL_ELEMENTS).filter(([k]) => k.startsWith('auth.')),
    ) as Record<string, ElementSpec>;

    results.push(...(await auditAll(page, authScope, 'login')));
  });

  const report = render(results);
  const misses = results.filter((r) => r.status === 'MISS');
  const ambiguous = results.filter((r) => r.status === 'AMBIG');

  const summary =
    `\nSelector audit against ${env.web.baseURL}\n` +
    `${'='.repeat(70)}\n\n${report}\n` +
    `${'='.repeat(70)}\n` +
    `${results.length} element(s) checked: ` +
    `${results.length - misses.length - ambiguous.length} OK, ${ambiguous.length} ambiguous, ${misses.length} missing\n` +
    (misses.length > 0
      ? `\nStale chains that need attention in web/support/elements.ts:\n` +
        misses.map((m) => `  - ${m.element}`).join('\n') +
        '\n'
      : '\nEvery chain resolved. The suite is safe to run against this build.\n');

  console.log(summary);

  const outDir = path.resolve(__dirname, '..', 'artifacts', 'verify');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'web-selector-audit.txt'), summary, 'utf8');

  await testInfo.attach('web-selector-audit.txt', { body: summary, contentType: 'text/plain' });

  // Reports, never fails: a stale chain is information, and the specs that
  // depend on it will fail on their own with a pointer back here.
});
