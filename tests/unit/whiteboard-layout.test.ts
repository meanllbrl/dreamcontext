/**
 * Where things are on a board and where a new thing may go (layout.ts): the overlap check
 * `draw` / `add` run under the lock, the tag summary `show` opens with, and the grid-aligned
 * free-slot search behind `place` and `--below` / `--right-of` / `--align-left`.
 */
import { describe, it, expect } from 'vitest';
import {
  assertFree,
  boxesOverlap,
  GRID_PITCH,
  occupantsOf,
  placeFree,
  tagBBox,
  tagGroups,
  WhiteboardOverlapError,
} from '../../src/lib/whiteboards/layout.js';
import { elementBBox, type BBox } from '../../src/lib/whiteboards/ops.js';
import type { WhiteboardElement } from '../../src/lib/whiteboards/widgets.js';

let n = 0;
function rect(x: number, y: number, w: number, h: number, tag?: string, extra: Partial<WhiteboardElement> = {}): WhiteboardElement {
  return {
    id: `el-${++n}`, type: 'rectangle', x, y, width: w, height: h, version: 1, versionNonce: 1, isDeleted: false,
    ...(tag ? { customData: { dcTag: tag } } : {}), ...extra,
  } as WhiteboardElement;
}

/** A 79-element section like the one another session drew: x 980..2156, y 1500..2301. */
function section(): WhiteboardElement[] {
  const els = [rect(980, 1500, 1176, 801, 'exp-4092')];
  for (let i = 0; i < 78; i++) els.push(rect(1004 + (i % 5) * 228, 1576 + Math.floor(i / 5) * 45, 200, 40, 'exp-4092'));
  return els;
}

const clearOf = (els: WhiteboardElement[], box: BBox, gap = 16) =>
  els.every((el) => !boxesOverlap({ x: box.x - gap, y: box.y - gap, w: box.w + 2 * gap, h: box.h + 2 * gap }, elementBBox(el)));

describe('boxesOverlap', () => {
  it('counts interiors meeting, not shared edges; a flat line inside a box counts', () => {
    const a = { x: 0, y: 0, w: 100, h: 100 };
    expect(boxesOverlap(a, { x: 50, y: 50, w: 100, h: 100 })).toBe(true);
    expect(boxesOverlap(a, { x: 100, y: 0, w: 50, h: 50 })).toBe(false);
    expect(boxesOverlap(a, { x: 0, y: 100, w: 50, h: 50 })).toBe(false);
    expect(boxesOverlap(a, { x: 10, y: 50, w: 80, h: 0 })).toBe(true);
    expect(boxesOverlap(a, { x: 200, y: 200, w: 10, h: 10 })).toBe(false);
  });
});

