/**
 * A card's view in the URL (board/cardViewUrl.ts): the picked funnel, the breakdown selection, the
 * pinned lanes and the open tabs travel as `v.<cardId>=<compact JSON>`, so a reload, a fullscreen
 * reload or a shared link restores them. Encoding writes only what is chosen; decoding is lenient
 * (a hand-edited param never throws, it keeps what is valid); writing keeps the URL in step with the
 * views of the board's cards and drops every other `v.*` param. BoardPage reads the URL once per
 * opened board (viewReducer `hydrate`) and then writes it from the state (replace, never a history
 * step), pinned here by source text (no DOM harness at the root).
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EMPTY_VIEW, setFilters, setFunnel, setLanes, setSelection, setTab, type CardView,
} from '../../dashboard/src/components/lab/board/cardViewState.js';
import {
  MAX_VIEW_PARAM_CHARS, MAX_VIEW_PARAMS, VIEW_PARAM_PREFIX, decodeCardView, encodeCardView,
  readViewParams, viewParamsMatch, writeViewParams,
} from '../../dashboard/src/components/lab/board/cardViewUrl.js';

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../../dashboard/src/context/ThemeContext.js', () => ({
  useTheme: () => ({ theme: 'light', resolved: 'light', setTheme: () => {} }),
  ThemeProvider: ({ children }: { children: unknown }) => children,
}));

const INS = 'acme-storefront-funnels';

/** A view with every URL part set: funnel, selection, two lanes and an open tab. */
function fullView(): CardView {
  let v: CardView = setFunnel(EMPTY_VIEW, INS, 'quiz');
  v = setSelection(v, INS, { country: 'TR', platform: 'Meta Ads' });
  v = setLanes(v, INS, [{ country: 'TR' }, { country: 'UA' }]);
  v = setTab(v, '1', 5);
  return v;
}

describe('encode / decode', () => {
  it('an empty view writes no param (tab 0 and empty maps are the default)', () => {
    expect(encodeCardView(EMPTY_VIEW)).toBeNull();
    expect(encodeCardView(undefined)).toBeNull();
    expect(encodeCardView(setTab(EMPTY_VIEW, '1', 0))).toBeNull();
  });

  it('round-trips funnel, selection, lanes and tabs; filters and app pages stay out of the URL', () => {
    const v = setFilters(fullView(), [{ key: 'c1:0', target: { insight: INS, dataset: 'declines' }, filter: { dim: 'cohort', value: 'new' } }]);
    const raw = encodeCardView(v);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({
      f: { [INS]: 'quiz' },
      s: { [INS]: { country: 'TR', platform: 'Meta Ads' } },
      l: { [INS]: [{ country: 'TR' }, { country: 'UA' }] },
      t: { 1: 5 },
    });
    const back = decodeCardView(raw) as CardView;
    expect(back.funnel).toEqual(v.funnel);
    expect(back.selection).toEqual(v.selection);
    expect(back.lanes).toEqual(v.lanes);
    expect(back.tabs).toEqual(v.tabs);
    expect(back.filters).toEqual([]);
    expect(back.appPage).toEqual({});
  });

  it('decoding is lenient: junk, unsafe keys, long values, extra lanes and bad tab indexes are dropped', () => {
    expect(decodeCardView('not json')).toBeNull();
    expect(decodeCardView('[1,2]')).toBeNull();
    expect(decodeCardView('{}')).toBeNull();
    expect(decodeCardView(null)).toBeNull();
    const long = 'x'.repeat(129);
    const raw = JSON.stringify({
      f: { [INS]: 'quiz', '../evil': 'x', other: long },
      s: { [INS]: { country: 'TR', bad: 7, '': 'x' } },
      l: { [INS]: [{ a: '1' }, { a: '2' }, { a: '3' }, { a: '4' }, { a: '5' }, 'nope'] },
      t: { 1: 2, '2': 64, '3': -1, '4': 1.5, 'x.y': 3 },
    });
    const v = decodeCardView(raw) as CardView;
    expect(v.funnel).toEqual({ [INS]: 'quiz' });
    expect(v.selection).toEqual({ [INS]: { country: 'TR' } });
    expect(v.lanes[INS]).toHaveLength(4);
    expect(v.tabs).toEqual({ 1: 2 });
  });

  it('a param over the cap is never read, and a view too big for it drops its lanes first', () => {
    expect(decodeCardView(`{"f":{"a":"${'b'.repeat(MAX_VIEW_PARAM_CHARS)}"}}`)).toBeNull();
    let v = setFunnel(EMPTY_VIEW, INS, 'quiz');
    const lanes = Array.from({ length: 4 }, (_, i) => Object.fromEntries(
      Array.from({ length: 6 }, (__, d) => [`dim${d}`, `${'v'.repeat(100)}${i}`]),
    ));
    v = setLanes(v, INS, lanes);
    const raw = encodeCardView(v) as string;
    expect(raw.length).toBeLessThanOrEqual(MAX_VIEW_PARAM_CHARS);
    expect(JSON.parse(raw)).toEqual({ f: { [INS]: 'quiz' } });
  });
});

