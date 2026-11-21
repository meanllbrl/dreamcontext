/**
 * The presentation layouts' geometry (plan-r2 D6, D7, D13, D14): every preset at three stage
 * sizes keeps its rects inside the content, never overlaps a shown card, the centre, the bands,
 * the queue pill or the agenda pill; on a wide stage spotlight, compare, grid and review draw in a
 * window as wide as what it shows (K14, W3) beside the chat's full-height column; a filmstrip's
 * thumbs are one row; compare's two cards are equal; a narrow stage is a sheet over a composer bar.
 */
import { describe, it, expect } from 'vitest';
import { PRESENT_WIN, STAGE, planStage, type Rect, type StageItem, type StagePlan } from '../../dashboard/src/components/sleepy/super/superLayout.js';
import type { PresentLayout, SuperView } from '../../dashboard/src/lib/superTypes.js';

const STAGES = [{ width: 1384, height: 844 }, { width: 1864, height: 1004 }, { width: 1000, height: 800 }];
const item = (id: string, kind: StageItem['kind'] = 'task'): StageItem => ({ id, kind, shape: 'square', place: 'float' });
const items = (n: number) => Array.from({ length: n }, (_, i) => item(`c${i}`));
const REVIEW = [item('web', 'web'), item('chat', 'chat'), item('br', 'browser')];

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
const inside = (r: Rect, o: Rect) => r.x >= o.x - 0.5 && r.y >= o.y - 0.5 && r.x + r.width <= o.x + o.width + 0.5 && r.y + r.height <= o.y + o.height + 0.5;
// A thumb scrolled out of a long strip's window is drawn nowhere (owner 2026-10-29).
const drawn = (p: StagePlan) => Object.values(p.cards).filter((c) => c.where !== 'others' && c.where !== 'tab' && !c.hidden);

/** Every preset with a card set it takes. */
const CASES: [PresentLayout, StageItem[]][] = [
  ['spotlight', items(1)], ['compare', items(2)], ['grid', items(3)], ['grid', items(4)],
  ['filmstrip', items(2)], ['filmstrip', items(5)], ['filmstrip', items(8)],
  ['review', REVIEW.slice(0, 2)], ['review', REVIEW],
];

function plan(layout: PresentLayout, list: StageItem[], stage: { width: number; height: number }, extra: Partial<SuperView> = {}, opts = {}) {
  const view: SuperView = { mode: 'present', cards: list.map((c) => c.id), layout, ...extra };
  // An unshown card and a minimised agenda, so Others and the agenda pill are on the stage too.
  return planStage([...list, item('rest')], view, stage, { agendaPill: 'agenda-x', ...opts });
}

describe('every preset at every stage size', () => {
  for (const stage of STAGES) {
    for (const [layout, list] of CASES) {
      for (const chat of [undefined, 'bar' as const]) {
        it(`${layout} x${list.length} at ${stage.width}x${stage.height}${chat ? ' (bar)' : ''}`, () => {
          const p = plan(layout, list, stage, chat ? { chat } : {});
          expect(p.mode).toBe('present');
          expect(p.layout).toBe(layout);
          const shown = drawn(p);
          const content = p.free;
          for (const c of shown) {
            expect(inside(c.rect, content), `${c.id} inside`).toBe(true);
            expect(c.rect.width).toBeGreaterThan(0);
            expect(c.rect.height).toBeGreaterThan(0);
            expect(overlaps(c.rect, p.centre), `${c.id} vs centre`).toBe(false);
            for (const d of shown) if (d.id !== c.id) expect(overlaps(c.rect, d.rect), `${c.id} vs ${d.id}`).toBe(false);
          }
          expect(inside(p.centre, content), 'centre inside').toBe(true);
          // The bands: queue and controls above the content, Others, dock and pill below it.
          for (const band of [p.queue, p.controls!]) {
            expect(band.y + band.height).toBeLessThanOrEqual(content.y + 0.5);
            for (const c of [...shown.map((s) => s.rect), p.centre]) expect(overlaps(band, c)).toBe(false);
          }
          expect(overlaps(p.queue, p.controls!), 'queue vs controls').toBe(false);
          for (const band of [p.othersRect, p.agendaPill]) {
            expect(band.y).toBeGreaterThanOrEqual(content.y + content.height - 0.5);
            for (const c of [...shown.map((s) => s.rect), p.centre]) expect(overlaps(band, c)).toBe(false);
          }
          expect(p.cards.rest.where).toBe('others');
        });
      }
    }
  }
});

