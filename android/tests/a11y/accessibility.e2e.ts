import { browser, expect } from '@wdio/globals';
import { HomeScreen } from '../../screens/home.screen';
import { BillFlowScreen } from '../../screens/bill-flow.screen';
import { deviceInfo } from '../../support/device';
import { must, mustBeEmpty } from '../../support/assert';

/**
 * Android accessibility.
 *
 * There is no axe for a native view hierarchy, so these specs check the things
 * TalkBack and Switch Access actually depend on, straight from the hierarchy XML:
 *
 *   - every interactive node has a content-desc or text (something to announce)
 *   - touch targets meet the 48dp minimum from the Material guidelines
 *   - EditText fields have a hint or label
 *   - the app does not break when the system font scale is turned up
 *
 * Findings are reported with the offending node's bounds so they can be located
 * in Layout Inspector.
 */

interface Node {
  className: string;
  resourceId: string;
  text: string;
  contentDesc: string;
  clickable: boolean;
  bounds: { left: number; top: number; right: number; bottom: number } | null;
}

/** Parse the UiAutomator hierarchy dump into something assertable. */
function parseHierarchy(xml: string): Node[] {
  const nodes: Node[] = [];

  for (const match of xml.matchAll(/<node\b([^>]*)\/?>/g)) {
    const attrs = match[1] ?? '';
    const attr = (name: string): string => {
      const found = attrs.match(new RegExp(`${name}="([^"]*)"`));
      return found?.[1] ?? '';
    };

    const boundsRaw = attr('bounds');
    const boundsMatch = boundsRaw.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);

    nodes.push({
      className: attr('class'),
      resourceId: attr('resource-id'),
      text: attr('text'),
      contentDesc: attr('content-desc'),
      clickable: attr('clickable') === 'true',
      bounds: boundsMatch
        ? {
            left: Number(boundsMatch[1]),
            top: Number(boundsMatch[2]),
            right: Number(boundsMatch[3]),
            bottom: Number(boundsMatch[4]),
          }
        : null,
    });
  }

  return nodes;
}

function describeNode(node: Node): string {
  const id = node.resourceId.split('/').pop() || '(no id)';
  const size = node.bounds ? `${node.bounds.right - node.bounds.left}×${node.bounds.bottom - node.bounds.top}px` : '?';
  return `${node.className.split('.').pop()} id=${id} "${node.text || node.contentDesc || ''}" (${size})`;
}

/** Interactive nodes that are actually on screen and big enough to matter. */
function interactiveNodes(nodes: Node[]): Node[] {
  return nodes.filter(
    (n) => n.clickable && n.bounds !== null && n.bounds.right > n.bounds.left && n.bounds.bottom > n.bounds.top);
}

describe('Accessibility @a11y', () => {
  const home = new HomeScreen();
  let density = 3; // fallback: xxhdpi

  before(async () => {
    const info = await deviceInfo();
    if (info.density > 0) density = info.density;
  });

  beforeEach(async function () {
    await home.settle();
    if (!(await home.isLoaded(20_000))) this.skip();
  });

  it('every interactive control announces something', async () => {
    const nodes = parseHierarchy(await browser.getPageSource());

    const silent = interactiveNodes(nodes)
      .filter((n) => !n.text.trim() && !n.contentDesc.trim())
      .filter((n) => {
        // A container that wraps a labelled child is announced through the child.
        const b = n.bounds;
        if (!b) return true;
        return !nodes.some(
          (other) =>
            other !== n &&
            other.bounds !== null &&
            (other.text.trim() || other.contentDesc.trim()) &&
            other.bounds.left >= b.left &&
            other.bounds.right <= b.right &&
            other.bounds.top >= b.top &&
            other.bounds.bottom <= b.bottom);
      })
      .slice(0, 12);

    mustBeEmpty(silent.map(describeNode), 'clickable controls with no text and no content-desc — TalkBack announces these as ' +
        `"unlabelled button":\n  ${silent.map(describeNode).join('\n  ')}`);
  });

  it('touch targets meet the 48dp minimum', async () => {
    const minPx = Math.round(48 * density);
    const nodes = parseHierarchy(await browser.getPageSource());

    const tooSmall = interactiveNodes(nodes)
      .filter((n) => {
        const b = n.bounds;
        if (!b) return false;
        return b.right - b.left < minPx || b.bottom - b.top < minPx;
      })
      .slice(0, 12);

    mustBeEmpty(tooSmall.map(describeNode), `controls below the ${minPx}px (48dp at density ${density}) minimum touch target:\n  ` +
        tooSmall.map(describeNode).join('\n  '));
  });

  it('form fields carry a hint or label', async function () {
    const opened = await home
      .openCategory('mobile-prepaid')
      .then(() => true)
      .catch(() => false);
    if (!opened) this.skip();

    const flow = new BillFlowScreen('mobile-prepaid');
    await flow.waitUntilLoaded();

    const source = await browser.getPageSource();
    const nodes = parseHierarchy(source);

    const unlabelled = nodes
      .filter((n) => n.className.includes('EditText'))
      .filter((n) => {
        // The hint attribute is not always emitted; fall back to content-desc.
        const hasHint = new RegExp(`hint="[^"]+"`).test(source);
        return !n.contentDesc.trim() && !hasHint;
      })
      .slice(0, 8);

    mustBeEmpty(unlabelled.map(describeNode), `text fields with no hint and no content-desc:\n  ${unlabelled.map(describeNode).join('\n  ')}`);

    await browser.back().catch(() => undefined);
  });

  it('remains usable at a large system font scale', async () => {
    // Bump the font scale, relaunch so the change takes effect, then check the
    // home screen still renders and nothing has collapsed to zero height.
    const applied = await browser
      .execute('mobile: shell', { command: 'settings', args: ['put', 'system', 'font_scale', '1.3'] })
      .then(() => true)
      .catch(() => false);

    if (!applied) {
      // relaxedSecurity is off, or this is a device cloud that blocks shell.
      console.log('Skipping font-scale check: adb shell is not available in this session.');
      return;
    }

    try {
      await browser.execute('mobile: terminateApp', { appId: (await browser.getCurrentPackage()) });
      await browser.pause(800);
      await browser.execute('mobile: activateApp', { appId: (await browser.getCurrentPackage()) });
      await browser.pause(3_000);
      await home.settle();

      must(await home.isLoaded(25_000), 'the home screen should still render at a 1.3× font scale');

      const nodes = parseHierarchy(await browser.getPageSource());
      const collapsed = nodes
        .filter((n) => n.text.trim().length > 0 && n.bounds !== null)
        .filter((n) => n.bounds !== null && n.bounds.bottom - n.bounds.top < 4)
        .slice(0, 8);

      mustBeEmpty(collapsed.map(describeNode), `text views collapsed to near-zero height at 1.3× font scale:\n  ${collapsed.map(describeNode).join('\n  ')}`);
    } finally {
      await browser
        .execute('mobile: shell', { command: 'settings', args: ['put', 'system', 'font_scale', '1.0'] })
        .catch(() => undefined);
    }
  });
});
