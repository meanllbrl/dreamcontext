/**
 * The page viewer's zoom bridge (layout/frameZoomBridge.ts): the page in "Click" mode posts its
 * wheel and pinch to the parent. The page's own scripts can post the same shapes, so the parent
 * reads only known shapes with finite, clamped numbers (and FrameViewer only from its frame's
 * own window).
 */
import { describe, it, expect } from 'vitest';
import { ZOOM_BRIDGE, ZOOM_MESSAGE_KEY, readZoomMessage } from '../../dashboard/src/components/layout/frameZoomBridge.js';

const msg = (m: unknown) => ({ [ZOOM_MESSAGE_KEY]: m });

describe('readZoomMessage', () => {
  it('reads a wheel and a pinch', () => {
    expect(readZoomMessage(msg({ kind: 'wheel', dx: 0, dy: 40, ctrl: false, x: 10, y: 20 }))).toEqual({ kind: 'wheel', dx: 0, dy: 40, ctrl: false, x: 10, y: 20 });
    expect(readZoomMessage(msg({ kind: 'gesture', phase: 'change', scale: 1.5, x: 1, y: 2 }))).toEqual({ kind: 'gesture', phase: 'change', scale: 1.5, x: 1, y: 2 });
  });

  it('reads Esc pressed inside the page (it closes the viewer)', () => {
    expect(readZoomMessage(msg({ kind: 'escape' }))).toEqual({ kind: 'escape' });
    expect(ZOOM_BRIDGE).toContain("if (e.key === 'Escape') post({ kind: 'escape' });");
  });

  it('reads a double click inside the page (a card zoomed in place fits on it)', () => {
    expect(readZoomMessage(msg({ kind: 'dblclick', x: 4, y: 5 }))).toEqual({ kind: 'dblclick', x: 4, y: 5 });
    expect(readZoomMessage(msg({ kind: 'dblclick', x: 'a', y: 5 }))).toBeNull();
    expect(ZOOM_BRIDGE).toContain("post({ kind: 'dblclick', x: e.clientX, y: e.clientY });");
  });

  it('clamps what it reads', () => {
    expect(readZoomMessage(msg({ kind: 'gesture', phase: 'change', scale: 1e9, x: 0, y: 0 }))).toMatchObject({ scale: 10 });
    expect(readZoomMessage(msg({ kind: 'wheel', dx: -1e12, dy: 1e12, ctrl: true, x: 0, y: 0 }))).toMatchObject({ dx: -100000, dy: 100000 });
  });

  it('ignores anything else', () => {
    for (const bad of [
      null, 'x', 42, {}, { other: 1 }, msg(null), msg('wheel'),
      msg({ kind: 'wheel', dx: NaN, dy: 0, ctrl: false, x: 0, y: 0 }),
      msg({ kind: 'wheel', dx: 0, dy: 0, ctrl: 'yes', x: 0, y: 0 }),
      msg({ kind: 'wheel', dx: 0, dy: 0, ctrl: false, x: Infinity, y: 0 }),
      msg({ kind: 'gesture', phase: 'begin', scale: 1, x: 0, y: 0 }),
      msg({ kind: 'gesture', phase: 'change', scale: '2', x: 0, y: 0 }),
      msg({ kind: 'navigate', href: 'https://example.com', x: 0, y: 0 }),
    ]) expect(readZoomMessage(bad)).toBeNull();
  });

  it('the script stops the page zooming itself on ctrl/cmd + wheel and posts to its parent only', () => {
    expect(ZOOM_BRIDGE).toContain('if (e.ctrlKey || e.metaKey) e.preventDefault();');
    expect(ZOOM_BRIDGE).toContain(`parent.postMessage({ ${ZOOM_MESSAGE_KEY}: m }, '*')`);
    expect(ZOOM_BRIDGE).not.toMatch(/fetch|XMLHttpRequest|location/);
  });
});
