import { env } from '../../shared/env';

/**
 * Resilient Android selectors.
 *
 * The same problem as the web suite, with sharper edges: an APK's view hierarchy
 * is generated, `resource-id`s are stripped or renamed by R8/ProGuard between
 * builds, and a Compose UI may expose no resource-ids at all — only semantics.
 *
 * So every element is again an ordered candidate chain, preferring:
 *   1. accessibility id  (content-desc) — stable, and the thing TalkBack reads
 *   2. resource-id       — stable within a build variant
 *   3. text / UiSelector — survives repackaging, breaks on copy changes
 *   4. xpath             — last resort, brittle by nature
 *
 * Candidates are expressed as WebdriverIO selector strings so they can be handed
 * straight to `$()`.
 */

export type AndroidCandidate =
  | { kind: 'accessibility'; value: string }
  | { kind: 'id'; value: string }
  | { kind: 'text'; value: string; exact?: boolean }
  | { kind: 'textContains'; value: string }
  | { kind: 'className'; value: string }
  | { kind: 'uiautomator'; value: string }
  | { kind: 'xpath'; value: string };

export interface AndroidElementSpec {
  name: string;
  candidates: AndroidCandidate[];
  optional?: boolean;
}

export function ael(name: string, candidates: AndroidCandidate[], optional = false): AndroidElementSpec {
  return { name, candidates, optional };
}

/** Escape a string for embedding in a UiSelector literal. */
function ui(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Turn a candidate into a WebdriverIO selector string. */
export function toSelector(candidate: AndroidCandidate): string {
  const pkg = env.android.appPackage;

  switch (candidate.kind) {
    case 'accessibility':
      return `~${candidate.value}`;
    case 'id':
      // Accept both bare ids and fully-qualified ones.
      return candidate.value.includes(':id/') ? `id=${candidate.value}` : `id=${pkg}:id/${candidate.value}`;
    case 'text':
      return candidate.exact === false
        ? `android=new UiSelector().textContains("${ui(candidate.value)}")`
        : `android=new UiSelector().text("${ui(candidate.value)}")`;
    case 'textContains':
      return `android=new UiSelector().textContains("${ui(candidate.value)}")`;
    case 'className':
      return `android=new UiSelector().className("${ui(candidate.value)}")`;
    case 'uiautomator':
      return `android=${candidate.value}`;
    case 'xpath':
      return candidate.value;
  }
}

export function describeAndroidCandidate(candidate: AndroidCandidate): string {
  return `${candidate.kind}=${'value' in candidate ? candidate.value : ''}`;
}

/**
 * Case-insensitive text matching via UiSelector's regex support. Android's
 * `text()` is exact and case-sensitive, which makes copy-based selectors far more
 * brittle than they need to be.
 */
export function textMatches(pattern: string): AndroidCandidate {
  return { kind: 'uiautomator', value: `new UiSelector().textMatches("(?i).*${ui(pattern)}.*")` };
}

/** Same, for content-desc. */
export function descMatches(pattern: string): AndroidCandidate {
  return { kind: 'uiautomator', value: `new UiSelector().descriptionMatches("(?i).*${ui(pattern)}.*")` };
}

/** Any clickable element whose text or content-desc matches. Good for buttons. */
export function clickableMatching(pattern: string): AndroidCandidate {
  return {
    kind: 'uiautomator',
    value: `new UiSelector().clickable(true).textMatches("(?i).*${ui(pattern)}.*")`,
  };
}

/** Editable field with a matching hint — how most Android forms label inputs. */
export function fieldWithHint(pattern: string): AndroidCandidate {
  return {
    kind: 'xpath',
    value: `//android.widget.EditText[contains(translate(@hint,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'${pattern.toLowerCase()}')]`,
  };
}
