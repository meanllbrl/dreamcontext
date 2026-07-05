import { describe, it, expect } from 'vitest';
import { deriveGranularity, capSeries, rollupSeries, MAX_POINTS } from '../../src/lib/lab/rollup.js';
import type { SeriesPoint } from '../../src/lib/lab/types.js';

function dailyPoints(days: number, startISO = '2025-01-01'): SeriesPoint[] {
  const start = Date.parse(`${startISO}T00:00:00Z`);
  const out: SeriesPoint[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start + i * 86_400_000);
    out.push({ t: d.toISOString().slice(0, 10), v: i });
  }
  return out;
}

describe('deriveGranularity — boundary-tested', () => {
  it('> 180 days => monthly', () => {
    expect(deriveGranularity(181)).toBe('monthly');
    expect(deriveGranularity(365)).toBe('monthly');
  });
  it('180 days exactly => weekly (boundary is exclusive on the monthly side)', () => {
    expect(deriveGranularity(180)).toBe('weekly');
  });
  it('46 days => weekly, 45 days => daily (the 45/46 boundary)', () => {
    expect(deriveGranularity(46)).toBe('weekly');
    expect(deriveGranularity(45)).toBe('daily');
  });
  it('30 days => daily', () => {
    expect(deriveGranularity(30)).toBe('daily');
  });
});

describe('capSeries — structural MAX_POINTS enforcement', () => {
  it('a year of daily raw points rolls to <= MAX_POINTS (62) MONTHLY buckets — no daily/weekly survive', () => {
    const points = dailyPoints(365);
    const { points: capped, granularity } = capSeries(points, deriveGranularity(365), 'last');
    expect(granularity).toBe('monthly');
    expect(capped.length).toBeLessThanOrEqual(MAX_POINTS);
    // Monthly keys look like YYYY-MM, never YYYY-MM-DD or YYYY-Www.
    for (const p of capped) expect(p.t).toMatch(/^\d{4}-\d{2}$/);
  });

  it('a 30-day daily insight keeps <= 31 daily points', () => {
    const points = dailyPoints(30);
    const { points: capped, granularity } = capSeries(points, deriveGranularity(30), 'last');
    expect(granularity).toBe('daily');
    expect(capped.length).toBeLessThanOrEqual(31);
    for (const p of capped) expect(p.t).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('coarsens progressively (daily -> weekly -> monthly) until under cap', () => {
    // ~200 days spans past the weekly cap too (200/7 ≈ 28 weeks, under cap) —
    // use a longer daily span to force a full monthly fallback.
    const points = dailyPoints(800);
    const { points: capped, granularity } = capSeries(points, 'daily', 'last');
    expect(granularity).toBe('monthly');
    expect(capped.length).toBeLessThanOrEqual(MAX_POINTS);
  });

  it('keeps the newest MAX_POINTS if still over cap at monthly (>62 months of data)', () => {
    // 70 months of daily-ish points spaced a month apart.
    const points: SeriesPoint[] = [];
    for (let i = 0; i < 70; i++) {
      const year = 2020 + Math.floor(i / 12);
      const month = (i % 12) + 1;
      points.push({ t: `${year}-${String(month).padStart(2, '0')}-01`, v: i });
    }
    const { points: capped } = capSeries(points, 'monthly', 'last');
    expect(capped.length).toBeLessThanOrEqual(MAX_POINTS);
    // The newest point survives.
    expect(capped[capped.length - 1].v).toBe(69);
  });
});

describe('rollupSeries — shared granularity across multi-series', () => {
  it('rolls every raw series to the same final granularity', () => {
    const a = { name: 'A', points: dailyPoints(365) };
    const b = { name: 'B', points: dailyPoints(365) };
    const { series, granularity } = rollupSeries([a, b], 365, 'last');
    expect(granularity).toBe('monthly');
    for (const s of series) {
      expect(s.points.length).toBeLessThanOrEqual(MAX_POINTS);
    }
  });

  it('supports sum/mean/max aggregation', () => {
    const points: SeriesPoint[] = [
      { t: '2025-01-01', v: 1 },
      { t: '2025-01-01', v: 3 },
    ];
    const sum = rollupSeries([{ name: 'x', points }], 10, 'sum');
    expect(sum.series[0].points[0].v).toBe(4);
    const mean = rollupSeries([{ name: 'x', points }], 10, 'mean');
    expect(mean.series[0].points[0].v).toBe(2);
    const max = rollupSeries([{ name: 'x', points }], 10, 'max');
    expect(max.series[0].points[0].v).toBe(3);
  });
});
