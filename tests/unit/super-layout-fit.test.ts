/**
 * The stage in a windowed app (owner 2026-10-28, a ~1140x710 window):
 *
 *  - the float centre runs the stage's height, margin to margin: the Others stack and the agenda's
 *    pill narrow into the side room beside it instead of taking its height; only the terminals dock
 *    (or the queue pill on top) keeps a band;
 *  - the agenda sizes itself: its size (the default or the owner's) is its largest, drawn as wide
 *    as leaves the centre its FLOOR in the middle (owner 2026-10-29, "Agenda büyümüyor?": the full
 *    list whenever there is room, the counts only on a window too small for it); other sized cards
 *    keep their rule;
 *  - no floating card overlaps another, the agenda or the centre, none sits off the stage, and every
 *    card is either on the stage or in Others, at every size the window is dragged through.
 */
import { describe, it, expect } from 'vitest';
import {
  STAGE, findFree, planStage, preferredCentre, stageItems, type Rect, type StagePlan,
} from '../../dashboard/src/components/sleepy/super/superLayout.js';
import type { ContainerSize, SuperContainer } from '../../dashboard/src/lib/superTypes.js';

const FLOAT = { mode: 'float' as const };
const EPS = 1e-6;
/** The stage a window of this size leaves (the app's rail and head taken off), and the owner's. */
const WINDOWS = { small: { width: 1090, height: 640 }, owner: { width: 1224, height: 717 }, mid: { width: 1390, height: 830 }, large: { width: 1870, height: 1010 } };
/** The stage of the owner's ~1630x1000 window in his 2026-10-29 video (measured in the app). */
const OWNER_1630 = { width: 1574, height: 914 };

const overlaps = (a: Rect, b: Rect, gap = 0) =>
  a.x < b.x + b.width + gap - EPS && b.x < a.x + a.width + gap - EPS && a.y < b.y + b.height + gap - EPS && b.y < a.y + a.height + gap - EPS;
const floats = (p: StagePlan) => Object.values(p.cards).filter((c) => c.where === 'float');
const agenda = (size?: ContainerSize, extra: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id: 'ag', kind: 'agenda', ref: 'agenda', shape: 'square', place: 'float', ...(size ? { size } : {}), ...extra } as SuperContainer);
const card = (id: string, extra: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id, kind: 'chat', ref: `r-${id}`, shape: 'square', place: 'float', ...extra } as SuperContainer);
const plan = (cs: SuperContainer[], stage: { width: number; height: number }, opts = {}) => planStage(stageItems(cs, [], FLOAT), FLOAT, stage, opts);

/** Every invariant of a float stage: no overlap (a gap apart), clear of the centre, on the stage, nothing lost. */
function expectSound(p: StagePlan, cs: readonly SuperContainer[], label: string) {
  const fl = floats(p);
  for (const c of fl) {
    expect(overlaps(c.rect, p.centre), `${label}: ${c.id} over the centre`).toBe(false);
    expect(c.rect.x >= -EPS && c.rect.y >= -EPS && c.rect.x + c.rect.width <= p.width + EPS && c.rect.y + c.rect.height <= p.height + EPS, `${label}: ${c.id} off the stage`).toBe(true);
    for (const d of fl) if (c.id < d.id) expect(overlaps(c.rect, d.rect, STAGE.GAP - 1), `${label}: ${c.id} overlaps ${d.id}`).toBe(false);
  }
  const shown = cs.filter((c) => c.place === 'float' && !c.min).map((c) => c.id);
  for (const id of shown) expect(p.cards[id]?.where === 'float' || p.others.includes(id), `${label}: ${id} is nowhere`).toBe(true);
  // The Others stack and the agenda's pill never sit under the centre.
  if (p.others.length) expect(overlaps(p.othersRect, p.centre), `${label}: Others under the centre`).toBe(false);
}

