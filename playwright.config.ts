import { defineConfig, devices } from '@playwright/test';
import { env } from './shared/env';

/**
 * Playwright configuration for the FreeCharge web suite.
 *
 * Projects are split by *device class* rather than by test type; test type is
 * selected with tags (@smoke, @functional, @a11y, @visual, @perf, @seo) so any
 * slice can run on any device class.
 */
export default defineConfig({
  testDir: '.',
  testMatch: ['web/tests/**/*.spec.ts'],
  outputDir: 'artifacts/web/test-results',

  /* A third-party production site is slower and less predictable than our own
   * staging box, so budgets are generous. Tighten them for staging runs. */
  timeout: 90_000,
  expect: { timeout: 15_000 },

  fullyParallel: true,
  /* Cap parallelism against production: a test suite should not look like a
   * traffic spike to the site it is testing. */
  workers: env.ci ? 4 : 2,

  forbidOnly: env.ci,
  retries: env.ci ? 2 : 0,

  reporter: [
    ['list'],
    ['html', { outputFolder: 'artifacts/web/html-report', open: 'never' }],
    ['json', { outputFile: 'artifacts/web/results.json' }],
    ...(env.ci ? ([['github']] as const) : []),
  ],

  use: {
    baseURL: env.web.baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: env.ci ? 'retain-on-failure' : 'off',
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    geolocation: { latitude: 28.6139, longitude: 77.209 }, // New Delhi
    permissions: [],
    launchOptions: { slowMo: env.web.slowMo },
    /* Identify the suite honestly. A site owner reading their logs should be
     * able to tell this is a QA bot and who to contact, not have to guess. */
    extraHTTPHeaders: {
      'x-automated-test': 'freecharge-frontend-suite',
    },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      /* Visual baselines are captured per-browser; keep webkit off the visual
       * tag until the team decides to maintain a second set of snapshots. */
      grepInvert: /@visual/,
    },
    {
      name: 'tablet',
      use: { ...devices['iPad (gen 7)'] },
      grep: /@responsive|@smoke/,
    },
  ],

  /* Visual baselines live next to their specs and are committed. */
  snapshotPathTemplate: 'web/tests/visual/__snapshots__/{projectName}/{arg}{ext}',
});
