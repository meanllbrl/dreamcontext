import { describe, it, expect } from 'vitest';
import {
  clampRect,
  compact,
  findFreeSlot,
  findOverlaps,
  gridBottom,
  isValidRect,
  narrowOrder,
  rectsOverlap,
  resolveOverlaps,
  type GridItem,
} from '../../src/lib/lab/grid.js';

const item = (id: string, x: number, y: number, w: number, h: number): GridItem => ({ id, at: { x, y, w, h } });

const noOverlaps = (items: GridItem[]) => expect(findOverlaps(items)).toEqual([]);

describe('clampRect', () => {
  it('keeps w 1..12, h 1..24, x 0..12-w, y >= 0, whole numbers', () => {
    expect(clampRect({ x: 20, y: -3, w: 30, h: 99 })).toEqual({ x: 0, y: 0, w: 12, h: 24 });
    expect(clampRect({ x: 10, y: 2, w: 4, h: 3 })).toEqual({ x: 8, y: 2, w: 4, h: 3 });
    expect(clampRect({ x: 1.6, y: '4', w: 0, h: -2 })).toEqual({ x: 2, y: 4, w: 1, h: 1 });
  });

  it('turns garbage into a 4x3 card at the origin', () => {
    expect(clampRect(null)).toEqual({ x: 0, y: 0, w: 4, h: 3 });
    expect(clampRect('nope')).toEqual({ x: 0, y: 0, w: 4, h: 3 });
    expect(clampRect({ x: 'a', w: NaN })).toEqual({ x: 0, y: 0, w: 4, h: 3 });
  });

  it('isValidRect is the strict twin', () => {
    expect(isValidRect({ x: 8, y: 0, w: 4, h: 3 })).toBe(true);
    expect(isValidRect({ x: 9, y: 0, w: 4, h: 3 })).toBe(false);
    expect(isValidRect({ x: 0, y: 0, w: 4, h: 25 })).toBe(false);
    expect(isValidRect({ x: 0.5, y: 0, w: 4, h: 3 })).toBe(false);
  });
});

describe('overlaps', () => {
  it('edges touching is not an overlap', () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 4, h: 3 }, { x: 4, y: 0, w: 4, h: 3 })).toBe(false);
    expect(rectsOverlap({ x: 0, y: 0, w: 4, h: 3 }, { x: 0, y: 3, w: 4, h: 3 })).toBe(false);
    expect(rectsOverlap({ x: 0, y: 0, w: 4, h: 3 }, { x: 3, y: 2, w: 4, h: 3 })).toBe(true);
  });

  it('resolveOverlaps pushes later cards down until they fit, keeps input order, leaves clean layouts alone', () => {
    const clean = [item('a', 0, 0, 6, 3), item('b', 6, 0, 6, 3)];
    expect(resolveOverlaps(clean)).toEqual(clean);

    const messy = [item('late', 0, 0, 12, 2), item('early', 0, 0, 4, 3), item('c', 2, 1, 4, 2)];
    const out = resolveOverlaps(messy);
    expect(out.map((i) => i.id)).toEqual(['late', 'early', 'c']);
    noOverlaps(out);
    // Reading order ties break by input position: 'late' keeps (0,0).
    expect(out[0].at).toEqual({ x: 0, y: 0, w: 12, h: 2 });
    expect(out[1].at.y).toBe(2);
    expect(out[2].at.y).toBe(5);
  });

  it('compact floats cards up into holes without overlaps', () => {
    const out = compact([item('a', 0, 5, 6, 2), item('b', 6, 9, 6, 2), item('c', 0, 12, 12, 1)]);
    expect(out.map((i) => i.at.y)).toEqual([0, 0, 2]);
    noOverlaps(out);
  });
});

describe('placement + narrow order', () => {
  it('findFreeSlot scans rows then columns', () => {
    const items = [item('a', 0, 0, 8, 3)];
    expect(findFreeSlot(items, 4, 3)).toEqual({ x: 8, y: 0, w: 4, h: 3 });
    expect(findFreeSlot(items, 6, 2)).toEqual({ x: 0, y: 3, w: 6, h: 2 });
    expect(findFreeSlot([], 20, 1)).toEqual({ x: 0, y: 0, w: 12, h: 1 });
  });

  it('gridBottom and narrow (single column) ordering by (y, x)', () => {
    const items = [item('c', 0, 4, 4, 1), item('b', 6, 0, 6, 3), item('a', 0, 0, 6, 4)];
    expect(gridBottom(items)).toBe(5);
    expect(gridBottom([])).toBe(0);
    expect(narrowOrder(items).map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });
});
