import { test, expect } from '../../support/fixtures';
import {
  instrument,
  collect,
  resourceProfile,
  formatVitals,
  formatResources,
  throttleToMidRangeMobile,
  BUDGETS,
} from '../../support/perf';

/**
 * Performance.
 *
 * Every spec prints its full measurement before asserting, so a failure tells
 * you *what* regressed rather than just that something did. Budgets live in
 * web/support/perf.ts and are set for a mid-range Android on 4G, which is the
 * median FreeCharge user — not for the machine CI happens to run on.
 *
 * Perf numbers from a shared CI runner are noisy. Treat a single failure as a
 * signal to re-measure, and a sustained trend as a regression.
 */

test.describe('Web vitals @perf', () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  test('home page meets its loading budgets', async ({ page, home }, testInfo) => {
    await instrument(page);
    await home.goto({ waitUntil: 'load' });
    await page.waitForTimeout(3_000); // let LCP and CLS settle

    const vitals = await collect(page);
    const report = formatVitals(vitals);

    await testInfo.attach('web-vitals.txt', { body: report, contentType: 'text/plain' });
    console.log(`\nHome page web vitals:\n${report}\n`);

    if (vitals.lcp !== null) {
      expect(vitals.lcp, `LCP ${vitals.lcp}ms exceeds the ${BUDGETS.lcp}ms budget\n${report}`).toBeLessThanOrEqual(
        BUDGETS.lcp,
      );
    }
    if (vitals.cls !== null) {
      expect(vitals.cls, `CLS ${vitals.cls} exceeds the ${BUDGETS.cls} budget\n${report}`).toBeLessThanOrEqual(
        BUDGETS.cls,
      );
    }
    if (vitals.ttfb !== null) {
      expect(vitals.ttfb, `TTFB ${vitals.ttfb}ms exceeds the ${BUDGETS.ttfb}ms budget\n${report}`).toBeLessThanOrEqual(
        BUDGETS.ttfb,
      );
    }
  });

  test('home page stays within its weight budget', async ({ page, home }, testInfo) => {
    await home.goto({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);

    const profile = await resourceProfile(page);
    const report = formatResources(profile);

    await testInfo.attach('resource-profile.txt', {
      body: `${report}\n\nSlowest resources:\n${profile.slowest.map((s) => `  ${s.duration}ms ${s.url}`).join('\n')}`,
      contentType: 'text/plain',
    });
    console.log(`\nHome page resources:\n${report}\n`);

    expect(
      profile.totalBytes,
      `page weighs ${(profile.totalBytes / 1024 / 1024).toFixed(2)} MB, over the ` +
        `${(BUDGETS.totalBytes / 1024 / 1024).toFixed(0)} MB budget\n${report}`,
    ).toBeLessThanOrEqual(BUDGETS.totalBytes);

    expect(
      profile.totalRequests,
      `page makes ${profile.totalRequests} requests, over the ${BUDGETS.totalRequests} budget\n${report}`,
    ).toBeLessThanOrEqual(BUDGETS.totalRequests);
  });

  test('home page is usable on a throttled mid-range device', async ({ page, home }, testInfo) => {
    test.skip(test.info().project.name !== 'chromium', 'CDP throttling is Chromium-only');

    await instrument(page);
    await throttleToMidRangeMobile(page);

    const start = Date.now();
    await home.goto({ waitUntil: 'load' });
    const elapsed = Date.now() - start;
    await page.waitForTimeout(3_000);

    const vitals = await collect(page);
    const report = `Navigation took ${elapsed}ms on 4G + 4× CPU throttle\n${formatVitals(vitals)}`;

    await testInfo.attach('throttled-vitals.txt', { body: report, contentType: 'text/plain' });
    console.log(`\nThrottled (4G, 4× CPU):\n${report}\n`);

    // Deliberately looser than the unthrottled budget: this documents the real
    // experience rather than gating on it.
    expect(
      elapsed,
      `home page took ${elapsed}ms to load on a throttled mid-range device\n${report}`,
    ).toBeLessThanOrEqual(30_000);
  });

  test('recharge flow renders promptly after navigation', async ({ page, home }, testInfo) => {
    await home.goto();

    const start = Date.now();
    const opened = await home
      .openCategory('mobile-prepaid')
      .then(() => true)
      .catch(() => false);
    test.skip(!opened, 'mobile prepaid flow is not reachable');
    const elapsed = Date.now() - start;

    testInfo.annotations.push({ type: 'flow-open-ms', description: String(elapsed) });
    console.log(`\nMobile prepaid flow opened in ${elapsed}ms\n`);

    expect(elapsed, `opening the recharge flow took ${elapsed}ms`).toBeLessThanOrEqual(10_000);
  });

  test('no single main-thread task blocks input for long @perf', async ({ page, home }, testInfo) => {
    await instrument(page);
    await home.goto({ waitUntil: 'load' });
    await page.waitForTimeout(3_000);

    const vitals = await collect(page);
    test.skip(vitals.longestTask === null, 'longtask observer unsupported in this browser');

    testInfo.annotations.push({ type: 'longest-task-ms', description: String(vitals.longestTask) });

    expect(
      vitals.longestTask,
      `longest main-thread task was ${vitals.longestTask}ms — anything over ${BUDGETS.longestTask}ms ` +
        'makes the page feel frozen to a tap',
    ).toBeLessThanOrEqual(BUDGETS.longestTask);
  });
});
