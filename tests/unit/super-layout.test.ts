/**
 * The hand-over stage (plan-r8 F4, §0 C1/C2/C3/D1, AC Layout, the 2026-10-20 redesign): the Super
 * Agent's window exactly in the centre and the larger share, every card a 1:1 tile on an orbit
 * around it (a side's middle tile stands out, its ends tuck in), groups as one tile, half /
 * present / narrow, the owner's drop kept, overflow DRAWN in Others without touching the record.
 * Invariants, not pixels.
 */
import { describe, it, expect } from 'vitest';
import {
  NARROW_STAGE_PX, STAGE, applyLayoutPatch, dropTargetAt, overCentre, overOthersZone, patchEchoed, planStage,
  posFromRect, preferredCentre, rectFromPos, stageItems, type Rect, type StagePlan,
} from '../../dashboard/src/components/sleepy/super/superLayout.js';
import { MAX_CONTAINERS, MAX_PRESENT, type SuperContainer, type SuperGroup, type SuperView } from '../../dashboard/src/lib/superTypes.js';

const card = (id: string, shape: SuperContainer['shape'] = 'tall', extra: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id, kind: shape === 'tall' ? 'chat' : 'insight', ref: `ref-${id}`, shape, place: 'float', ...extra });
const FLOAT: SuperView = { mode: 'float' };
const EPS = 0.5;
const T = STAGE.TILE;

/** The stage a window of this size leaves, as the app draws it handed over: the 56 px rail and
 *  the 86 px of header (title bar + the Chat toolbar) off (measured in the verify's screenshots). */
const STAGES = [
  { width: 1224, height: 714 },   // a 1280 x 800 window
  { width: 1384, height: 814 },   // 1440 x 900
  { width: 1544, height: 914 },   // 1600 x 1000
  { width: 1864, height: 994 },   // 1920 x 1080
];

const fiveTallTwoSquare = () => [card('a'), card('b'), card('c'), card('d'), card('e'), card('s1', 'square'), card('s2', 'square')];

const gapBetween = (a: Rect, b: Rect) => {
  const dx = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
  const dy = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height));
  return Math.max(dx, dy);
};
const inStage = (p: StagePlan, r: Rect) =>
  r.x >= -EPS && r.y >= -EPS && r.x + r.width <= p.width + EPS && r.y + r.height <= p.height + EPS;
const floats = (p: StagePlan) => Object.values(p.cards).filter((c) => c.where === 'float');
const sideOf = (p: StagePlan, r: Rect) => (r.x + r.width / 2 < p.width / 2 ? 'L' : 'R');

/** Centred across; down the stage it starts under the job bar's band and runs to the bottom
 *  margin, or stops above the bottom band when that band holds something (owner 2026-10-21). */
function expectCentred(p: StagePlan, banded = p.narrow || p.others.length > 0) {
  const left = p.centre.x;
  const right = p.width - (p.centre.x + p.centre.width);
  const top = p.centre.y;
  const bottom = p.height - (p.centre.y + p.centre.height);
  expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
  expect(top).toBeCloseTo(STAGE.MARGIN + STAGE.BAND, 6);
  expect(bottom).toBeCloseTo(banded ? STAGE.MARGIN + STAGE.BAND : STAGE.MARGIN, 6);
}

