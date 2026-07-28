/**
 * Assertions with mandatory failure messages.
 *
 * expect-webdriverio's `expect` does not accept a message argument the way
 * Playwright's does, and a bare `expect(x).toBe(true)` failure on a device tells
 * you nothing — you get "expected true, received false" with no indication of
 * which control, which screen, or what the app actually showed.
 *
 * These helpers make the message mandatory, so every Android failure explains
 * itself. Mocha reports a thrown AssertionError exactly the same way it reports
 * a failed matcher.
 */

export class AndroidAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AndroidAssertionError';
  }
}

function fail(message: string): never {
  throw new AndroidAssertionError(message);
}

/** The condition must hold. */
export function must(condition: boolean, message: string): asserts condition {
  if (!condition) fail(message);
}

/** The condition must not hold. */
export function mustNot(condition: boolean, message: string): void {
  if (condition) fail(message);
}

export function mustEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    fail(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
  }
}

export function mustContain(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    fail(`${message}\n  looking for: ${needle}\n  in:          ${haystack.slice(0, 200)}`);
  }
}

export function mustBeGreaterThan(actual: number, floor: number, message: string): void {
  if (!(actual > floor)) {
    fail(`${message}\n  expected greater than ${floor}, got ${actual}`);
  }
}

/** A list of findings must be empty; each finding is printed on its own line. */
export function mustBeEmpty(findings: readonly string[], message: string): void {
  if (findings.length > 0) {
    fail(`${message}\n  ${findings.join('\n  ')}`);
  }
}
