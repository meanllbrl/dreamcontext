/**
 * A picture card is only as wide as its picture needs (owner 2026-11-07: "bu resim bu kadar
 * genişlik almamalı"): ONE portrait screenshot presented beside the chat gets a narrow card and the
 * chat the width it frees. A landscape, several pictures and a card the owner sized keep today's box.
 */
import { describe, it, expect } from 'vitest';
import { STAGE, planStage, stageItems } from '../../dashboard/src/components/sleepy/super/superLayout.js';
import type { SuperContainer, SuperView } from '../../dashboard/src/lib/superTypes.js';

const PORTRAIT = 390 / 844;
const LANDSCAPE = 16 / 9;
const STAGES = { mac: { width: 1440, height: 900 }, wide: { width: 2380, height: 1300 } };
const pic = (id: string, aspect: number, extra: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id, kind: 'image', ref: `docs/${id}.png`, shape: 'tall', place: 'float', aspect, ...extra } as SuperContainer);
const present = (cards: string[], layout: string, extra: Partial<SuperView> = {}): SuperView => ({ mode: 'present', cards, layout, ...extra } as SuperView);
const plan = (cs: SuperContainer[], view: SuperView, stage: { width: number; height: number }, opts = {}) =>
  planStage(stageItems(cs, [], view), view, stage, opts);
const shapeOf = (r: { width: number; height: number }) => (r.width - STAGE.CARD_CHROME.w) / (r.height - STAGE.CARD_CHROME.h);
/** The same card with no known shape: the box it had before this change. */
const unknown = (c: SuperContainer): SuperContainer => ({ ...c, aspect: undefined });

describe('spotlight (super ask --show, super present) with a picture', () => {
  for (const [name, s] of Object.entries(STAGES)) {
    it(`${name}: a portrait gets a narrow card hugging it, the chat takes the width it frees`, () => {
      const view = present(['a'], 'spotlight');
      const p = plan([pic('a', PORTRAIT)], view, s, { asking: true });
      const before = plan([unknown(pic('a', PORTRAIT))], view, s, { asking: true });
      expect(shapeOf(p.cards.a.rect)).toBeCloseTo(PORTRAIT, 6);
      expect(p.cards.a.rect.width).toBeLessThan(before.cards.a.rect.width / 2);
      expect(p.centre.width).toBeGreaterThan(before.centre.width + 300);
      expect(p.centre.x + p.centre.width + STAGE.GAP).toBeCloseTo(p.cards.a.rect.x, 6);
      expect(p.cards.a.rect.x + p.cards.a.rect.width).toBeCloseTo(before.cards.a.rect.x + before.cards.a.rect.width, 6);
    });

    it(`${name}: a landscape keeps today's card and chat`, () => {
      const view = present(['a'], 'spotlight');
      const p = plan([pic('a', LANDSCAPE)], view, s);
      const before = plan([unknown(pic('a', LANDSCAPE))], view, s);
      expect(p.centre).toEqual(before.centre);
      expect(p.cards.a.rect).toEqual(before.cards.a.rect);
    });

    it(`${name}: a card the owner sized keeps today's box`, () => {
      const view = present(['a'], 'spotlight');
      const own = pic('a', PORTRAIT, { size: 'large', sizeBy: 'owner' });
      const p = plan([own], view, s);
      const before = plan([unknown(own)], view, s);
      expect(p.cards.a.rect).toEqual(before.cards.a.rect);
      expect(p.centre).toEqual(before.centre);
    });
  }
});

describe('a web card', () => {
  const s = STAGES.mac;

  it('a web card keeps its width (unchanged)', () => {
    const view = present(['w'], 'spotlight');
    const web = { id: 'w', kind: 'web', ref: 'http://localhost:5173', shape: 'tall', place: 'float' } as SuperContainer;
    const p = plan([web], view, s);
    expect(p.centre.width).toBe(Math.min(STAGE.MINI_MAX_W, Math.max(STAGE.MINI_MIN_W, STAGE.MINI_FRAC_W * s.width)));
  });
});