describe('floating tiles (O1, 2026-10-20: small 1:1 cards)', () => {
  for (const s of STAGES) {
    it(`5 chats + 2 others at ${s.width}x${s.height}: centred, every card one ${T} px tile, gaps >= 24`, () => {
      const p = planStage(fiveTallTwoSquare(), FLOAT, s);
      expect(p.narrow).toBe(false);
      expectCentred(p);
      const floating = floats(p);
      // 1280 holds three a side (the seventh in Others); from 1440 the taller centre's columns
      // hold them all (owner 2026-10-21: the centre takes the height while the band is empty).
      expect(floating.length + p.others.length).toBe(7);
      expect(floating).toHaveLength(s.width >= 1300 ? 7 : 6);
      const rects = floating.map((c) => c.rect);
      for (const c of floating) {
        expect(c.rect.width).toBe(T);
        expect(c.rect.height).toBe(T);
        expect(c.shape).toBe('square');
        expect(gapBetween(c.rect, p.centre)).toBeGreaterThanOrEqual(STAGE.GAP - EPS);
        expect(inStage(p, c.rect)).toBe(true);
        expect(c.rect.x).toBeGreaterThanOrEqual(STAGE.MARGIN - EPS);
        expect(c.rect.x + c.rect.width).toBeLessThanOrEqual(p.width - STAGE.MARGIN + EPS);
        expect(c.rect.y).toBeGreaterThanOrEqual(p.centre.y - EPS);
        expect(c.rect.y + c.rect.height).toBeLessThanOrEqual(p.centre.y + p.centre.height + EPS);
      }
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        expect(gapBetween(rects[i], rects[j])).toBeGreaterThanOrEqual(STAGE.GAP - EPS);
      }
    });
  }

  it('the orbit: each side\'s column sits on the midline, its ends next to the centre, its middle standing out', () => {
    for (const s of STAGES) for (let n = 2; n <= 10; n++) {
      const p = planStage(Array.from({ length: n }, (_, i) => card(`k${i}`)), FLOAT, s);
      const label = `${n} cards at ${s.width}`;
      const mid = p.centre.y + p.centre.height / 2;
      for (const side of ['L', 'R'] as const) {
        const inner = side === 'L' ? p.centre.x - STAGE.GAP - T : p.centre.x + p.centre.width + STAGE.GAP;
        // The inner column: the tiles whose x is within the orbit's depth of the inner edge.
        const col = floats(p).map((c) => c.rect).filter((r) => sideOf(p, r) === side && Math.abs(r.x - inner) <= STAGE.ORBIT_DEPTH + EPS)
          .sort((a, b) => a.y - b.y);
        if (col.length < 2) continue;
        // One gap between the tiles of a column; the column centred on the centre's midline.
        for (let i = 1; i < col.length; i++) expect(Math.abs(col[i].y - (col[i - 1].y + T) - STAGE.GAP), label).toBeLessThanOrEqual(EPS);
        expect(Math.abs((col[0].y + col[col.length - 1].y + T) / 2 - mid), label).toBeLessThanOrEqual(1);
        // The ends tuck in, one gap from the centre.
        for (const end of [col[0], col[col.length - 1]]) expect(Math.abs(end.x - inner), label).toBeLessThanOrEqual(EPS);
        // Nearer the midline, farther out (never into the centre's gap).
        const out = (r: Rect) => (side === 'L' ? inner - r.x : r.x - inner);
        for (const r of col) expect(out(r), label).toBeGreaterThanOrEqual(-EPS);
        const byDist = [...col].sort((a, b) => Math.abs(a.y + T / 2 - mid) - Math.abs(b.y + T / 2 - mid));
        for (let i = 1; i < byDist.length; i++) expect(out(byDist[i - 1]) + EPS, label).toBeGreaterThanOrEqual(out(byDist[i]));
        if (col.length >= 3) expect(out(byDist[0]), `${label}: the middle stands out`).toBeGreaterThan(0);
      }
    }
  });

  it('the plan carries each side\'s arc, and it runs through the tiles\' centres', () => {
    const p = planStage(Array.from({ length: 7 }, (_, i) => card(`k${i}`)), FLOAT, STAGES[2]);
    expect(p.orbit.map((a) => a.side).sort()).toEqual(['left', 'right']);
    for (const a of p.orbit) {
      const xAt = (y: number) => a.x0 + a.dir * a.depth * (1 - ((y - a.cy) / a.ymax) ** 2);
      const mine = floats(p).filter((c) => (a.side === 'left' ? c.rect.x < p.centre.x : c.rect.x > p.centre.x));
      for (const c of mine) expect(Math.abs(xAt(c.rect.y + T / 2) - (c.rect.x + T / 2))).toBeLessThanOrEqual(EPS);
    }
    // A side with one tile has no arc to draw.
    expect(planStage([card('a'), card('b')], FLOAT, STAGES[2]).orbit).toEqual([]);
  });

  it('a lone tile, and two a side, stand straight next to the centre on its midline', () => {
    for (const n of [2, 4]) {
      const p = planStage(Array.from({ length: n }, (_, i) => card(`k${i}`)), FLOAT, STAGES[1]);
      const mid = p.centre.y + p.centre.height / 2;
      for (const c of floats(p)) {
        const inner = c.rect.x < p.centre.x ? p.centre.x - STAGE.GAP - T : p.centre.x + p.centre.width + STAGE.GAP;
        expect(Math.abs(c.rect.x - inner)).toBeLessThanOrEqual(EPS);
      }
      const left = floats(p).filter((c) => c.rect.x < p.centre.x).map((c) => c.rect);
      expect(Math.abs((Math.min(...left.map((r) => r.y)) + Math.max(...left.map((r) => r.y + T))) / 2 - mid)).toBeLessThanOrEqual(1);
    }
  });

  it('alternates left/right in record order', () => {
    const p = planStage([card('a', 'square'), card('b', 'square')], FLOAT, STAGES[2]);
    expect(p.cards.a.rect.x + p.cards.a.rect.width).toBeLessThanOrEqual(p.centre.x);
    expect(p.cards.b.rect.x).toBeGreaterThanOrEqual(p.centre.x + p.centre.width);
  });

  it('an outer column opens only once the inner one is full, and only where the side has the room', () => {
    const many = Array.from({ length: MAX_CONTAINERS }, (_, i) => card(`k${i}`));
    const wide = planStage(many, FLOAT, STAGES[3]);
    expect(wide.others).toEqual([]);
    const xs = new Set(floats(wide).filter((c) => c.rect.x < wide.centre.x).map((c) => Math.round(c.rect.x)));
    expect(xs.size).toBeGreaterThan(1);
    const narrowish = planStage(many, FLOAT, STAGES[0]);
    expect(narrowish.others.length).toBeGreaterThan(0);
    expect(floats(narrowish).every((c) => c.rect.x >= STAGE.MARGIN - EPS)).toBe(true);
  });

  it('an empty stage is just the centre, at its preferred width', () => {
    const p = planStage([], FLOAT, STAGES[3]);
    expectCentred(p);
    expect(p.centre.width).toBeCloseTo(preferredCentre(STAGES[3].width), 5);
  });

  it('a card that fits nowhere is DRAWN in Others; the record stays float', () => {
    const many = Array.from({ length: MAX_CONTAINERS }, (_, i) => card(`k${i}`));
    const p = planStage(many, FLOAT, { width: 1100, height: 600 });
    expect(p.others.length).toBeGreaterThan(0);
    for (const id of p.others) expect(p.cards[id].where).toBe('others');
    expect(many.every((c) => c.place === 'float')).toBe(true);
    const floating = floats(p).map((c) => c.rect);
    for (let i = 0; i < floating.length; i++) for (let j = i + 1; j < floating.length; j++) {
      expect(gapBetween(floating[i], floating[j])).toBeGreaterThanOrEqual(STAGE.GAP - EPS);
    }
  });

  it('what does not fit goes to Others, the last ones first; a tile never shrinks', () => {
    const many = Array.from({ length: MAX_CONTAINERS }, (_, i) => card(`k${i}`));
    for (const s of STAGES.slice(0, 3)) {
      const p = planStage(many, FLOAT, s);
      expect(p.others.length).toBeGreaterThan(0);
      for (const c of floats(p)) expect(c.rect.width).toBe(T);
      expect(p.others).toEqual(many.map((c) => c.id).filter((id) => p.others.includes(id)));
      expect(p.others).toContain(`k${MAX_CONTAINERS - 1}`);
    }
  });

  it('chats stay on the stage longest: other cards go to Others first', () => {
    // Five other cards opened first, then five chats delegated: the chats are last in the record.
    const list = [...['t', 'k', 'w', 'i', 'b2'].map((id) => card(id, 'square')), ...['a', 'b', 'c', 'd', 'e'].map((id) => card(id))];
    for (const s of STAGES) {
      const p = planStage(list, FLOAT, s);
      const floating = floats(p).map((c) => c.id);
      expect(floating.length).toBeGreaterThanOrEqual(5);
      for (const id of ['a', 'b', 'c', 'd', 'e']) expect(floating, `${id} at ${s.width}`).toContain(id);
    }
  });

  it('a card the record stacks in Others is drawn there', () => {
    const p = planStage([card('a'), card('b', 'tall', { place: 'others' })], FLOAT, STAGES[1]);
    expect(p.others).toEqual(['b']);
    expect(p.cards.b.rect).toEqual(p.othersRect);
  });

  it('never lays out more than the record\'s 12 cards plus the 4 a view may present beside their group', () => {
    const many = Array.from({ length: MAX_CONTAINERS + MAX_PRESENT + 1 }, (_, i) => card(`k${i}`, 'square'));
    expect(Object.keys(planStage(many, FLOAT, STAGES[3]).cards)).toHaveLength(MAX_CONTAINERS + MAX_PRESENT);
  });
});