describe('the centre takes the stage\'s height in a window (problem 1)', () => {
  it('with cards in Others the stack narrows beside the centre and the centre still runs margin to margin', () => {
    for (const [name, s] of Object.entries(WINDOWS)) {
      const cs = [agenda('medium'), card('a'), card('b'), card('c'), card('d'), ...Array.from({ length: 4 }, (_, i) => card(`o${i}`, { place: 'others' }))];
      const p = plan(cs, s);
      expect(p.others.length, name).toBeGreaterThan(0);
      expect(p.centre.y, name).toBeCloseTo(STAGE.MARGIN, 6);
      expect(p.centre.y + p.centre.height, name).toBeCloseTo(s.height - STAGE.MARGIN, 6);
      expect(p.othersRect.width, name).toBeGreaterThanOrEqual(STAGE.OTHERS_MIN_W - EPS);
      expect(p.othersRect.x, name).toBeGreaterThanOrEqual(p.centre.x + p.centre.width + STAGE.GAP - EPS);
      expect(p.othersRect.x + p.othersRect.width, name).toBeCloseTo(s.width - STAGE.MARGIN, 6);
      expect(p.othersZone.x, name).toBeGreaterThanOrEqual(p.centre.x + p.centre.width + STAGE.GAP - EPS);
      expectSound(p, cs, name);
    }
  });

  it('a centre pushed right by a wide left side still takes the height (the owner\'s screenshot)', () => {
    const cs = [card('pic', { kind: 'image', size: 'medium', sizeBy: 'owner' }), card('a'), card('b'), card('o', { place: 'others' })];
    const p = plan(cs, WINDOWS.owner);
    expect(p.centre.x + p.centre.width / 2).toBeGreaterThan(WINDOWS.owner.width / 2 + 1);
    expect(p.centre.height).toBeCloseTo(WINDOWS.owner.height - 2 * STAGE.MARGIN, 6);
  });

  it('the minimised agenda\'s pill narrows beside the centre too', () => {
    const cs = [agenda('large', { min: true }), card('a'), card('b'), card('c')];
    const p = plan(cs, WINDOWS.small, { agendaPill: 'ag' });
    expect(p.centre.height).toBeCloseTo(WINDOWS.small.height - 2 * STAGE.MARGIN, 6);
    expect(p.agendaPill.x + p.agendaPill.width).toBeLessThanOrEqual(p.centre.x - STAGE.GAP + EPS);
  });

  it('the terminals dock runs under the centre: the bottom band stays; the queue pill keeps the top one', () => {
    const p = plan([card('a'), card('b')], WINDOWS.small, { terminals: 1, queueUp: true });
    expect(p.centre.y).toBeGreaterThanOrEqual(p.queue.y + p.queue.height - EPS);
    expect(p.centre.y + p.centre.height).toBeLessThanOrEqual(p.dock.y + EPS);
  });
});

