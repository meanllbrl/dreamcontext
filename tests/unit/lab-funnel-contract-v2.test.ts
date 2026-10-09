import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_FUNNEL_BYTES,
  MAX_NOTES,
  computeFunnelPrev,
  computeStepRows,
  funnelLatest,
  funnelSetRange,
  funnelToSeries,
  makeFunnelSnapshot,
  parseFunnelSet,
  worstDropIndex,
} from '../../src/lib/lab/funnel.js';
import {
  computeStepRows as dashboardStepRows,
  worstDropIndex as dashboardWorstDrop,
} from '../../dashboard/src/components/lab/funnel/funnelModel';
import { createInsight, readCache } from '../../src/lib/lab/store.js';
import { syncInsight } from '../../src/lib/lab/sync.js';
import { readFrontmatter, writeFrontmatter } from '../../src/lib/frontmatter.js';
import type { FunnelCacheEntry } from '../../src/lib/lab/types.js';

/**
 * The funnel explorer contract: funnel-set/v1 extended additively. Every new
 * field is optional, capped with a notice, and a payload without them parses
 * exactly as before.
 */

const steps = [
  { key: 'visit', label: 'Visit', users: 1000 },
  { key: 'lead', label: 'Lead', users: 400 },
  { key: 'buy', label: 'Buy', users: 40 },
];

/** A payload with none of the new fields (the shape every existing insight returns). */
const OLD = {
  kind: 'funnel-set/v1',
  primary: 'conversion',
  low_sample_threshold: 100,
  segment_mode: 'lookup',
  dimensions: [{ key: 'country', label: 'Country', mode: 'client' }],
  benchmarks: { conversion: { floor: 2, target: 5, floor_source: 'book', better: 'higher' } },
  funnels: [{
    id: 'quiz',
    name: 'Quiz',
    meta: { window: '28 days' },
    metrics: { conversion: { v: 4, format: 'pct', prev: 3.5 }, spend: { v: 900, format: 'usd' } },
    steps,
    daily: [{ t: '2026-09-01', m: { conversion: 4.1 } }],
    segments: [
      { dims: { country: 'TR' }, users: 600, steps: [{ key: 'visit', users: 600 }, { key: 'lead', users: 250 }, { key: 'buy', users: 30 }], metrics: { conversion: { v: 5, format: 'pct' } } },
      { dims: { country: 'DE' }, users: 0, steps: [], measured: false, reason: 'under 300 users' },
    ],
  }],
};

/** What OLD parses to (pinned: the pre-change output). */
const OLD_PARSED = {
  kind: 'funnel-set/v1',
  dimensions: [{ key: 'country', label: 'Country', mode: 'client' }],
  funnels: [{
    id: 'quiz',
    name: 'Quiz',
    meta: { window: '28 days' },
    metrics: { conversion: { v: 4, format: 'pct', prev: 3.5 }, spend: { v: 900, format: 'usd' } },
    steps,
    daily: [{ t: '2026-09-01', m: { conversion: 4.1 } }],
    segments: [
      { dims: { country: 'TR' }, users: 600, steps: [{ key: 'visit', users: 600 }, { key: 'lead', users: 250 }, { key: 'buy', users: 30 }], metrics: { conversion: { v: 5, format: 'pct' } } },
      { dims: { country: 'DE' }, users: 0, steps: [], measured: false, reason: 'under 300 users' },
    ],
  }],
  primary: 'conversion',
  low_sample_threshold: 100,
  benchmarks: { conversion: { floor: 2, target: 5, floor_source: 'book', better: 'higher' } },
  segment_mode: 'lookup',
};

function full(extra: Record<string, unknown> = {}, funnelExtra: Record<string, unknown> = {}) {
  return {
    ...OLD,
    funnels: [{ ...OLD.funnels[0], ...funnelExtra }],
    ...extra,
  };
}

describe('back-compat', () => {
  it('a payload without the new fields parses deep-equal to the pre-change output, with no notices', () => {
    const { set, notices } = parseFunnelSet(OLD);
    expect(set).toEqual(OLD_PARSED);
    expect(JSON.stringify(set)).toBe(JSON.stringify(OLD_PARSED));
    expect(notices).toEqual([]);
  });

  it('the stored-set byte cap is unchanged', () => {
    expect(MAX_FUNNEL_BYTES).toBe(400_000);
  });
});

