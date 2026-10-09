/**
 * Card view state (cardViewState.ts): the pure reducers BoardPage holds per card id so a card and
 * its fullscreen twin share one view. Every no-op returns the SAME object (React skips the render),
 * lanes are deduplicated by their sorted entries and capped at MAX_LANES, and a view dies with its
 * card (pruneViews) or with the board (viewReducer).
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_VIEW, MAX_LANES, pathKey, pinLane, pruneViews, setAppPage, setFilters, setFunnel, setLanes, setSelection,
  setTab, unpinLane, updateView, type CardView,
} from '../../dashboard/src/components/lab/board/cardViewState.js';
import type { ActiveFilter } from '../../dashboard/src/components/lab/blocks/frameShape.js';

const INS = 'acme-funnel-explorer';

describe('selection', () => {
  it('sets the selection per insight and an empty one removes the entry', () => {
    const a = setSelection(EMPTY_VIEW, INS, { platform: 'Meta Ads' });
    expect(a.selection[INS]).toEqual({ platform: 'Meta Ads' });
    expect(EMPTY_VIEW.selection).toEqual({});
    const b = setSelection(a, INS, {});
    expect(INS in b.selection).toBe(false);
  });

  it('drops empty values and returns the same view for an equal selection in any key order', () => {
    const a = setSelection(EMPTY_VIEW, INS, { platform: 'Meta Ads', language: 'EN', country: '' });
    expect(a.selection[INS]).toEqual({ platform: 'Meta Ads', language: 'EN' });
    expect(setSelection(a, INS, { language: 'EN', platform: 'Meta Ads' })).toBe(a);
    expect(setSelection(EMPTY_VIEW, INS, {})).toBe(EMPTY_VIEW);
  });

  it('keeps each insight separate', () => {
    const a = setSelection(setSelection(EMPTY_VIEW, INS, { platform: 'TikTok Ads' }), 'other', { cohort: 'new' });
    expect(a.selection).toEqual({ [INS]: { platform: 'TikTok Ads' }, other: { cohort: 'new' } });
  });
});

describe('lanes', () => {
  it('pins up to MAX_LANES distinct selections; a duplicate (any key order) or a fifth is refused', () => {
    expect(MAX_LANES).toBe(4);
    let v: CardView = EMPTY_VIEW;
    v = pinLane(v, INS, { platform: 'Meta Ads', language: 'EN' });
    const dup = pinLane(v, INS, { language: 'EN', platform: 'Meta Ads' });
    expect(dup).toBe(v);
    v = pinLane(v, INS, { platform: 'TikTok Ads' });
    v = pinLane(v, INS, { platform: 'Unattributed' });
    v = pinLane(v, INS, {});
    expect(v.lanes[INS]).toHaveLength(4);
    const fifth = pinLane(v, INS, { language: 'DE' });
    expect(fifth).toBe(v);
  });

  it('unpins by index; the last lane gone removes the entry; a bad index is a no-op', () => {
    let v = pinLane(pinLane(EMPTY_VIEW, INS, { platform: 'A' }), INS, { platform: 'B' });
    expect(unpinLane(v, INS, 5)).toBe(v);
    v = unpinLane(v, INS, 0);
    expect(v.lanes[INS]).toEqual([{ platform: 'B' }]);
    v = unpinLane(v, INS, 0);
    expect(INS in v.lanes).toBe(false);
  });

  it('setLanes replaces the list, deduplicated and capped, and is a no-op for the same list', () => {
    const list = [{ p: '1' }, { p: '1' }, { p: '2' }, { p: '3' }, { p: '4' }, { p: '5' }];
    const v = setLanes(EMPTY_VIEW, INS, list);
    expect(v.lanes[INS]).toEqual([{ p: '1' }, { p: '2' }, { p: '3' }, { p: '4' }]);
    expect(setLanes(v, INS, [{ p: '1' }, { p: '2' }, { p: '3' }, { p: '4' }])).toBe(v);
    expect(INS in setLanes(v, INS, []).lanes).toBe(false);
  });
});

describe('tabs, app page, filters', () => {
  it('holds the open tab per block path; negative or fractional indices read as 0', () => {
    const v = setTab(EMPTY_VIEW, pathKey([1]), 3);
    expect(v.tabs['1']).toBe(3);
    expect(setTab(v, '1', 3)).toBe(v);
    expect(setTab(EMPTY_VIEW, '1', -2)).toBe(EMPTY_VIEW);
    expect(setTab(v, '1', 1.5).tabs['1']).toBe(0);
    expect(pathKey([1, 0, 2])).toBe('1.0.2');
  });

  it('holds the open app page per block path', () => {
    const v = setAppPage(EMPTY_VIEW, '0', 'overview');
    expect(v.appPage).toEqual({ 0: 'overview' });
    expect(setAppPage(v, '0', 'overview')).toBe(v);
    expect(setAppPage(v, '0', 'detail').appPage['0']).toBe('detail');
  });

  it('replaces the filter list (same list = same view)', () => {
    const list: ActiveFilter[] = [{ key: 'c1:0', target: { insight: INS, dataset: 'declines' }, filter: { dim: 'cohort', value: 'new' } }];
    const v = setFilters(EMPTY_VIEW, list);
    expect(v.filters).toBe(list);
    expect(setFilters(v, list)).toBe(v);
  });
});

describe('funnel pick', () => {
  it('EMPTY_VIEW carries an empty funnel map', () => {
    expect(EMPTY_VIEW.funnel).toEqual({});
  });

  it('holds the picked funnel per insight; the same pick is a no-op; null or empty clears it', () => {
    const v = setFunnel(EMPTY_VIEW, INS, 'quiz');
    expect(v.funnel).toEqual({ [INS]: 'quiz' });
    expect(setFunnel(v, INS, 'quiz')).toBe(v);
    const other = setFunnel(v, 'other', 'ladder');
    expect(other.funnel).toEqual({ [INS]: 'quiz', other: 'ladder' });
    expect(setFunnel(other, INS, null).funnel).toEqual({ other: 'ladder' });
    expect(setFunnel(v, INS, '').funnel).toEqual({});
    expect(setFunnel(EMPTY_VIEW, INS, null)).toBe(EMPTY_VIEW);
    // The pick leaves the rest of the view alone.
    expect(setFunnel(setTab(EMPTY_VIEW, '1', 2), INS, 'quiz').tabs).toEqual({ 1: 2 });
  });
});

describe('views by card', () => {
  it('updateView creates a view from EMPTY_VIEW and returns the same map on a no-op', () => {
    const views = updateView({}, 'c1', (v) => setTab(v, '1', 2));
    expect(views.c1.tabs).toEqual({ 1: 2 });
    expect(updateView(views, 'c1', (v) => setTab(v, '1', 2))).toBe(views);
    expect(updateView(views, 'c2', (v) => v)).toBe(views);
  });

  it('pruneViews drops the views of cards that left and keeps the same map when none did', () => {
    const views = { c1: EMPTY_VIEW, c2: setTab(EMPTY_VIEW, '0', 1) };
    expect(pruneViews(views, ['c1', 'c2', 'c3'])).toBe(views);
    expect(pruneViews(views, ['c2'])).toEqual({ c2: views.c2 });
    expect(pruneViews(views, [])).toEqual({});
  });
});
