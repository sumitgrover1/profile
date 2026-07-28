import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import type { Result } from 'axe-core';

/**
 * Accessibility scanning.
 *
 * The suite asserts on WCAG 2.1 A and AA, which is the level Indian consumer
 * fintech is generally held to, and reports violations grouped by impact so a
 * team can triage rather than drown.
 *
 * Third-party embeds (chat widgets, ad iframes) are excluded: they are real
 * accessibility problems, but they are not fixable by the team that owns this
 * suite, and leaving them in makes every run red and therefore ignored.
 */

export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const;

/** Selectors excluded from every scan, with the reason kept next to them. */
const EXCLUDED = [
  { selector: 'iframe[src*="doubleclick"]', why: 'third-party ad frame' },
  { selector: 'iframe[src*="googlesyndication"]', why: 'third-party ad frame' },
  { selector: 'iframe[title*="chat" i]', why: 'vendor chat widget' },
  { selector: '[id*="freshchat" i]', why: 'vendor chat widget' },
  { selector: '[class*="intercom" i]', why: 'vendor chat widget' },
];

export interface A11yReport {
  violations: Result[];
  critical: Result[];
  serious: Result[];
  moderate: Result[];
  minor: Result[];
  summary: string;
}

export async function scan(page: Page, options: { include?: string } = {}): Promise<A11yReport> {
  let builder = new AxeBuilder({ page }).withTags([...WCAG_TAGS]);

  if (options.include) builder = builder.include(options.include);
  for (const { selector } of EXCLUDED) builder = builder.exclude(selector);

  const results = await builder.analyze();
  const byImpact = (impact: string) => results.violations.filter((v) => v.impact === impact);

  const critical = byImpact('critical');
  const serious = byImpact('serious');
  const moderate = byImpact('moderate');
  const minor = byImpact('minor');

  return {
    violations: results.violations,
    critical,
    serious,
    moderate,
    minor,
    summary: formatViolations(results.violations),
  };
}

export function formatViolations(violations: Result[]): string {
  if (violations.length === 0) return 'No accessibility violations found.';

  return violations
    .map((v) => {
      const nodes = v.nodes
        .slice(0, 3)
        .map((n) => `      ${n.target.join(' ')}`)
        .join('\n');
      const more = v.nodes.length > 3 ? `\n      …and ${v.nodes.length - 3} more node(s)` : '';
      return (
        `  [${(v.impact ?? 'unknown').toUpperCase()}] ${v.id}: ${v.help}\n` +
        `    ${v.helpUrl}\n` +
        `    ${v.nodes.length} node(s):\n${nodes}${more}`
      );
    })
    .join('\n\n');
}

/**
 * Keyboard-only reachability check.
 *
 * Tabs through the page and reports the elements that took focus. A bill-payment
 * flow that cannot be completed on a keyboard is unusable with a screen reader,
 * and axe alone will not catch it.
 */
export async function tabOrder(page: Page, maxStops = 40): Promise<string[]> {
  const stops: string[] = [];
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  for (let i = 0; i < maxStops; i += 1) {
    await page.keyboard.press('Tab');
    const descriptor = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active || active === document.body) return null;
      const label =
        active.getAttribute('aria-label') ??
        active.getAttribute('placeholder') ??
        active.textContent?.trim().slice(0, 40) ??
        '';
      return `${active.tagName.toLowerCase()}${label ? `[${label}]` : ''}`;
    });

    if (descriptor === null) break;
    stops.push(descriptor);
  }

  return stops;
}

/** True when the focused element has a visible focus indicator. */
export async function focusIsVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) return false;
    const style = window.getComputedStyle(active);
    const hasOutline = style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
    const hasShadow = style.boxShadow !== 'none' && style.boxShadow !== '';
    const hasBorderChange = style.borderColor !== 'rgb(0, 0, 0)' && Number.parseFloat(style.borderWidth) > 0;
    return hasOutline || hasShadow || hasBorderChange;
  });
}