describe('new fields parse', () => {
  it('steps: basis, and measured:false drops the count and keeps the reason', () => {
    const { set, notices } = parseFunnelSet(full({}, {
      steps: [
        { key: 'visit', label: 'Visit', users: 1000 },
        { key: 'lead', label: 'Lead', users: 400, basis: 'derived' },
        { key: 'buy', label: 'Buy', users: 9, measured: false, reason: 'the event is not recorded' },
        { key: 'x', label: 'X', users: 1, basis: 'guessed' },
      ],
    }));
    expect(set.funnels[0].steps).toEqual([
      { key: 'visit', label: 'Visit', users: 1000 },
      { key: 'lead', label: 'Lead', users: 400, basis: 'derived' },
      { key: 'buy', label: 'Buy', users: 0, measured: false, reason: 'the event is not recorded' },
      { key: 'x', label: 'X', users: 1 },
    ]);
    expect(notices.some((n) => n.includes('unknown basis "guessed"'))).toBe(true);
  });

  it('set and funnel fields: window, provenance, notes, hints, rates, intersections, payment, reasons, access, unmeasured, own benchmarks', () => {
    const { set, notices } = parseFunnelSet(full({
      window: { from: '2026-09-07', to: '2026-10-04', prev_from: '2026-08-10', prev_to: '2026-09-06' },
      provenance: { source: 'Funnel Analysis via KB MCP', pulled_at: '2026-10-08T14:33:48Z', freshness: 'data 2h old', filters: ['product = Acme', 'date 2026-09-07..2026-10-04'] },
      notes: [{ text: 'Country RU is a language, not a country', code: 'R1', keys: ['dim:country'] }, { text: 'Refund rate not used', level: 'info' }],
      hints: { daily: 'query by event day', 'dim:country': 'query by country', payment: 'acceptance report' },
      rates: { conversion: { num: 'buy', den: 'visit' } },
      intersections: [{ dims: ['country'], min_users: 300 }],
      payment: { cells: [{ dims: {}, attempts: 50, declines: 5 }] },
      payment_reasons: [{ key: 'insufficient', label: 'Insufficient funds', note: 'the card had no money' }],
      access: { stages: [{ key: 'paid', label: 'Paid' }, { key: 'app', label: 'Opened the app' }], rows: [{ counts: { paid: 100, app: 60 } }, { funnel: 'quiz', counts: { paid: 40, app: null } }], as_of: '2026-10-08' },
    }, {
      notes: [{ text: 'Lead is below finish here', keys: ['lead', 'buy'] }],
      benchmarks: { conversion: { floor: 3, target: 6, floor_from: 'own', target_from: 'book', weeks: 8 } },
      payment: { cells: [{ dims: {}, cohort: 'first', attempts: 300, declines: 30, reasons: { insufficient: 12 } }, { dims: { country: 'TR' }, attempts: 80, declines: 9 }] },
      unmeasured: { 'dim:country': 'country split not pulled for this funnel' },
    }));
    expect(notices).toEqual([]);
    expect(set.window).toEqual({ from: '2026-09-07', to: '2026-10-04', prev_from: '2026-08-10', prev_to: '2026-09-06' });
    expect(set.provenance?.filters).toEqual(['product = Acme', 'date 2026-09-07..2026-10-04']);
    expect(set.notes).toEqual([
      { text: 'Country RU is a language, not a country', code: 'R1', keys: ['dim:country'] },
      { text: 'Refund rate not used', level: 'info' },
    ]);
    expect(set.hints).toEqual({ daily: 'query by event day', 'dim:country': 'query by country', payment: 'acceptance report' });
    expect(set.rates).toEqual({ conversion: { num: 'buy', den: 'visit' } });
    expect(set.intersections).toEqual([{ dims: ['country'], min_users: 300 }]);
    expect(set.payment).toEqual({ cells: [{ dims: {}, attempts: 50, declines: 5 }] });
    expect(set.payment_reasons).toEqual([{ key: 'insufficient', label: 'Insufficient funds', note: 'the card had no money' }]);
    expect(set.access).toEqual({
      stages: [{ key: 'paid', label: 'Paid' }, { key: 'app', label: 'Opened the app' }],
      rows: [{ counts: { paid: 100, app: 60 } }, { funnel: 'quiz', counts: { paid: 40, app: null } }],
      as_of: '2026-10-08',
    });
    const f = set.funnels[0];
    expect(f.notes).toEqual([{ text: 'Lead is below finish here', keys: ['lead', 'buy'] }]);
    expect(f.benchmarks).toEqual({ conversion: { floor: 3, target: 6, floor_from: 'own', target_from: 'book', weeks: 8 } });
    expect(f.payment?.cells[0]).toEqual({ dims: {}, cohort: 'first', attempts: 300, declines: 30, reasons: { insufficient: 12 } });
    expect(f.unmeasured).toEqual({ 'dim:country': 'country split not pulled for this funnel' });
  });

  it('payment measured:false keeps its reason with no cells', () => {
    const { set } = parseFunnelSet(full({}, { payment: { measured: false, reason: 'no funnel id in the acceptance report', cells: [] } }));
    expect(set.funnels[0].payment).toEqual({ cells: [], measured: false, reason: 'no funnel id in the acceptance report' });
  });
});