describe('URL params', () => {
  it('writes one v.<cardId> per card with a view, in board order, and reads them back', () => {
    const params = new URLSearchParams('card=c1&p.page=x');
    const views = { c1: fullView(), c2: EMPTY_VIEW, c3: setTab(EMPTY_VIEW, '1', 2) };
    expect(writeViewParams(params, views, ['c1', 'c2', 'c3'])).toBe(true);
    expect(params.get('card')).toBe('c1');
    expect(params.get('p.page')).toBe('x');
    expect(params.has(`${VIEW_PARAM_PREFIX}c2`)).toBe(false);
    const read = readViewParams(params, ['c1', 'c2', 'c3']);
    expect(Object.keys(read)).toEqual(['c1', 'c3']);
    expect(read.c1.funnel).toEqual({ [INS]: 'quiz' });
    expect(read.c3.tabs).toEqual({ 1: 2 });
    // Nothing to change the second time.
    expect(writeViewParams(params, views, ['c1', 'c2', 'c3'])).toBe(false);
    expect(viewParamsMatch(params, views, ['c1', 'c2', 'c3'])).toBe(true);
  });

  it('drops the params of cards not on the board and of views that became empty', () => {
    const params = new URLSearchParams();
    writeViewParams(params, { c1: fullView(), gone: fullView() }, ['c1', 'gone']);
    expect(params.has('v.gone')).toBe(true);
    expect(writeViewParams(params, { c1: EMPTY_VIEW }, ['c1'])).toBe(true);
    expect([...params.keys()].filter((k) => k.startsWith(VIEW_PARAM_PREFIX))).toEqual([]);
  });

  it('caps the URL at MAX_VIEW_PARAMS cards, first in board order', () => {
    const ids = Array.from({ length: MAX_VIEW_PARAMS + 3 }, (_, i) => `c${i}`);
    const views = Object.fromEntries(ids.map((id) => [id, setTab(EMPTY_VIEW, '1', 1)]));
    const params = new URLSearchParams();
    writeViewParams(params, views, ids);
    expect([...params.keys()]).toEqual(ids.slice(0, MAX_VIEW_PARAMS).map((id) => `v.${id}`));
  });

  it('viewParamsMatch never mutates the params it checks', () => {
    const params = new URLSearchParams('v.old=%7B%7D');
    expect(viewParamsMatch(params, { c1: fullView() }, ['c1'])).toBe(false);
    expect(params.toString()).toBe('v.old=%7B%7D');
  });
});

const { viewReducer } = await import('../../dashboard/src/components/lab/board/BoardPage.js');
const pageSrc = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/lab/board/BoardPage.tsx'), 'utf8');

describe('BoardPage: the URL is read once per opened board, then follows the state', () => {
  it('hydrate puts the URL parts into the views and keeps filters and app pages', () => {
    let s = viewReducer({ board: null, views: {} }, { type: 'prune', board: 'demo', cards: ['c1'] });
    const kept = setFilters(EMPTY_VIEW, [{ key: 'c1:0', target: { insight: INS, dataset: 'd' }, filter: { dim: 'x', value: 'y' } }]);
    s = viewReducer(s, { type: 'update', board: 'demo', card: 'c1', fn: () => kept });
    const url = readViewParams(new URLSearchParams({ 'v.c1': encodeCardView(fullView()) as string }), ['c1']);
    const h = viewReducer(s, { type: 'hydrate', board: 'demo', views: url });
    expect(h.views.c1.funnel).toEqual({ [INS]: 'quiz' });
    expect(h.views.c1.tabs).toEqual({ 1: 5 });
    expect(h.views.c1.filters).toBe(kept.filters);
    // Nothing in the URL: the state stays the same object.
    expect(viewReducer(h, { type: 'hydrate', board: 'demo', views: {} })).toBe(h);
    // A hydrate for another board starts from empty views.
    expect(viewReducer(h, { type: 'hydrate', board: 'other', views: {} }).views).toEqual({});
  });

  it('reads the URL only when a board opens, and writes it with the replacing search writer', () => {
    expect(pageSrc).toMatch(/hydratedFor\.current === boardSlug\) return;\s*hydratedFor\.current = boardSlug;/);
    expect(pageSrc).toContain("dispatchView({ type: 'hydrate', board: boardSlug, views: readViewParams(");
    expect(pageSrc).toContain('if (viewParamsMatch(new URLSearchParams(searchKey), views, ids)) return;');
    expect(pageSrc).toContain('updateSearch((p) => { writeViewParams(p, views, ids); });');
    // The writer waits until this board's URL views were read (no wiping a shared link on mount).
    expect(pageSrc).toContain('hydratedFor.current !== boardSlug || viewState.board !== boardSlug) return;');
  });
});