describe('the centre takes the larger share and never moves (stage v2, 2026-10-20)', () => {
  it('56% of the stage (within its floor and ceiling), centred, whatever opens or closes', () => {
    for (const s of STAGES) for (let n = 0; n <= MAX_CONTAINERS; n++) {
      const p = planStage(Array.from({ length: n }, (_, i) => card(`k${i}`, i % 2 ? 'square' : 'tall')), FLOAT, s);
      expect(p.centre.width, `${n} cards at ${s.width}`).toBeCloseTo(preferredCentre(s.width), 6);
      expect(p.centre.width / s.width).toBeGreaterThanOrEqual(0.55);
      expectCentred(p);
    }
  });
});

describe('groups on the stage (2026-10-20)', () => {
  const eight = () => [card('a'), card('b'), card('c'), card('s1', 'square'), card('d'), card('s2', 'square'), card('e'), card('f')];
  const grouped = (list: SuperContainer[], groups: SuperGroup[], view: SuperView = FLOAT) => stageItems(list, groups, view);

  it('a group is ONE tile at its first card\'s place in the record; its cards are not on the stage', () => {
    const list = eight();
    const g: SuperGroup = { id: 'grp-1', name: 'Forms', cards: ['b', 'f'], place: 'float' };
    const items = grouped(list, [g]);
    expect(items.map((i) => i.id)).toEqual(['a', 'grp-1', 'c', 's1', 'd', 's2', 'e']);
    expect(items[1]).toMatchObject({ kind: 'group', slot: 1, shape: 'square' });
    const p = planStage(items, FLOAT, STAGES[2]);
    expect(p.cards['grp-1'].where).toBe('float');
    expect(p.cards['grp-1'].rect.width).toBe(T);
    expect(p.cards.b).toBeUndefined();
    expect(p.cards.f).toBeUndefined();
  });

  it('grouping two cards moves no other card to the other side', () => {
    const list = eight();
    for (const s of STAGES) {
      const before = planStage(list, FLOAT, s);
      for (const pair of [['b', 'f'], ['c', 'a'], ['s1', 'd'], ['e', 'b']]) {
        const after = planStage(grouped(list, [{ id: 'grp-x', name: 'X', cards: pair, place: 'float' }]), FLOAT, s);
        for (const c of floats(before)) {
          if (pair.includes(c.id) || after.cards[c.id]?.where !== 'float') continue;
          expect(sideOf(after, after.cards[c.id].rect), `${pair} at ${s.width}: ${c.id}`).toBe(sideOf(before, c.rect));
        }
        // The group stands on its first card's side.
        if (before.cards[pair[0]].where === 'float' && after.cards['grp-x'].where === 'float') {
          expect(sideOf(after, after.cards['grp-x'].rect)).toBe(sideOf(before, before.cards[pair[0]].rect));
        }
      }
    }
  });

  it('a group keeps its own place and drop: in Others it is drawn there, dropped it stands where it was put', () => {
    const list = eight();
    const inOthers = planStage(grouped(list, [{ id: 'grp-1', name: 'X', cards: ['a', 'b'], place: 'others' }]), FLOAT, STAGES[2]);
    expect(inOthers.others).toContain('grp-1');
    const dropped = planStage(grouped(list, [{ id: 'grp-1', name: 'X', cards: ['a', 'b'], place: 'float', pos: { x: 0, y: 0 } }]), FLOAT, STAGES[2]);
    expect(dropped.cards['grp-1'].owner).toBe(true);
    expect(dropped.cards['grp-1'].rect).toMatchObject({ x: dropped.free.x, y: dropped.free.y, width: T, height: T });
  });

  it('a grouped card shown side by side is drawn there; its group waits in Others', () => {
    const list = eight();
    const g: SuperGroup = { id: 'grp-1', name: 'X', cards: ['a', 'b'], place: 'float' };
    const view: SuperView = { mode: 'half', card: 'b' };
    const p = planStage(grouped(list, [g], view), view, STAGES[2]);
    expect(p.cards.b.where).toBe('half');
    expect(p.cards['grp-1'].where).toBe('others');
  });

  it('12 cards, a group of two presented beside two others: every card has a place (end review)', () => {
    const list = Array.from({ length: MAX_CONTAINERS }, (_, i) => card(`c${i}`));
    const g: SuperGroup = { id: 'grp-1', name: 'X', cards: ['c0', 'c1'], place: 'float' };
    const view: SuperView = { mode: 'present', cards: ['c0', 'c1', 'c2', 'c3'] };
    const p = planStage(grouped(list, [g], view), view, STAGES[2]);
    for (const c of list) expect(p.cards[c.id], c.id).toBeDefined();
    for (const id of ['c0', 'c1', 'c2', 'c3']) expect(p.cards[id].where).toBe('present');
    expect(p.cards['grp-1'].where).toBe('others');
    expect(p.others).toContain('c11');
  });

  it('the drop target is the tile under the pointer, never the held card itself; a held group groups with nothing', () => {
    const list = eight();
    const p = planStage(grouped(list, [{ id: 'grp-1', name: 'X', cards: ['e', 'f'], place: 'float' }]), FLOAT, STAGES[2]);
    const at = (id: string) => ({ x: p.cards[id].rect.x + T / 2, y: p.cards[id].rect.y + T / 2 });
    expect(dropTargetAt(p, at('c').x, at('c').y, 'a')).toBe('c');
    expect(dropTargetAt(p, at('grp-1').x, at('grp-1').y, 'a')).toBe('grp-1');
    expect(dropTargetAt(p, at('a').x, at('a').y, 'a')).toBeNull();
    expect(dropTargetAt(p, at('c').x, at('c').y, 'grp-1')).toBeNull();
    expect(dropTargetAt(p, p.centre.x + 10, p.centre.y + 10, 'a')).toBeNull();
  });

  it('the owner\'s group patch, applied locally: a drop on a card groups at the target, a drop on a group joins, out and Ungroup', () => {
    const list = [card('a'), card('b', 'tall', { pos: { x: 0.9, y: 0.2 } }), card('c'), card('d')];
    const s0 = { containers: list, groups: [] as SuperGroup[], view: FLOAT };
    const s1 = applyLayoutPatch(s0, { group: { id: 'grp-o1', cards: ['b', 'a'], name: 'Grup 1' } });
    expect(s1.groups).toEqual([{ id: 'grp-o1', name: 'Grup 1', cards: ['b', 'a'], place: 'float', pos: { x: 0.9, y: 0.2 } }]);
    expect(patchEchoed(s1, { group: { id: 'grp-o1', cards: ['b', 'a'], name: 'Grup 1' } })).toBe(true);
    expect(patchEchoed(s0, { group: { id: 'grp-o1', cards: ['b', 'a'], name: 'Grup 1' } })).toBe(false);
    const s2 = applyLayoutPatch(s1, { group: { id: 'grp-o1', cards: ['c'] } });
    expect(s2.groups[0].cards).toEqual(['b', 'a', 'c']);
    const s3 = applyLayoutPatch(s2, { leave: ['a'], cards: [{ id: 'a', place: 'float', pos: { x: 0.1, y: 0.5 } }] });
    expect(s3.groups[0].cards).toEqual(['b', 'c']);
    expect(s3.containers.find((c) => c.id === 'a')?.pos).toEqual({ x: 0.1, y: 0.5 });
    expect(patchEchoed(s2, { leave: ['a'] })).toBe(false);
    expect(patchEchoed(s3, { leave: ['a'] })).toBe(true);
    const s4 = applyLayoutPatch(s3, { ungroup: ['grp-o1'] });
    expect(s4.groups).toEqual([]);
    // The first card takes the group's spot.
    expect(s4.containers.find((c) => c.id === 'b')?.pos).toEqual({ x: 0.9, y: 0.2 });
    expect(patchEchoed(s4, { ungroup: ['grp-o1'] })).toBe(true);
    // A cards entry may move a whole group.
    const s5 = applyLayoutPatch(s2, { cards: [{ id: 'grp-o1', place: 'others' }] });
    expect(s5.groups[0].place).toBe('others');
    expect(patchEchoed(s5, { cards: [{ id: 'grp-o1', place: 'others' }] })).toBe(true);
  });
});

