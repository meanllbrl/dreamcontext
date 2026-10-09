import { describe, it, expect } from 'vitest';
import {
  LADDER_DEFAULTS,
  deriveLadderBands,
  ladderBand,
  percentile,
  pickBound,
  usableWeeks,
} from '../../src/lib/lab/funnelLadder.js';
import { parseFunnelSet } from '../../src/lib/lab/funnel.js';
import type { FunnelSet, FunnelWeek } from '../../src/lib/lab/types.js';

/**
 * The benchmark ladder: floor = max(book, own p25), target = max(book, own p75),
 * own percentiles only from >= 4 usable weeks (>= 300 users, starting before the
 * judged window, the newest 12), each bound saying which input won.
 */

const week = (t: string, v: number | null, users = 1000): FunnelWeek => ({ t, users, m: { c2s: v } });
const RESOLVED = { minWeeks: 4, minWeekUsers: 300, maxWeeks: 12 };

describe('percentile + pickBound', () => {
  it('linear interpolation, rounded to 4 decimals', () => {
    expect(percentile([0.4, 0.6, 0.8, 1.0, 1.2], 0.25)).toBe(0.6);
    expect(percentile([0.4, 0.6, 0.8, 1.0, 1.2], 0.75)).toBe(1.0);
    expect(percentile([1, 2, 3, 4], 0.25)).toBe(1.75);
    expect(percentile([0.123456, 0.2], 0.5)).toBe(0.1617);
  });

  it('the max of book and own; a tie goes to the book; one side alone wins', () => {
    expect(pickBound(0.5, 0.6)).toEqual({ v: 0.6, from: 'own' });
    expect(pickBound(1.5, 1.0)).toEqual({ v: 1.5, from: 'book' });
    expect(pickBound(1, 1)).toEqual({ v: 1, from: 'book' });
    expect(pickBound(undefined, 0.7)).toEqual({ v: 0.7, from: 'own' });
    expect(pickBound(2, null)).toEqual({ v: 2, from: 'book' });
    expect(pickBound(undefined, null)).toBeNull();
  });
});

describe('usableWeeks', () => {
  it('drops weeks under the user floor, at or after the window, without a value; the later repeat wins; keeps the newest', () => {
    const weeks = [
      week('2026-06-01', 0.1),
      week('2026-06-08', 0.2, 299),        // under the floor
      week('2026-06-15', null),            // no value
      week('2026-06-22', 0.3),
      week('2026-06-22', 0.35),            // repeat: later wins
      week('2026-09-07', 9),               // the judged window starts here: excluded
      week('2026-09-14', 9),
    ];
    expect(usableWeeks(weeks, 'c2s', RESOLVED, '2026-09-07')).toEqual([0.1, 0.35]);
    expect(usableWeeks(weeks, 'c2s', RESOLVED, null)).toEqual([0.1, 0.35, 9, 9]);
    const many = Array.from({ length: 20 }, (_, i) => week(`2026-0${1 + Math.floor(i / 4)}-${String(1 + (i % 4) * 7).padStart(2, '0')}`, i));
    expect(usableWeeks(many, 'c2s', RESOLVED, null)).toEqual(Array.from({ length: 12 }, (_, i) => i + 8));
  });

  it('defaults are 4 weeks, 300 users, 12 weeks', () => {
    expect(LADDER_DEFAULTS).toEqual({ minWeeks: 4, minWeekUsers: 300, maxWeeks: 12 });
  });
});

