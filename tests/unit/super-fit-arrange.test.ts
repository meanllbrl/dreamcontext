/**
 * Compare and grid by the pictures' shape (task a-picture-question…, D10 b-d, owner 2026-10-24):
 * two wide pictures stack, two tall ones stand side by side, three take a 2 x 2 with the last row
 * centred; a set with any card of unknown shape keeps exactly today's grid(); every picture card
 * hugs its picture, never under FIT_MIN when its slot allows, never over its slot. Regions are the
 * ones measured in the 0.34.5 rig (olcum/results.json).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { STAGE, fitArrange, fitCard, planStage, stageItems, type Rect, type StageItem } from '../../dashboard/src/components/sleepy/super/superLayout.js';
import type { SuperContainer, SuperView } from '../../dashboard/src/lib/superTypes.js';

const R1440: Rect = { x: 574.546875, y: 150, width: 841.4375, height: 686 };
const R2000: Rect = { x: 664, y: 150, width: 1312, height: 1086 };
const WIDE = 1600 / 960;
const PORTRAIT = 0.5625;
const PHONE = 0.46;

const pics = (n: number, aspect: number) => Array.from({ length: n }, () => ({ aspect }));
const area = (r: Rect, aspect: number) => {
  const w = r.width - STAGE.CARD_CHROME.w;
  const h = r.height - STAGE.CARD_CHROME.h;
  return w / h > aspect ? h * aspect * h : w * (w / aspect);
};
const inside = (r: Rect, o: Rect) => r.x >= o.x - 0.01 && r.y >= o.y - 0.01 && r.x + r.width <= o.x + o.width + 0.01 && r.y + r.height <= o.y + o.height + 0.01;
const centred = (r: Rect, o: Rect) => Math.abs((r.x + r.width / 2) - (o.x + o.width / 2)) < 0.01 && Math.abs((r.y + r.height / 2) - (o.y + o.height / 2)) < 0.01;

/** Today's grid(): 2 columns, 3-4 in a 2 x 2 with the last row left-aligned. */
function todayGrid(region: Rect, n: number): Rect[] {
  const rows = n <= 2 ? 1 : 2;
  const w = (region.width - STAGE.GAP) / 2;
  const h = (region.height - (rows - 1) * STAGE.GAP) / rows;
  return Array.from({ length: n }, (_, i) => ({ x: region.x + (i % 2) * (w + STAGE.GAP), y: region.y + Math.floor(i / 2) * (h + STAGE.GAP), width: w, height: h }));
}

describe('the constants V7 depends on', () => {
  it('pins the gap (the 1440 headroom over 1.4x is about 3 %)', () => {
    expect(STAGE.GAP).toBe(24);
    expect(STAGE.FIT_MIN).toEqual({ w: 200, h: 140 });
  });
  it('CARD_CHROME matches the card CSS: a 1 px border and a 36 px header', () => {
    const css = readFileSync(join(__dirname, '../../dashboard/src/components/sleepy/super/SuperSurface.css'), 'utf8');
    const clip = css.match(/^\.super-card-clip\s*\{[^}]*\}/m)![0];
    const head = css.match(/^\.super-card-head\s*\{[^}]*\}/m)![0];
    const border = Number(clip.match(/border:\s*(\d+)px solid/)![1]);
    const height = Number(head.match(/height:\s*(\d+)px/)![1]);
    expect(STAGE.CARD_CHROME).toEqual({ w: 2 * border, h: height + 2 * border });
  });
});

