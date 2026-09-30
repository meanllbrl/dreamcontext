/**
 * The chart hover model (dashboard/src/components/lab/chart/hover.ts): the pointer is
 * mapped through the plot's RENDERED bounding box to the nearest datum. It must land on
 * the datum under the pointer at any cell width and under zoom (the client rect is
 * larger or smaller than the layout size), clamp at the edges, and place the tooltip
 * inside the cell, flipping at the edge.
 */
import { describe, expect, it } from 'vitest';
import {
  nearestIndex, placeTooltip, pointerToIndex, pointerToLocal, stepIndex,
} from '../../dashboard/src/components/lab/chart/hover.js';
import { bandScale, parseTimeKey, pointPositions, timeScale } from '../../dashboard/src/components/lab/chart/scales.js';

// Irregular dates on purpose (a gap after the 3rd): a time axis spaces them by time, not by index.
const KEYS = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-14'];
const TIMES = KEYS.map((k) => parseTimeKey(k) as number);

function timePositions(width: number): number[] {
  const s = timeScale([TIMES[0], TIMES[TIMES.length - 1]], [0, width]);
  return TIMES.map((t) => s(t));
}

describe('pointer -> datum', () => {
  for (const width of [220, 560, 1180]) {
    for (const zoom of [1, 1.25, 0.8]) {
      it(`lands on the datum under the pointer at width ${width}, zoom ${zoom}`, () => {
        const xs = timePositions(width);
        // The hit rect as the browser reports it: offset in the page, scaled by zoom.
        const rect = { left: 137.5, top: 40, width: width * zoom, height: 180 * zoom };
        xs.forEach((x, i) => {
          // Aim at the datum, then wobble by 40% of the distance to each neighbour.
          const leftRoom = i > 0 ? (x - xs[i - 1]) * 0.4 : 3;
          const rightRoom = i < xs.length - 1 ? (xs[i + 1] - x) * 0.4 : 3;
          for (const local of [x, x - leftRoom, x + rightRoom]) {
            const clientX = rect.left + local * zoom;
            expect(pointerToIndex(clientX, rect, width, xs), `datum ${i} at local ${local.toFixed(1)}`).toBe(i);
          }
        });
      });
    }
  }

  it('a pointer mapped WITHOUT the zoom ratio would miss (the bug this model fixes)', () => {
    const width = 560;
    const xs = timePositions(width);
    const zoom = 1.25;
    const rect = { left: 0, top: 0, width: width * zoom, height: 100 };
    const clientX = xs[6] * zoom;
    expect(pointerToIndex(clientX, rect, width, xs)).toBe(6);
    // Naive: treat client px as layout px.
    expect(nearestIndex(xs, clientX - rect.left)).not.toBe(6);
  });

  it('works for evenly spaced category points and for bands', () => {
    const xs = pointPositions(5, [0, 400], 12);
    const rect = { left: 10, top: 0, width: 400, height: 100 };
    expect(xs.map((x) => pointerToIndex(10 + x, rect, 400, xs))).toEqual([0, 1, 2, 3, 4]);
    const b = bandScale(6, [0, 300]);
    const centers = Array.from({ length: 6 }, (_, i) => b.center(i));
    for (let i = 0; i < 6; i++) {
      expect(pointerToIndex(b.start(i) + 1, { left: 0, top: 0, width: 300, height: 1 }, 300, centers)).toBe(i);
    }
  });

  it('clamps at the edges and handles empty/degenerate input', () => {
    const xs = [10, 20, 30];
    expect(nearestIndex(xs, -100)).toBe(0);
    expect(nearestIndex(xs, 1e6)).toBe(2);
    expect(nearestIndex(xs, 15)).toBe(0); // tie -> earlier datum
    expect(nearestIndex(xs, 15.01)).toBe(1);
    expect(nearestIndex([], 5)).toBe(-1);
    expect(nearestIndex([42], 5)).toBe(0);
    expect(nearestIndex(xs, NaN)).toBe(0);
    // A zero-size rect (not laid out yet) does not divide by zero.
    expect(pointerToLocal(50, 50, { left: 0, top: 0, width: 0, height: 0 }, 100, 100)).toEqual({ x: 50, y: 50 });
  });

  it('maps y too (horizontal bars)', () => {
    const p = pointerToLocal(0, 140, { left: 0, top: 40, width: 100, height: 250 }, 100, 200);
    expect(p.y).toBe(80);
  });
});

describe('keyboard stepping', () => {
  it('enters at an end, steps and clamps', () => {
    expect(stepIndex(null, 1, 5)).toBe(0);
    expect(stepIndex(null, -1, 5)).toBe(4);
    expect(stepIndex(2, 1, 5)).toBe(3);
    expect(stepIndex(4, 1, 5)).toBe(4);
    expect(stepIndex(0, -1, 5)).toBe(0);
    expect(stepIndex(0, 1, 0)).toBeNull();
  });
});

describe('tooltip placement', () => {
  const bounds = { width: 400, height: 200 };
  const box = { width: 120, height: 60 };

  it('sits right of the anchor, vertically centred', () => {
    expect(placeTooltip({ x: 100, y: 100 }, box, bounds)).toEqual({ left: 112, top: 70, side: 'right' });
  });

  it('flips left at the right edge', () => {
    const p = placeTooltip({ x: 350, y: 100 }, box, bounds);
    expect(p.side).toBe('left');
    expect(p.left + box.width).toBeLessThanOrEqual(350);
  });

  it('never leaves the cell: vertical clamp, and a tooltip wider than either side', () => {
    expect(placeTooltip({ x: 100, y: 5 }, box, bounds).top).toBe(0);
    expect(placeTooltip({ x: 100, y: 199 }, box, bounds).top).toBe(140);
    const wide = { width: 300, height: 60 };
    for (const x of [20, 200, 380]) {
      const p = placeTooltip({ x, y: 100 }, wide, bounds);
      expect(p.left).toBeGreaterThanOrEqual(0);
      expect(p.left + wide.width).toBeLessThanOrEqual(bounds.width);
    }
  });
});