describe('assertFree (the check draw / add run under the lock)', () => {
  it('refuses a box over a live section, naming every overlapping id, its tag and bbox', () => {
    const board = section();
    const box = { x: 980, y: 1360, w: 1140, h: 941 };
    let err: unknown;
    try {
      assertFree(board, box, { slug: 'cb-experiment', what: 'draw winback.excalidraw.md' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WhiteboardOverlapError);
    const o = err as WhiteboardOverlapError;
    expect(o.occupants).toHaveLength(79);
    expect(o.occupants.every((x) => x.tag === 'exp-4092')).toBe(true);
    expect(o.groups).toEqual([{ tag: 'exp-4092', count: 79, bbox: { x: 980, y: 1500, w: 1176, h: 801 } }]);
    expect(o.message).toContain('overlaps 79 live elements on cb-experiment');
    expect(o.message).toContain(`${board[1].id}  rectangle  #exp-4092  @1004,1576,200,40`);
    expect(o.message).toContain('dreamcontext whiteboard place cb-experiment --size 1140,941 --below exp-4092');
    expect(o.message).toContain('--allow-overlap');
    expect(o.toJSON()).toMatchObject({ error: 'overlap', box, overlaps: expect.any(Array) });
  });

  it('a frame holding the box is a container, not an occupant; what the frame holds still counts', () => {
    const frame = rect(0, 0, 1000, 1000, 'lane', { type: 'frame' });
    const inside = rect(100, 100, 200, 200, 'lane');
    expect(occupantsOf([frame, inside], { x: 500, y: 500, w: 200, h: 200 })).toEqual([]);
    expect(occupantsOf([frame, inside], { x: 150, y: 150, w: 200, h: 200 }).map((o) => o.id)).toEqual([inside.id]);
    expect(occupantsOf([frame], { x: 900, y: 900, w: 200, h: 200 }).map((o) => o.id)).toEqual([frame.id]);
  });

  it('passes a box on empty space, and ignores tombstones', () => {
    const board = [...section(), rect(0, 3000, 500, 500, 'gone', { isDeleted: true })];
    expect(() => assertFree(board, { x: 980, y: 2352, w: 1140, h: 633 }, { slug: 's', what: 'draw' })).not.toThrow();
    expect(() => assertFree(board, { x: 0, y: 3000, w: 100, h: 100 }, { slug: 's', what: 'draw' })).not.toThrow();
    expect(occupantsOf(board, { x: 0, y: 3000, w: 100, h: 100 })).toEqual([]);
  });
});

describe('placeFree (place, --below, --right-of, --align-left)', () => {
  it('--below a tag: grid-aligned, under the group, lined up with its left edge, clear of everything', () => {
    const board = section();
    const pos = placeFree(board, { w: 1140, h: 633 }, { below: 'exp-4092' });
    expect(pos.x % GRID_PITCH).toBe(0);
    expect(pos.y % GRID_PITCH).toBe(0);
    expect(pos).toEqual({ x: 980, y: 2352 });
    expect(clearOf(board, { ...pos, w: 1140, h: 633 })).toBe(true);
  });

  it('--below walks down past whatever already sits under the group', () => {
    const board = [...section(), rect(1100, 2400, 300, 300, 'other')];
    const pos = placeFree(board, { w: 400, h: 200 }, { below: 'exp-4092' });
    expect(pos.x).toBe(980);
    expect(pos.y % GRID_PITCH).toBe(0);
    expect(pos.y).toBeGreaterThanOrEqual(2700);
    expect(clearOf(board, { ...pos, w: 400, h: 200 })).toBe(true);
  });

  it('--align-left lines up with another group; --right-of sits beside, top-aligned', () => {
    const board = [...section(), rect(196, 0, 300, 100, 'intro')];
    expect(placeFree(board, { w: 300, h: 100 }, { below: 'exp-4092', alignLeft: 'intro' })).toEqual({ x: 196, y: 2352 });
    const right = placeFree(board, { w: 376, h: 180 }, { rightOf: 'exp-4092' });
    expect(right.y).toBe(1568);
    expect(right.x % GRID_PITCH).toBe(0);
    expect(right.x).toBeGreaterThanOrEqual(2156 + 16);
    expect(clearOf(board, { ...right, w: 376, h: 180 })).toBe(true);
  });

  it('refuses an unknown tag (naming the tags there) and conflicting anchors', () => {
    const board = section();
    expect(() => placeFree(board, { w: 10, h: 10 }, { below: 'nope' })).toThrow(/no live element tagged 'nope'.*exp-4092/);
    expect(() => placeFree(board, { w: 10, h: 10 }, { below: 'exp-4092', rightOf: 'exp-4092' })).toThrow(/not both/);
    expect(() => placeFree(board, { w: 10, h: 10 }, { rightOf: 'exp-4092', alignLeft: 'exp-4092' })).toThrow(/goes with --below/);
  });

  it('no anchor: the same slot `add` takes without --at, on an empty board the origin', () => {
    expect(placeFree([], { w: 180, h: 180 })).toEqual({ x: 0, y: 0 });
    const board = section();
    const pos = placeFree(board, { w: 180, h: 180 });
    expect(clearOf(board, { ...pos, w: 180, h: 180 })).toBe(true);
  });
});

describe('tagGroups / tagBBox (the show summary)', () => {
  it('groups by tag top to bottom, untagged last, with counts and boxes', () => {
    const board = [rect(0, 400, 10, 10), ...section(), rect(0, 0, 100, 100, 'intro'), rect(200, 0, 100, 50, 'intro')];
    expect(tagGroups(board)).toEqual([
      { tag: 'intro', count: 2, bbox: { x: 0, y: 0, w: 300, h: 100 } },
      { tag: 'exp-4092', count: 79, bbox: { x: 980, y: 1500, w: 1176, h: 801 } },
      { tag: null, count: 1, bbox: { x: 0, y: 400, w: 10, h: 10 } },
    ]);
    expect(tagBBox(board, 'intro')).toEqual({ x: 0, y: 0, w: 300, h: 100 });
  });
});