describe('the agenda sizes itself (problem 2)', () => {
  it('on a small window it is the 1x1 counts and the centre keeps its preferred width, centred', () => {
    for (const size of ['medium', 'large', 'wide'] as const) {
      const p = plan([agenda(size, { sizeBy: 'owner' }), card('a'), card('b')], WINDOWS.small);
      expect(p.cards.ag.size, size).toBe('small');
      expect(p.centre.width, size).toBeCloseTo(preferredCentre(WINDOWS.small.width), 6);
      expect(p.centre.x + p.centre.width / 2, size).toBeCloseTo(WINDOWS.small.width / 2, 6);
    }
  });

  it('it grows whenever there is room, never past its own size, never taking the centre under its floor', () => {
    const at = (size: ContainerSize, s: { width: number; height: number }) => plan([agenda(size), card('a'), card('b'), card('c')], s);
    expect(at('large', WINDOWS.large).cards.ag.size).toBe('large');
    expect(at('medium', WINDOWS.large).cards.ag.size).toBe('medium');
    // A 1440 window (owner 2026-10-29): two tiles a side still leave the centre its floor, so the list.
    expect(at('medium', WINDOWS.mid).cards.ag.size).toBe('medium');
    expect(at('large', WINDOWS.mid).cards.ag.size).toBe('large');
    for (const [name, s] of Object.entries({ ...WINDOWS, owner1630: OWNER_1630 })) {
      for (const size of ['medium', 'large', 'wide'] as const) {
        const p = at(size, s);
        expect(p.centre.width, `${name}/${size}`).toBeGreaterThanOrEqual(STAGE.CENTRE_MIN - EPS);
        expect(p.centre.x + p.centre.width / 2, `${name}/${size} centred`).toBeCloseTo(s.width / 2, 6);
        expectSound(p, [agenda(size), card('a'), card('b'), card('c')], `${name}/${size}`);
      }
    }
  });

  it('on the owner\'s ~1630x1000 window the default agenda is its full list, beside his chats and a group (owner 2026-10-29)', () => {
    // His stage: two chat cards and a group on the left with the agenda, the default (large) agenda.
    const cs = [card('c1'), card('c2'), agenda('large'), card('p1', { kind: 'image' }), card('p2', { kind: 'image' }), card('t1', { kind: 'task' })];
    const groups = [{ id: 'grp-changes', name: 'Changes', cards: ['p1', 'p2'] }];
    const p = planStage(stageItems(cs, groups as never, FLOAT), FLOAT, OWNER_1630, {});
    expect(p.cards.ag.where).toBe('float');
    expect(p.cards.ag.size).toBe('large');
    expect(p.centre.width).toBeGreaterThanOrEqual(STAGE.CENTRE_MIN - EPS);
    // The owner's own size is kept the same way: large drawn large, medium drawn medium.
    for (const size of ['large', 'medium'] as const) {
      const q = plan([agenda(size, { sizeBy: 'owner' }), card('a'), card('b')], OWNER_1630);
      expect(q.cards.ag.size, size).toBe(size);
    }
  });

  it('on a touch remote (a lower floor) the agenda never pushes the centre off the middle (review r1)', () => {
    for (const width of [1264, 1280, 1300, 1632, 1700]) {
      for (const size of ['large', 'wide'] as const) {
        const cs = [agenda(size), card('a'), card('b'), card('c')];
        const p = plan(cs, { width, height: 900 }, { centreMin: 480 });
        expect(p.centre.x + p.centre.width / 2, `${width}/${size}`).toBeCloseTo(width / 2, 6);
        expectSound(p, cs, `touch ${width}/${size}`);
      }
    }
  });

  it('a side crowded with cards never pays for the agenda\'s list: the centre stays as centred and no more cards go to Others than with the counts (review r2)', () => {
    const offMid = (p: StagePlan) => Math.abs(p.centre.x + p.centre.width / 2 - p.width / 2);
    // The reviewer's cases: the default agenda and ten chats at a 1440 window and the owner's 1630.
    for (const s of [WINDOWS.mid, OWNER_1630, { width: 1500, height: 900 }]) {
      const cs = [agenda('large'), ...Array.from({ length: 10 }, (_, i) => card(`c${i}`))];
      const p = plan(cs, s);
      expect(offMid(p), `${s.width}`).toBeLessThan(1e-6);
      expect(p.others, `${s.width}`).toEqual([]);
      expectSound(p, cs, `crowded ${s.width}`);
    }
    // The sweep: against the same stage with the agenda as its 1x1 counts, never worse on both.
    for (let width = 900; width <= 2400; width += 37) {
      for (const height of [640, 830, 1010]) {
        for (let n = 0; n <= 10; n += 2) {
          for (const size of ['medium', 'large', 'wide'] as const) {
            for (const centreMin of [undefined, 480]) {
              const chats = Array.from({ length: n }, (_, i) => card(`c${i}`));
              const opts = centreMin ? { centreMin } : {};
              const p = plan([agenda(size), ...chats], { width, height }, opts);
              const q = plan([agenda('small'), ...chats], { width, height }, opts);
              const at = `${width}x${height} n=${n} ${size} ${centreMin ?? 'desk'}`;
              // A sized stage may trade the middle for keeping cards out of Others (its old rule);
              // the agenda's list never costs both, and never costs a card.
              expect(p.others.length, at).toBeLessThanOrEqual(q.others.length);
              expect(offMid(p) <= offMid(q) + 1e-6 || p.others.length < q.others.length, at).toBe(true);
              expect(p.centre.width, at).toBeGreaterThanOrEqual(Math.min(q.centre.width, STAGE.CENTRE_MIN) - 1e-6);
            }
          }
        }
      }
    }
  });

  it('a window too small for the list beside the centre still draws the counts (1140x710)', () => {
    for (const size of ['large', 'medium'] as const) {
      const p = plan([agenda(size, { sizeBy: 'owner' }), card('a'), card('b')], WINDOWS.small);
      expect(p.cards.ag.size, size).toBe('small');
      expect(p.centre.width, size).toBeGreaterThanOrEqual(STAGE.CENTRE_MIN - EPS);
    }
  });

  it('another card the owner sized keeps the old rule: the centre narrows for it, down to its floor', () => {
    const p = plan([card('pic', { kind: 'image', size: 'medium', sizeBy: 'owner' }), card('a')], WINDOWS.owner);
    expect(p.cards.pic.size).toBe('medium');
    expect(p.centre.width).toBeLessThan(preferredCentre(WINDOWS.owner.width));
    expect(p.centre.width).toBeGreaterThanOrEqual(STAGE.CENTRE_MIN - EPS);
  });

  it('a side another card already widened lends the agenda its width for free', () => {
    const cs = [agenda('medium'), card('a'), card('pic', { kind: 'image', size: 'medium', sizeBy: 'owner' })];
    // ag (slot 0) and pic (slot 2) are both on the left.
    const p = plan(cs, WINDOWS.owner);
    expect(p.cards.pic.size).toBe('medium');
    expect(p.cards.ag.size).toBe('medium');
  });
});

