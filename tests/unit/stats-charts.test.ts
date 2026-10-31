import { describe, expect, it } from 'vitest';
import { ecoStartAt, topEaters, trendBuckets } from '../../dashboard/src/components/stats/statsCharts';
import type { ProjectRow } from '../../dashboard/src/components/stats/statsTypes';

const row = (key: string, sleep: number, memory: number, saved: number, owner: number | null = 1): ProjectRow => ({
  key, label: key, tokens: 1, cost: 10, prompts: owner === null ? null : { owner, super: 0, auto: 0 },
  sleep: { tokens: 1, cost: sleep }, estMemory: { tokens: 1, cost: memory }, estSaved: { tokens: 1, cost: saved },
  estNet: { tokens: 0, cost: saved - sleep - memory },
});

describe('the project charts', () => {
  it('biggest eater first, nothing for a zero line, five and one Other that keeps the sums', () => {
    const rows = [row('a', 1, 0, 0), row('zero', 0, 0, 0), row('b', 9, 1, 2), row('c', 8, 0, 0), row('d', 7, 0, 0), row('e', 6, 0, 0), row('f', 5, 0, 1), row('g', 0, 0.5, 0, null)];
    const items = topEaters(rows);
    expect(items.map((i) => i.key)).toEqual(['b', 'c', 'd', 'e', 'f', '\0other']);
    const other = items[5];
    expect(other).toMatchObject({ others: 2, sleep: 1, memory: 0.5, prompts: 1 });
    expect(other.net).toBeCloseTo(-1.5);
  });

  it('a lone project is one line, no Other; only-saved stays', () => {
    expect(topEaters([row('a', 1, 1, 0)]).map((i) => i.key)).toEqual(['a']);
    expect(topEaters([row('a', 0, 0, 3)]).map((i) => i.key)).toEqual(['a']);
    expect(topEaters([row('a', 0, 0, 0)])).toEqual([]);
  });

  it('weeks count back from today and lose nothing', () => {
    const days = Array.from({ length: 90 }, (_, i) => ({ start: i * 10, end: (i + 1) * 10 }));
    const one = days.map(() => 1);
    const weeks = trendBuckets(days, { sleep: one, memory: one, saved: one }, true);
    expect(weeks).toHaveLength(13);
    expect(weeks[12]).toMatchObject({ start: 830, end: 900, sleep: 7 });
    expect(weeks.reduce((a, w) => a + w.sleep, 0)).toBe(90);
    expect(trendBuckets(days, { sleep: one, memory: one, saved: one }, false)).toHaveLength(90);
  });

  it('the Eco mark sits inside its bucket, is gone when the record covers the range, and fills it when there is none', () => {
    const days = [{ start: 0, end: 10 }, { start: 10, end: 20 }, { start: 20, end: 30 }];
    expect(ecoStartAt(days, 15)).toBe(1.5);
    expect(ecoStartAt(days, 0)).toBeNull();
    expect(ecoStartAt(days, -5)).toBeNull();
    expect(ecoStartAt(days, null)).toBe(3);
    expect(ecoStartAt(days, 99)).toBe(3);
  });
});
