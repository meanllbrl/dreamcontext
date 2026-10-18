/**
 * The hand-over stage (plan-r8 F4, §0 C1/C2/C3/D1, AC Layout): the Super Agent's window exactly
 * in the centre, cards floating around it at a fixed gap, half / present / narrow, the owner's
 * drop kept, overflow DRAWN in Others without touching the record. Invariants, not pixels.
 */
import { describe, it, expect } from 'vitest';
import {
  NARROW_STAGE_PX, STAGE, applyLayoutPatch, centreCandidates, overCentre, overOthersZone, patchEchoed, planStage,
  posFromRect, rectFromPos, type Rect, type StagePlan,
} from '../../dashboard/src/components/sleepy/super/superLayout.js';
import { MAX_CONTAINERS, type SuperContainer, type SuperView } from '../../dashboard/src/lib/superTypes.js';

const card = (id: string, shape: SuperContainer['shape'] = 'tall', extra: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id, kind: shape === 'tall' ? 'chat' : 'insight', ref: `ref-${id}`, shape, place: 'float', ...extra });
const FLOAT: SuperView = { mode: 'float' };
const EPS = 0.5;

/** The stage a window of this size leaves (the rail, the header and the window chrome off). */
const STAGES = [
  { width: 1224, height: 740 },   // a 1280 x 800 window
  { width: 1384, height: 840 },   // 1440 x 900
  { width: 1544, height: 940 },   // 1600 x 1000
  { width: 1864, height: 1020 },  // 1920 x 1080
];

const fiveTallTwoSquare = () => [card('a'), card('b'), card('c'), card('d'), card('e'), card('s1', 'square'), card('s2', 'square')];

const gapBetween = (a: Rect, b: Rect) => {
  const dx = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
  const dy = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height));
  return Math.max(dx, dy);
};
const inStage = (p: StagePlan, r: Rect) =>
  r.x >= -EPS && r.y >= -EPS && r.x + r.width <= p.width + EPS && r.y + r.height <= p.height + EPS;

function expectCentred(p: StagePlan) {
  const left = p.centre.x;
  const right = p.width - (p.centre.x + p.centre.width);
  const top = p.centre.y;
  const bottom = p.height - (p.centre.y + p.centre.height);
  expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
  expect(Math.abs(top - bottom)).toBeLessThanOrEqual(1);
}