describe('floating cards place themselves (problem 3)', () => {
  it('two of the owner\'s cards on one spot: the one he dropped later keeps it, the other moves clear', () => {
    const cs = [card('a', { pos: { x: 0.02, y: 0.3 } }), card('b', { pos: { x: 0.02, y: 0.32 } }), card('c'), card('d')];
    for (const recent of [['a', 'b'], ['b', 'a']]) {
      const p = plan(cs, WINDOWS.mid, { recent });
      const kept = recent[1];
      const free = { ...p.free };
      const want = { x: free.x + Math.max(0, free.width - 160) * 0.02, y: free.y + Math.max(0, free.height - 160) * (kept === 'a' ? 0.3 : 0.32) };
      expect(p.cards[kept].rect.x).toBeCloseTo(want.x, 6);
      expect(p.cards[kept].rect.y).toBeCloseTo(want.y, 6);
      expectSound(p, cs, `recent ${recent}`);
    }
  });

  it('an owner card too wide for its side never lands on the centre', () => {
    const cs = [card('pic', { kind: 'image', size: 'large', sizeBy: 'owner', pos: { x: 0.3, y: 0.2 } }), card('a'), card('b')];
    for (const [name, s] of Object.entries(WINDOWS)) expectSound(plan(cs, s), cs, name);
  });

  it('a card the owner covers moves to free space before it goes to Others', () => {
    // Every owner card dropped on the left column: the auto cards there find room elsewhere.
    const cs = [card('a'), card('b'), card('c'), card('d', { pos: { x: 0.0, y: 0.0 } }), card('e', { pos: { x: 0.0, y: 0.5 } }), card('f', { pos: { x: 0.0, y: 1 } })];
    const p = plan(cs, WINDOWS.large);
    expect(p.others).toEqual([]);
    expectSound(p, cs, 'large');
  });

  it('more cards than the stage holds: the rest are drawn in Others, none hidden or lost', () => {
    const cs = Array.from({ length: 24 }, (_, i) => card(`k${i}`, i % 3 === 0 ? { pos: { x: (i * 0.137) % 1, y: (i * 0.291) % 1 } } : {}));
    for (const [name, s] of Object.entries(WINDOWS)) {
      const p = plan(cs, s);
      expect(p.others.length, name).toBeGreaterThan(0);
      expectSound(p, cs, name);
    }
  });

  it('re-flows as the window is dragged smaller and larger, sound at every size (seeded random records)', () => {
    let seed = 20261028;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const sizes = [undefined, undefined, undefined, 'medium', 'large', 'wide'] as const;
    const kinds = ['chat', 'task', 'image', 'web', 'whiteboard'] as const;
    for (let t = 0; t < 300; t++) {
      const n = 1 + Math.floor(rnd() * 9);
      const cs: SuperContainer[] = [agenda((['medium', 'large', undefined] as const)[Math.floor(rnd() * 3)])];
      for (let i = 0; i < n; i++) {
        const size = sizes[Math.floor(rnd() * sizes.length)];
        cs.push(card(`c${i}`, { kind: kinds[i % kinds.length], ...(size ? { size } : {}), ...(rnd() < 0.4 ? { pos: { x: rnd(), y: rnd() } } : {}) }));
      }
      const owned = cs.filter((c) => c.pos).map((c) => c.id);
      for (let w = 1040; w <= 1940; w += 150) {
        const s = { width: w, height: 560 + ((w * 7) % 480) };
        expectSound(plan(cs, s, { recent: owned.slice(0, 1) }), cs, `#${t} ${s.width}x${s.height}`);
      }
    }
  });
});