describe('arrangement by shape', () => {
  for (const [name, region, base] of [['1440', R1440, 407 * 244], ['2000', R2000, 642 * 385]] as const) {
    it(`2 wide at ${name} stack as rows, each picture >= 1.4x today's`, () => {
      const out = fitArrange(region, pics(2, WIDE));
      expect(out.name).toBe('rows');
      expect(out.slots[0].width).toBeCloseTo(region.width);
      expect(out.slots[1].y).toBeGreaterThan(out.slots[0].y);
      for (const r of out.rects) {
        const pic = { w: r.width - 2, h: r.height - 38 };
        expect(pic.w * pic.h).toBeGreaterThanOrEqual(1.4 * base);
        // The card hugs its picture: picture area / card area.
        expect((pic.w * pic.h) / (r.width * r.height)).toBeGreaterThanOrEqual(0.85);
      }
    });
    it(`2 portrait at ${name} stand side by side`, () => {
      const out = fitArrange(region, pics(2, PORTRAIT));
      expect(out.name).toBe('columns');
      for (const r of out.rects) expect(((r.width - 2) * (r.height - 38)) / (r.width * r.height)).toBeGreaterThanOrEqual(0.9);
    });
    it(`3 wide at ${name} take a 2 x 2 with the last row centred`, () => {
      const out = fitArrange(region, pics(3, WIDE));
      expect(out.name).toBe('2x2');
      const third = out.slots[2];
      expect(third.x + third.width / 2).toBeCloseTo(region.x + region.width / 2);
      expect(third.y).toBeGreaterThan(out.slots[0].y);
    });
    it(`4 wide at ${name} keep the 2 x 2`, () => {
      expect(fitArrange(region, pics(4, WIDE)).name).toBe('2x2');
    });
  }

  it('a tie within 1 % keeps today\'s', () => {
    // Square pictures, 1000 high: rows show 450 px sides; 924 wide, columns show 448 (0.9 % less).
    expect(fitArrange({ x: 0, y: 0, width: 924, height: 1000 }, pics(2, 1)).name).toBe('columns');
    // 908 wide, columns show 440 (4.6 % less): rows win.
    expect(fitArrange({ x: 0, y: 0, width: 908, height: 1000 }, pics(2, 1)).name).toBe('rows');
  });
});

describe('a set with any card of unknown shape keeps today\'s grid()', () => {
  it('3 chats and 4 chats: exactly today\'s rects, last row left-aligned', () => {
    for (const n of [3, 4]) {
      const out = fitArrange(R1440, Array.from({ length: n }, () => ({})));
      expect(out.rects).toEqual(todayGrid(R1440, n));
    }
  });
  it('1 wide + 1 chat: columns, the picture card shrunk in its slot', () => {
    const out = fitArrange(R1440, [{ aspect: WIDE }, {}]);
    const today = todayGrid(R1440, 2);
    expect(out.slots).toEqual(today);
    expect(out.rects[1]).toEqual(today[1]);
    expect(out.rects[0].height).toBeLessThan(today[0].height);
    expect(centred(out.rects[0], today[0])).toBe(true);
  });
  it('1 wide + 2 chats: today\'s 2 x 2, the picture shrunk, the chats untouched', () => {
    const out = fitArrange(R1440, [{ aspect: WIDE }, {}, {}]);
    const today = todayGrid(R1440, 3);
    expect(out.slots).toEqual(today);
    expect(out.rects.slice(1)).toEqual(today.slice(1));
    expect(inside(out.rects[0], today[0])).toBe(true);
  });
});