describe('floating cards (O1, O2, §0 C1)', () => {
  for (const s of STAGES) {
    it(`5 tall + 2 square all FLOAT at ${s.width}x${s.height}, centred, gaps >= 24`, () => {
      const p = planStage(fiveTallTwoSquare(), FLOAT, s);
      expect(p.narrow).toBe(false);
      expect(p.others).toEqual([]);
      expectCentred(p);
      const rects = Object.values(p.cards).map((c) => c.rect);
      expect(rects).toHaveLength(7);
      for (const r of rects) {
        expect(gapBetween(r, p.centre)).toBeGreaterThanOrEqual(STAGE.GAP - EPS);
        expect(inStage(p, r)).toBe(true);
        expect(r.y).toBeGreaterThanOrEqual(p.centre.y - EPS);
        expect(r.y + r.height).toBeLessThanOrEqual(p.centre.y + p.centre.height + EPS);
      }
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        expect(gapBetween(rects[i], rects[j])).toBeGreaterThanOrEqual(STAGE.GAP - EPS);
      }
    });
  }

  it('chat cards are 9:16 and the rest 1:1, unit width in [150, 232]', () => {
    const p = planStage([card('a'), card('s', 'square')], FLOAT, STAGES[1]);
    const a = p.cards.a.rect;
    const s = p.cards.s.rect;
    expect(a.height / a.width).toBeCloseTo(16 / 9, 5);
    expect(s.height).toBeCloseTo(s.width, 5);
    for (const r of [a, s]) {
      expect(r.width).toBeGreaterThanOrEqual(STAGE.U_MIN - EPS);
      expect(r.width).toBeLessThanOrEqual(STAGE.U_MAX + EPS);
    }
  });

  it('alternates left/right in record order, each column centred on the midline', () => {
    const p = planStage([card('a', 'square'), card('b', 'square')], FLOAT, STAGES[2]);
    expect(p.cards.a.rect.x + p.cards.a.rect.width).toBeLessThanOrEqual(p.centre.x);
    expect(p.cards.b.rect.x).toBeGreaterThanOrEqual(p.centre.x + p.centre.width);
    const mid = p.centre.y + p.centre.height / 2;
    expect(Math.abs(p.cards.a.rect.y + p.cards.a.rect.height / 2 - mid)).toBeLessThanOrEqual(1);
  });

  it('an empty stage is just the centre, at its preferred width', () => {
    const p = planStage([], FLOAT, STAGES[3]);
    expectCentred(p);
    expect(p.centre.width).toBeCloseTo(centreCandidates(STAGES[3].width)[0], 5);
  });

  it('a card that fits nowhere is DRAWN in Others; the record stays float', () => {
    const many = Array.from({ length: MAX_CONTAINERS }, (_, i) => card(`k${i}`));
    const p = planStage(many, FLOAT, { width: 1100, height: 600 });
    expect(p.others.length).toBeGreaterThan(0);
    for (const id of p.others) expect(p.cards[id].where).toBe('others');
    expect(many.every((c) => c.place === 'float')).toBe(true);
    const floating = Object.values(p.cards).filter((c) => c.where === 'float').map((c) => c.rect);
    for (let i = 0; i < floating.length; i++) for (let j = i + 1; j < floating.length; j++) {
      expect(gapBetween(floating[i], floating[j])).toBeGreaterThanOrEqual(STAGE.GAP - EPS);
    }
  });

  it('before overflowing, tall cards are DRAWN square (the record keeps tall)', () => {
    const many = Array.from({ length: MAX_CONTAINERS }, (_, i) => card(`k${i}`));
    const p = planStage(many, FLOAT, STAGES[0]);
    expect(p.others).toEqual([]);
    expect(Object.values(p.cards).every((c) => c.shape === 'square')).toBe(true);
    expect(many.every((c) => c.shape === 'tall')).toBe(true);
  });

  it('a card the record stacks in Others is drawn there', () => {
    const p = planStage([card('a'), card('b', 'tall', { place: 'others' })], FLOAT, STAGES[1]);
    expect(p.others).toEqual(['b']);
    expect(p.cards.b.rect).toEqual(p.othersRect);
  });

  it('never lays out more than 12', () => {
    const many = Array.from({ length: MAX_CONTAINERS + 1 }, (_, i) => card(`k${i}`, 'square'));
    expect(Object.keys(planStage(many, FLOAT, STAGES[3]).cards)).toHaveLength(MAX_CONTAINERS);
  });
});

describe('the centre steps with hysteresis (round 2)', () => {
  it('narrows through the fixed steps to make room', () => {
    const p = planStage(fiveTallTwoSquare(), FLOAT, STAGES[0]);
    expect(centreCandidates(STAGES[0].width)).toContain(p.centreWidth);
    expect(p.centreWidth).toBeLessThan(centreCandidates(STAGES[0].width)[0]);
  });

  it('one card opening and closing never makes the centre wobble', () => {
    const n = (k: number) => Array.from({ length: k }, (_, i) => card(`k${i}`));
    const s = STAGES[1];
    const wide = planStage(n(8), FLOAT, s).centreWidth;
    const nine = planStage(n(9), FLOAT, s, { prevCentre: wide });
    expect(nine.centreWidth).toBeLessThan(wide);
    // Back to 8: the wider step would fit, but not with a card to spare, so it stays.
    const eight = planStage(n(8), FLOAT, s, { prevCentre: nine.centreWidth });
    expect(eight.centreWidth).toBe(nine.centreWidth);
    expectCentred(eight);
    // Back to 7: now it widens.
    expect(planStage(n(7), FLOAT, s, { prevCentre: eight.centreWidth }).centreWidth).toBe(wide);
  });
});

