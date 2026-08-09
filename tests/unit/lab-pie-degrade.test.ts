/**
 * The pie → bar degrade rule.
 *
 * A pie with too many slices is the bug that broke the board's rows: the wedges
 * stop reading and the legend grows the card until the grid row breaks. The fix
 * is a DATA rule (`degradesToBars`), which is why it lives in barRows.ts and can
 * be asserted here without a DOM: the threshold, the ranking/cap the two renders
 * share, and — textually, the chartRegistry drift-guard idiom — that PieChart
 * still routes through the rule instead of re-inlining a comparison.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BAR_THRESHOLD,
  ROW_CAP,
  degradesToBars,
  rankRows,
  toBarRows,
} from '../../dashboard/src/components/lab/barRows.js';

const LAB_DIR = join(import.meta.dirname, '../../dashboard/src/components/lab');

/** N series, each one point, descending values — the shape a pie is fed. */
function fakeSeries(n: number): { name: string; points: { t: string; v: number }[] }[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `s${i + 1}`,
    points: [{ t: '2026-08-08', v: 100 - i }],
  }));
}

describe('degradesToBars — the ≥7-slice threshold', () => {
  it('keeps the donut at 6 slices and below', () => {
    for (let n = 0; n <= 6; n++) expect(degradesToBars(n), `${n} slices`).toBe(false);
  });

  it('degrades at 7 slices and above', () => {
    for (const n of [7, 8, 12, 40]) expect(degradesToBars(n), `${n} slices`).toBe(true);
  });

  it('pins the threshold at 7 (the documented donut ≤ 6 rule)', () => {
    expect(BAR_THRESHOLD).toBe(7);
    expect(degradesToBars(BAR_THRESHOLD - 1)).toBe(false);
    expect(degradesToBars(BAR_THRESHOLD)).toBe(true);
  });

  it('decides on the ROWS the pie would draw, not the raw series count', () => {
    // Eight series, but two are non-positive: `toBarRows` drops those, leaving
    // six drawable slices — still a donut. Deciding on `series.length` here
    // would degrade a readable pie.
    const series = [...fakeSeries(6), { name: 'zero', points: [{ t: '2026-08-08', v: 0 }] }, { name: 'empty', points: [] }];
    const rows = toBarRows(series);
    expect(rows).toHaveLength(6);
    expect(degradesToBars(rows.length)).toBe(false);
  });
});

describe('toBarRows — the shared row math', () => {
  it('takes each series\' LATEST point and share-weights it', () => {
    const rows = toBarRows([
      { name: 'a', points: [{ t: '2026-08-01', v: 1 }, { t: '2026-08-02', v: 30 }] },
      { name: 'b', points: [{ t: '2026-08-02', v: 10 }] },
    ]);
    expect(rows.map((r) => [r.name, r.value])).toEqual([['a', 30], ['b', 10]]);
    expect(rows[0].frac).toBeCloseTo(0.75);
    expect(rows[1].frac).toBeCloseTo(0.25);
  });

  it('colors rows from the --chart-n token scale, cycling past 8', () => {
    const rows = toBarRows(fakeSeries(9));
    expect(rows[0].color).toBe('var(--chart-1)');
    expect(rows[7].color).toBe('var(--chart-8)');
    expect(rows[8].color).toBe('var(--chart-1)');
  });

  it('returns nothing when no series has a positive latest value', () => {
    expect(toBarRows([{ name: 'a', points: [{ t: '2026-08-08', v: 0 }] }])).toEqual([]);
    expect(toBarRows([])).toEqual([]);
  });
});

describe('rankRows — the card cap vs the detail panel', () => {
  it('caps the card at ROW_CAP rows and summarises the tail', () => {
    const { rows, restCount, restFrac } = rankRows(toBarRows(fakeSeries(9)), false);
    expect(ROW_CAP).toBe(5);
    expect(rows).toHaveLength(ROW_CAP);
    expect(restCount).toBe(4);
    expect(restFrac).toBeGreaterThan(0);
    // Ranked by value, biggest first.
    expect(rows.map((r) => r.name)).toEqual(['s1', 's2', 's3', 's4', 's5']);
  });

  it('shows every row (and no tail) in the full/detail variant', () => {
    const { rows, restCount, restFrac } = rankRows(toBarRows(fakeSeries(9)), true);
    expect(rows).toHaveLength(9);
    expect(restCount).toBe(0);
    expect(restFrac).toBe(0);
  });

  it('leaves a short list alone', () => {
    const { rows, restCount } = rankRows(toBarRows(fakeSeries(ROW_CAP)), false);
    expect(rows).toHaveLength(ROW_CAP);
    expect(restCount).toBe(0);
  });
});

describe('the renders wire through the shared rule', () => {
  const pie = readFileSync(join(LAB_DIR, 'PieChart.tsx'), 'utf-8');
  const bar = readFileSync(join(LAB_DIR, 'BarChart.tsx'), 'utf-8');

  it('PieChart degrades via degradesToBars — never an inline comparison', () => {
    expect(pie).toMatch(/if \(degradesToBars\(slices\.length\)\) \{/);
    expect(pie).not.toMatch(/slices\.length\s*>=\s*\d/);
  });

  it('the degrade draws the SAME BarList the `bar` render draws', () => {
    expect(pie).toMatch(/<BarList rows=\{slices\}/);
    expect(bar).toMatch(/<BarList rows=\{rows\}/);
    for (const source of [pie, bar]) {
      expect(source).toMatch(/import \{ BarList \} from '\.\/BarList'/);
    }
  });
});
