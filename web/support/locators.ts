import { expect, type Locator, type Page, type FrameLocator } from '@playwright/test';

/**
 * Resilient locators.
 *
 * FreeCharge's markup is not ours and it changes without notice — class names are
 * hashed by the bundler, `data-testid` attributes may or may not survive a build,
 * and copy gets reworded. A suite that hard-codes one selector per element breaks
 * every sprint and teaches the team to ignore it.
 *
 * So every element here is declared as an *ordered list of candidates*. The
 * resolver tries them in order and uses the first one that actually attaches to
 * the DOM. Candidates are ordered most-stable-first: test ids, then ARIA roles
 * and accessible names, then visible text, and only then CSS as a last resort.
 *
 * When an element cannot be resolved, the error names every candidate that was
 * tried, so fixing a drifted selector is a one-line edit in the element map
 * rather than an archaeology session.
 */

export type Scope = Page | Locator | FrameLocator;

export type Candidate =
  | { kind: 'testid'; value: string }
  | { kind: 'role'; role: Parameters<Page['getByRole']>[0]; name?: string | RegExp; exact?: boolean }
  | { kind: 'label'; value: string | RegExp; exact?: boolean }
  | { kind: 'placeholder'; value: string | RegExp; exact?: boolean }
  | { kind: 'text'; value: string | RegExp; exact?: boolean }
  | { kind: 'altText'; value: string | RegExp }
  | { kind: 'title'; value: string | RegExp }
  | { kind: 'css'; value: string };

/** An element declared as an ordered candidate chain. */
export interface ElementSpec {
  /** Human name used in errors and reports. */
  name: string;
  candidates: Candidate[];
  /** When true, callers may legitimately find nothing (e.g. a cookie banner). */
  optional?: boolean;
}

export function el(name: string, candidates: Candidate[], optional = false): ElementSpec {
  return { name, candidates, optional };
}

function build(scope: Scope, c: Candidate): Locator {
  switch (c.kind) {
    case 'testid':
      return scope.getByTestId(c.value);
    case 'role':
      return scope.getByRole(c.role, c.name === undefined ? {} : { name: c.name, exact: c.exact });
    case 'label':
      return scope.getByLabel(c.value, { exact: c.exact });
    case 'placeholder':
      return scope.getByPlaceholder(c.value, { exact: c.exact });
    case 'text':
      return scope.getByText(c.value, { exact: c.exact });
    case 'altText':
      return scope.getByAltText(c.value);
    case 'title':
      return scope.getByTitle(c.value);
    case 'css':
      return scope.locator(c.value);
  }
}

export function describeCandidate(c: Candidate): string {
  switch (c.kind) {
    case 'testid':
      return `testid=${c.value}`;
    case 'role':
      return `role=${c.role}${c.name ? ` name=${String(c.name)}` : ''}`;
    case 'label':
      return `label=${String(c.value)}`;
    case 'placeholder':
      return `placeholder=${String(c.value)}`;
    case 'text':
      return `text=${String(c.value)}`;
    case 'altText':
      return `alt=${String(c.value)}`;
    case 'title':
      return `title=${String(c.value)}`;
    case 'css':
      return `css=${c.value}`;
  }
}

export interface ResolveOptions {
  /** Total budget across all candidates, ms. */
  timeout?: number;
  /** Require the element to be visible, not merely attached. Default true. */
  visible?: boolean;
  /** When several match, take this index. Default 0. */
  index?: number;
}

const DEFAULT_TIMEOUT = 15_000;
/** Time given to each candidate on a pass before moving to the next one. */
const PER_CANDIDATE_PROBE = 250;

/**
 * Try every candidate repeatedly until one attaches (and is visible, by default)
 * or the budget runs out. Polls in rounds so a slow-rendering element does not
 * cause the resolver to settle on a later, worse candidate just because the
 * better one had not painted yet.
 */
export async function resolve(scope: Scope, spec: ElementSpec, opts: ResolveOptions = {}): Promise<Locator> {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  const wantVisible = opts.visible ?? true;
  const index = opts.index ?? 0;
  const deadline = Date.now() + timeout;

  let lastError: unknown;
  while (Date.now() < deadline) {
    for (const candidate of spec.candidates) {
      const locator = build(scope, candidate).nth(index);
      try {
        await locator.waitFor({
          state: wantVisible ? 'visible' : 'attached',
          timeout: PER_CANDIDATE_PROBE,
        });
        return locator;
      } catch (err) {
        lastError = err;
      }
    }
  }

  const tried = spec.candidates.map((c) => `  - ${describeCandidate(c)}`).join('\n');
  throw new Error(
    `Could not resolve element "${spec.name}" within ${timeout}ms.\n` +
      `Tried ${spec.candidates.length} candidate(s):\n${tried}\n` +
      `If the page has changed, update the candidate chain in web/support/elements.ts.\n` +
      `Run "npm run verify:selectors:web" to see which candidates still match the live site.\n` +
      `Last probe error: ${lastError instanceof Error ? lastError.message.split('\n')[0] : String(lastError)}`,
  );
}

/**
 * Non-throwing resolve. Returns null when nothing matches, for genuinely
 * optional chrome like consent banners and promo interstitials.
 */
export async function resolveOptional(
  scope: Scope,
  spec: ElementSpec,
  opts: ResolveOptions = {},
): Promise<Locator | null> {
  try {
    return await resolve(scope, spec, { timeout: 3_000, ...opts });
  } catch {
    return null;
  }
}

/** True when at least one candidate is currently visible. */
export async function isPresent(scope: Scope, spec: ElementSpec, timeout = 3_000): Promise<boolean> {
  return (await resolveOptional(scope, spec, { timeout })) !== null;
}

/**
 * Report which candidates match right now. Used by the selector-verification
 * tool to tell the team which chains have gone stale before the specs do.
 */
export async function auditCandidates(
  scope: Scope,
  spec: ElementSpec,
): Promise<{ candidate: string; matches: number }[]> {
  const results: { candidate: string; matches: number }[] = [];
  for (const c of spec.candidates) {
    let matches = 0;
    try {
      matches = await build(scope, c).count();
    } catch {
      matches = -1; // malformed selector for this DOM
    }
    results.push({ candidate: describeCandidate(c), matches });
  }
  return results;
}

/** Assert an element is visible, with the candidate chain named on failure. */
export async function expectVisible(scope: Scope, spec: ElementSpec, timeout = DEFAULT_TIMEOUT): Promise<Locator> {
  const locator = await resolve(scope, spec, { timeout });
  await expect(locator, `${spec.name} should be visible`).toBeVisible();
  return locator;
}
