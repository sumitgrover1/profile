import type { Page } from '@playwright/test';

/**
 * Field-realistic performance measurement.
 *
 * FreeCharge's audience is overwhelmingly on mid-range Android over mobile data,
 * so the budgets below are set for that, not for a desktop on office wifi.
 * Numbers come from the browser's own Performance APIs rather than a full
 * Lighthouse run, which keeps the suite fast enough to gate a PR.
 */

export interface WebVitals {
  /** Largest Contentful Paint, ms. */
  lcp: number | null;
  /** Cumulative Layout Shift, unitless. */
  cls: number | null;
  /** First Contentful Paint, ms. */
  fcp: number | null;
  /** Time to First Byte, ms. */
  ttfb: number | null;
  /** DOM Content Loaded, ms from navigation start. */
  domContentLoaded: number | null;
  /** Load event, ms from navigation start. */
  load: number | null;
  /** Longest task on the main thread, ms. */
  longestTask: number | null;
}

export interface ResourceProfile {
  totalBytes: number;
  totalRequests: number;
  byType: Record<string, { bytes: number; requests: number }>;
  slowest: { url: string; duration: number }[];
}

/**
 * Budgets, as the "needs improvement" thresholds from web.dev, loosened where a
 * production consumer site with ad tech realistically lands. Failing one of
 * these is a conversation, not necessarily a bug — which is why the perf specs
 * report every metric before asserting.
 */
export const BUDGETS = {
  lcp: 4_000,
  cls: 0.25,
  fcp: 3_000,
  ttfb: 1_800,
  load: 12_000,
  longestTask: 500,
  totalBytes: 6 * 1024 * 1024,
  totalRequests: 200,
} as const;

/**
 * Install the observers before navigation. LCP and CLS are only reported for
 * entries observed from the start of the page's life, so this has to run as an
 * init script rather than after load.
 */
export async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const store = {
      lcp: 0,
      cls: 0,
      longestTask: 0,
    };
    (window as unknown as { __vitals: typeof store }).__vitals = store;

    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          store.lcp = Math.max(store.lcp, entry.startTime);
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {
      /* unsupported in this browser */
    }

    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
          if (!shift.hadRecentInput) store.cls += shift.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {
      /* unsupported in this browser */
    }

    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          store.longestTask = Math.max(store.longestTask, entry.duration);
        }
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      /* unsupported in this browser */
    }
  });
}

export async function collect(page: Page): Promise<WebVitals> {
  return page.evaluate(() => {
    const vitals = (window as unknown as { __vitals?: { lcp: number; cls: number; longestTask: number } }).__vitals;
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const fcpEntry = performance.getEntriesByName('first-contentful-paint')[0];

    return {
      lcp: vitals && vitals.lcp > 0 ? Math.round(vitals.lcp) : null,
      cls: vitals ? Number(vitals.cls.toFixed(4)) : null,
      longestTask: vitals && vitals.longestTask > 0 ? Math.round(vitals.longestTask) : null,
      fcp: fcpEntry ? Math.round(fcpEntry.startTime) : null,
      ttfb: nav ? Math.round(nav.responseStart - nav.requestStart) : null,
      domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      load: nav ? Math.round(nav.loadEventEnd) : null,
    };
  });
}

/** Weight and request count, from the browser's resource timeline. */
export async function resourceProfile(page: Page): Promise<ResourceProfile> {
  return page.evaluate(() => {
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const byType: Record<string, { bytes: number; requests: number }> = {};
    let totalBytes = 0;

    for (const entry of entries) {
      const type = entry.initiatorType || 'other';
      const bytes = entry.transferSize || 0;
      byType[type] ??= { bytes: 0, requests: 0 };
      byType[type].bytes += bytes;
      byType[type].requests += 1;
      totalBytes += bytes;
    }

    const slowest = entries
      .map((e) => ({ url: e.name, duration: Math.round(e.duration) }))
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 10);

    return { totalBytes, totalRequests: entries.length, byType, slowest };
  });
}

export function formatVitals(vitals: WebVitals): string {
  const row = (label: string, value: number | null, unit: string, budget?: number) => {
    if (value === null) return `  ${label.padEnd(20)} n/a`;
    const verdict = budget !== undefined ? (value <= budget ? 'OK' : `OVER (budget ${budget}${unit})`) : '';
    return `  ${label.padEnd(20)} ${String(value).padStart(8)}${unit}  ${verdict}`;
  };

  return [
    row('TTFB', vitals.ttfb, 'ms', BUDGETS.ttfb),
    row('FCP', vitals.fcp, 'ms', BUDGETS.fcp),
    row('LCP', vitals.lcp, 'ms', BUDGETS.lcp),
    row('CLS', vitals.cls, '', BUDGETS.cls),
    row('DOMContentLoaded', vitals.domContentLoaded, 'ms'),
    row('Load', vitals.load, 'ms', BUDGETS.load),
    row('Longest task', vitals.longestTask, 'ms', BUDGETS.longestTask),
  ].join('\n');
}

export function formatResources(profile: ResourceProfile): string {
  const types = Object.entries(profile.byType)
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .map(([type, v]) => `    ${type.padEnd(12)} ${(v.bytes / 1024).toFixed(0).padStart(7)} KB  ${v.requests} req`)
    .join('\n');

  return (
    `  Total ${(profile.totalBytes / 1024 / 1024).toFixed(2)} MB across ${profile.totalRequests} requests\n` +
    `  By type:\n${types}`
  );
}

/** Emulate a mid-range device on a 4G connection, which is the median user. */
export async function throttleToMidRangeMobile(page: Page): Promise<void> {
  const client = await page.context().newCDPSession(page);
  await client.send('Network.enable');
  await client.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150,
    downloadThroughput: (4 * 1024 * 1024) / 8,
    uploadThroughput: (1 * 1024 * 1024) / 8,
  });
  await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
}
