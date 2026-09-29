import { describe, it, expect } from 'vitest';
import {
  applyFrameOps,
  distinctValues,
  frameKey,
  frameOpsFromOptions,
  parseSort,
  type SeriesFrame,
  type TableFrame,
} from '../../src/lib/lab/frameOps.js';

const table = (): TableFrame => {
  const rows = [
    { d: { country: 'TR', plan: 'pro' }, v: 50, n: 5 },
    { d: { country: 'DE', plan: 'pro' }, v: 30, n: 3 },
    { d: { country: 'TR', plan: 'free' }, v: 10, n: 1 },
    { d: { country: 'US', plan: 'free' }, v: null, n: 2 },
    { d: { country: 'TR', plan: 'team' }, v: 40, n: 4 },
    { d: { country: 'DE', plan: 'free' }, v: 20, n: 2 },
  ];
  return {
    kind: 'table',
    insight: 'revenue',
    dataset: 'by-country',
    label: null,
    dims: [{ key: 'country', label: 'Country' }, { key: 'plan', label: 'Plan' }],
    rows,
    sourceTotal: { v: 999, n: 17 },
    total: { count: rows.length, v: 999, n: 17 },
    unit: 'USD',
  };
};

describe('applyFrameOps: where -> filter -> sort -> limit', () => {
  it('the filtered total is correct under a limit (computed after filtering, before the limit)', () => {
    const out = applyFrameOps(table(), {
      filter: { dim: 'country', value: 'TR' },
      sort: { by: 'v', dir: 'desc' },
      limit: 2,
    }) as TableFrame;
    expect(out.rows.map((r) => r.v)).toEqual([50, 40]);
    expect(out.total).toEqual({ count: 3, v: 100, n: 10 });
  });

  it('where runs before the interactive filter, and both before sort/limit', () => {
    const out = applyFrameOps(table(), {
      where: { plan: ['pro', 'free'] },
      filter: { dim: 'country', value: 'DE' },
      sort: { by: 'v', dir: 'asc' },
      limit: 1,
    }) as TableFrame;
    expect(out.rows).toEqual([{ d: { country: 'DE', plan: 'free' }, v: 20, n: 2 }]);
    expect(out.total).toEqual({ count: 2, v: 50, n: 5 });
  });

  it('with nothing filtered out the source grand total is kept (a rate is not a sum)', () => {
    const out = applyFrameOps(table(), { sort: { by: 'v', dir: 'desc' }, limit: 2 }) as TableFrame;
    expect(out.rows).toHaveLength(2);
    expect(out.total).toEqual({ count: 6, v: 999, n: 17 });
  });

  it('sorts nulls last in both directions, stably, and by dim values', () => {
    const desc = applyFrameOps(table(), { sort: { by: 'v', dir: 'desc' } }) as TableFrame;
    expect(desc.rows.map((r) => r.v)).toEqual([50, 40, 30, 20, 10, null]);
    const asc = applyFrameOps(table(), { sort: { by: 'v', dir: 'asc' } }) as TableFrame;
    expect(asc.rows.map((r) => r.v)).toEqual([10, 20, 30, 40, 50, null]);
    const byDim = applyFrameOps(table(), { sort: { by: 'country', dir: 'asc' } }) as TableFrame;
    expect(byDim.rows.map((r) => r.d.country)).toEqual(['DE', 'DE', 'TR', 'TR', 'TR', 'US']);
  });

  it('never mutates the input frame', () => {
    const t = table();
    const snapshot = JSON.stringify(t);
    applyFrameOps(t, { where: { country: ['TR'] }, sort: { by: 'v', dir: 'desc' }, limit: 1 });
    expect(JSON.stringify(t)).toBe(snapshot);
  });

  it('series: pick in the given order, then keep the last `limit` points', () => {
    const s: SeriesFrame = {
      kind: 'series', insight: 'x', unit: null, granularity: 'daily',
      series: [
        { name: 'a', points: [{ t: '1', v: 1 }, { t: '2', v: 2 }, { t: '3', v: 3 }] },
        { name: 'b', points: [{ t: '1', v: 4 }] },
      ],
    };
    const out = applyFrameOps(s, { series: ['b', 'a', 'missing'], limit: 2 }) as SeriesFrame;
    expect(out.series.map((x) => x.name)).toEqual(['b', 'a']);
    expect(out.series[1].points.map((p) => p.v)).toEqual([2, 3]);
  });

  it('other kinds pass through', () => {
    const v = { kind: 'value' as const, insight: 'x', value: 1, prev: null, spark: [], unit: null };
    expect(applyFrameOps(v, { limit: 1 })).toBe(v);
  });
});

describe('options -> ops', () => {
  it('reads where/sort/limit/series leniently and caps the limit at 400', () => {
    expect(frameOpsFromOptions({ where: { country: 'TR', plan: ['pro', 1], bad: {} }, sort: '-v', limit: 5000, series: 'a' })).toEqual({
      where: { country: ['TR'], plan: ['pro', '1'] },
      sort: { by: 'v', dir: 'desc' },
      limit: 400,
      series: ['a'],
    });
    expect(frameOpsFromOptions({ limit: 0, sort: 7, where: 'x' })).toEqual({});
    expect(frameOpsFromOptions(undefined)).toEqual({});
  });

  it('parseSort accepts "-v", "label" and {by, dir}', () => {
    expect(parseSort('-v')).toEqual({ by: 'v', dir: 'desc' });
    expect(parseSort('country')).toEqual({ by: 'country', dir: 'asc' });
    expect(parseSort({ by: 'n', dir: 'desc' })).toEqual({ by: 'n', dir: 'desc' });
    expect(parseSort({ by: '' })).toBeNull();
  });
});

describe('helpers', () => {
  it('distinctValues honours where, in first-seen order', () => {
    expect(distinctValues(table(), 'country')).toEqual(['TR', 'DE', 'US']);
    expect(distinctValues(table(), 'country', { plan: ['free'] })).toEqual(['TR', 'US', 'DE']);
  });

  it('frameKey = card:path[#input]', () => {
    expect(frameKey('c-a', [0])).toBe('c-a:0');
    expect(frameKey('c-a', [2, 1, 0])).toBe('c-a:2.1.0');
    expect(frameKey('c-a', [1], 'signups')).toBe('c-a:1#signups');
  });
});
