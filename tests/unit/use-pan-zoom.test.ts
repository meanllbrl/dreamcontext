/**
 * usePanZoom (dashboard/src/components/layout/usePanZoom.ts), the zoom and pan the full-screen
 * viewers share (2026-10-22): the arithmetic, and the two viewers' settings pinned so the picture
 * viewer behaves as it did before the hook was extracted from it (fit = contain, never below fit,
 * a plain wheel zooms) while the page viewer scrolls on a plain wheel and zooms 25-400 %.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clampPan, gestureScale, takesWheel, wheelAction, zoomAbout } from '../../dashboard/src/components/layout/usePanZoom.js';
import { snapSize } from '../../dashboard/src/components/sleepy/super/useStageDrag.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('usePanZoom\'s arithmetic', () => {
  it('zooming about a point keeps that point where it is', () => {
    const v = zoomAbout({ scale: 1, x: 0, y: 0 }, 2, 100, 50);
    // The point 100 px right of centre stays 100 px right of centre: 2·(100 − x') ... x' = −100.
    expect(v).toEqual({ scale: 2, x: -100, y: -50 });
    expect(zoomAbout(v, 1, 100, 50)).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it('pan stays inside the content; content smaller than the stage stays centred', () => {
    expect(clampPan({ scale: 1, x: 500, y: 500 }, { w: 400, h: 300 }, { w: 800, h: 600 })).toEqual({ scale: 1, x: 0, y: 0 });
    // A tall page (fit to width): vertical pan reaches its top and bottom at fit.
    expect(clampPan({ scale: 1, x: 40, y: 99999 }, { w: 800, h: 3000 }, { w: 800, h: 600 })).toEqual({ scale: 1, x: 0, y: 1200 });
    expect(clampPan({ scale: 2, x: 99999, y: -99999 }, { w: 800, h: 3000 }, { w: 800, h: 600 })).toEqual({ scale: 2, x: 400, y: -2700 });
  });

  it('a picture zooms on a plain wheel; a page scrolls on it; ctrl or cmd always zooms', () => {
    expect(wheelAction({ deltaX: 0, deltaY: 100, ctrlKey: false, metaKey: false }, 'zoom').kind).toBe('zoom');
    expect(wheelAction({ deltaX: 3, deltaY: 100, ctrlKey: false, metaKey: false }, 'pan')).toEqual({ kind: 'pan', dx: -3, dy: -100 });
    const pinch = wheelAction({ deltaX: 0, deltaY: -10, ctrlKey: true, metaKey: false }, 'pan');
    expect(pinch.kind).toBe('zoom');
    expect(pinch.kind === 'zoom' && pinch.factor).toBeGreaterThan(1);
    expect(wheelAction({ deltaX: 0, deltaY: 10, ctrlKey: false, metaKey: true }, 'pan').kind).toBe('zoom');
  });

  it('in place (`pinch`, owner 2026-10-22): only ctrl/cmd and a pinch zoom; a plain wheel scrolls the content until zoomed, then pans', () => {
    const plain = { deltaX: 2, deltaY: 50, ctrlKey: false, metaKey: false };
    expect(takesWheel(plain, 'pinch', 1, 1)).toBe(false);
    expect(takesWheel(plain, 'pinch', 1.5, 1)).toBe(true);
    expect(wheelAction(plain, 'pinch')).toEqual({ kind: 'pan', dx: -2, dy: -50 });
    expect(takesWheel({ ...plain, ctrlKey: true }, 'pinch', 1, 1)).toBe(true);
    expect(wheelAction({ ...plain, metaKey: true }, 'pinch').kind).toBe('zoom');
    // The full-screen viewers take every wheel, as before.
    for (const mode of ['zoom', 'pan'] as const) expect(takesWheel(plain, mode, 1, 1)).toBe(true);
  });

  it('a gesture\'s scale is from its start; nonsense asks for nothing', () => {
    expect(gestureScale(1.5, 2)).toBe(3);
    for (const bad of [0, -1, NaN, Infinity, '2', undefined]) expect(gestureScale(1, bad)).toBeNull();
  });
});

describe('the viewers\' settings', () => {
  const image = read('dashboard/src/components/layout/ImageViewer.tsx');
  const frame = read('dashboard/src/components/layout/FrameViewer.tsx');
  const hook = read('dashboard/src/components/layout/usePanZoom.ts');

  it('the picture viewer is as before: never below fit, a plain wheel zooms, + − 0 and double-click', () => {
    expect(image).toMatch(/usePanZoom\(\{ stageRef, content, stage, minScale: 1, maxScale, wheel: 'zoom', fit: FIT, enabled: !failed \}\)/);
    expect(image).toMatch(/const FIT: View = \{ scale: 1, x: 0, y: 0 \};/);
    expect(image).toMatch(/if \(e\.key === '\+' \|\| e\.key === '='\)/);
    expect(image).toMatch(/else if \(e\.key === '0'\) \{ e\.preventDefault\(\); setView\(FIT\); \}/);
    expect(image).toMatch(/onDoubleClick=/);
  });

  it('the page viewer scrolls on a plain wheel and zooms 25-400 %', () => {
    expect(frame).toMatch(/minScale: MIN_SCALE, maxScale: MAX_SCALE, wheel: 'pan'/);
    expect(frame).toMatch(/const MIN_SCALE = 0\.25;/);
    expect(frame).toMatch(/const MAX_SCALE = 4;/);
  });

  it('only the stage owns a pinch (never the bar or the close button), and it stops it', () => {
    for (const src of [image, frame]) {
      expect(src).toMatch(/ref=\{stageRef\}\s*\n\s*className="[a-z-]+-stage"\s*\n\s*data-pinch-owner="true"/);
      expect(src.match(/data-pinch-owner/g)?.length).toBe(1);
    }
    expect(hook).toMatch(/gestureStart\.current = viewRef\.current\.scale;/);
    expect(hook).not.toMatch(/let start = 1/);
    for (const t of ['onGestureStart', 'onGestureChange', 'onGestureEnd']) {
      expect(hook).toMatch(new RegExp(`const ${t} = \\(e: Event\\) => \\{\\s*e\\.preventDefault\\(\\);\\s*e\\.stopPropagation\\(\\);`));
    }
  });
});

describe('the corner handle snaps to a preset (useStageDrag snapSize)', () => {
  const tile = { width: 160, height: 160 };
  const all = () => true;
  it('grows away from the centre to the nearest preset that fits', () => {
    expect(snapSize(tile, 184, 0, 'right', all)).toBe('medium');
    expect(snapSize(tile, 184, 184, 'right', all)).toBe('large');
    expect(snapSize(tile, 368, 184, 'right', all)).toBe('wide');
    // On the left side the card grows to the left: a negative dx.
    expect(snapSize(tile, -184, 184, 'left', all)).toBe('large');
    expect(snapSize(tile, 184, 184, 'left', all)).toBe('small');
  });
  it('never offers a preset that does not fit: the nearest one that does', () => {
    expect(snapSize(tile, 368, 184, 'right', (s) => s !== 'wide')).toBe('large');
    expect(snapSize(tile, 368, 184, 'right', () => false)).toBe('small');
  });
});

describe('the card zoom (super/ZoomPane.tsx)', () => {
  const pane = read('dashboard/src/components/sleepy/super/ZoomPane.tsx');
  const card = read('dashboard/src/components/sleepy/super/SuperContainer.tsx');
  it('zooms in place 100-500 %, a plain wheel left to the content at fit, and owns its pinch', () => {
    expect(pane).toMatch(/usePanZoom\(\{ stageRef, content, stage, minScale: MIN_SCALE, maxScale: MAX_SCALE, wheel: 'pinch', fit: FIT \}\)/);
    expect(pane).toMatch(/const MIN_SCALE = 1;/);
    expect(pane).toMatch(/const MAX_SCALE = 5;/);
    // Only while it is in the owner's hands: a floating or parked pane leaves the pinch alone.
    expect(pane.match(/data-pinch-owner=\{interactive \? 'true' : undefined\}/g)?.length).toBe(1);
    // A bridge message counts only from a frame inside this pane.
    expect(pane).toMatch(/querySelectorAll\('iframe'\)\]\.find\(\(f\) => f\.contentWindow === event\.source\)/);
  });
  it('wraps a picture, a page and a live browser shown large; a page served by a server gets Inspect', () => {
    expect(card).toMatch(/c\.kind === 'image' \|\| c\.kind === 'web' \|\| c\.kind === 'browser'/);
    expect(card).toMatch(/<ZoomPane key=\{c\.id\}>\{viewFor\(p\)\}<\/ZoomPane>/);
    // A web card's pane: the bar and Inspect only for a page from a server; a project page carries
    // its zoom bridge in every state, so its srcdoc (and frame) never changes with the card.
    expect(card).toMatch(/const live = isLivePage\(c\);/);
    expect(card).toMatch(/<ZoomPane live=\{live\} interactive=\{p\.large\} control=\{live \? control : undefined\}>/);
    expect(card).toMatch(/control=\{live \? control : undefined\} zoomBridge=\{!live\} desktop=\{desktop\} \/>/);
    // …which is harmless while the card floats: the pane reads a bridge message only while
    // interactive (the card shown large).
    expect(pane).toMatch(/const onMessage = \(event: MessageEvent\) => \{\s*\n\s*if \(!interactive\) return;/);
  });
});