describe('FIT_MIN', () => {
  it('4 phone screenshots at 1440: the 1 x 4 (192 px slots) is dropped, the 2 x 2 wins', () => {
    const out = fitArrange(R1440, pics(4, PHONE));
    expect(out.name).toBe('2x2');
  });
  it('3 portraits in a 400 px region: no too-narrow arrangement wins', () => {
    const out = fitArrange({ x: 0, y: 0, width: 400, height: 800 }, pics(3, PORTRAIT));
    expect(out.name).toBe('2x2');
    expect(out.slots.every((s) => s.width >= 0)).toBe(true);
  });
  it('4 portraits beside one live rail job at 1060 x 900: today\'s 2 x 2, cards = their slots', () => {
    const imgs: StageItem[] = Array.from({ length: 4 }, (_, i) => ({ id: `image-${i}`, kind: 'image', shape: 'square', place: 'float', slot: i, aspect: PORTRAIT }));
    const job: StageItem = { id: 'chat-live', kind: 'chat', shape: 'square', place: 'float', slot: 4, live: true };
    const view: SuperView = { mode: 'present', cards: imgs.map((c) => c.id), layout: 'grid' };
    const p = planStage([...imgs, job], view, { width: 1060, height: 900 });
    const rects = imgs.map((c) => p.cards[c.id].rect);
    expect(new Set(rects.map((r) => Math.round(r.x))).size).toBe(2);
    expect(new Set(rects.map((r) => Math.round(r.y))).size).toBe(2);
    // Under FIT_MIN wide: each card is its whole slot (today's look).
    if (rects[0].width < STAGE.FIT_MIN.w) expect(rects[0].width).toBeCloseTo(rects[1].x - rects[0].x - STAGE.GAP);
  });
  it('every fitted card: <= its slot, >= FIT_MIN when the slot allows, centred', () => {
    const slots: Rect[] = [
      { x: 0, y: 0, width: 841, height: 331 }, { x: 10, y: 20, width: 190, height: 600 }, { x: 0, y: 0, width: 600, height: 150 },
      { x: 5, y: 5, width: 300, height: 300 }, { x: 0, y: 0, width: 1200, height: 160 },
    ];
    for (const slot of slots) {
      for (const a of [0.05, PHONE, PORTRAIT, 1, WIDE, 20]) {
        const r = fitCard(slot, a);
        expect(inside(r, slot), `${a} in ${JSON.stringify(slot)}`).toBe(true);
        if (slot.width >= STAGE.FIT_MIN.w && slot.height >= STAGE.FIT_MIN.h) {
          expect(r.width).toBeGreaterThanOrEqual(STAGE.FIT_MIN.w - 1e-9);
          expect(r.height).toBeGreaterThanOrEqual(STAGE.FIT_MIN.h - 1e-9);
        } else {
          expect(r).toEqual(slot);
        }
        expect(centred(r, slot)).toBe(true);
      }
    }
  });
});

describe('planStage and stageItems carry the shape', () => {
  const card = (id: string, aspect?: number, kind: SuperContainer['kind'] = 'image'): SuperContainer => ({ id, kind, ref: `${id}.png`, shape: 'square', place: 'float', ...(aspect ? { aspect } : {}) });
  it('stageItems passes an image\'s aspect, never another kind\'s', () => {
    const view: SuperView = { mode: 'float' };
    const items = stageItems([card('image-a', WIDE), { ...card('chat-b', 2, 'chat'), ref: 's' }], [], view);
    expect(items.find((i) => i.id === 'image-a')?.aspect).toBe(WIDE);
    expect(items.find((i) => i.id === 'chat-b')?.aspect).toBeUndefined();
  });
  it('compare of 2 wide pictures at a 1440 stage: stacked, beside the chat column', () => {
    const cs = [card('image-a', WIDE), card('image-b', WIDE)];
    const view: SuperView = { mode: 'present', cards: cs.map((c) => c.id), layout: 'compare' };
    const p = planStage(stageItems(cs, [], view), view, { width: 1392, height: 830 });
    const [a, b] = [p.cards['image-a'].rect, p.cards['image-b'].rect];
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);
    expect(a.x).toBeGreaterThan(p.centre.x + p.centre.width);
  });
  it('compare of 2 cards without a shape: today\'s two equal columns', () => {
    const cs = [card('image-a'), card('image-b')];
    const view: SuperView = { mode: 'present', cards: cs.map((c) => c.id), layout: 'compare' };
    const p = planStage(stageItems(cs, [], view), view, { width: 1392, height: 830 });
    const [a, b] = [p.cards['image-a'].rect, p.cards['image-b'].rect];
    expect(a.y).toBe(b.y);
    expect(a.width).toBeCloseTo(b.width);
    expect(a.height).toBe(b.height);
  });
  it('3 chats in compare/grid: today\'s rects', () => {
    const cs: SuperContainer[] = ['a', 'b', 'c'].map((x) => ({ id: `chat-${x}`, kind: 'chat', ref: x, shape: 'square', place: 'float' }));
    const view: SuperView = { mode: 'present', cards: cs.map((c) => c.id), layout: 'grid' };
    const p = planStage(stageItems(cs, [], view), view, { width: 1392, height: 830 });
    const rects = cs.map((c) => p.cards[c.id].rect);
    expect(rects[2].x).toBe(rects[0].x);
    expect(rects[1].width).toBeCloseTo(rects[0].width);
  });
});