describe('findFree', () => {
  it('returns the spot itself when it is clear, the nearest clear spot otherwise, null when none', () => {
    const area: Rect = { x: 0, y: 0, width: 600, height: 400 };
    const want: Rect = { x: 100, y: 100, width: 160, height: 160 };
    expect(findFree(want, area, [])).toEqual(want);
    const block: Rect = { x: 100, y: 100, width: 160, height: 160 };
    const got = findFree(want, area, [block])!;
    expect(overlaps(got, block, STAGE.GAP - 1)).toBe(false);
    expect(got.x >= 0 && got.y >= 0 && got.x + 160 <= 600 && got.y + 160 <= 400).toBe(true);
    expect(findFree(want, area, [area])).toBeNull();
    expect(findFree({ ...want, width: 700 }, area, [])).toBeNull();
  });
});

describe('side by side, the web card takes its device\'s shape (owner 2026-10-28, item 4)', () => {
  // The device shapes webDevice.ts gives a card (390x844, 820x1180, 1440x900).
  const ASPECT = { phone: 390 / 844, tablet: 820 / 1180, desktop: 1440 / 900 } as const;
  const web = card('w', { kind: 'web', ref: 'http://localhost:5287' });
  const halfPlan = (s: { width: number; height: number }, device?: keyof typeof ASPECT) =>
    planStage(stageItems([card('a'), web, card('b')], [], { mode: 'half', card: 'w' }, () => false, (c) => (device && c.id === 'w' ? ASPECT[device] : undefined)),
      { mode: 'half', card: 'w' }, s);

  it('no device: the two halves, as before', () => {
    const p = halfPlan(WINDOWS.mid);
    expect(p.cards.w.rect.width).toBeCloseTo(p.centre.width, 6);
  });

  it('phone is a narrow tall card, tablet wider, desktop the widest; the centre takes what each leaves', () => {
    for (const [name, s] of Object.entries(WINDOWS)) {
      const ph = halfPlan(s, 'phone');
      const tb = halfPlan(s, 'tablet');
      const dt = halfPlan(s, 'desktop');
      expect(ph.cards.w.rect.width, name).toBeLessThan(tb.cards.w.rect.width);
      expect(tb.cards.w.rect.width, name).toBeLessThan(dt.cards.w.rect.width);
      expect(ph.centre.width, name).toBeGreaterThan(tb.centre.width);
      expect(tb.centre.width, name).toBeGreaterThanOrEqual(dt.centre.width);
      for (const [d, p] of [['phone', ph], ['tablet', tb], ['desktop', dt]] as const) {
        const r = p.cards.w.rect;
        expect(p.cards.w.where).toBe('half');
        // The card hugs the device: its page area has the device's shape (until FIT_MIN).
        expect((r.width - STAGE.CARD_CHROME.w) / (r.height - STAGE.CARD_CHROME.h), `${name}/${d}`).toBeCloseTo(ASPECT[d], 2);
        expect(overlaps(r, p.centre), `${name}/${d}`).toBe(false);
        expect(r.x >= STAGE.MARGIN - EPS && r.y >= 0 && r.x + r.width <= s.width - STAGE.MARGIN + EPS && r.y + r.height <= s.height + EPS, `${name}/${d}`).toBe(true);
        expect(p.centre.width, `${name}/${d}`).toBeGreaterThanOrEqual(STAGE.PRESENT_MIN - EPS);
      }
      // The phone's card runs the content's height.
      expect(ph.cards.w.rect.height, name).toBeCloseTo(ph.centre.height, 6);
    }
  });

  it('a picture shown side by side keeps the two halves (only a page with a device changes)', () => {
    const cs = [card('a'), card('pic', { kind: 'image', aspect: 0.5 } as Partial<SuperContainer>)];
    const p = planStage(stageItems(cs, [], { mode: 'half', card: 'pic' }), { mode: 'half', card: 'pic' }, WINDOWS.mid);
    expect(p.cards.pic.rect.width).toBeCloseTo(p.centre.width, 6);
  });
});