describe('the owner\'s drop (O3, §0 C-minors, D1)', () => {
  it('a dropped card is drawn where it was dropped, and pos round-trips through the free area', () => {
    const p0 = planStage([card('a'), card('b', 'square')], FLOAT, STAGES[2]);
    // Flush with the left margin: the side is one card wide, so the gap to the centre stays clear.
    const r = { x: p0.free.x, y: p0.free.y + 30, width: p0.cards.b.rect.width, height: p0.cards.b.rect.height };
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
      // Two cards off the same side: the stage rebalances by moving exactly one card (six cards,
      // so every one of them floats at every size).
      const six = list.slice(0, 6);
      const six0 = sides(six, st);
      expect(six0.size).toBe(6);
      const lopsided = sides(to(six, ['a', 'c'], 'others'), st);
      const count = (m: Map<string, string>, s: string) => [...m.values()].filter((v) => v === s).length;
      expect(Math.abs(count(lopsided, 'L') - count(lopsided, 'R'))).toBeLessThanOrEqual(1);
      expect([...lopsided].filter(([k, s]) => six0.get(k) !== s)).toHaveLength(1);
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
  it('the job bar sits above the centre; with terminals in the dock, the dock and Others sit below it, in the reserved band', () => {
    const p = planStage([card('a')], FLOAT, STAGES[1], { terminals: 2 });
    expect(p.queue.y + p.queue.height).toBeLessThanOrEqual(p.centre.y);
    expect(p.othersRect.y).toBeGreaterThanOrEqual(p.centre.y + p.centre.height);
    expect(p.dock.y).toBeGreaterThanOrEqual(p.centre.y + p.centre.height);
    expect(p.dock.x + p.dock.width).toBeLessThanOrEqual(p.othersRect.x);
    expectCentred(p, true);
  });

  it('the centre takes the height while the bottom band is empty, its width unchanged (owner 2026-10-21)', () => {
    for (const s of STAGES) {
      const tall = planStage([card('a'), card('b')], FLOAT, s);
      const banded = planStage([card('a'), card('b')], FLOAT, s, { terminals: 1 });
      expectCentred(tall, false);
      expect(tall.centre.height - banded.centre.height).toBeCloseTo(STAGE.BAND, 6);
      expect(tall.centre.width).toBeCloseTo(banded.centre.width, 6);
      expect(tall.centre.x).toBeCloseTo(banded.centre.x, 6);
      // The job bar never meets the centre; the tiles stay inside the centre's height.
      expect(tall.queue.y + tall.queue.height).toBeLessThanOrEqual(tall.centre.y);
      for (const c of floats(tall)) expect(c.rect.y + c.rect.height).toBeLessThanOrEqual(tall.centre.y + tall.centre.height + EPS);
    }
  });

  it('a card drawn in Others reserves the band again (the stack never sits under a tile or the centre)', () => {
    const many = Array.from({ length: 12 }, (_, i) => card(`c${i}`));
    const p = planStage(many, FLOAT, STAGES[0]);
    expect(p.others.length).toBeGreaterThan(0);
    expectCentred(p, true);
    expect(p.othersRect.y).toBeGreaterThanOrEqual(p.centre.y + p.centre.height);
    for (const c of floats(p)) expect(c.rect.y + c.rect.height).toBeLessThanOrEqual(p.othersRect.y - STAGE.GAP / 2 + EPS);
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

  it('the queue band keeps one width when the stage resizes (no re-fit of the pill mid-resize, stage v2)', () => {
    const widths = new Set<number>();
    for (const width of [1100, 1224, 1384, 1424, 1544, 1864, 2400]) {
      for (const view of [FLOAT, { mode: 'half' as const, card: 'a' }]) {
        widths.add(planStage([card('a'), card('b')], view, { width, height: 900 }).queue.width);
      }
    }
    expect([...widths]).toEqual([STAGE.QUEUE_MAX]);
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
