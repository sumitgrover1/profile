import { browser } from '@wdio/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ALL_ANDROID_ELEMENTS } from '../support/elements';
import { auditAndroidCandidates } from '../support/resolver';
import type { AndroidElementSpec } from '../support/selectors';
import { HomeScreen } from '../screens/home.screen';
import { dumpHierarchy } from '../support/device';
import { env } from '../../shared/env';

/**
 * Android selector verification.
 *
 * Walks the app through its main screens and reports, for every element in
 * android/support/elements.ts, which candidates match the live view hierarchy.
 *
 *     npm run verify:selectors:android
 *
 * Run this first, against a real build. The chains in the element map were
 * authored from the app's feature set rather than from a hierarchy dump, so
 * expect to fix some of them — that is what this tool is for, and fixing them
 * touches one file.
 *
 * It also writes the full hierarchy of each screen to
 * artifacts/android/hierarchy/, which is what you want open in a second window
 * while repairing a chain.
 */

interface Row {
  element: string;
  optional: boolean;
  status: 'OK' | 'AMBIG' | 'MISS';
  candidates: { candidate: string; matches: number }[];
}

function classify(candidates: { matches: number }[], optional: boolean): Row['status'] {
  if (candidates.some((c) => c.matches === 1)) return 'OK';
  if (candidates.some((c) => c.matches > 1)) return 'AMBIG';
  return optional ? 'OK' : 'MISS';
}

async function audit(prefix: string, context: string): Promise<Row[]> {
  const rows: Row[] = [];

  const specs = Object.entries(ALL_ANDROID_ELEMENTS).filter(([key]) => key.startsWith(prefix)) as [
    string,
    AndroidElementSpec,
  ][];

  for (const [name, spec] of specs) {
    const candidates = await auditAndroidCandidates(spec);
    rows.push({
      element: `${context}::${name}`,
      optional: spec.optional ?? false,
      status: classify(candidates, spec.optional ?? false),
      candidates,
    });
  }

  return rows;
}

function render(rows: Row[]): string {
  const lines: string[] = [];

  for (const row of rows) {
    lines.push(`${row.status.padEnd(6)} ${row.element}${row.optional ? ' (optional)' : ''}`);
    for (const c of row.candidates) {
      const verdict = c.matches === -1 ? 'invalid selector' : c.matches === 0 ? 'no match' : `${c.matches} node(s)`;
      const marker = c.matches === 1 ? '✔' : c.matches > 1 ? '~' : ' ';
      lines.push(`         ${marker} ${c.candidate.padEnd(56)} ${verdict}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

describe('Selector audit @tooling', () => {
  const home = new HomeScreen();
  const rows: Row[] = [];

  it('audits the launch / onboarding screen', async () => {
    await browser.pause(2_000);
    await dumpHierarchy('audit-launch');
    rows.push(...(await audit('onboarding.', 'launch')));
    rows.push(...(await audit('auth.', 'launch')));
  });

  it('audits the home screen', async () => {
    await home.settle();
    const loaded = await home.isLoaded(25_000);

    await dumpHierarchy('audit-home');

    if (!loaded) {
      rows.push({
        element: 'home::(screen unreachable)',
        optional: false,
        status: 'MISS',
        candidates: [{ candidate: 'home screen did not load — is the app signed in?', matches: 0 }],
      });
      return;
    }

    rows.push(...(await audit('home.', 'home')));
  });

  it('audits the recharge flow', async () => {
    const opened = await home
      .openCategory('mobile-prepaid')
      .then(() => true)
      .catch(() => false);

    if (!opened) {
      rows.push({
        element: 'bill::(flow unreachable)',
        optional: false,
        status: 'MISS',
        candidates: [{ candidate: 'could not open the mobile prepaid category', matches: 0 }],
      });
      return;
    }

    await browser.pause(2_000);
    await dumpHierarchy('audit-recharge');
    rows.push(...(await audit('bill.', 'recharge')));

    await browser.back().catch(() => undefined);
  });

  it('audits the account section', async () => {
    await home.settle();
    const opened = await home
      .openTab('Profile')
      .then(() => true)
      .catch(() => false);

    if (opened) {
      await browser.pause(1_500);
      await dumpHierarchy('audit-account');
    }

    rows.push(...(await audit('account.', 'account')));
  });

  after(() => {
    const misses = rows.filter((r) => r.status === 'MISS');
    const ambiguous = rows.filter((r) => r.status === 'AMBIG');

    const summary =
      `\nAndroid selector audit — package ${env.android.appPackage}\n` +
      `${'='.repeat(74)}\n\n${render(rows)}\n` +
      `${'='.repeat(74)}\n` +
      `${rows.length} element(s) checked: ` +
      `${rows.length - misses.length - ambiguous.length} OK, ${ambiguous.length} ambiguous, ${misses.length} missing\n` +
      (misses.length > 0
        ? '\nStale chains to fix in android/support/elements.ts:\n' +
          misses.map((m) => `  - ${m.element}`).join('\n') +
          '\n\nHierarchy dumps for each screen are in artifacts/android/hierarchy/.\n'
        : '\nEvery chain resolved. The suite is safe to run against this build.\n');

    console.log(summary);

    const outDir = path.resolve(__dirname, '..', '..', 'artifacts', 'android');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'android-selector-audit.txt'), summary, 'utf8');
  });
});