describe('the owner\'s drop (O3, §0 C-minors, D1)', () => {
  it('a dropped card is drawn where it was dropped, and pos round-trips through the free area', () => {
    const p0 = planStage([card('a'), card('b', 'square')], FLOAT, STAGES[2]);
    const r = { x: 40, y: p0.free.y + 30, width: p0.cards.b.rect.width, height: p0.cards.b.rect.height };
    const pos = posFromRect(p0.free, r);
    const p = planStage([card('a'), card('b', 'square', { pos })], FLOAT, STAGES[2]);
    expect(p.cards.b.owner).toBe(true);
    const back = rectFromPos(p.free, pos, p.cards.b.rect.width, p.cards.b.rect.height);
    expect(Math.abs(back.x - p.cards.b.rect.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(back.y - p.cards.b.rect.y)).toBeLessThanOrEqual(1);
  });

  it('x = 1 is flush right whatever the card size', () => {
    const p = planStage([card('b', 'square', { pos: { x: 1, y: 0 } })], FLOAT, STAGES[1]);
    const r = p.cards.b.rect;
    expect(r.x + r.width).toBeCloseTo(p.free.x + p.free.width, 5);
  });

  it('a stale pos over the centre is pushed out to the nearer side, a gap away', () => {
    const p = planStage([card('b', 'square', { pos: { x: 0.45, y: 0.3 } })], FLOAT, STAGES[3]);
    expect(gapBetween(p.cards.b.rect, p.centre)).toBeGreaterThanOrEqual(STAGE.GAP - EPS);
  });

  it('auto cards route around an owner-placed card', () => {
    const p = planStage([card('o', 'square', { pos: { x: 0, y: 0.5 } }), card('a'), card('b'), card('c')], FLOAT, STAGES[3]);
    for (const id of ['a', 'b', 'c']) {
      if (p.cards[id].where !== 'float') continue;
      expect(gapBetween(p.cards[id].rect, p.cards.o.rect)).toBeGreaterThanOrEqual(STAGE.GAP - EPS);
    }
  });

  it('a running drag keeps the dragged card at its drag-start rect while a push adds a card (D1)', () => {
    const list = [card('a'), card('b'), card('c')];
    const before = planStage(list, FLOAT, STAGES[2]);
    const rect = before.cards.b.rect;
    const during = planStage([...list, card('n'), card('m', 'square')], FLOAT, STAGES[2], { dragging: { id: 'b', rect } });
    expect(during.cards.b.rect).toEqual(rect);
    for (const id of ['a', 'c', 'n', 'm']) {
      if (during.cards[id].where !== 'float') continue;
      expect(gapBetween(during.cards[id].rect, rect)).toBeGreaterThanOrEqual(STAGE.GAP - EPS);
    }
  });

  it('a card dropped where it stood keeps its size and place; no other card changes side (stable drop)', () => {
    for (const st of STAGES) {
      const list = [card('a'), card('b'), card('c'), card('s1', 'square'), card('d'), card('s2', 'square'), card('e'), card('f')];
      const before = planStage(list, FLOAT, st);
      for (const id of ['a', 'b', 's1', 'e']) {
        const b = before.cards[id];
        if (b.where !== 'float') continue;
        // The owner's drop: pos from the card's own rect (the window never reorders the record).
        const dropped = applyLayoutPatch({ containers: list, view: FLOAT }, { cards: [{ id, pos: posFromRect(before.free, b.rect), place: 'float' }] });
        const after = planStage(dropped.containers, FLOAT, st);
        const a = after.cards[id];
        expect(a.owner).toBe(true);
        for (const k of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(a.rect[k] - b.rect[k])).toBeLessThanOrEqual(1);
        const side = (r: Rect, p: StagePlan) => (r.x + r.width / 2 < p.width / 2 ? 'L' : 'R');
        for (const other of Object.values(before.cards)) {
          if (other.id === id || other.where !== 'float' || after.cards[other.id].where !== 'float') continue;
          expect(side(after.cards[other.id].rect, after)).toBe(side(other.rect, before));
        }
      }
    }
  });

  it('a card sent to Others, or brought back, changes no other card\'s side; a lopsided stage moves one card', () => {
    const side = (r: Rect, p: StagePlan) => (r.x + r.width / 2 < p.width / 2 ? 'L' : 'R');
    const list = [card('a'), card('b'), card('c'), card('s1', 'square'), card('d'), card('s2', 'square'), card('e'), card('f')];
    const sides = (l: SuperContainer[], st: { width: number; height: number }) => {
      const p = planStage(l, FLOAT, st);
      return new Map(Object.values(p.cards).filter((c) => c.where === 'float').map((c) => [c.id, side(c.rect, p)] as const));
    };
    const to = (l: SuperContainer[], ids: string[], place: SuperContainer['place']) => applyLayoutPatch({ containers: l, view: FLOAT }, { cards: ids.map((id) => ({ id, place })) }).containers;
    for (const st of STAGES) {
      const before = sides(list, st);
      for (const id of list.map((c) => c.id)) {
        const out = to(list, [id], 'others');
        const after = sides(out, st);
        for (const [k, s] of after) if (before.has(k)) expect(s, `${id} to Others moved ${k} at ${st.width}`).toBe(before.get(k));
        // …and back: every card where it was.
        expect(sides(to(out, [id], 'float'), st)).toEqual(before);
      }
      // Two cards off the same side: the stage rebalances by moving exactly one card.
      const lopsided = sides(to(list, ['a', 'c'], 'others'), st);
      const count = (m: Map<string, string>, s: string) => [...m.values()].filter((v) => v === s).length;
      expect(Math.abs(count(lopsided, 'L') - count(lopsided, 'R'))).toBeLessThanOrEqual(1);
      expect([...lopsided].filter(([k, s]) => before.get(k) !== s)).toHaveLength(1);
    }
  });

  it('dragging the card a rebalance moved changes no other side; its drop and a later card keep every side', () => {
    const side = (r: Rect, p: StagePlan) => (r.x + r.width / 2 < p.width / 2 ? 'L' : 'R');
    const sides = (p: StagePlan, skip = '') =>
      new Map(Object.values(p.cards).filter((c) => c.where === 'float' && c.id !== skip).map((c) => [c.id, side(c.rect, p)] as const));
    const count = (m: Map<string, string>, s: string) => [...m.values()].filter((v) => v === s).length;
    for (const st of STAGES) {
      // a and c (same parity) in Others: parity leaves 3 on the right, so the rebalance moves f left.
      const list = [card('a', 'tall', { place: 'others' }), card('b'), card('c', 'tall', { place: 'others' }), card('d'), card('e'), card('f')];
      const rest = planStage(list, FLOAT, st);
      const atRest = sides(rest);
      expect(atRest.get('f'), `rebalanced card at ${st.width}`).toBe('L');
      // The drag starts on f: no other card changes side under the owner's hand.
      const during = planStage(list, FLOAT, st, { dragging: { id: 'f', rect: rest.cards.f.rect } });
      expect(sides(during, 'f'), `drag start at ${st.width}`).toEqual(sides(rest, 'f'));
      // Dropped where it stood: every side as at rest.
      const dropped = applyLayoutPatch({ containers: list, view: FLOAT }, { cards: [{ id: 'f', pos: posFromRect(rest.free, rest.cards.f.rect) }] }).containers;
      const after = planStage(dropped, FLOAT, st);
      expect(sides(after), `drop at ${st.width}`).toEqual(atRest);
      // A new card arrives: no card changes side, the owner's own card included.
      const added = planStage([...dropped, card('g')], FLOAT, st);
      for (const [k, s] of sides(after)) if (added.cards[k].where === 'float') expect(side(added.cards[k].rect, added), `${k} after g at ${st.width}`).toBe(s);
      // Dropped on the far side: exactly one card crosses and the stage stays balanced.
      const across = planStage(applyLayoutPatch({ containers: list, view: FLOAT }, { cards: [{ id: 'f', pos: { x: 1, y: 0.5 } }] }).containers, FLOAT, st);
      const acrossSides = sides(across);
      expect(acrossSides.get('f')).toBe('R');
      expect(Math.abs(count(acrossSides, 'L') - count(acrossSides, 'R'))).toBeLessThanOrEqual(1);
      expect([...acrossSides].filter(([k, s]) => k !== 'f' && atRest.get(k) !== s)).toHaveLength(1);
    }
  });

  it('paint order follows the record; an owner-placed card paints above every auto-placed one', () => {
    const p = planStage([card('a'), card('b')], FLOAT, STAGES[1]);
    expect(p.cards.b.z).toBeGreaterThan(p.cards.a.z);
    const owned = planStage([card('a', 'tall', { pos: { x: 0, y: 0 } }), card('b'), card('c')], FLOAT, STAGES[1]);
    expect(owned.cards.a.z).toBeGreaterThan(Math.max(owned.cards.b.z, owned.cards.c.z));
  });
});

describe('half, present, narrow (O5, O8, §0 C2)', () => {
  it('half: the centre left, the card right, both full height; the rest in Others', () => {
    const p = planStage([card('a'), card('b'), card('c', 'square')], { mode: 'half', card: 'b' }, STAGES[2]);
    expect(p.cards.b.where).toBe('half');
    expect(p.cards.b.rect.height).toBeCloseTo(p.centre.height, 5);
    expect(p.cards.b.rect.width).toBeCloseTo(p.centre.width, 5);
    expect(p.cards.b.rect.x).toBeGreaterThanOrEqual(p.centre.x + p.centre.width + STAGE.GAP - EPS);
    expect(p.others).toEqual(['a', 'c']);
  });

  it('present: the centre a left column, 1-4 cards on the right, the rest in Others', () => {
    const p = planStage([card('a'), card('b'), card('c'), card('d'), card('e')], { mode: 'present', cards: ['a', 'b', 'c'] }, STAGES[3]);
    expect(p.centre.x).toBe(STAGE.MARGIN);
    expect(p.centre.width).toBeGreaterThanOrEqual(STAGE.PRESENT_MIN);
    expect(p.centre.width).toBeLessThanOrEqual(STAGE.PRESENT_MAX);
    for (const id of ['a', 'b', 'c']) {
      expect(p.cards[id].where).toBe('present');
      expect(p.cards[id].rect.x).toBeGreaterThanOrEqual(p.centre.x + p.centre.width + STAGE.GAP - EPS);
    }
    expect(p.others).toEqual(['d', 'e']);
  });

  it('a view naming no card is the floating layout', () => {
    const p = planStage([card('a')], { mode: 'half', card: 'gone' }, STAGES[1]);
    expect(p.mode).toBe('float');
    expectCentred(p);
  });

  it(`under ${NARROW_STAGE_PX} px every card is in Others and half opens as a sheet over the centre`, () => {
    const s = { width: NARROW_STAGE_PX - 1, height: 700 };
    const flo = planStage([card('a'), card('b', 'square')], FLOAT, s);
    expect(flo.narrow).toBe(true);
    expect(flo.others).toEqual(['a', 'b']);
    const half = planStage([card('a'), card('b', 'square')], { mode: 'half', card: 'a' }, s);
    expect(half.cards.a.where).toBe('sheet');
    const sheet = half.cards.a.rect;
    expect(sheet.x).toBeGreaterThanOrEqual(half.centre.x);
    expect(sheet.x + sheet.width).toBeLessThanOrEqual(half.centre.x + half.centre.width);
  });
});

describe('bands and hit tests (F7, F12, FE1)', () => {
  it('the queue pill sits above the centre, the dock and Others below, in the reserved bands', () => {
    const p = planStage([card('a')], FLOAT, STAGES[1]);
    expect(p.queue.y + p.queue.height).toBeLessThanOrEqual(p.centre.y);
    expect(p.othersRect.y).toBeGreaterThanOrEqual(p.centre.y + p.centre.height);
    expect(p.dock.y).toBeGreaterThanOrEqual(p.centre.y + p.centre.height);
    expect(p.dock.x + p.dock.width).toBeLessThanOrEqual(p.othersRect.x);
  });

  it('the queue band outgrows a narrow centre so a pill keeps one row, centred on it and inside the stage', () => {
    for (const stage of STAGES) {
      for (const view of [FLOAT, { mode: 'half' as const, card: 'a' }]) {
        const p = planStage([card('a'), card('b'), card('c', 'square')], view, stage);
        expect(p.queue.width).toBeGreaterThanOrEqual(Math.min(STAGE.QUEUE_MAX, stage.width - 2 * STAGE.MARGIN) - 0.5);
        expect(p.queue.x).toBeGreaterThanOrEqual(STAGE.MARGIN - 0.5);
        expect(p.queue.x + p.queue.width).toBeLessThanOrEqual(stage.width - STAGE.MARGIN + 0.5);
        if (view.mode === 'float') expect(Math.abs(p.queue.x + p.queue.width / 2 - (p.centre.x + p.centre.width / 2))).toBeLessThanOrEqual(1);
      }
    }
  });

  it('the Others zone is a 168 x 128 target in the bottom-right corner; the centre is the ask target', () => {
    const p = planStage([card('a')], FLOAT, STAGES[1]);
    expect(p.othersZone).toEqual({ x: p.width - 168, y: p.height - 128, width: 168, height: 128 });
    expect(overOthersZone(p, p.width - 4, p.height - 4)).toBe(true);
    expect(overOthersZone(p, p.width / 2, p.height / 2)).toBe(false);
    expect(overCentre(p, p.width / 2, p.height / 2)).toBe(true);
    expect(overCentre(p, 2, 2)).toBe(false);
  });
});

describe('the owner\'s patch, applied locally (§0 C3)', () => {
  const state = () => ({ containers: [card('a'), card('b'), card('c')], view: { mode: 'half', card: 'b' } as SuperView });

  it('a drop writes pos and moves the card to the end (on top); unknown ids are ignored', () => {
    const s = applyLayoutPatch(state(), { cards: [{ id: 'a', pos: { x: 0.2, y: 2 }, order: 'last' }, { id: 'zz', place: 'others' }] });
    expect(s.containers.map((c) => c.id)).toEqual(['b', 'c', 'a']);
    expect(s.containers[2].pos).toEqual({ x: 0.2, y: 1 });
  });

  it('closing the half card returns the view to float; pos null clears the drop', () => {
    const s = applyLayoutPatch(state(), { closed: ['b'] });
    expect(s.view).toEqual({ mode: 'float' });
    const t = applyLayoutPatch({ ...state(), containers: [card('a', 'tall', { pos: { x: 0, y: 0 } })] }, { cards: [{ id: 'a', pos: null }] });
    expect(t.containers[0].pos).toBeUndefined();
  });

  it('an Others click: half on it and back to float', () => {
    const s0 = { containers: [card('a', 'tall', { place: 'others' })], view: FLOAT };
    const s = applyLayoutPatch(s0, { cards: [{ id: 'a', place: 'float' }], view: { mode: 'half', card: 'a' } });
    expect(s.containers[0].place).toBe('float');
    expect(s.view).toEqual({ mode: 'half', card: 'a' });
  });

  it('patchEchoed knows when the server state carries the edit', () => {
    const patch = { cards: [{ id: 'a', pos: { x: 0.5, y: 0.5 } }] };
    expect(patchEchoed(state(), patch)).toBe(false);
    expect(patchEchoed(applyLayoutPatch(state(), patch), patch)).toBe(true);
  });

  it('a push with the same view mode on another card does not echo the owner\'s view (end review r8)', () => {
    const s0 = { containers: [card('a', 'tall'), card('b', 'tall'), card('c', 'square')], view: { mode: 'half' as const, card: 'a' } };
    const toB = { cards: [{ id: 'b', place: 'float' as const }], view: { mode: 'half' as const, card: 'b' } };
    expect(patchEchoed(s0, toB)).toBe(false);
    expect(patchEchoed(applyLayoutPatch(s0, toB), toB)).toBe(true);
    const present = { view: { mode: 'present' as const, cards: ['a', 'c'] } };
    expect(patchEchoed({ ...s0, view: { mode: 'present', cards: ['b'] } }, present)).toBe(false);
    expect(patchEchoed({ ...s0, view: { mode: 'present', cards: ['a', 'c'] } }, present)).toBe(true);
    // A half on a card the server already closed is stored as float: that push carries it.
    const gone = { containers: [card('a', 'tall')], view: FLOAT };
    expect(patchEchoed(gone, toB)).toBe(true);
  });
});