describe('bad input is a notice, never a throw', () => {
  it('drops a bad window, an undeclared intersection dim, a non-part hint key, a rate without steps', () => {
    const { set, notices } = parseFunnelSet(full({
      window: { from: '2026-10-04', to: '2026-09-07' },
      intersections: [{ dims: ['country', 'platform'] }],
      hints: { nonsense: 'x', daily: 'ok' },
      rates: { conversion: { num: 'buy' } },
      provenance: { filters: ['x'] },
      ladder: { stages: [] },
      access: { stages: [] },
      payment: { cells: [{ dims: {}, attempts: 'many' }] },
    }));
    expect(set.window).toBeUndefined();
    expect(set.intersections).toBeUndefined();
    expect(set.hints).toEqual({ daily: 'ok' });
    expect(set.rates).toBeUndefined();
    expect(set.provenance).toBeUndefined();
    expect(set.ladder).toBeUndefined();
    expect(set.access).toBeUndefined();
    expect(set.payment).toBeUndefined();
    for (const bit of ['window:', '"platform" are not declared', 'key "nonsense"', 'rates "conversion"', 'provenance:', 'ladder:', 'access:', 'payment cell 1']) {
      expect(notices.some((n) => n.includes(bit)), bit).toBe(true);
    }
  });
});

describe('caps, each with a notice', () => {
  it('notes per level, note text, note keys', () => {
    const notes = Array.from({ length: MAX_NOTES + 2 }, (_, i) => ({ text: `note ${i}`, keys: Array.from({ length: 20 }, (_, k) => `k${k}`) }));
    notes[0].text = 'x'.repeat(250);
    const { set, notices } = parseFunnelSet(full({ notes }));
    expect(set.notes).toHaveLength(MAX_NOTES);
    expect(set.notes![0].text).toHaveLength(200);
    expect(set.notes![1].keys).toHaveLength(16);
    expect(notices.some((n) => n.includes('set notes: 10 given, kept the first 8'))).toBe(true);
    expect(notices.some((n) => n.includes('over 200 chars'))).toBe(true);
  });

  it('hints, provenance filters, payment cells and reasons, access stages and rows, ladder stages, weekly', () => {
    const hints = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`metric:m${i}`, 'fill it']));
    const reasons = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`r${i}`, 1]));
    const cells = Array.from({ length: 70 }, (_, i) => ({ dims: { country: `C${i}` }, attempts: 10, declines: 1, reasons }));
    const { set, notices } = parseFunnelSet(full({
      hints,
      provenance: { source: 'src', filters: Array.from({ length: 10 }, (_, i) => `f${i}`) },
      payment: { cells },
      access: {
        stages: Array.from({ length: 10 }, (_, i) => ({ key: `s${i}`, label: `S${i}` })),
        rows: Array.from({ length: 70 }, () => ({ counts: { s0: 1 } })),
      },
      ladder: { stages: Array.from({ length: 20 }, (_, i) => ({ metric: `m${i}` })) },
      weekly: Array.from({ length: 60 }, (_, i) => ({ t: new Date(Date.UTC(2025, 0, 6 + 7 * i)).toISOString().slice(0, 10), users: 500, m: {} })),
    }));
    expect(Object.keys(set.hints!)).toHaveLength(24);
    expect(set.provenance!.filters).toHaveLength(8);
    expect(set.payment!.cells).toHaveLength(64);
    expect(Object.keys(set.payment!.cells[0].reasons!)).toHaveLength(12);
    expect(set.access!.stages).toHaveLength(8);
    expect(set.access!.rows).toHaveLength(64);
    expect(set.ladder!.stages).toHaveLength(16);
    for (const bit of ['hints: 30 entries, kept the first 24', 'provenance filters: 10 given', 'set payment cells: 70 given', 'more than 12 reasons', 'access stages: 10 given', 'access rows: 70 given', 'ladder stages: 20 given', '60 weekly entries, kept the newest 52']) {
      expect(notices.some((n) => n.includes(bit)), bit).toBe(true);
    }
  });

  it('weekly is never stored, at any level', () => {
    const weekly = [{ t: '2026-08-03', users: 900, m: { conversion: 3 } }];
    const { set, notices } = parseFunnelSet(full({ weekly }, { weekly }));
    expect(JSON.stringify(set)).not.toContain('weekly');
    expect(notices).toContain('weekly history given without a ladder: ignored.');
  });
});

