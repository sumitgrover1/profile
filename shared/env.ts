import * as dotenv from 'dotenv';
import * as path from 'node:path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

/**
 * Execution mode for the whole suite.
 *
 * `prod-readonly` is the default on purpose. In this mode the suite is allowed to
 * browse public pages and assert on rendered UI, but the safety guard blocks any
 * request that would create an order, debit a wallet, or hit a payment gateway.
 * Destructive / transactional specs skip themselves rather than fail.
 *
 * `staging` unlocks the transactional specs. Point BASE_URL at a non-production
 * host and use a dedicated test account with sandbox payment credentials.
 */
export type TestEnv = 'prod-readonly' | 'staging';

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

const testEnv = str('TEST_ENV', 'prod-readonly') as TestEnv;
if (testEnv !== 'prod-readonly' && testEnv !== 'staging') {
  throw new Error(`TEST_ENV must be "prod-readonly" or "staging", got "${testEnv}"`);
}

export const env = {
  /** prod-readonly (default) or staging. See TestEnv. */
  testEnv,
  /** True when transactional / mutating specs are permitted to run. */
  get allowMutations(): boolean {
    return this.testEnv === 'staging';
  },

  web: {
    baseURL: str('BASE_URL', 'https://www.freecharge.in'),
    /** Extra hosts the suite is allowed to talk to, comma separated. */
    allowedHosts: str('ALLOWED_HOSTS', '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
    /** Block analytics/ads/3rd-party beacons. Makes runs faster and quieter. */
    blockThirdParty: bool('BLOCK_THIRD_PARTY', true),
    slowMo: int('SLOW_MO', 0),
  },

  android: {
    /** Path to the .apk under test. Leave empty to attach to an already-installed build. */
    appPath: str('ANDROID_APP_PATH', ''),
    appPackage: str('ANDROID_APP_PACKAGE', 'com.freecharge.android'),
    appActivity: str('ANDROID_APP_ACTIVITY', ''),
    deviceName: str('ANDROID_DEVICE_NAME', 'Android Emulator'),
    platformVersion: str('ANDROID_PLATFORM_VERSION', ''),
    udid: str('ANDROID_UDID', ''),
    appiumHost: str('APPIUM_HOST', '127.0.0.1'),
    appiumPort: int('APPIUM_PORT', 4723),
    /** Reinstall the app between specs for a clean state. Slower but deterministic. */
    fullReset: bool('ANDROID_FULL_RESET', false),
    noReset: bool('ANDROID_NO_RESET', true),
  },

  /**
   * Credentials for a dedicated automation account. Never commit real values —
   * supply them through .env locally and repository secrets in CI.
   */
  account: {
    mobile: str('TEST_MOBILE', ''),
    /**
     * Static OTP issued by the backend for allow-listed test numbers on staging.
     * Real OTPs delivered over SMS are deliberately out of scope: see
     * shared/otp.ts for the supported strategies.
     */
    staticOtp: str('TEST_STATIC_OTP', ''),
    otpProviderUrl: str('OTP_PROVIDER_URL', ''),
    otpProviderToken: str('OTP_PROVIDER_TOKEN', ''),
  },

  ci: bool('CI', false),
  /** Fail a spec when the safety guard sees a forbidden request, instead of just blocking it. */
  strictSafety: bool('STRICT_SAFETY', true),
} as const;

export type Env = typeof env;
