/**
 * Unit tests for per-board isolation of an Excalidraw viewport
 * (`dashboard/src/lib/excalidraw.ts` + `dashboard/src/lib/excalidrawPinch.ts`).
 *
 * The regression these lock down: every board in the app rendered under the literal React
 * key `'board'` (`slug ?? 'board'`, and the Chat transcript passes no slug), so swapping the
 * board inside one slot REUSED the mounted canvas — which freezes its scene at mount and
 * owns its viewport for life, meaning the second board inherited the first board's zoom.
 * Separately, Excalidraw 0.18 drives WebKit's pinch from module-level state shared by every
 * mounted editor, so one pinch zoomed every board on the page to the same scale.
 */
import { describe, it, expect } from 'vitest';
import { boardInstanceKey } from '../../dashboard/src/lib/excalidraw.js';
import {
  normalizeBoardZoom, zoomAroundPoint, resolvePinchTarget,
  MIN_BOARD_ZOOM, MAX_BOARD_ZOOM,
  type BoardViewport,
} from '../../dashboard/src/lib/excalidrawPinch.js';

describe('boardInstanceKey', () => {
  it('gives two different boards two different identities', () => {
    expect(boardInstanceKey('a/one.excalidraw.md')).not.toBe(boardInstanceKey('b/two.excalidraw.md'));
  });

  it('is stable for the same board across renders', () => {
    expect(boardInstanceKey('a/one.excalidraw.md')).toBe(boardInstanceKey('a/one.excalidraw.md'));
  });

  it('separates a board from its own full-screen copy', () => {
    // Two live mounts of one board must not share a key either, or opening full screen
    // would hand the overlay the card's canvas (and its zoom) instead of a fresh fit.
    const p = 'a/one.excalidraw.md';
    expect(boardInstanceKey(p)).not.toBe(boardInstanceKey(`${p}#full`));
  });

  it('falls back to a usable key rather than an empty one', () => {
    // An empty key is not "no key" to React — it is a key every anonymous board shares,
    // i.e. exactly the bug. The fallback is explicit so it can never be reached by accident.
    for (const empty of [undefined, null, '', '   ']) {
      expect(boardInstanceKey(empty)).toBe('board');
    }
  });
});

describe('normalizeBoardZoom', () => {
  it('clamps to Excalidraw’s own bounds', () => {
    expect(normalizeBoardZoom(0.0001)).toBe(MIN_BOARD_ZOOM);
    expect(normalizeBoardZoom(1e6)).toBe(MAX_BOARD_ZOOM);
  });

  it('sends any non-finite scale to the floor rather than propagating NaN into scroll math', () => {
    // The finite check runs BEFORE the clamp, so Infinity lands on the floor too — not on
    // MAX. Unreachable from a real gesture (`scale` is a ratio of touch distances); what
    // matters is that no non-number escapes into zoomAroundPoint's arithmetic, where a
    // single NaN would poison scrollX/scrollY and blank the board.
    expect(normalizeBoardZoom(Number.NaN)).toBe(MIN_BOARD_ZOOM);
    expect(normalizeBoardZoom(Number.POSITIVE_INFINITY)).toBe(MIN_BOARD_ZOOM);
  });

  it('passes an ordinary zoom through', () => {
    expect(normalizeBoardZoom(1.5)).toBe(1.5);
  });
});

describe('zoomAroundPoint', () => {
  const state: BoardViewport = {
    scrollX: 0, scrollY: 0, offsetLeft: 0, offsetTop: 0, zoom: { value: 1 },
  };

  it('holds the scene point under the fingers still', () => {
    // The anchor is what makes a pinch feel pinned instead of drifting: the scene
    // coordinate under (x, y) must be the same before and after the zoom.
    const sceneAt = (s: { scrollX: number; scrollY: number; zoom: { value: number } }, vx: number) =>
      vx / s.zoom.value - s.scrollX;
    const before = sceneAt(state, 300);
    const after = zoomAroundPoint(state, 300, 200, 2);
    expect(sceneAt({ ...after }, 300)).toBeCloseTo(before, 6);
  });

  it('reports the zoom it was asked for', () => {
    expect(zoomAroundPoint(state, 10, 10, 2.5).zoom).toEqual({ value: 2.5 });
  });

  it('is a no-op at the same zoom', () => {
    const patch = zoomAroundPoint(state, 120, 90, 1);
    expect(patch.scrollX).toBeCloseTo(0, 6);
    expect(patch.scrollY).toBeCloseTo(0, 6);
  });
});

describe('resolvePinchTarget', () => {
  const board = (name: string) => ({ name, el: { contains: (n: Node) => (n as unknown as { owner: string }).owner === name } });
  const node = (owner: string) => ({ owner }) as unknown as Node;

  it('routes a gesture to the ONE board under the fingers', () => {
    const a = board('a');
    const b = board('b');
    expect(resolvePinchTarget([a, b], node('b'))).toBe(b);
  });

  it('routes a gesture over page chrome to NO board', () => {
    // The case that cannot be solved with a listener per wrapper, and the reason a pinch
    // over the transcript must not move the boards sitting in it.
    expect(resolvePinchTarget([board('a'), board('b')], node('elsewhere'))).toBeNull();
  });

  it('handles a null target', () => {
    expect(resolvePinchTarget([board('a')], null)).toBeNull();
  });
});
