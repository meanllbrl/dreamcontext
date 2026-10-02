/**
 * The board grid's geometry, as BoardGrid.tsx uses it: the narrow column's order, the drag and
 * resize snap, where a dropped card lands, and the rule that a drag crossing 720px is cancelled.
 *
 * Pure-function tests (this repo runs no DOM harness): the component is a thin pointer layer over
 * exactly these functions, so a regression in the math shows up here first.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  GRID_GAP_PX, NARROW_PX, columnPitch, isNarrow, placeCard, rectToBox, sameLayout, shouldCancelDrag,
  snapMove, snapResize,
} from '../../dashboard/src/components/lab/board/BoardGrid';
import { GRID_ROW_PX, findOverlaps, narrowOrder } from '../../dashboard/src/generated/grid';

const card = (id: string, x: number, y: number, w: number, h: number) => ({ id, at: { x, y, w, h } });

describe('narrow layout', () => {
  it('is narrow below 720px only', () => {
    expect(NARROW_PX).toBe(720);
    expect(isNarrow(719)).toBe(true);
    expect(isNarrow(720)).toBe(false);
    expect(isNarrow(1280)).toBe(false);
  });

  it('stacks cards in reading order (y, then x), ties by file order', () => {
    const cards = [card('c', 8, 0, 4, 3), card('d', 0, 3, 12, 2), card('a', 0, 0, 4, 3), card('b', 4, 0, 4, 3), card('e', 0, 3, 4, 1)];
    expect(narrowOrder(cards).map((c) => c.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('pixel boxes', () => {
  it('a cell is 1/12 of the container plus its share of gap; the gap is carved out of each card', () => {
    const width = 1188; // 12 * 100 - 12
    expect(columnPitch(width)).toBe(100);
    expect(rectToBox({ x: 2, y: 3, w: 4, h: 2 }, width)).toEqual({
      left: 200,
      top: 3 * GRID_ROW_PX,
      width: 400 - GRID_GAP_PX,
      height: 2 * GRID_ROW_PX - GRID_GAP_PX,
    });
  });
});

describe('snap', () => {
  const pitch = 100;
  const start = { x: 2, y: 2, w: 4, h: 3 };

  it('a move snaps to the nearest cell', () => {
    expect(snapMove(start, 149, 27, pitch)).toEqual({ x: 3, y: 2, w: 4, h: 3 });
    expect(snapMove(start, 151, 29, pitch)).toEqual({ x: 4, y: 3, w: 4, h: 3 });
    expect(snapMove(start, -49, -28, pitch)).toEqual({ x: 2, y: 2, w: 4, h: 3 });
  });

  it('a move never leaves the board (x 0..12-w, y >= 0)', () => {
    expect(snapMove(start, 5000, 0, pitch)).toEqual({ x: 8, y: 2, w: 4, h: 3 });
    expect(snapMove(start, -5000, -5000, pitch)).toEqual({ x: 0, y: 0, w: 4, h: 3 });
  });

  it('a resize keeps the origin and snaps the size, 1..12-x wide and 1..24 tall', () => {
    expect(snapResize(start, 120, 60, pitch)).toEqual({ x: 2, y: 2, w: 5, h: 4 });
    expect(snapResize(start, 5000, 5000, pitch)).toEqual({ x: 2, y: 2, w: 10, h: 24 });
    expect(snapResize(start, -5000, -5000, pitch)).toEqual({ x: 2, y: 2, w: 1, h: 1 });
  });
});

describe('dropping a card', () => {
  it('the dropped card keeps its spot and the card it covers is pushed below it', () => {
    const cards = [card('a', 0, 0, 6, 3), card('b', 6, 0, 6, 3)];
    const next = placeCard(cards, 'b', { x: 0, y: 0, w: 6, h: 3 });
    const byId = Object.fromEntries(next.map((c) => [c.id, c.at]));
    expect(byId.b).toEqual({ x: 0, y: 0, w: 6, h: 3 });
    expect(byId.a).toEqual({ x: 0, y: 3, w: 6, h: 3 });
    expect(findOverlaps(next)).toEqual([]);
  });

  it('leaves no hole behind and keeps the file order of the cards', () => {
    const cards = [card('a', 0, 0, 12, 2), card('b', 0, 2, 12, 2), card('c', 0, 4, 12, 2)];
    const next = placeCard(cards, 'a', { x: 0, y: 10, w: 12, h: 2 });
    expect(next.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    const byId = Object.fromEntries(next.map((c) => [c.id, c.at.y]));
    expect(byId).toEqual({ b: 0, c: 2, a: 4 });
  });

  it('a drop on the same spot is the same layout (no write)', () => {
    const cards = [card('a', 0, 0, 6, 3), card('b', 6, 0, 6, 3)];
    expect(sameLayout(cards, placeCard(cards, 'a', { x: 0, y: 0, w: 6, h: 3 }))).toBe(true);
    expect(sameLayout(cards, placeCard(cards, 'a', { x: 0, y: 0, w: 5, h: 3 }))).toBe(false);
  });
});

describe('drag cancel rule', () => {
  it('a running drag is cancelled the moment the container turns narrow', () => {
    expect(shouldCancelDrag(true, 719)).toBe(true);
    expect(shouldCancelDrag(true, 720)).toBe(false);
    expect(shouldCancelDrag(false, 400)).toBe(false);
  });
});

describe('blocks inside tabs find their frames', () => {
  it('BoardCard keys a tabs child by the full path the engine resolves (index.tab.child)', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { resolveBoardFrames } = await import('../../src/lib/lab/frames');
    const { frameKey } = await import('../../dashboard/src/generated/frameOps');
    const { tabChildPath } = await import('../../dashboard/src/components/lab/board/BoardCard');
    const root = mkdtempSync(join(tmpdir(), 'lab-board-tabs-'));
    try {
      const tabs = {
        type: 'tabs' as const,
        options: {},
        tabs: [
          { label: 'a', blocks: [{ type: 'line' as const, data: 'x', options: {} }] },
          { label: 'b', blocks: [{ type: 'text' as const, options: {} }, { type: 'bar' as const, data: 'y', options: {} }] },
        ],
      };
      const card = {
        id: 'c-x',
        at: { x: 0, y: 0, w: 12, h: 4 },
        blocks: [{ type: 'text' as const, options: {} }, { type: 'text' as const, options: {} }, tabs],
      };
      const keys = Object.keys(resolveBoardFrames(root, { cards: [card] as never }));
      // TabsBlock hands [tab, child]; the card prefixes the tabs block's own path [2].
      expect(frameKey('c-x', tabChildPath([2], [1, 1]))).toBe('c-x:2.1.1');
      expect(keys.sort()).toEqual([frameKey('c-x', tabChildPath([2], [0, 0])), frameKey('c-x', tabChildPath([2], [1, 1]))].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('BoardCard wiring', () => {
  it('draws tabs children through tabChildPath and mounts blocks under blockRenderKey', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/lab/board/BoardCard.tsx'), 'utf8');
    expect(src).toMatch(/renderChild: block\.type === 'tabs' \? \(child, rel\) => draw\(child, tabChildPath\(path, rel\)\)/);
    expect(src).toMatch(/key=\{blockRenderKey\(card\.id, \[i\], block\)\}/);
  });
});