describe('an unmeasured step never becomes a 0 downstream', () => {
  const unmeasured = () => parseFunnelSet(full({}, {
    steps: [
      { key: 'visit', label: 'Visit', users: 1000, measured: false, reason: 'the visit event is not recorded' },
      { key: 'lead', label: 'Lead', users: 400 },
      { key: 'buy', label: 'Buy', users: 9, measured: false, reason: 'the event is not recorded' },
    ],
  })).set;

  it('series skip it, latest takes the first measured step', () => {
    const set = unmeasured();
    expect(funnelToSeries(set)[0].points).toEqual([{ t: 'Lead', v: 400 }]);
    expect(funnelLatest({ ...set, primary: undefined })).toBe(400);
    const none = { ...set, primary: undefined, funnels: [{ ...set.funnels[0], steps: set.funnels[0].steps.filter((s) => s.measured === false) }] };
    expect(funnelLatest(none)).toBeNull();
  });

  it('a history snapshot leaves it out, and a later delta reads it as no value', () => {
    const set = unmeasured();
    const range = { fromISO: '2026-08-10', toISO: '2026-09-06' };
    const snap = makeFunnelSnapshot(set, range, '2026-09-07T00:00:00Z');
    expect(snap.funnels[0].steps).toEqual([{ key: 'lead', users: 400 }]);

    // The next window measures every step: an unmeasured step in the snapshot is no previous value, never 0.
    const next = parseFunnelSet(OLD).set;
    const nextFunnel = { ...next.funnels[0], steps: [
      { key: 'visit', label: 'Visit', users: 1000 }, { key: 'lead', label: 'Lead', users: 400 }, { key: 'buy', label: 'Buy', users: 40 },
    ] };
    const entry: FunnelCacheEntry = { set: { ...next, funnels: [nextFunnel] }, notices: [], range: { fromISO: '2026-09-07', toISO: '2026-10-04' } };
    const legacyNull = { ...snap, funnels: [{ ...snap.funnels[0], steps: [...snap.funnels[0].steps, { key: 'buy', users: null as unknown as number }] }] };
    expect(computeFunnelPrev(entry, [snap]).steps.quiz).toEqual({ visit: null, lead: 400, buy: null });
    expect(computeFunnelPrev(entry, [legacyNull]).steps.quiz).toEqual({ visit: null, lead: 400, buy: null });

    // And a step unmeasured NOW has no previous value either.
    const nowUnmeasured: FunnelCacheEntry = { ...entry, set: set };
    expect(computeFunnelPrev(nowUnmeasured, [makeFunnelSnapshot(next, range, '2026-09-07T00:00:00Z')]).steps.quiz.visit).toBeNull();
  });
});

