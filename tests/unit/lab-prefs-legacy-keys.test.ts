/**
 * `.lab-prefs.json` after Insights v2: the v1 board keys (order, catOrder, category, collapsed)
 * and the funnel `columns` survive every write the v2 page makes, and `activeBoard` is added.
 *
 * Why it matters: `PUT /api/lab-prefs` replaces the whole file, and the server derives boards
 * from `order` + `catOrder` until the first edit materializes them. A write that dropped a v1 key
 * would silently reshuffle a legacy vault's derived boards.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_LAB_PREFS, mergePrefs, resolveActiveBoard, type LabPrefs } from '../../dashboard/src/hooks/useLabPrefs';

const LEGACY = {
  order: { 'Growth / Signups': ['daily-signups', 'weekly-signups'], Ungrouped: ['mrr'] },
  catOrder: ['Growth', 'Revenue'],
  category: 'Growth',
  collapsed: ['Revenue / Churn'],
  columns: { 'checkout-funnel': ['users', 'conv'], 'empty-choice': [] },
};

/** What `useLabPrefs().setActiveBoard` does to the blob it reads (then PUTs whole). */
const setActiveBoard = (blob: Partial<LabPrefs>, slug: string | null): LabPrefs => ({ ...mergePrefs(blob), activeBoard: slug });

describe('lab prefs keep their legacy keys', () => {
  it('a v1 file round-trips every key untouched and gains activeBoard: null', () => {
    const merged = mergePrefs(LEGACY);
    expect(merged).toEqual({ ...LEGACY, activeBoard: null });
  });

  it('choosing a board writes activeBoard and leaves order/catOrder/category/collapsed/columns as they were', () => {
    const written = JSON.parse(JSON.stringify(setActiveBoard(LEGACY, 'growth')));
    expect(written).toEqual({ ...LEGACY, activeBoard: 'growth' });
    // And the next read of that file gives the same thing back.
    expect(mergePrefs(written)).toEqual(written);
  });

  it('an empty funnel column choice stays an empty choice (not "no opinion")', () => {
    expect(mergePrefs(LEGACY).columns['empty-choice']).toEqual([]);
  });

  it('keys a newer build wrote are carried through, not dropped', () => {
    const blob = { ...LEGACY, futureKey: { a: 1 } } as Partial<LabPrefs>;
    expect((setActiveBoard(blob, 'x') as unknown as Record<string, unknown>).futureKey).toEqual({ a: 1 });
  });

  it('malformed values fall back to the defaults instead of throwing', () => {
    const merged = mergePrefs({ order: 'nope', catOrder: [1, 'A'], activeBoard: 7 } as unknown as Partial<LabPrefs>);
    expect(merged.order).toEqual({});
    expect(merged.catOrder).toEqual(['A']);
    expect(merged.activeBoard).toBeNull();
    expect(mergePrefs({})).toEqual(DEFAULT_LAB_PREFS);
  });
});

describe('activeBoard fallback', () => {
  const boards = [{ slug: 'growth' }, { slug: 'revenue' }];

  it('opens the saved board while it exists', () => {
    expect(resolveActiveBoard(boards, 'revenue')).toBe('revenue');
  });

  it('falls back to the first board when the saved one is gone, or none was saved', () => {
    expect(resolveActiveBoard(boards, 'deleted-board')).toBe('growth');
    expect(resolveActiveBoard(boards, null)).toBe('growth');
  });

  it('is null with no boards at all (the empty state)', () => {
    expect(resolveActiveBoard([], 'growth')).toBeNull();
  });
});
