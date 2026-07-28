import { defineConfig, devices } from '@playwright/test';
import { env } from '../shared/env';

/**
 * Config for the selector-verification tool only.
 *
 * Kept separate from playwright.config.ts so the tool never runs as part of a
 * normal test pass — it reports rather than asserts, and a reporting run should
 * not be able to fail a build.
 */
export default defineConfig({
  testDir: '.',
  testMatch: ['verify-web-selectors.spec.ts'],
  outputDir: '../artifacts/verify/test-results',
  timeout: 180_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: env.web.baseURL,
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    ...devices['Desktop Chrome'],
  },
  projects: [{ name: 'chromium' }],
});