describe('ladderBand', () => {
  const stage = { metric: 'c2s', book_floor: 0.5, book_target: 1.5, book_source: 'web funnel book' };

  it('book 0.5/1.5 with weeks [0.4, 0.6, 0.8, 1.0, 1.2]: floor 0.6 (own), target 1.5 (book)', () => {
    expect(ladderBand(stage, [1.2, 0.4, 1.0, 0.6, 0.8], RESOLVED, false)).toEqual({
      better: 'higher',
      floor: 0.6,
      floor_from: 'own',
      target: 1.5,
      target_from: 'book',
      target_source: 'web funnel book',
      weeks: 5,
    });
  });

  it('fewer than 4 usable weeks: the set falls back to the book, a funnel gets no band (it inherits)', () => {
    expect(ladderBand(stage, [0.9, 1.0, 1.1], RESOLVED, true)).toEqual({
      better: 'higher', floor: 0.5, floor_from: 'book', floor_source: 'web funnel book',
      target: 1.5, target_from: 'book', target_source: 'web funnel book',
    });
    expect(ladderBand(stage, [0.9, 1.0, 1.1], RESOLVED, false)).toBeNull();
    expect(ladderBand({ metric: 'c2s' }, null, RESOLVED, true)).toBeNull();
  });
});

describe('deriveLadderBands through parseFunnelSet', () => {
  const portfolio = ['2026-07-27', '2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24']
    .map((t, i) => ({ t, users: 5000, m: { c2s: [0.4, 0.6, 0.8, 1.0, 1.2][i] } }));
  const funnel = (id: string, weekly?: unknown) => ({
    id,
    name: id,
    metrics: { c2s: { v: 0.7, format: 'pct' } },
    steps: [{ key: 'users', label: 'Users', users: 1000 }, { key: 'subs', label: 'Subs', users: 7 }],
    ...(weekly ? { weekly } : {}),
  });
  const payload = (extra: Record<string, unknown> = {}) => ({
    kind: 'funnel-set/v1',
    dimensions: [],
    window: { from: '2026-09-07', to: '2026-10-04' },
    ladder: { stages: [{ metric: 'c2s', book_floor: 0.5, book_target: 1.5, book_source: 'web funnel book' }] },
    weekly: [...portfolio, { t: '2026-09-07', users: 5000, m: { c2s: 99 } }],
    funnels: [
      funnel('own', portfolio.map((w) => ({ ...w, m: { c2s: w.m.c2s * 2 } }))),
      funnel('short', portfolio.slice(0, 3)),
      funnel('none'),
    ],
    ...extra,
  });

  it('the set band from the whole-set weeks (the week inside the window never counts); weekly is never stored', () => {
    const { set, notices } = parseFunnelSet(payload());
    expect(set.benchmarks?.c2s).toEqual({
      better: 'higher', floor: 0.6, floor_from: 'own', target: 1.5, target_from: 'book', target_source: 'web funnel book', weeks: 5,
    });
    expect(JSON.stringify(set)).not.toContain('weekly');
    expect(notices).toEqual([]);
  });

  it('a funnel with >= 4 own weeks gets its own band; fewer or none inherits (no band of its own)', () => {
    const { set } = parseFunnelSet(payload());
    const byId = Object.fromEntries(set.funnels.map((f) => [f.id, f]));
    expect(byId.own.benchmarks?.c2s).toEqual({
      better: 'higher', floor: 1.2, floor_from: 'own', target: 2, target_from: 'own', weeks: 5,
    });
    expect(byId.short.benchmarks).toBeUndefined();
    expect(byId.none.benchmarks).toBeUndefined();
  });

  it('an explicit benchmark wins at its level, with a notice', () => {
    const { set, notices } = parseFunnelSet(payload({ benchmarks: { c2s: { floor: 0.9, target: 1.1 } } }));
    expect(set.benchmarks?.c2s).toEqual({ floor: 0.9, target: 1.1 });
    expect(notices).toContain('explicit benchmark "c2s" at set overrides the ladder.');
  });

  it('no weekly at all: the set band is the book alone', () => {
    const { set } = parseFunnelSet(payload({ weekly: undefined }));
    expect(set.benchmarks?.c2s).toMatchObject({ floor: 0.5, floor_from: 'book', target: 1.5, target_from: 'book' });
    expect(set.benchmarks?.c2s.weeks).toBeUndefined();
  });

  it('deriveLadderBands does nothing without a ladder', () => {
    const set: FunnelSet = { kind: 'funnel-set/v1', dimensions: [], funnels: [] };
    deriveLadderBands(set, { funnels: new Map() }, []);
    expect(set.benchmarks).toBeUndefined();
  });
});
