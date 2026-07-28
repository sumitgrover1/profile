import { env } from '../../shared/env';

/**
 * Android safety guard.
 *
 * The web suite can intercept requests and abort anything transactional. On a
 * device there is no equivalent hook without standing up a proxy, so the guard
 * here works at the interaction layer instead: it refuses to tap a control whose
 * label indicates it commits a payment.
 *
 * This is a real protection, not a formality. An automated suite driving a
 * payments app on a device with a live account can spend actual money, and the
 * failure mode is silent — the test passes and someone's balance is gone. Every
 * tap in the flow screens goes through `safeTap`.
 */

/** Labels that indicate the control commits money. Never tapped in readonly mode. */
const COMMITTING_LABELS: readonly RegExp[] = [
  /\bpay\s*(now|₹|rs\.?|\d)/i,
  /\bproceed to pay\b/i,
  /\bconfirm (payment|and pay|order)\b/i,
  /\bplace order\b/i,
  /\bmake payment\b/i,
  /\bpay securely\b/i,
  /\bauthorize\b/i,
  /\bcomplete (payment|purchase)\b/i,
  /\badd money\b/i,
  /\bsend money\b/i,
  /\brecharge now\b/i,
  /\bverify (upi )?pin\b/i,
];

/** Screens that must never be interacted with beyond reading. */
const COMMITTING_SCREEN_MARKERS: readonly RegExp[] = [
  /enter (your )?upi pin/i,
  /card (number|cvv)/i,
  /otp for (your )?(payment|transaction)/i,
  /3d.?secure/i,
];

export class PaymentGuardError extends Error {
  constructor(label: string) {
    super(
      `Refusing to tap "${label}" — the label matches a control that commits a payment.\n` +
        'The Android suite stops at the payment-method screen by design.\n\n' +
        'If this is correct: stop the flow earlier, or run against a staging build ' +
        '(ANDROID_APP_PATH + TEST_ENV=staging) where the guard is lifted.\n\n' +
        'If this is a false positive — the control is navigation, not a commit ' +
        '(a "Recharge Now" tile that only opens a form, say) — narrow the matching ' +
        'pattern in COMMITTING_LABELS in android/support/guard.ts. Prefer narrowing ' +
        'one pattern over deleting it: the guard is the only thing standing between ' +
        'an automated run and a real transaction.',
    );
    this.name = 'PaymentGuardError';
  }
}

export function isCommittingLabel(label: string): boolean {
  return COMMITTING_LABELS.some((re) => re.test(label));
}

export function isCommittingScreen(pageText: string): boolean {
  return COMMITTING_SCREEN_MARKERS.some((re) => re.test(pageText));
}

/** Read whatever text identifies an element, for the guard to inspect. */
export async function labelOf(element: WebdriverIO.Element): Promise<string> {
  const text = await element.getText().catch(() => '');
  if (text.trim()) return text.trim();

  const desc = await element.getAttribute('content-desc').catch(() => '');
  return (desc ?? '').trim();
}

/**
 * Tap an element unless its label says it commits a payment.
 *
 * Every screen object in this suite taps through here. Adding a raw `.click()`
 * to a flow screen bypasses the guard, so don't.
 */
export async function safeTap(element: WebdriverIO.Element): Promise<void> {
  if (env.allowMutations) {
    await element.click();
    return;
  }

  const label = await labelOf(element);
  if (label && isCommittingLabel(label)) {
    throw new PaymentGuardError(label);
  }

  await element.click();
}

/**
 * Assert the app has not landed on a screen that takes payment credentials.
 * Called after any navigation that could plausibly overshoot.
 */
export function assertNotCommittingScreen(pageSource: string): void {
  if (env.allowMutations) return;

  if (isCommittingScreen(pageSource)) {
    throw new Error(
      'The flow reached a screen that collects payment credentials (card/UPI PIN). ' +
        'A read-only run should stop at the payment-method list. ' +
        'Either the test navigated too far or the app skipped a confirmation step.',
    );
  }
}