describe('the agenda stays on a crowded small stage', () => {
  it('it gives way after the other cards (like a live job): compact counts, not Others', () => {
    const cs = [agenda('medium'), ...Array.from({ length: 24 }, (_, i) => card(`k${i}`, { kind: 'task' }))];
    for (const [name, s] of Object.entries(WINDOWS)) {
      const p = plan(cs, s);
      if (name === 'small') expect(p.others.length, name).toBeGreaterThan(0);
      expect(p.cards.ag.where, name).toBe('float');
      expectSound(p, cs, name);
    }
  });
});

describe('beside a presentation the live jobs keep ONE column; the rest wait in a "more" tile (item 5)', () => {
  const jobs = Array.from({ length: 7 }, (_, i) => card(`j${i}`));
  const pics = Array.from({ length: 4 }, (_, i) => card(`p${i}`, { kind: 'image', aspect: 1.6 } as Partial<SuperContainer>));
  const cs = [...jobs, ...pics];
  const present = { mode: 'present' as const, cards: pics.map((p) => p.id), layout: 'grid' as const };
  const live = (c: SuperContainer) => c.id.startsWith('j');
  const planP = (s: { width: number; height: number }, view: typeof present | { mode: 'float' } = present) =>
    planStage(stageItems(cs, [], view, live), view, s);

  it('one column of tiles, the jobs past it in the tile at its foot, none in Others, the chat at its floor', () => {
    // The owner's screen (a 110% zoomed big window) and the asked window sizes.
    for (const [name, s] of Object.entries({ ...WINDOWS, owner2: { width: 1580, height: 1050 } })) {
      const p = planP(s);
      const tiles = jobs.map((j) => p.cards[j.id]).filter((c) => c?.where === 'float');
      expect(new Set(tiles.map((c) => c.rect.x)).size, name).toBeLessThanOrEqual(1);
      expect(p.centre.width, name).toBeGreaterThanOrEqual(STAGE.PRESENT_MIN - EPS);
      // No room for even one column beside the chat and the cards: the jobs lead Others, as before.
      if (!tiles.length) for (const j of jobs) expect(p.others.includes(j.id), `${name}: ${j.id} leads Others`).toBe(true);
      if (tiles.length) {
        for (const j of jobs) expect(p.others.includes(j.id), `${name}: ${j.id} in Others`).toBe(false);
        expect(p.more?.ids.length ?? 0, name).toBe(jobs.length - tiles.length);
        for (const t of tiles) {
          expect(overlaps(t.rect, p.centre), name).toBe(false);
          if (p.more) expect(overlaps(t.rect, p.more.rect), name).toBe(false);
          expect(t.rect.y >= 0 && t.rect.y + t.rect.height <= s.height, name).toBe(true);
        }
        if (p.more) {
          expect(p.more.rect.x + p.more.rect.width, name).toBeLessThanOrEqual(p.centre.x - STAGE.GAP + EPS);
          expect(p.more.rect.y + p.more.rect.height, name).toBeLessThanOrEqual(s.height - STAGE.MARGIN + EPS);
          for (const id of p.more.ids) expect(p.cards[id].rect, name).toEqual(p.more.rect);
        }
      }
    }
  });

  it('the tile is gone when the presentation ends: every job floats or is in Others as usual', () => {
    const p = planP(WINDOWS.large, { mode: 'float' });
    expect(p.more).toBeUndefined();
  });

  it('side by side too: one column, the rest in the tile', () => {
    const web = card('w', { kind: 'web', ref: 'http://localhost:5287' });
    const p = planStage(stageItems([...jobs, web], [], { mode: 'half', card: 'w' }, live), { mode: 'half', card: 'w' }, WINDOWS.small);
    const tiles = jobs.map((j) => p.cards[j.id]).filter((c) => c?.where === 'float');
    expect(new Set(tiles.map((c) => c.rect.x)).size).toBeLessThanOrEqual(1);
    expect(tiles.length + (p.more?.ids.length ?? 0) + jobs.filter((j) => p.others.includes(j.id)).length).toBe(jobs.length);
  });
});

