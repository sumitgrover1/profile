import * as fs from 'node:fs';
import * as path from 'node:path';
import { env } from '../../shared/env';

/**
 * WebdriverIO + Appium configuration for the FreeCharge Pay Bills Android app.
 *
 * Two ways to point this at a build:
 *
 *   ANDROID_APP_PATH=/path/to/freecharge.apk   install and test that APK
 *   (unset)                                    attach to the already-installed
 *                                              ANDROID_APP_PACKAGE on the device
 *
 * The second is the right default for a first run: install the app from the Play
 * Store on an emulator, sign in by hand once, then run the suite against that
 * installed state with ANDROID_NO_RESET=true.
 */

const artifactsDir = path.resolve(__dirname, '..', '..', 'artifacts', 'android');
fs.mkdirSync(artifactsDir, { recursive: true });

const hasApk = env.android.appPath.length > 0;
if (hasApk && !fs.existsSync(env.android.appPath)) {
  throw new Error(`ANDROID_APP_PATH points at a file that does not exist: ${env.android.appPath}`);
}

export const config: WebdriverIO.Config = {
  runner: 'local',
  /* WDIO v9 compiles TypeScript specs itself; it only needs to be told which
   * tsconfig to use, since this one lives at the repo root rather than beside
   * the config. */
  tsConfigPath: path.resolve(__dirname, '..', '..', 'tsconfig.json'),

  specs: [path.resolve(__dirname, '..', 'tests', '**', '*.e2e.ts')],
  exclude: [path.resolve(__dirname, '..', 'tools', '**', '*.e2e.ts')],

  /* One device, one session. Parallelising Appium against a single emulator
   * causes more flake than it saves in wall-clock. Scale out with more
   * emulators and more workers, not with more sessions per device. */
  maxInstances: 1,

  capabilities: [
    {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:deviceName': env.android.deviceName,
      ...(env.android.platformVersion ? { 'appium:platformVersion': env.android.platformVersion } : {}),
      ...(env.android.udid ? { 'appium:udid': env.android.udid } : {}),

      ...(hasApk
        ? { 'appium:app': path.resolve(env.android.appPath) }
        : {
            'appium:appPackage': env.android.appPackage,
            ...(env.android.appActivity ? { 'appium:appActivity': env.android.appActivity } : {}),
          }),

      'appium:noReset': env.android.noReset,
      'appium:fullReset': env.android.fullReset,

      /* Let the driver dismiss the OS-level permission dialogs that would
       * otherwise block every single spec. In-app prompts are still handled
       * explicitly by BaseScreen.settle(). */
      'appium:autoGrantPermissions': true,

      'appium:newCommandTimeout': 300,
      'appium:adbExecTimeout': 60_000,
      'appium:uiautomator2ServerLaunchTimeout': 90_000,
      'appium:uiautomator2ServerInstallTimeout': 90_000,
      'appium:androidInstallTimeout': 180_000,

      /* Use a Unicode-capable keyboard so tests can type non-ASCII input, and
       * reset it afterwards so the device is left as it was found. */
      'appium:unicodeKeyboard': true,
      'appium:resetKeyboard': true,

      /* Keeps the hierarchy small enough to query quickly on a busy screen. */
      'appium:disableWindowAnimation': true,
      'appium:ignoreHiddenApiPolicyError': true,
    },
  ],

  logLevel: env.ci ? 'warn' : 'info',
  outputDir: path.join(artifactsDir, 'logs'),
  bail: 0,
  baseUrl: '',
  waitforTimeout: 15_000,
  connectionRetryTimeout: 180_000,
  connectionRetryCount: 2,

  hostname: env.android.appiumHost,
  port: env.android.appiumPort,
  path: '/',

  /* Starts a local Appium server for the run. Drop this service and point
   * hostname/port at a grid to run against a device cloud instead. */
  services: [
    [
      'appium',
      {
        args: {
          address: env.android.appiumHost,
          port: env.android.appiumPort,
          relaxedSecurity: true,
          log: path.join(artifactsDir, 'logs', 'appium.log'),
        },
        logPath: path.join(artifactsDir, 'logs'),
      },
    ],
  ],

  framework: 'mocha',
  mochaOpts: {
    ui: 'bdd',
    timeout: 180_000,
  },

  reporters: [
    'spec',
    [
      'allure',
      {
        outputDir: path.join(artifactsDir, 'allure-results'),
        disableWebdriverStepsReporting: false,
        disableWebdriverScreenshotsReporting: false,
      },
    ],
  ],

  /**
   * Zero implicit wait on purpose. The candidate resolver in
   * android/support/resolver.ts does all the waiting; a non-zero implicit wait
   * would make every failed candidate probe block for its full duration.
   */
  before: async () => {
    await browser.setTimeout({ implicit: 0 });
  },

  /** Capture a screenshot and the view hierarchy for anything that fails. */
  afterTest: async function (test, _context, { passed }) {
    if (passed) return;

    const label = `${test.parent}-${test.title}`.replace(/[^a-z0-9-]+/gi, '-').slice(0, 120);

    const shotDir = path.join(artifactsDir, 'screenshots');
    fs.mkdirSync(shotDir, { recursive: true });
    await browser.saveScreenshot(path.join(shotDir, `${label}.png`)).catch(() => undefined);

    const hierarchyDir = path.join(artifactsDir, 'hierarchy');
    fs.mkdirSync(hierarchyDir, { recursive: true });
    const source = await browser.getPageSource().catch(() => '');
    if (source) {
      fs.writeFileSync(path.join(hierarchyDir, `${label}.xml`), source, 'utf8');
    }
  },
};