describe('the wide stage (not narrow)', () => {
  for (const stage of STAGES.slice(0, 2)) {
    it(`spotlight at ${stage.width}: the chat the whole left column, the card in a desktop-wide window at the right`, () => {
      const p = plan('spotlight', items(1), stage);
      expect(p.chat).toBe('column');
      const win = p.presentWindow!;
      // Desktop width, as far as the chat's floor allows (K14: the chat never under CHAT_MIN).
      expect(win.width).toBe(Math.min(PRESENT_WIN.DESK_W, p.free.width - STAGE.GAP - PRESENT_WIN.CHAT_MIN));
      expect(p.centre.width).toBeGreaterThanOrEqual(PRESENT_WIN.CHAT_MIN);
      expect(p.centre.height).toBeCloseTo(p.free.height, 5);
      expect(p.centre.x).toBe(p.free.x);
      expect(win.x).toBeCloseTo(p.centre.x + p.centre.width + STAGE.GAP, 5);
      expect(win.x + win.width).toBeCloseTo(p.free.x + p.free.width, 5);
      expect(p.presentFrame).toEqual(win);
      const c = p.cards.c0.rect;
      expect(c).toEqual({ x: win.x, y: win.y + PRESENT_WIN.TITLE_H, width: win.width, height: win.height - PRESENT_WIN.TITLE_H });
    });

    it(`the chat bar at ${stage.width}: only a filmstrip folds the chat (its big card spans the content); the window never does`, () => {
      const [, film] = CASES.find(([l]) => l === 'filmstrip')!;
      const p = plan('filmstrip', film, stage, { chat: 'bar' });
      expect(p.chat).toBe('bar');
      expect(p.centre.height).toBe(STAGE.CHAT_BAR_H);
      expect(p.cards[p.strip!.big].rect.width).toBeCloseTo(p.free.width, 5);
      expect(plan('filmstrip', film, stage, { chat: 'bar' }, { asking: true }).chat).toBe('mini');
      // The window keeps the chat a readable column (frame 07c): a stored bar is ignored there.
      for (const layout of ['spotlight', 'compare', 'review'] as const) {
        const list = layout === 'spotlight' ? items(1) : layout === 'compare' ? items(2) : REVIEW;
        expect(plan(layout, list, stage, { chat: 'bar' }).chat).toBe('column');
      }
    });
  }

  it('the expected first look at a 1440 window (stage 1384): a desktop card in a window that leaves the chat its 520, then 820 on a wider stage', () => {
    const p = plan('spotlight', items(1), STAGES[0]);
    expect(p.centre.width).toBe(PRESENT_WIN.CHAT_MIN);
    expect(p.presentWindow!.width).toBeCloseTo(p.free.width - STAGE.GAP - PRESENT_WIN.CHAT_MIN, 5);
    expect(plan('spotlight', items(1), STAGES[1]).presentWindow!.width).toBe(PRESENT_WIN.DESK_W);
  });

  it('filmstrip: one row holding a slot for every card in a fixed order; the agenda is never the big one; selecting never reorders', () => {
    const list = [item('ag', 'agenda'), ...items(7)];
    const p = plan('filmstrip', list, STAGES[0]);
    expect(p.strip!.big).toBe('c0');
    // Every card has its slot, the big one's included (owner 2026-10-29: "the selected one must
    // also show in the strip"); the agenda last.
    expect(p.strip!.ids).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'ag']);
    const thumbs = Object.values(p.cards).filter((c) => c.where === 'thumb' && !c.hidden);
    expect(new Set(thumbs.map((t) => t.rect.y)).size).toBe(1);
    expect(thumbs.every((t) => inside(t.rect, p.strip!.rect))).toBe(true);
    expect(p.strip!.current && inside(p.strip!.current, p.strip!.rect)).toBe(true);
    const sel = plan('filmstrip', list, STAGES[0], {}, { selected: 'c4' });
    expect(sel.strip!.big).toBe('c4');
    expect(sel.cards.c4.where).toBe('present');
    expect(sel.cards.c0.where).toBe('thumb');
    // Order stability: the same ids in the same order; every other card keeps its exact slot,
    // and the big card's mark sits in c4's own slot (where c4's thumb was).
    expect(sel.strip!.ids).toEqual(p.strip!.ids);
    for (const id of ['c1', 'c2', 'c3', 'c5', 'c6', 'ag']) expect(sel.cards[id].rect).toEqual(p.cards[id].rect);
    expect(sel.strip!.current).toEqual(p.cards.c4.rect);
    expect(sel.cards.c0.rect).toEqual(p.strip!.current);
    // A selection no longer presented resets to the first.
    expect(plan('filmstrip', list, STAGES[0], {}, { selected: 'gone' }).strip!.big).toBe('c0');
  });

  it('filmstrip: more cards than fit scroll (no cap); the window clamps; the big card\'s slot stays its own', () => {
    const list = items(20);
    const p = plan('filmstrip', list, STAGES[0]);
    const st = p.strip!;
    expect(st.ids).toHaveLength(20);
    expect(st.visible).toBeLessThan(20);
    expect(st.prev && st.next).toBeTruthy();
    const shown = Object.values(p.cards).filter((c) => c.where === 'thumb' && !c.hidden);
    // The big card's slot is in view (start 0) and is not a thumb: visible - 1 thumbs show.
    expect(shown).toHaveLength(st.visible - 1);
    expect(shown.every((t) => inside(t.rect, st.rect))).toBe(true);
    expect(Object.values(p.cards).filter((c) => c.where === 'thumb')).toHaveLength(19);
    // Scrolled to the end: the window clamps, the big card's mark scrolls out with its slot.
    const end = plan('filmstrip', list, STAGES[0], {}, { stripStart: 99 });
    expect(end.strip!.start).toBe(20 - st.visible);
    expect(end.strip!.current).toBeUndefined();
    expect(end.cards.c19.hidden).toBeFalsy();
    expect(end.cards.c1.hidden).toBe(true);
  });

  it('compare: two equal widths; review: the page big on top, the child\'s cards in a row under it', () => {
    const c = plan('compare', items(2), STAGES[0]);
    expect(c.cards.c0.rect.width).toBeCloseTo(c.cards.c1.rect.width, 5);
    expect(c.chat).toBe('column');
    const r = plan('review', REVIEW, STAGES[0]);
    expect(r.cards.web.rect.y).toBe(r.presentWindow!.y + PRESENT_WIN.TITLE_H);
    expect(r.cards.chat.rect.y).toBeCloseTo(r.cards.br.rect.y, 5);
    expect(r.cards.chat.rect.y).toBeGreaterThan(r.cards.web.rect.y + r.cards.web.rect.height);
    expect(r.cards.web.rect.width).toBeGreaterThan(r.cards.chat.rect.width);
  });

  it('a layout the count cannot take is drawn as the count\'s default (an older push)', () => {
    expect(planStage(items(2), { mode: 'present', cards: ['c0', 'c1'], layout: 'spotlight' }, STAGES[0]).layout).toBe('compare');
    expect(planStage(items(6), { mode: 'present', cards: items(6).map((c) => c.id) }, STAGES[0]).layout).toBe('filmstrip');
  });
});

