import { $$, browser } from '@wdio/globals';
import { toSelector, describeAndroidCandidate, type AndroidElementSpec } from './selectors';

/**
 * Candidate resolution for Android, mirroring web/support/locators.ts.
 *
 * Appium's own implicit wait is deliberately left at zero (see the WDIO config)
 * so this resolver controls all waiting — an implicit wait would make every
 * candidate probe take the full timeout and turn a five-candidate chain into a
 * minute of dead air.
 */

export interface AndroidResolveOptions {
  timeout?: number;
  /** Require displayed, not merely present in the hierarchy. Default true. */
  displayed?: boolean;
  index?: number;
}

const DEFAULT_TIMEOUT = 15_000;
const PER_CANDIDATE_PROBE = 400;

export async function resolveAndroid(
  spec: AndroidElementSpec,
  opts: AndroidResolveOptions = {},
): Promise<WebdriverIO.Element> {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  const wantDisplayed = opts.displayed ?? true;
  const index = opts.index ?? 0;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    for (const candidate of spec.candidates) {
      const selector = toSelector(candidate);
      try {
        // Fetch the whole match set rather than branching on index: it keeps the
        // element type uniform and makes an ambiguous chain visible to callers.
        const element = (await $$(selector).getElements())[index];
        if (!element) continue;

        const ok = wantDisplayed
          ? await element.isDisplayed().catch(() => false)
          : await element.isExisting().catch(() => false);

        if (ok) return element;
      } catch {
        /* candidate not usable against this hierarchy; try the next */
      }
    }
    await browser.pause(PER_CANDIDATE_PROBE);
  }

  const tried = spec.candidates.map((c) => `  - ${describeAndroidCandidate(c)}`).join('\n');
  throw new Error(
    `Could not resolve Android element "${spec.name}" within ${timeout}ms.\n` +
      `Tried ${spec.candidates.length} candidate(s):\n${tried}\n` +
      `If the app has changed, update the chain in android/support/elements.ts.\n` +
      `Run "npm run verify:selectors:android" to see which candidates still match, ` +
      `or dump the current hierarchy with the pageSource helper in android/support/device.ts.`,
  );
}

export async function resolveAndroidOptional(
  spec: AndroidElementSpec,
  opts: AndroidResolveOptions = {},
): Promise<WebdriverIO.Element | null> {
  try {
    return await resolveAndroid(spec, { timeout: 4_000, ...opts });
  } catch {
    return null;
  }
}

export async function androidPresent(spec: AndroidElementSpec, timeout = 4_000): Promise<boolean> {
  return (await resolveAndroidOptional(spec, { timeout })) !== null;
}

/** Report which candidates currently match, for the verification tool. */
export async function auditAndroidCandidates(
  spec: AndroidElementSpec,
): Promise<{ candidate: string; matches: number }[]> {
  const out: { candidate: string; matches: number }[] = [];

  for (const candidate of spec.candidates) {
    let matches = -1;
    try {
      const elements = await $$(toSelector(candidate)).getElements();
      matches = elements.length;
    } catch {
      matches = -1;
    }
    out.push({ candidate: describeAndroidCandidate(candidate), matches });
  }

  return out;
}
