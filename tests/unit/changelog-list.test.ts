import { describe, it, expect } from 'vitest';
import { listChangelogEntries, type ChangelogEntry } from '../../src/lib/changelog-list.js';

/**
 * `dreamcontext changelog list` core: paginated CHRONOLOGICAL browse of
 * CHANGELOG.json (LIFO preserved), with exact type/scope filters and a
 * case-insensitive grep. Complements recall (relevance search) — this is the
 * "what happened, in order?" surface (owner ask 2026-07-30).
 */

const entries: ChangelogEntry[] = Array.from({ length: 25 }, (_, i) => ({
  date: `2026-07-${String(30 - i).padStart(2, '0')}`,
  type: i % 3 === 0 ? 'feat' : 'fix',
  scope: i % 2 === 0 ? 'chat' : 'sleep',
  summary: `Headline ${i} about ${i % 5 === 0 ? 'Öğretmen paneli' : 'plumbing'}`,
  description: `Detail ${i}`,
}));

describe('listChangelogEntries', () => {
  it('pages LIFO order without reordering', () => {
    const p1 = listChangelogEntries(entries, { page: 1, size: 10 });
    expect(p1.entries).toHaveLength(10);
    expect(p1.entries[0].summary).toBe('Headline 0 about Öğretmen paneli');
    expect(p1.total).toBe(25);
    expect(p1.pages).toBe(3);

    const p3 = listChangelogEntries(entries, { page: 3, size: 10 });
    expect(p3.entries).toHaveLength(5);
    expect(p3.entries[0].summary).toBe('Headline 20 about Öğretmen paneli');
  });

  it('a page past the end is empty but the totals stay honest', () => {
    const p = listChangelogEntries(entries, { page: 9, size: 10 });
    expect(p.entries).toEqual([]);
    expect(p.total).toBe(25);
    expect(p.pages).toBe(3);
    expect(p.page).toBe(9);
  });

  it('clamps size to [1, 50] and page to >= 1', () => {
    expect(listChangelogEntries(entries, { size: 500 }).size).toBe(50);
    expect(listChangelogEntries(entries, { size: 0 }).size).toBe(1);
    expect(listChangelogEntries(entries, { page: -3 }).page).toBe(1);
  });

  it('filters by exact type and scope', () => {
    const feats = listChangelogEntries(entries, { type: 'feat', size: 50 });
    expect(feats.total).toBe(9);
    expect(feats.entries.every((e) => e.type === 'feat')).toBe(true);

    const both = listChangelogEntries(entries, { type: 'feat', scope: 'chat', size: 50 });
    expect(both.entries.every((e) => e.type === 'feat' && e.scope === 'chat')).toBe(true);
  });

  it('greps case-insensitively across summary + description + scope (Turkish intact)', () => {
    const hit = listChangelogEntries(entries, { grep: 'öğretmen paneli', size: 50 });
    expect(hit.total).toBe(5);

    const byScope = listChangelogEntries(entries, { grep: 'SLEEP', size: 50 });
    expect(byScope.total).toBe(12);

    expect(listChangelogEntries(entries, { grep: 'no-such-thing' }).total).toBe(0);
  });

  it('handles an empty changelog', () => {
    const p = listChangelogEntries([], {});
    expect(p).toEqual({ entries: [], total: 0, page: 1, pages: 1, size: 10 });
  });
});
