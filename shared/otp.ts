import { env } from './env';

/**
 * OTP retrieval.
 *
 * Automating a login that is gated by an SMS OTP has exactly three legitimate
 * strategies, and this module implements all three. What it deliberately does
 * *not* do is scrape a personal inbox, drive an SMS-forwarding app on someone's
 * real handset, or brute-force the code — those are how OTP automation goes
 * wrong, and none of them belong in a test suite.
 *
 *   1. `static`   — the backend issues a fixed OTP for allow-listed test numbers
 *                   on staging. Set TEST_STATIC_OTP. This is the right answer and
 *                   the one to lobby the backend team for if it does not exist.
 *   2. `provider` — a team-run test-SMS service (Twilio test numbers, an internal
 *                   OTP-vending endpoint) exposes the last code over HTTP. Set
 *                   OTP_PROVIDER_URL and OTP_PROVIDER_TOKEN.
 *   3. `session`  — skip OTP entirely by reusing a storage state / auth token
 *                   captured once by a human. See web/support/auth-state.ts.
 *
 * When none is configured, `resolveOtp` throws with a message that says which
 * knob to turn, and the authenticated specs skip rather than fail.
 */

export type OtpStrategy = 'static' | 'provider' | 'none';

export function activeStrategy(): OtpStrategy {
  if (env.account.staticOtp) return 'static';
  if (env.account.otpProviderUrl) return 'provider';
  return 'none';
}

export function otpAvailable(): boolean {
  return activeStrategy() !== 'none';
}

export function unavailableReason(): string {
  return (
    'No OTP strategy configured. Set TEST_STATIC_OTP (staging test number with a fixed code) ' +
    'or OTP_PROVIDER_URL + OTP_PROVIDER_TOKEN (team OTP-vending endpoint), ' +
    'or capture a storage state once and set STORAGE_STATE. See shared/otp.ts.'
  );
}

export interface OtpRequest {
  mobile: string;
  /** Milliseconds to keep polling the provider for a fresh code. */
  timeout?: number;
}

/**
 * Fetch the OTP for a number. Polls the provider until a code arrives, because
 * SMS delivery is asynchronous and a single immediate GET almost always races.
 */
export async function resolveOtp({ mobile, timeout = 30_000 }: OtpRequest): Promise<string> {
  const strategy = activeStrategy();

  if (strategy === 'static') {
    return env.account.staticOtp;
  }

  if (strategy === 'provider') {
    const deadline = Date.now() + timeout;
    let lastStatus = 0;

    while (Date.now() < deadline) {
      const url = new URL(env.account.otpProviderUrl);
      url.searchParams.set('mobile', mobile);

      const response = await fetch(url, {
        headers: env.account.otpProviderToken
          ? { authorization: `Bearer ${env.account.otpProviderToken}` }
          : {},
      });
      lastStatus = response.status;

      if (response.ok) {
        const body = (await response.json()) as { otp?: string; code?: string };
        const code = body.otp ?? body.code;
        if (code) return String(code);
      }

      await new Promise((r) => setTimeout(r, 2_000));
    }

    throw new Error(
      `OTP provider did not return a code for ${maskMobile(mobile)} within ${timeout}ms (last status ${lastStatus}).`,
    );
  }

  throw new Error(unavailableReason());
}

/** Never let a full number reach a log line or a report. */
export function maskMobile(mobile: string): string {
  if (mobile.length < 4) return '***';
  return `${'*'.repeat(Math.max(0, mobile.length - 4))}${mobile.slice(-4)}`;
}
