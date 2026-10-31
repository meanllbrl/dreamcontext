/**
 * A report's card takes its page's measured width and the chat the rest (owner 2026-10-31); a page
 * with no measured width, a device width or an owner's size keeps today's card to the pixel.
 */
import { describe, it, expect } from 'vitest';
import { STAGE, planStage, stageItems } from '../../dashboard/src/components/sleepy/super/superLayout.js';
import { MAX_PAGE_FITS, PAGE_FIT_KEY, pageFitKey, pageFitOf, readPageFit, setPageFit } from '../../dashboard/src/lib/pageFit.js';
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