describe('a narrow stage (1000 x 800)', () => {
  const narrow = STAGES[2];
  it('open, any layout is a sheet under its tab row over a composer bar; a filmstrip keeps its strip', () => {
    for (const [layout, list] of CASES) {
      const p = plan(layout, list, narrow);
      expect(p.narrow).toBe(true);
      expect(p.chat).toBe('bar');
      expect(p.centre.height).toBe(STAGE.CHAT_BAR_H);
      const sheet = drawn(p).filter((c) => c.where === 'sheet');
      expect(sheet).toHaveLength(1);
      for (const c of drawn(p)) expect(c.rect.y + c.rect.height).toBeLessThanOrEqual(p.centre.y + 0.5);
      // Every card the view shows has its tab, the open one included (owner 2026-11-17).
      expect(p.tabs!.ids).toEqual(list.map((c) => c.id));
      expect(p.tabs!.folded).toBeUndefined();
      for (const c of drawn(p)) expect(c.rect.y).toBeGreaterThanOrEqual(p.tabs!.rect.y + p.tabs!.rect.height);
      if (layout === 'filmstrip') expect(p.strip).toBeDefined();
      else expect(Object.values(p.cards).filter((c) => c.where === 'tab')).toHaveLength(list.length - 1);
    }
  });

  it('folded (the default for what the agent shows): the tab row over a full-height chat, nothing drawn over it', () => {
    for (const [layout, list] of CASES) {
      for (const asking of [false, true]) {
        const p = plan(layout, list, narrow, {}, { folded: true, asking });
        expect(p.mode).toBe('present');
        expect(p.chat).toBe('column');
        expect(drawn(p)).toHaveLength(0);
        expect(p.tabs).toEqual({ rect: expect.any(Object), ids: list.map((c) => c.id), folded: true });
        for (const c of list) expect(p.cards[c.id].where).toBe('tab');
        // The chat runs from under the row to the content's foot: the screen is not split.
        expect(p.centre.y).toBeGreaterThanOrEqual(p.tabs!.rect.y + p.tabs!.rect.height);
        expect(p.centre.height).toBeGreaterThan(narrow.height / 2);
        expect(p.centre.width).toBe(p.tabs!.rect.width);
        // The switcher and exit stay in the top band, above the row, never over the chat.
        expect(p.controls).toBeDefined();
        expect(p.controls!.y + p.controls!.height).toBeLessThanOrEqual(p.tabs!.rect.y + 0.5);
        expect(p.strip).toBeUndefined();
      }
    }
  });

  it('a page side by side folds to its one tab the same way, and opens under it', () => {
    const view: SuperView = { mode: 'half', card: 'c0' };
    const folded = planStage(items(2), view, narrow, { folded: true });
    expect(folded.cards.c0.where).toBe('tab');
    expect(folded.tabs).toMatchObject({ ids: ['c0'], folded: true });
    expect(folded.centre.y).toBeGreaterThanOrEqual(folded.tabs!.rect.y + folded.tabs!.rect.height);
    const open = planStage(items(2), view, narrow, {});
    expect(open.cards.c0.where).toBe('sheet');
    expect(open.tabs).toMatchObject({ ids: ['c0'] });
    expect(open.cards.c0.rect.y).toBeGreaterThanOrEqual(open.tabs!.rect.y + open.tabs!.rect.height);
  });

  it('a wide stage ignores the fold: the cards are drawn beside the chat as before', () => {
    const p = plan('compare', items(2), STAGES[0], {}, { folded: true });
    expect(p.tabs).toBeUndefined();
    expect(drawn(p).filter((c) => c.where === 'present')).toHaveLength(2);
  });

  it('a question of his open: the chat at the mini\'s height with its transcript, the sheet above it', () => {
    const p = plan('compare', items(2), narrow, {}, { asking: true });
    expect(p.chat).toBe('mini');
    expect(p.centre.height).toBeGreaterThanOrEqual(STAGE.MINI_MIN_H);
    for (const c of drawn(p)) expect(c.rect.y + c.rect.height).toBeLessThanOrEqual(p.centre.y + 0.5);
  });

  it('the picked tab is the one drawn; widening restores the stored layout (width never writes)', () => {
    const view: SuperView = { mode: 'present', cards: ['c0', 'c1', 'c2'], layout: 'grid' };
    const p = planStage(items(3), view, narrow, { selected: 'c2' });
    expect(p.cards.c2.where).toBe('sheet');
    expect(p.cards.c0.where).toBe('tab');
    const wide = planStage(items(3), view, STAGES[0], { selected: 'c2' });
    expect(wide.layout).toBe('grid');
    expect(Object.values(wide.cards).every((c) => c.where === 'present')).toBe(true);
  });
});
