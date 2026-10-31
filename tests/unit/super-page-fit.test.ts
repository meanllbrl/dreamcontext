/**
 * A report's card takes its page's measured width and the chat the rest (owner 2026-10-31); a page
 * with no measured width, a device width or an owner's size keeps today's card to the pixel.
 */
import { describe, it, expect } from 'vitest';
import { STAGE, fitCard, planStage, stageItems } from '../../dashboard/src/components/sleepy/super/superLayout.js';
import { MAX_PAGE_FITS, PAGE_FIT_KEY, pageFitKey, pageFitOf, readPageFit, setPageFit } from '../../dashboard/src/lib/pageFit.js';
import { deviceAspect } from '../../dashboard/src/lib/webDevice.js';
import type { SuperContainer, SuperView } from '../../dashboard/src/lib/superTypes.js';

const WIDE = { width: 1600, height: 900 };
const web = (id: string, extra: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id, kind: 'web', ref: `_dream_context/tmp/${id}.html`, shape: 'tall', place: 'float', ...extra } as SuperContainer);
const FIT = 760;
const CHROME = STAGE.CARD_CHROME.w + STAGE.WIDGET_BORDER_W;
const plan = (cs: SuperContainer[], view: SuperView, fit: (c: SuperContainer) => number | undefined, opts = {}, stage = WIDE) =>
  planStage(stageItems(cs, [], view, () => false, () => undefined, fit), view, stage, opts);
const present = (cards: string[], layout: string): SuperView => ({ mode: 'present', cards, layout } as SuperView);
const fitted = () => FIT;
const none = () => undefined;

describe('a measured page sets its card', () => {
  it('spotlight: the card is the page plus its border, the chat takes all the rest', () => {
    const p = plan([web('a')], present(['a'], 'spotlight'), fitted);
    const free = plan([web('a')], present(['a'], 'spotlight'), none);
    expect(p.cards.a.rect.width).toBe(FIT + CHROME);
    expect(p.cards.a.fitted).toBe(true);
    expect(p.centre.x + p.centre.width + STAGE.GAP).toBeCloseTo(p.cards.a.rect.x, 6);
    expect(p.cards.a.rect.x + p.cards.a.rect.width).toBeCloseTo(free.cards.a.rect.x + free.cards.a.rect.width, 6);
    expect(p.centre.width).toBeGreaterThan(free.centre.width);
  });

  it('half: never wider than the half it had, narrower when the page is', () => {
    const view: SuperView = { mode: 'half', card: 'a' } as SuperView;
    expect(plan([web('a')], view, fitted).cards.a.rect.width).toBe(FIT + CHROME);
    const free = plan([web('a')], view, none).cards.a.rect.width;
    expect(plan([web('a')], view, () => 1400).cards.a.rect.width).toBe(free);
  });

  it('compare: two measured pages hold their width, one unmeasured keeps the old split', () => {
    const view = present(['a', 'b'], 'compare');
    const cs = [web('a'), web('b')];
    const narrowPage = 400;
    const p = plan(cs, view, () => narrowPage);
    expect(p.cards.a.rect.width).toBe(narrowPage + CHROME);
    expect(p.cards.b.rect.width).toBe(narrowPage + CHROME);
    const free = plan(cs, view, none);
    expect(p.centre.width).toBeGreaterThan(free.centre.width);
    expect(plan(cs, view, (c) => (c.id === 'a' ? narrowPage : undefined)).cards.a.rect).toEqual(free.cards.a.rect);
    // Wider than the slots there are: the old split, never a chat under its width.
    expect(plan(cs, view, fitted).cards.a.rect).toEqual(free.cards.a.rect);
  });

  it('review: the page and its row narrow together, the row keeps its floor', () => {
    const cs = [web('a'), web('b', { kind: 'image', ref: 'x.png' } as Partial<SuperContainer>)];
    const p = plan(cs, present(['a', 'b'], 'review'), (c) => (c.id === 'a' ? FIT : undefined));
    expect(p.cards.a.rect.width).toBe(FIT + CHROME);
    expect(p.cards.b.rect.x).toBeCloseTo(p.cards.a.rect.x, 6);
    expect(p.cards.a.fitted).toBe(true);
  });
});

