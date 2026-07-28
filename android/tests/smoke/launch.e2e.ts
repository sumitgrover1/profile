import { browser, expect } from '@wdio/globals';
import { HomeScreen } from '../../screens/home.screen';
import { LoginScreen } from '../../screens/login.screen';
import { deviceInfo, restartApp, background, pressBack, screenshot } from '../../support/device';
import { env } from '../../../shared/env';
import { must, mustEqual } from '../../support/assert';

/**
 * Smoke: does the app launch, and does it survive the lifecycle events every
 * real user puts it through within the first minute?
 *
 * If these fail nothing else is worth running.
 */
describe('App launch @smoke', () => {
  const home = new HomeScreen();
  const login = new LoginScreen();

  before(async () => {
    const info = await deviceInfo();
    console.log(
      `\nDevice: Android ${info.platformVersion} (API ${info.deviceApiLevel}), ` +
        `${info.screen.width}×${info.screen.height}, package ${env.android.appPackage}\n`);
  });

  it('launches and lands on either the home screen or the login screen', async () => {
    await home.settle();

    const onHome = await home.isLoaded(20_000);
    const onLogin = await login.isShown(5_000);

    if (!onHome && !onLogin) {
      await screenshot('launch-unexpected-screen');
    }

    must(onHome || onLogin, `after launch the app showed neither home nor login. Visible text: ${(await home.visibleText()).slice(0, 300)}`);
  });

  it('runs the app under test, not something else', async () => {
    const pkg = await browser.getCurrentPackage();
    expect(pkg).toBe(env.android.appPackage);
  });

  it('does not crash on launch', async () => {
    await browser.pause(3_000);

    const pkg = await browser.getCurrentPackage();
    mustEqual(pkg, env.android.appPackage, `the app is no longer in the foreground three seconds after launch (now: ${pkg}) — it likely crashed`);
  });

  it('survives being backgrounded and resumed', async () => {
    await home.settle();
    const before = await browser.getCurrentPackage();

    await background(5);

    const after = await browser.getCurrentPackage();
    mustEqual(after, before, 'the app should return to the foreground after backgrounding');

    await home.settle();
    const stillUsable = (await home.isLoaded(15_000)) || (await login.isShown(5_000));
    must(stillUsable, 'the app should still show a usable screen after resuming');
  });

  it('survives a cold restart', async () => {
    await restartApp();
    await home.settle();

    const usable = (await home.isLoaded(25_000)) || (await login.isShown(8_000));
    must(usable, 'the app should present a usable screen after being killed and relaunched');
  });

  it('does not exit on the first back press from a sub-screen', async () => {
    await home.settle();
    const loaded = await home.isLoaded(15_000);
    if (!loaded) return; // not signed in; covered by the auth specs

    const opened = await home
      .openCategory('mobile-prepaid')
      .then(() => true)
      .catch(() => false);
    if (!opened) return;

    await pressBack();
    const pkg = await browser.getCurrentPackage();

    mustEqual(pkg, env.android.appPackage, 'pressing back from a sub-screen should return to the previous screen, not exit the app');
  });
});
