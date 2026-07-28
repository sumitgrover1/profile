import { browser } from '@wdio/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { env } from '../../shared/env';

/**
 * Device-level helpers: the things a mobile suite needs that a web suite does
 * not — rotation, backgrounding, the hardware back button, permission dialogs,
 * and network conditions.
 */

export type Orientation = 'PORTRAIT' | 'LANDSCAPE';

export async function rotate(orientation: Orientation): Promise<void> {
  await browser.setOrientation(orientation);
  await browser.pause(800); // let the relayout finish
}

export async function currentOrientation(): Promise<Orientation> {
  return (await browser.getOrientation()) as Orientation;
}

/** Hardware back. Returns the activity we landed on. */
export async function pressBack(): Promise<string> {
  await browser.back();
  await browser.pause(500);
  return browser.getCurrentActivity();
}

/** Send the app to the background for N seconds, then bring it back. */
export async function background(seconds: number): Promise<void> {
  await browser.execute('mobile: backgroundApp', { seconds });
  await browser.pause(500);
}

/** Kill and relaunch, keeping app data. Used to test state restoration. */
export async function restartApp(): Promise<void> {
  await browser.execute('mobile: terminateApp', { appId: env.android.appPackage });
  await browser.pause(500);
  await browser.execute('mobile: activateApp', { appId: env.android.appPackage });
  await browser.pause(1_500);
}

/** Clear app data — a true first-run state. */
export async function clearAppData(): Promise<void> {
  await browser.execute('mobile: clearApp', { appId: env.android.appPackage });
  await browser.pause(500);
}

export async function isKeyboardShown(): Promise<boolean> {
  return browser.isKeyboardShown().catch(() => false);
}

export async function hideKeyboard(): Promise<void> {
  if (await isKeyboardShown()) {
    await browser.hideKeyboard().catch(() => undefined);
    await browser.pause(300);
  }
}

/**
 * Airplane-mode style offline simulation.
 *
 * Emulator-only: real devices reject connection-type changes without system
 * permissions. Callers should treat a rejection as "skip the offline test"
 * rather than a failure.
 */
export async function setNetwork(state: 'online' | 'offline'): Promise<boolean> {
  const online = state === 'online';

  // Appium 2's UiAutomator2 extension is the reliable path on modern images.
  try {
    await browser.execute('mobile: setConnectivity', { wifi: online, data: online });
    await browser.pause(1_500);
    return true;
  } catch {
    /* fall through to the legacy JSONWP command */
  }

  try {
    // type 6 = wifi + data, type 1 = airplane mode
    await browser.setNetworkConnection({ type: online ? 6 : 1 });
    await browser.pause(1_500);
    return true;
  } catch {
    return false;
  }
}

/** Open a deep link, the way a push notification or an SMS link would. */
export async function openDeepLink(url: string): Promise<void> {
  await browser.execute('mobile: deepLink', {
    url,
    package: env.android.appPackage,
  });
  await browser.pause(2_000);
}

/**
 * Dump the current view hierarchy to artifacts/android/. This is the tool to
 * reach for when a selector chain has gone stale and you need to see what the
 * app is actually rendering.
 */
export async function dumpHierarchy(label: string): Promise<string> {
  const source = await browser.getPageSource();
  const dir = path.resolve(__dirname, '..', '..', 'artifacts', 'android', 'hierarchy');
  fs.mkdirSync(dir, { recursive: true });

  const file = path.join(dir, `${label.replace(/[^a-z0-9-]+/gi, '-')}.xml`);
  fs.writeFileSync(file, source, 'utf8');
  return file;
}

export async function screenshot(label: string): Promise<string> {
  const dir = path.resolve(__dirname, '..', '..', 'artifacts', 'android', 'screenshots');
  fs.mkdirSync(dir, { recursive: true });

  const file = path.join(dir, `${label.replace(/[^a-z0-9-]+/gi, '-')}.png`);
  await browser.saveScreenshot(file);
  return file;
}

export interface DeviceInfo {
  platformVersion: string;
  deviceApiLevel: number;
  screen: { width: number; height: number };
  density: number;
  locale: string;
}

export async function deviceInfo(): Promise<DeviceInfo> {
  const caps = browser.capabilities as Record<string, unknown>;
  const size = await browser.getWindowSize();

  return {
    platformVersion: String(caps['platformVersion'] ?? 'unknown'),
    deviceApiLevel: Number(caps['deviceApiLevel'] ?? 0),
    screen: { width: size.width, height: size.height },
    density: Number(caps['pixelRatio'] ?? 0),
    locale: String(caps['locale'] ?? 'unknown'),
  };
}

/** Scroll down within a scrollable container until `predicate` is satisfied. */
export async function scrollUntil(
  predicate: () => Promise<boolean>,
  maxSwipes = 8,
): Promise<boolean> {
  for (let i = 0; i < maxSwipes; i += 1) {
    if (await predicate()) return true;
    await swipe('up');
  }
  return predicate();
}

export async function swipe(direction: 'up' | 'down' | 'left' | 'right'): Promise<void> {
  const { width, height } = await browser.getWindowSize();
  const midX = Math.round(width / 2);
  const midY = Math.round(height / 2);

  const distance = { x: Math.round(width * 0.35), y: Math.round(height * 0.35) };
  const from = { x: midX, y: midY };
  const to = { ...from };

  if (direction === 'up') to.y = midY - distance.y;
  if (direction === 'down') to.y = midY + distance.y;
  if (direction === 'left') to.x = midX - distance.x;
  if (direction === 'right') to.x = midX + distance.x;

  await browser.performActions([
    {
      type: 'pointer',
      id: 'finger1',
      parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, x: from.x, y: from.y },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 100 },
        { type: 'pointerMove', duration: 400, x: to.x, y: to.y },
        { type: 'pointerUp', button: 0 },
      ],
    },
  ]);

  await browser.releaseActions();
  await browser.pause(400);
}