describe('what keeps the width it has', () => {
  const view = present(['a'], 'spotlight');
  const today = plan([web('a')], view, none);

  it('a page with no measured width (a site, a fluid page, a wide table)', () => {
    expect(today.cards.a.fitted).toBeUndefined();
    expect(plan([web('a')], view, () => 0).cards.a.rect).toEqual(today.cards.a.rect);
  });

  it('the owner\'s size', () => {
    const cs = [web('a', { size: 'large', sizeBy: 'owner' })];
    expect(plan(cs, view, fitted).cards.a.rect).toEqual(plan(cs, view, none).cards.a.rect);
  });

  it('a device width picked on the card', () => {
    const items = stageItems([web('a')], [], view, () => false, () => 0.5, fitted);
    expect(items[0].fit).toBeUndefined();
  });

  it('a page wider than the room: the stage does not grow it past today', () => {
    expect(plan([web('a')], view, () => 3000).cards.a.rect).toEqual(today.cards.a.rect);
  });

  it('a folded chat, a filmstrip and a narrow stage', () => {
    const folded = { ...view, chat: 'bar' } as SuperView;
    expect(plan([web('a')], folded, fitted).cards.a.rect).toEqual(plan([web('a')], folded, none).cards.a.rect);
    const film = present(['a', 'b'], 'filmstrip');
    expect(plan([web('a'), web('b')], film, fitted).cards.a.rect).toEqual(plan([web('a'), web('b')], film, none).cards.a.rect);
    const phone = { width: 390, height: 780 };
    expect(plan([web('a')], view, fitted, {}, phone).cards.a.rect).toEqual(plan([web('a')], view, none, {}, phone).cards.a.rect);
  });
});

describe('the report', () => {
  it('takes a width, 0, and nothing else', () => {
    expect(readPageFit({ [PAGE_FIT_KEY]: 759.2 })).toBe(760);
    expect(readPageFit({ [PAGE_FIT_KEY]: 0 })).toBe(0);
    expect(readPageFit({ [PAGE_FIT_KEY]: 1e9 })).toBe(0);
    for (const bad of [null, 'x', {}, { [PAGE_FIT_KEY]: -1 }, { [PAGE_FIT_KEY]: '700' }, { [PAGE_FIT_KEY]: Number.NaN }]) expect(readPageFit(bad)).toBeUndefined();
  });

  it('is kept per project and page, forgotten at 0, and bounded', () => {
    const k = pageFitKey('p', 'r.html');
    expect(pageFitKey('q', 'r.html')).not.toBe(k);
    setPageFit(k, 700);
    expect(pageFitOf(k)).toBe(700);
    setPageFit(k, 0);
    expect(pageFitOf(k)).toBeUndefined();
    setPageFit(k, 700);
    for (let i = 0; i < MAX_PAGE_FITS; i += 1) setPageFit(pageFitKey('p', `f${i}`), 700);
    expect(pageFitOf(k)).toBeUndefined();
  });
});

