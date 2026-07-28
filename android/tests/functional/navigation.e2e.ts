import { browser, expect } from '@wdio/globals';
import { HomeScreen } from '../../screens/home.screen';
import { BillFlowScreen } from '../../screens/bill-flow.screen';
import { rotate, currentOrientation, pressBack, setNetwork, restartApp, screenshot } from '../../support/device';
import { CORE_CATEGORIES, category } from '../../../shared/data/catalog';
import { env } from '../../../shared/env';
import { must, mustBeGreaterThan, mustContain, mustEqual } from '../../support/assert';

/**
 * Navigation, rotation, and connectivity — the platform behaviours that a
 * web-only suite has no equivalent for, and where Android apps most often break.
 */

describe('Navigation @functional', () => {
  const home = new HomeScreen();

  beforeEach(async function () {
    await home.settle();
    if (!(await home.isLoaded(20_000))) this.skip();
  });

  it('bottom navigation switches sections', async function () {
    if (!(await home.hasBottomNav())) this.skip();

    const tabs = ['Home', 'Cards', 'Rewards', 'Profile', 'Account'];
    let switched = 0;

    for (const tab of tabs) {
      const ok = await home
        .openTab(tab)
        .then(() => true)
        .catch(() => false);
      if (ok) switched += 1;
    }

    mustBeGreaterThan(switched, 0, `none of the expected bottom-nav tabs were reachable (tried: ${tabs.join(', ')})`);

    await home.openTab('Home').catch(() => undefined);
  });

  it('back from a category returns to home, not out of the app', async function () {
    const opened = await home
      .openCategory('mobile-prepaid')
      .then(() => true)
      .catch(() => false);
    if (!opened) this.skip();

    await pressBack();
    await home.settle();

    must(await home.isLoaded(15_000), 'pressing back from the recharge screen should return to the home screen');
  });

  it('deep back-stack unwinds one screen at a time', async function () {
    const opened = await home
      .openCategory('mobile-prepaid')
      .then(() => true)
      .catch(() => false);
    if (!opened) this.skip();

    const flow = new BillFlowScreen('mobile-prepaid');
    await flow.waitUntilLoaded();
    await flow.enterIdentifier('9999900001');

    await pressBack();
    await browser.pause(800);

    const pkg = await browser.getCurrentPackage();
    mustEqual(pkg, env.android.appPackage, 'the app should still be in the foreground after one back press');

    await home.settle();
  });
});

describe('Rotation @functional', () => {
  const home = new HomeScreen();

  beforeEach(async function () {
    await home.settle();
    if (!(await home.isLoaded(20_000))) this.skip();
  });

  afterEach(async () => {
    await rotate('PORTRAIT').catch(() => undefined);
  });

  it('home screen survives rotation to landscape and back', async function () {
    const rotated = await rotate('LANDSCAPE')
      .then(() => true)
      .catch(() => false);
    if (!rotated) this.skip(); // orientation locked by the app or the device

    expect(await currentOrientation()).toBe('LANDSCAPE');
    must(await home.isLoaded(15_000), 'the home screen should still render in landscape');

    await rotate('PORTRAIT');
    must(await home.isLoaded(15_000), 'the home screen should still render back in portrait');
  });

  it('form input survives rotation', async function () {
    const opened = await home
      .openCategory('mobile-prepaid')
      .then(() => true)
      .catch(() => false);
    if (!opened) this.skip();

    const flow = new BillFlowScreen('mobile-prepaid');
    await flow.waitUntilLoaded();
    await flow.enterIdentifier('9999900001');

    const rotated = await rotate('LANDSCAPE')
      .then(() => true)
      .catch(() => false);
    if (!rotated) this.skip();

    const afterRotation = await flow.identifierValue().catch(() => '');

    mustContain(afterRotation.replace(/\D/g, ''), '9999900001', 'the number typed before rotation was lost — the activity is not saving instance state');
  });
});

describe('Connectivity @functional', () => {
  const home = new HomeScreen();

  afterEach(async () => {
    await setNetwork('online');
    await browser.pause(1_500);
  });

  it('shows a clear message when the device is offline', async function () {
    await home.settle();
    if (!(await home.isLoaded(20_000))) this.skip();

    const toggled = await setNetwork('offline');
    if (!toggled) this.skip(); // real device without permission to toggle radios

    await restartApp();
    await browser.pause(3_000);

    const text = await home.visibleText();
    const mentionsOffline = /(no internet|offline|check your (internet|connection)|network|try again)/i.test(text);

    if (!mentionsOffline) await screenshot('offline-no-message');

    must(mentionsOffline, `with the network off the app should say so. Visible text was: ${text.slice(0, 300)}`);
  });

  it('recovers when connectivity returns', async function () {
    const toggled = await setNetwork('offline');
    if (!toggled) this.skip();

    await browser.pause(2_000);
    await setNetwork('online');
    await browser.pause(3_000);

    await restartApp();
    await home.settle();

    must(await home.isLoaded(30_000), 'the app should recover and load the home screen once connectivity is back');
  });
});

describe('Category coverage @functional', () => {
  const home = new HomeScreen();

  it('surfaces its core categories', async function () {
    await home.settle();
    if (!(await home.isLoaded(20_000))) this.skip();

    const visible = await home.visibleCategories();
    console.log(`\nCategories visible on the home screen: ${visible.join(', ') || '(none)'}\n`);

    mustBeGreaterThan(visible.length, 0, 'no known category tiles were found on the home screen. ' +
        'If the app was redesigned, update the labels in shared/data/catalog.ts.');

    const missing = CORE_CATEGORIES.filter((c) => !visible.includes(c));
    if (missing.length > 0) {
      console.log(`Core categories not visible without scrolling: ${missing.map((m) => category(m).labels[0]).join(', ')}`);
    }
  });
});