describe('step rows: an unmeasured step has no rates and is never the worst drop', () => {
  // visit 1000 -> lead 900 -> buy (NOT measured, stored as 0) -> upsell 300
  const steps = [
    { key: 'visit', label: 'Visit', users: 1000 },
    { key: 'lead', label: 'Lead', users: 900 },
    { key: 'buy', label: 'Buy', users: 0, measured: false as const, reason: 'not recorded' },
    { key: 'upsell', label: 'Upsell', users: 300 },
  ];
  const expected = [
    { key: 'visit', label: 'Visit', users: 1000, ofTop: 100, ofPrev: null, drop: null },
    { key: 'lead', label: 'Lead', users: 900, ofTop: 90, ofPrev: 90, drop: 100 },
    { key: 'buy', label: 'Buy', users: 0, ofTop: null, ofPrev: null, drop: null, measured: false },
    // Compared with the last MEASURED step (lead), not with the unmeasured 0.
    { key: 'upsell', label: 'Upsell', users: 300, ofTop: 30, ofPrev: (300 / 900) * 100, drop: 600 },
  ];

  it('engine computeStepRows + worstDropIndex (the CLI summary)', () => {
    const rows = computeStepRows(steps);
    expect(rows).toEqual(expected);
    expect(worstDropIndex(rows)).toBe(3);
  });

  it('dashboard computeStepRows + worstDropIndex give the same answer', () => {
    const rows = dashboardStepRows(steps);
    expect(rows).toEqual(expected);
    expect(dashboardWorstDrop(rows)).toBe(3);
  });

  it('an unmeasured first step: top is the first measured step', () => {
    const first = [{ key: 'visit', label: 'Visit', users: 0, measured: false as const }, { key: 'lead', label: 'Lead', users: 400 }, { key: 'buy', label: 'Buy', users: 40 }];
    for (const rows of [computeStepRows(first), dashboardStepRows(first)]) {
      expect(rows.map((r) => [r.ofTop, r.ofPrev])).toEqual([[null, null], [100, null], [10, 10]]);
      expect(worstDropIndex(rows)).toBe(2);
    }
  });

  it('measured steps compute exactly as before', () => {
    const plain = [{ key: 'a', label: 'A', users: 100 }, { key: 'b', label: 'B', users: 0 }, { key: 'c', label: 'C', users: 10 }];
    expect(computeStepRows(plain)).toEqual([
      { key: 'a', label: 'A', users: 100, ofTop: 100, ofPrev: null, drop: null },
      { key: 'b', label: 'B', users: 0, ofTop: 0, ofPrev: 0, drop: 100 },
      { key: 'c', label: 'C', users: 10, ofTop: 10, ofPrev: null, drop: -10 },
    ]);
  });
});

describe('window: the cache range and the previous period', () => {
  it('funnelSetRange is the window, or null', () => {
    expect(funnelSetRange(parseFunnelSet(full({ window: { from: '2026-09-07', to: '2026-10-04' } })).set)).toEqual({ fromISO: '2026-09-07', toISO: '2026-10-04' });
    expect(funnelSetRange(parseFunnelSet(OLD).set)).toBeNull();
  });

  it('a set with a window never takes its previous period from history; without one it still does', () => {
    const range = { fromISO: '2026-09-07', toISO: '2026-10-04' };
    const priorRange = { fromISO: '2026-08-10', toISO: '2026-09-06' };
    const old = parseFunnelSet(OLD).set;
    const history = [makeFunnelSnapshot({ ...old, funnels: [{ ...old.funnels[0], metrics: { spend: { v: 700, format: 'usd' } } }] }, priorRange, '2026-09-07T00:00:00Z')];
    const plain: FunnelCacheEntry = { set: old, notices: [], range };
    expect(computeFunnelPrev(plain, history).metrics.quiz.spend).toBe(700);
    const windowed: FunnelCacheEntry = { set: parseFunnelSet(full({ window: { from: '2026-09-07', to: '2026-10-04' } })).set, notices: [], range };
    const prev = computeFunnelPrev(windowed, history);
    expect(prev.source).toBeNull();
    expect(prev.metrics.quiz.spend).toBeNull();
    expect(prev.metrics.quiz.conversion).toBe(3.5);
  });
});

describe('sync caches a windowed set under its window, not the range tweak', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dc-lab-contract-v2-'));
    mkdirSync(join(root, 'core'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('cache.funnel.range and the history snapshot range equal the window', async () => {
    createInsight(root, { slug: 'acme-funnels', title: 'Acme funnels', render: 'funnel', adapter: 'script' });
    const payload = full({ window: { from: '2026-09-07', to: '2026-10-04' } });
    writeFileSync(join(root, 'lab', 'scripts', 'acme-funnels.mjs'), `export default async () => (${JSON.stringify(payload)});\n`, 'utf-8');
    const path = join(root, 'lab', 'insights', 'acme-funnels.md');
    const { data, content } = readFrontmatter(path);
    writeFrontmatter(path, { ...data, tweaks: [] }, content);
    const result = await syncInsight(root, 'acme-funnels', { force: true });
    expect(result.status).toBe('ok');
    const cache = readCache(root, 'acme-funnels');
    expect(cache?.funnel?.range).toEqual({ fromISO: '2026-09-07', toISO: '2026-10-04' });
    expect(cache?.funnelHistory?.[0].range).toEqual({ fromISO: '2026-09-07', toISO: '2026-10-04' });
  });
});
