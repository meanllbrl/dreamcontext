/**
 * A web page's phone / tablet / desktop width (owner 2026-10-27) and the honest Inspect: the
 * element picker exists only in a page carrying the bridge; a site on the web gets the shield,
 * named for what it does, and says why there is no picking.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEVICE_WIDTH, MAX_REMEMBERED, deviceFit, isWebDevice, withDevice } from '../../dashboard/src/lib/webDevice.js';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('deviceFit', () => {
  it('no device, or no box yet: the page fills its box', () => {
    expect(deviceFit(null, { w: 700, h: 500 })).toBeNull();
    expect(deviceFit('phone', null)).toBeNull();
    expect(deviceFit('phone', { w: 0, h: 500 })).toBeNull();
  });
  it('the widths are a phone, a tablet and a desktop', () => {
    expect(DEVICE_WIDTH).toEqual({ phone: 390, tablet: 820, desktop: 1440 });
  });
  it('a desktop in a 720 px card: laid out at 1440, drawn at half, as tall as the card', () => {
    const f = deviceFit('desktop', { w: 720, h: 500 })!;
    expect(f).toEqual({ w: 1440, h: 1000, scale: 0.5 });
    expect(f.h * f.scale).toBe(500);
  });
  it('a phone in a wider card is never scaled up: its real size, the card\'s height', () => {
    expect(deviceFit('phone', { w: 720, h: 500 })).toEqual({ w: 390, h: 500, scale: 1 });
  });
  it('a tablet just wider than the card fits it exactly', () => {
    const f = deviceFit('tablet', { w: 738, h: 600 })!;
    expect(f.w * f.scale).toBeCloseTo(738, 6);
  });
});

describe('the remembered choice', () => {
  it('per card, newest last; null forgets; never more than the cap', () => {
    let s = withDevice([], 'a', 'phone');
    s = withDevice(s, 'b', 'desktop');
    s = withDevice(s, 'a', 'tablet');
    expect(s).toEqual([['b', 'desktop'], ['a', 'tablet']]);
    expect(withDevice(s, 'b', null)).toEqual([['a', 'tablet']]);
    let big: ReturnType<typeof withDevice> = [];
    for (let i = 0; i < MAX_REMEMBERED + 10; i += 1) big = withDevice(big, `c${i}`, 'phone');
    expect(big.length).toBe(MAX_REMEMBERED);
    expect(big[0][0]).toBe('c10');
  });
  it('reads only the three devices', () => {
    expect(isWebDevice('phone')).toBe(true);
    expect(isWebDevice('watch')).toBe(false);
  });
});

describe('wiring', () => {
  const pane = read('dashboard/src/components/sleepy/super/ZoomPane.tsx');
  const card = read('dashboard/src/components/sleepy/super/SuperContainer.tsx');
  const widget = read('dashboard/src/components/whiteboard/widgets/WebWidget.tsx');
  const viewer = read('dashboard/src/components/layout/FrameViewer.tsx');
  it('the button picks only in a bridged page; elsewhere it is the shield and says why', () => {
    expect(pane).toMatch(/\{picker \? t\('super\.zoom\.pick'\) : t\('super\.zoom\.pan'\)\}/);
    expect(pane).toMatch(/live && inspect && !picker && !control\?\.proxied && !askClear && \(\s*<p className="super-zoom-note"/);
    expect(pane).not.toMatch(/t\('super\.zoom\.inspect'\)/);
  });
  it('the card, its frame and its full-screen view share one device choice', () => {
    expect(card).toMatch(/const \[device, setDevice\] = useWebDevice\(c\.id\);/);
    expect(card).toMatch(/<ZoomPane live interactive=\{p\.large\} control=\{control\} device=\{device\} onDevice=\{setDevice\}>/);
    expect(card).toMatch(/control=\{control\} device=\{device\} \/><\/div>/);
    // The one frame every web card draws (the board's widget too) sits in the device box.
    expect(widget).toMatch(/const box = useDeviceBox\(device\);/);
    expect(widget).toMatch(/style=\{box\.frameStyle\}/);
    expect(viewer).toMatch(/useWebDevice\(deviceKey \?\? null\)/);
    expect(read('dashboard/src/components/sleepy/super/SuperSurface.tsx')).toMatch(/<CardFullscreenView subject=\{full\.subject\} cardId=\{full\.id\}/);
  });
});
