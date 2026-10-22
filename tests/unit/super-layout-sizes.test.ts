/**
 * The stage with sized cards (owner 2026-10-22, "like Apple widgets"): small 1×1, medium 2×1,
 * large 2×2, wide 3×2 tiles.
 *
 *  - a stage of small cards only is laid out EXACTLY as before sizes existed: the snapshot was
 *    taken from the code before it changed (tests/unit/fixtures/super-layout/), and a sized card
 *    resting in Others does not change it;
 *  - with a sized card each side is as wide as its widest card and the centre narrows for it,
 *    never under CENTRE_MIN and never over its preferred width; at a 1440 window with the sidebar
 *    open (a 1220 stage) a large card really is 344×344;
 *  - a size that cannot fit is drawn smaller and `fitsNow` says so; a side too tall gives up
 *    height before anything goes to Others;
 *  - an owner-placed card resized with `anchoredPos` keeps its inner top corner.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  STAGE, anchoredPos, applyLayoutPatch, fitsNow, patchEchoed, planStage, preferredCentre, sizePx, stageItems, type Rect, type StagePlan,
} from '../../dashboard/src/components/sleepy/super/superLayout.js';
import type { ContainerSize, SuperContainer } from '../../dashboard/src/lib/superTypes.js';

const SNAPSHOT = JSON.parse(readFileSync(new URL('./fixtures/super-layout/small-only-snapshot.json', import.meta.url), 'utf-8')) as Record<string, {
  centre: Rect; cards: Record<string, { rect: Rect; where: string }>; others: string[]; orbit: unknown[];
}>;

const kinds: SuperContainer['kind'][] = ['chat', 'task', 'insight', 'web', 'image', 'knowledge'];
const FLOAT = { mode: 'float' as const };

/** The snapshot's own record: n cards, the 4th dropped by the owner, the 6th in Others. */
function snapshotRecord(n: number, extra: (i: number) => Partial<SuperContainer> = () => ({})): SuperContainer[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i}`, kind: kinds[i % kinds.length], ref: `r${i}`, shape: 'square', place: 'float',
    ...(i === 3 ? { pos: { x: 0.08, y: 0.3 } } : {}),
    ...(i === 5 ? { place: 'others' as const } : {}),
    ...extra(i),
  } as SuperContainer));
}
const view = (plan: StagePlan) => ({
  centre: plan.centre,
  cards: Object.fromEntries(Object.entries(plan.cards).map(([k, v]) => [k, { rect: v.rect, where: v.where }])),
  others: plan.others,
  orbit: plan.orbit,
});

describe('a stage of small cards is laid out exactly as before sizes', () => {
  it('every snapshot case (1..12 cards, stage 1000-1920 wide, two heights) is unchanged', () => {
    let n = 0;
    for (const [key, want] of Object.entries(SNAPSHOT)) {
      const [dims, count] = key.split('/');
      const [width, height] = dims.split('x').map(Number);
      const plan = planStage(stageItems(snapshotRecord(Number(count)), [], FLOAT), FLOAT, { width, height });
      expect(view(plan), key).toEqual(want);
      n++;
    }
    expect(n).toBe(144);
  });

  it('a sized card resting in Others changes nothing on the stage', () => {
    for (const width of [1220, 1744]) {
      const key = `${width}x1000/8`;
      const rec = snapshotRecord(8, (i) => (i === 5 ? { size: 'wide' } : {}));
      const plan = planStage(stageItems(rec, [], FLOAT), FLOAT, { width, height: 1000 });
      expect(view(plan), key).toEqual(SNAPSHOT[key]);
    }
  });

  it('every small floating card is drawn small', () => {
    const plan = planStage(stageItems(snapshotRecord(6), [], FLOAT), FLOAT, { width: 1744, height: 1000 });
    for (const c of Object.values(plan.cards)) if (c.where === 'float') expect(c.size).toBe('small');
  });
});

/** Cards by size, in record order (even slots on the left, odd on the right). */
function record(sizes: ContainerSize[], extra: (i: number) => Partial<SuperContainer> = () => ({})): SuperContainer[] {
  return sizes.map((size, i) => ({
    id: `c${i}`, kind: kinds[i % kinds.length], ref: `r${i}`, shape: 'square', place: 'float',
    ...(size !== 'small' ? { size } : {}), ...extra(i),
  } as SuperContainer));
}
const plan = (rec: SuperContainer[], width: number, height = 1000) => planStage(stageItems(rec, [], FLOAT), FLOAT, { width, height });
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const inflate = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, width: r.width + 2 * d, height: r.height + 2 * d });

function invariants(p: StagePlan, label: string): void {
  const floats = Object.values(p.cards).filter((c) => c.where === 'float');
  expect(p.centre.width, `${label} centre floor`).toBeGreaterThanOrEqual(STAGE.CENTRE_MIN - 1e-6);
  expect(p.centre.width, `${label} centre ceiling`).toBeLessThanOrEqual(preferredCentre(p.width) + 1e-6);
  for (const c of floats) {
    const r = c.rect;
    expect(r.x, `${label} ${c.id} left`).toBeGreaterThanOrEqual(p.free.x - 1e-6);
    expect(r.y, `${label} ${c.id} top`).toBeGreaterThanOrEqual(p.free.y - 1e-6);
    expect(r.x + r.width, `${label} ${c.id} right`).toBeLessThanOrEqual(p.free.x + p.free.width + 1e-6);
    expect(r.y + r.height, `${label} ${c.id} bottom`).toBeLessThanOrEqual(p.free.y + p.free.height + 1e-6);
    // The drawn rect is the drawn size.
    expect({ w: r.width, h: r.height }, `${label} ${c.id} size`).toEqual({ w: sizePx(c.size!).width, h: sizePx(c.size!).height });
    expect(overlaps(r, inflate(p.centre, STAGE.GAP - 0.5)), `${label} ${c.id} clear of the centre`).toBe(false);
    for (const d of floats) if (d.id < c.id) expect(overlaps(inflate(r, STAGE.GAP - 0.5), d.rect), `${label} ${c.id}/${d.id}`).toBe(false);
  }
}

describe('sized cards: each side as wide as it needs, the centre narrows for it', () => {
  it('at a 1440 window with the sidebar open (stage 1220), a large card is drawn 344×344', () => {
    const p = plan(record(['large', 'small', 'small', 'small']), 1220);
    expect(p.cards.c0).toMatchObject({ where: 'float', size: 'large' });
    expect(p.cards.c0.rect.width).toBe(344);
    expect(p.cards.c0.rect.height).toBe(344);
    // The chat narrowed (1220 − 48 − 344 − 160 − 48 = 620), it did not vanish.
    expect(p.centre.width).toBeCloseTo(620, 6);
    invariants(p, '1220 large');
  });

  it('a wide card does not fit a 1220 stage: drawn large, and fitsNow says wide does not fit', () => {
    const rec = record(['wide', 'small', 'small']);
    const p = plan(rec, 1220);
    expect(p.cards.c0.size).toBe('large');
    const items = stageItems(rec, [], FLOAT);
    expect(fitsNow(items, FLOAT, { width: 1220, height: 1000 }, 'c0', 'wide')).toBe(false);
    expect(fitsNow(items, FLOAT, { width: 1220, height: 1000 }, 'c0', 'large')).toBe(true);
    expect(fitsNow(items, FLOAT, { width: 1220, height: 1000 }, 'c0', 'medium')).toBe(true);
    // A wider stage fits it.
    expect(plan(rec, 1744).cards.c0.size).toBe('wide');
    expect(fitsNow(items, FLOAT, { width: 1744, height: 1000 }, 'c0', 'wide')).toBe(true);
    invariants(p, '1220 wide');
  });

  it('large left + medium right at 1220: the later card is drawn smaller (the centre would be 436)', () => {
    const rec = record(['large', 'medium', 'small']);
    const p = plan(rec, 1220);
    expect(p.cards.c0.size).toBe('large');
    expect(p.cards.c1.size).toBe('small');
    expect(fitsNow(stageItems(rec, [], FLOAT), FLOAT, { width: 1220, height: 1000 }, 'c1', 'medium')).toBe(false);
    invariants(p, '1220 large+medium');
  });

  it('the centre never grows past its preferred width, and stays centred when both sides fit', () => {
    const p = plan(record(['medium', 'small', 'small']), 1920);
    expect(p.centre.width).toBeCloseTo(preferredCentre(1920), 6);
    expect(p.centre.x).toBeCloseTo((1920 - preferredCentre(1920)) / 2, 6);
    invariants(p, '1920 medium');
  });

  it('owner 2026-10-22: a card grows on one side, the chat stays in the middle while it can', () => {
    // Stage 1384 (a 1440 window): large on the left, small on the right. Centred, the chat keeps
    // 1384 − 48 − 2 × 368 = 600 ≥ 560, so it narrows evenly instead of sliding right.
    const p = plan(record(['large', 'small', 'small', 'small']), 1384);
    expect(p.cards.c0).toMatchObject({ where: 'float', size: 'large' });
    expect(p.centre.width).toBeCloseTo(600, 6);
    expect(p.centre.x + p.centre.width / 2).toBeCloseTo(1384 / 2, 6);
    invariants(p, '1384 large centred');
    // Stage 1744 (the owner's window): 16 px narrower than preferred, still in the middle.
    const q = plan(record(['large', 'small', 'small', 'small']), 1744);
    expect(q.centre.width).toBeCloseTo(960, 6);
    expect(q.centre.x + q.centre.width / 2).toBeCloseTo(1744 / 2, 6);
    invariants(q, '1744 large centred');
    // A medium on the right as well: both sides need 368, still centred.
    const r = plan(record(['large', 'medium', 'small']), 1744);
    expect(r.cards.c1.size).toBe('medium');
    expect(r.centre.x + r.centre.width / 2).toBeCloseTo(1744 / 2, 6);
  });

  it('only with no room in the middle does the chat move off it (1220: centred would be 436)', () => {
    const p = plan(record(['large', 'small', 'small', 'small']), 1220);
    expect(p.centre.width).toBeGreaterThanOrEqual(STAGE.CENTRE_MIN);
    expect(p.centre.x + p.centre.width / 2).toBeGreaterThan(1220 / 2 + 1);
  });

  it('holds its invariants across sizes, stage widths and heights', () => {
    const mixes: ContainerSize[][] = [
      ['large'], ['wide', 'wide'], ['medium', 'large', 'small', 'small', 'small'],
      ['small', 'wide', 'small', 'medium', 'large', 'small', 'small', 'small'],
      ['large', 'large', 'large', 'large', 'small', 'small'], ['wide', 'small', 'small', 'small', 'small', 'small', 'small', 'small', 'small', 'small', 'small', 'small'],
    ];
    for (const sizes of mixes) {
      for (const width of [1040, 1220, 1384, 1700, 1744, 1920]) {
        for (const height of [560, 760, 1000]) invariants(plan(record(sizes), width, height), `${sizes.join(',')} @${width}x${height}`);
      }
    }
  });

  it('a side too tall gives up height first (the later, auto-placed card), before anything goes to Others', () => {
    // Stage 1744×760: the content is 672 tall; two large cards on the left need 712.
    const p = plan(record(['large', 'small', 'large', 'small']), 1744, 760);
    expect(p.others).toEqual([]);
    expect(p.cards.c0.size).toBe('large');
    expect(p.cards.c2.size).toBe('medium');
    invariants(p, 'height');
  });

  it('the owner\'s large card keeps its size; the auto one gives up height first', () => {
    const rec = record(['large', 'small', 'large', 'small'], (i) => (i === 0 ? { pos: { x: 0.02, y: 0.1 } } : {}));
    const p = plan(rec, 1744, 760);
    expect(p.cards.c0).toMatchObject({ size: 'large', owner: true });
    expect(p.cards.c2.size).toBe('medium');
  });
});

describe('resizing a card the owner placed keeps its inner top corner (anchoredPos)', () => {
  for (const side of ['left', 'right'] as const) {
    it(`on the ${side}: the corner toward the centre stays put`, () => {
      // Stage 1920: the side has 374 px beside the centre; the card stands where a large one
      // grown from its inner corner still fits on its side.
      const pos = side === 'left' ? { x: 0.1203, y: 0.3 } : { x: 0.8797, y: 0.3 };
      const before = plan(record(['small', 'small', 'small'], (i) => (i === 0 ? { pos } : {})), 1920);
      const r0 = before.cards.c0.rect;
      const next = anchoredPos(before.free, r0, 'large', side);
      const after = plan(record(['large', 'small', 'small'], (i) => (i === 0 ? { pos: next } : {})), 1920);
      const r1 = after.cards.c0.rect;
      expect(r1.width).toBe(344);
      expect(r1.y).toBeCloseTo(r0.y, 6);
      if (side === 'left') expect(r1.x + r1.width).toBeCloseTo(r0.x + r0.width, 6);
      else expect(r1.x).toBeCloseTo(r0.x, 6);
      // It stays on its side (the record decides the side by pos.x).
      expect(next.x < 0.5).toBe(side === 'left');
    });
  }
});

describe('the owner\'s size as a layout patch, applied locally the way the server applies it', () => {
  const state = () => ({ containers: record(['small', 'large']), groups: [{ id: 'grp-1', name: 'G', cards: ['c0', 'c1'], place: 'float' as const }], view: FLOAT });

  it('writes the size and his mark; small takes the size off but keeps the mark; null hands it back', () => {
    let s = applyLayoutPatch(state(), { cards: [{ id: 'c0', size: 'wide' }] });
    expect(s.containers[0]).toMatchObject({ size: 'wide', sizeBy: 'owner' });
    s = applyLayoutPatch(s, { cards: [{ id: 'c0', size: 'small' }] });
    expect(s.containers[0].size).toBeUndefined();
    expect(s.containers[0].sizeBy).toBe('owner');
    s = applyLayoutPatch(s, { cards: [{ id: 'c0', size: null }] });
    expect(s.containers[0].size).toBeUndefined();
    expect(s.containers[0].sizeBy).toBeUndefined();
  });

  it('echoed once the pushed record carries it; a group\'s size (ignored) counts as echoed', () => {
    const base = state();
    const patch = { cards: [{ id: 'c0', size: 'large' as const }] };
    expect(patchEchoed(base, patch)).toBe(false);
    expect(patchEchoed(applyLayoutPatch(base, patch), patch)).toBe(true);
    expect(patchEchoed(base, { cards: [{ id: 'grp-1', size: 'large' }] })).toBe(true);
    // A card closed meanwhile: nothing to wait for.
    expect(patchEchoed(base, { cards: [{ id: 'gone', size: 'large' }] })).toBe(true);
    const sized = applyLayoutPatch(base, patch);
    expect(patchEchoed(sized, { cards: [{ id: 'c0', size: null }] })).toBe(false);
    expect(patchEchoed(applyLayoutPatch(sized, { cards: [{ id: 'c0', size: null }] }), { cards: [{ id: 'c0', size: null }] })).toBe(true);
  });
});
