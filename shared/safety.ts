/**
 * Safety guard.
 *
 * The suite is expected to run against production (www.freecharge.in) most of the
 * time, because that is where the frontend actually lives. Browsing and asserting
 * on public pages is harmless; submitting a payment is not. This module is the
 * single place that decides what "harmless" means, and both the web and Android
 * layers consult it.
 *
 * Rules:
 *   1. Anything that looks like a payment-gateway or order-placement endpoint is
 *      blocked outright when TEST_ENV=prod-readonly.
 *   2. Analytics / ad / session-replay beacons are blocked by default so runs are
 *      quiet and do not pollute the product's own funnels with bot traffic.
 *   3. Navigation to hosts outside the configured allow-list is blocked, so a
 *      stray redirect can never make the suite hammer someone else's service.
 */

/** Endpoint fragments that move money or create an order. Blocked in prod-readonly. */
export const TRANSACTIONAL_PATTERNS: readonly RegExp[] = [
  /\/(v\d\/)?(payment|payments|pay)\b/i,
  /\/(v\d\/)?(order|orders)\/(create|place|confirm)/i,
  /\/checkout\/(submit|confirm|process)/i,
  /\/wallet\/(debit|deduct|withdraw|transfer)/i,
  /\/txn\/(init|initiate|submit)/i,
  /\/recharge\/(do|submit|confirm)/i,
  /\/upi\/(collect|pay|mandate)/i,
];

/** Third-party payment gateways and bank ACS hosts. Never touched by automation. */
export const PAYMENT_GATEWAY_HOSTS: readonly string[] = [
  'razorpay.com',
  'payu.in',
  'payubiz.in',
  'billdesk.com',
  'ccavenue.com',
  'cashfree.com',
  'juspay.in',
  'paytm.in',
  'phonepe.com',
  'npci.org.in',
  'mastercard.com',
  'visa.com',
  'amazonpay.in',
];

/** Analytics, ads, session replay, crash reporting. Blocked to keep runs clean. */
export const THIRD_PARTY_NOISE_HOSTS: readonly string[] = [
  'google-analytics.com',
  'googletagmanager.com',
  'analytics.google.com',
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'facebook.net',
  'facebook.com',
  'connect.facebook.net',
  'clarity.ms',
  'hotjar.com',
  'hotjar.io',
  'fullstory.com',
  'mixpanel.com',
  'segment.com',
  'segment.io',
  'branch.io',
  'app-measurement.com',
  'crashlytics.com',
  'appsflyer.com',
  'clevertap.com',
  'moengage.com',
  'webengage.com',
  'newrelic.com',
  'nr-data.net',
  'sentry.io',
  'amplitude.com',
  'criteo.com',
  'taboola.com',
  'outbrain.com',
];

export type BlockReason = 'transactional' | 'payment-gateway' | 'third-party' | 'off-domain';

export interface GuardDecision {
  blocked: boolean;
  reason?: BlockReason;
  detail?: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function hostMatches(host: string, needle: string): boolean {
  return host === needle || host.endsWith(`.${needle}`);
}

export interface GuardOptions {
  /** Hosts the suite is allowed to talk to at all (the app under test + its APIs). */
  allowedHosts: readonly string[];
  /** When false, transactional endpoints are permitted (staging only). */
  readonly: boolean;
  /** When true, analytics/ads beacons are blocked. */
  blockThirdParty: boolean;
}

/**
 * Decide whether a request should be allowed through.
 *
 * Order matters: payment gateways are rejected even on staging via `readonly`,
 * because a sandbox gateway is still someone else's service and the suite should
 * stub it rather than drive it. Flip `readonly` to false only when the target is
 * a staging host with sandbox credentials.
 */
export function evaluateRequest(url: string, opts: GuardOptions): GuardDecision {
  const host = hostOf(url);
  if (!host) return { blocked: false };

  if (PAYMENT_GATEWAY_HOSTS.some((h) => hostMatches(host, h))) {
    if (opts.readonly) {
      return {
        blocked: true,
        reason: 'payment-gateway',
        detail: `${host} is a payment gateway; blocked in ${'prod-readonly'} mode`,
      };
    }
  }

  if (opts.readonly && TRANSACTIONAL_PATTERNS.some((re) => re.test(url))) {
    return {
      blocked: true,
      reason: 'transactional',
      detail: `${url} looks like an order/payment endpoint; blocked in prod-readonly mode`,
    };
  }

  if (opts.blockThirdParty && THIRD_PARTY_NOISE_HOSTS.some((h) => hostMatches(host, h))) {
    return { blocked: true, reason: 'third-party', detail: `${host} is an analytics/ads beacon` };
  }

  if (opts.allowedHosts.length > 0) {
    const allowed = opts.allowedHosts.some((h) => hostMatches(host, h));
    if (!allowed) {
      return { blocked: true, reason: 'off-domain', detail: `${host} is not in ALLOWED_HOSTS` };
    }
  }

  return { blocked: false };
}

/**
 * Hosts that must always be reachable for the app under test to render.
 * Derived from BASE_URL plus FreeCharge's own asset/API domains.
 */
export function defaultAllowedHosts(baseURL: string, extra: readonly string[] = []): string[] {
  const base = hostOf(baseURL);
  const apex = base.split('.').slice(-2).join('.');
  return Array.from(new Set([base, apex, ...extra].filter(Boolean)));
}