describe('the "more" tile\'s panel opens above it, left-aligned, never over the tile', () => {
  it('panelRect upLeft', async () => {
    const { panelRect } = await import('../../dashboard/src/components/sleepy/super/GroupPanel.js');
    const stage = { width: 1544, height: 1014 };
    const tile: Rect = { x: 24, y: 855, width: 160, height: 40 };
    const r = panelRect(tile, 3, stage, false, true);
    expect(r.x).toBe(tile.x);
    expect(r.y + r.height).toBeLessThanOrEqual(tile.y);
    expect(r.y).toBeGreaterThanOrEqual(STAGE.MARGIN);
  });
});

describe('the agenda keeps its place when the owner\'s cards take its column', () => {
  it('an ordinary auto card gives way to it, and a sized card that cannot be seated no longer narrows the centre', () => {
    const cs = [
      agenda('medium', { sizeBy: 'owner' }), card('chat'),
      card('t1', { kind: 'task', pos: { x: 0.02, y: 0.28 } }), card('pic', { kind: 'image' }),
      card('t2', { kind: 'task', pos: { x: 0.03, y: 0.33 } }), card('web', { kind: 'web', ref: 'http://localhost:5287', size: 'large' }),
    ];
    for (const [name, s] of Object.entries(WINDOWS)) {
      const p = plan(cs, s);
      expect(p.cards.ag.where, name).toBe('float');
      if (p.cards.web.where !== 'float') expect(p.centre.width, name).toBeGreaterThanOrEqual(preferredCentre(s.width) - EPS);
      expectSound(p, cs, name);
    }
  });
});

describe('end review r1 regressions', () => {
  it('a sized agenda that cannot be seated is drawn 1x1, never sent to Others (review M1)', () => {
    const cs = [card('c0'), agenda('large'), card('c1'), card('c2', { pos: { x: 0.85, y: 0.49 } }), card('c3'), card('c4'), card('c5'), card('c6')];
    const p = plan(cs, { width: 1833, height: 874 });
    expect(p.cards.ag.where).toBe('float');
    expectSound(p, cs, '1833x874');
    // The reviewer's sweep: one owner card on an 11 x 11 grid of drops, the agenda always on the stage.
    for (const s of [WINDOWS.small, WINDOWS.mid, WINDOWS.large, { width: 1833, height: 874 }]) {
      for (let gx = 0; gx <= 10; gx += 2) for (let gy = 0; gy <= 10; gy += 2) {
        const rec = [card('c0'), agenda('large'), card('c1'), card('c2', { pos: { x: gx / 10, y: gy / 10 } }), card('c3'), card('c4')];
        const q = plan(rec, s);
        expect(q.cards.ag.where, `${s.width} ${gx},${gy}`).toBe('float');
        expectSound(q, rec, `${s.width} ${gx},${gy}`);
      }
    }
  });

  it('two columns a side never overlap: the outer column stands out by the orbit\'s depth (review M2)', () => {
    for (let n = 5; n <= 14; n++) {
      for (const s of [{ width: 1918, height: 670 }, { width: 1940, height: 700 }, { width: 1900, height: 620 }]) {
        const cs = Array.from({ length: n }, (_, i) => card(`c${i}`));
        expectSound(plan(cs, s), cs, `${n} @ ${s.width}x${s.height}`);
      }
    }
  });

  it('compare on a 968 px touch stage keeps both cards at FIT_MIN', () => {
    const cs = [card('a', { kind: 'task' }), card('b', { kind: 'task' })];
    const v = { mode: 'present' as const, cards: ['a', 'b'], layout: 'compare' as const };
    const p = planStage(stageItems(cs, [], v), v, { width: 968, height: 700 }, { narrowPx: 940, centreMin: 480 });
    for (const id of ['a', 'b']) expect(p.cards[id].rect.width).toBeGreaterThanOrEqual(STAGE.FIT_MIN.w - EPS);
    expect(p.centre.width).toBeGreaterThanOrEqual(STAGE.REGION_MIN - EPS);
  });
});