describe('a web page with a device picked takes the device shape in a presentation', () => {
  const PHONE = deviceAspect('phone');
  const DESKTOP = deviceAspect('desktop');
  const shaped = (cs: SuperContainer[], view: SuperView, aspect: number | undefined, opts = {}) =>
    planStage(stageItems(cs, [], view, () => false, () => aspect), view, WIDE, opts);
  const spotlight = present(['a'], 'spotlight');
  const shapeOf = (r: { width: number; height: number }) => (r.width - STAGE.CARD_CHROME.w) / (r.height - STAGE.CARD_CHROME.h);

  it('spotlight + phone: a narrow tall card, the chat takes the width it frees', () => {
    const p = shaped([web('a')], spotlight, PHONE);
    const free = shaped([web('a')], spotlight, undefined);
    expect(shapeOf(p.cards.a.rect)).toBeCloseTo(PHONE, 6);
    expect(p.cards.a.rect.height).toBeCloseTo(free.cards.a.rect.height, 6);
    expect(p.cards.a.rect.width).toBeLessThan(free.cards.a.rect.width / 2);
    expect(p.centre.width).toBeGreaterThan(free.centre.width);
    expect(p.centre.x + p.centre.width + STAGE.GAP).toBeCloseTo(p.cards.a.rect.x, 6);
    expect(p.cards.a.rect.x + p.cards.a.rect.width).toBeCloseTo(free.cards.a.rect.x + free.cards.a.rect.width, 6);
    expect(p.cards.a.fitted).toBeUndefined();
  });

  it('spotlight + desktop: a wide card, the chat narrows to its floor and no further', () => {
    const p = shaped([web('a')], spotlight, DESKTOP);
    const free = shaped([web('a')], spotlight, undefined);
    expect(p.centre.width).toBe(STAGE.MINI_MIN_W);
    expect(p.centre.width).toBeLessThan(free.centre.width);
    expect(p.cards.a.rect.width).toBeGreaterThan(free.cards.a.rect.width);
    expect(shapeOf(p.cards.a.rect)).toBeCloseTo(DESKTOP, 6);
  });

  it('spotlight, no device: today\'s card and chat to the pixel; a picture keeps them too', () => {
    const p = shaped([web('a')], spotlight, undefined);
    expect(p.centre.width).toBe(Math.min(STAGE.MINI_MAX_W, Math.max(STAGE.MINI_MIN_W, STAGE.MINI_FRAC_W * WIDE.width)));
    const pic = { ...web('a'), kind: 'image', aspect: PHONE } as SuperContainer;
    const q = shaped([pic], spotlight, undefined);
    expect(q.centre.width).toBe(p.centre.width);
    expect(q.cards.a.rect).toEqual(p.cards.a.rect);
  });

  it('a folded chat: the card sits in shape in the middle of the stage, the bar keeps its width', () => {
    const folded = { ...spotlight, chat: 'bar' } as SuperView;
    const p = shaped([web('a')], folded, PHONE);
    const free = shaped([web('a')], folded, undefined);
    expect(p.chat).toBe('bar');
    expect(p.cards.a.rect).toEqual(fitCard(free.cards.a.rect, PHONE));
    expect(p.centre).toEqual(free.centre);
  });

  it('a question open over a folded chat: the mini is back and the card still in shape', () => {
    const p = shaped([web('a')], { ...spotlight, chat: 'bar' } as SuperView, PHONE, { asking: true });
    expect(p.chat).toBe('mini');
    expect(shapeOf(p.cards.a.rect)).toBeCloseTo(PHONE, 6);
  });

  it('review + phone: the page in shape, the row of cards under it keeps its floor', () => {
    const view = present(['a', 'b', 'c'], 'review');
    const cs = [web('a'), web('b', { kind: 'task' } as Partial<SuperContainer>), web('c', { kind: 'task' } as Partial<SuperContainer>)];
    const p = planStage(stageItems(cs, [], view, () => false, (c) => (c.id === 'a' ? PHONE : undefined)), view, WIDE, {});
    const free = planStage(stageItems(cs, [], view), view, WIDE, {});
    expect(shapeOf(p.cards.a.rect)).toBeCloseTo(PHONE, 6);
    expect(p.centre.width).toBeGreaterThan(free.centre.width);
    expect(p.cards.b.rect.width).toBeGreaterThanOrEqual(STAGE.FIT_MIN.w);
    expect(p.cards.c.rect.x + p.cards.c.rect.width).toBeCloseTo(free.cards.c.rect.x + free.cards.c.rect.width, 6);
  });
});
