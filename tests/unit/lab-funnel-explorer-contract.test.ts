import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_DAILY_DAYS,
  MAX_FUNNEL_BYTES,
  MAX_REASON_CHARS,
  MAX_SEGMENTS,
  MAX_SOURCE_CHARS,
  OTHER_VALUE,
  parseFunnelSet,
} from '../../src/lib/lab/funnel.js';
import { parseDatasetBundle } from '../../src/lib/lab/dataset.js';
import { createInsight, readCache } from '../../src/lib/lab/store.js';
import { syncInsight } from '../../src/lib/lab/sync.js';
import { readFrontmatter, writeFrontmatter } from '../../src/lib/frontmatter.js';
import { LabError } from '../../src/lib/lab/types.js';

/**
 * Funnel explorer contract (D1): a dataset/v1 bundle may carry ONE funnel-set/v1
 * member; funnel-set gains segment_mode lookup|cells, measured + reason,
 * per-segment metrics/benchmarks/daily, FunnelDef.daily, band sources and
 * better. Lookup mode never sums, never folds into Other.
 */

const STEPS = [
  { key: 'visit', label: 'Visit', users: 1000 },
  { key: 'lead', label: 'Lead', users: 400 },
  { key: 'buy', label: 'Buy', users: 90 },
];

function day(i: number): string {
  return new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
}

function set(extra: Record<string, unknown> = {}, funnel: Record<string, unknown> = {}) {
  return {
    kind: 'funnel-set/v1',
    dimensions: [{ key: 'platform', label: 'Platform', mode: 'client' }, { key: 'language', label: 'Language', mode: 'client' }],
    funnels: [{ id: 'f', name: 'Checkout', metrics: { rate: { v: 9, format: 'pct' } }, steps: STEPS, ...funnel }],
    ...extra,
  };
}

describe('funnel-set/v1 additive fields', () => {
  it('an old payload parses exactly as before (no new keys appear)', () => {
    const { set: parsed, notices } = parseFunnelSet(set({}, { segments: [{ dims: { platform: 'A' }, users: 10, steps: [{ key: 'visit', users: 10 }] }] }));
    expect(notices).toEqual([]);
    expect(parsed).toEqual({
      kind: 'funnel-set/v1',
      dimensions: [{ key: 'platform', label: 'Platform', mode: 'client' }, { key: 'language', label: 'Language', mode: 'client' }],
      funnels: [{
        id: 'f', name: 'Checkout', meta: {}, metrics: { rate: { v: 9, format: 'pct' } }, steps: STEPS,
        segments: [{ dims: { platform: 'A' }, users: 10, steps: [{ key: 'visit', users: 10 }] }],
      }],
    });
  });

  it('keeps segment_mode, and an unknown mode falls back to cells with a notice', () => {
    expect(parseFunnelSet(set({ segment_mode: 'lookup' })).set.segment_mode).toBe('lookup');
    expect(parseFunnelSet(set({ segment_mode: 'cells' })).set.segment_mode).toBe('cells');
    const bad = parseFunnelSet(set({ segment_mode: 'sum' }));
    expect(bad.set.segment_mode).toBeUndefined();
    expect(bad.notices.join(' ')).toMatch(/segment_mode "sum"/);
  });

  it('a segment can be not measured, with a capped reason and empty steps', () => {
    const long = 'x'.repeat(MAX_REASON_CHARS + 50);
    const { set: parsed, notices } = parseFunnelSet(set({ segment_mode: 'lookup' }, {
      segments: [
        { dims: { platform: 'A' }, users: 120, steps: [], measured: false, reason: '  fewer than 300\n users  ' },
        { dims: { platform: 'B' }, users: 80, steps: [], measured: false, reason: long },
      ],
    }));
    const [a, b] = parsed.funnels[0].segments!;
    expect(a).toEqual({ dims: { platform: 'A' }, users: 120, steps: [], measured: false, reason: 'fewer than 300 users' });
    expect(b.reason).toHaveLength(MAX_REASON_CHARS);
    expect(notices.join(' ')).toMatch(/over 200 chars/);
  });

  it('an unmeasured metric carries no value (not zero), keeps prev and its reason', () => {
    const { set: parsed } = parseFunnelSet(set({}, {
      metrics: { c2p: { v: 0, prev: 31, format: 'pct', measured: false, reason: 'denominator event missing' } },
    }));
    expect(parsed.funnels[0].metrics.c2p).toEqual({ v: null, prev: 31, format: 'pct', measured: false, reason: 'denominator event missing' });
  });

  it('segment metrics, benchmarks and daily are the segment\'s own', () => {
    const { set: parsed } = parseFunnelSet(set({ segment_mode: 'lookup' }, {
      segments: [{
        dims: { platform: 'A' }, users: 500, steps: [{ key: 'visit', users: 500 }],
        metrics: { rate: { v: 12, prev: 10, format: 'pct' } },
        benchmarks: { rate: { floor: 8, target: 14, floor_source: 'own p25 (8 wk)' } },
        daily: [{ t: '2026-01-02', m: { rate: 11 } }, { t: '2026-01-01', m: { rate: 10 } }],
      }],
    }));
    const seg = parsed.funnels[0].segments![0];
    expect(seg.metrics).toEqual({ rate: { v: 12, prev: 10, format: 'pct' } });
    expect(seg.benchmarks).toEqual({ rate: { floor: 8, target: 14, floor_source: 'own p25 (8 wk)' } });
    expect(seg.daily).toEqual([{ t: '2026-01-01', m: { rate: 10 } }, { t: '2026-01-02', m: { rate: 11 } }]);
  });

  it('daily: ISO days only, known metric keys only, one per day, newest 92 kept, each with a notice', () => {
    const many = Array.from({ length: MAX_DAILY_DAYS + 8 }, (_, i) => ({ t: day(i), m: { rate: i, ghost: 1 } }));
    const { set: parsed, notices } = parseFunnelSet(set({}, {
      daily: [...many, { t: '2026-02-30', m: { rate: 1 } }, { t: 'yesterday', m: { rate: 1 } }, { t: day(0), m: 'x' }],
    }));
    const daily = parsed.funnels[0].daily!;
    expect(daily).toHaveLength(MAX_DAILY_DAYS);
    expect(daily[0].t).toBe(day(8));
    expect(daily[daily.length - 1]).toEqual({ t: day(MAX_DAILY_DAYS + 7), m: { rate: MAX_DAILY_DAYS + 7 } });
    const text = notices.join(' ');
    expect(text).toMatch(/3 daily entries without a YYYY-MM-DD/);
    expect(text).toMatch(/"ghost" not in metrics/);
    expect(text).toMatch(/kept the newest 92/);
  });

  it('bands: sources (capped, only beside their bound), better higher|lower, unknown better noticed', () => {
    const { set: parsed, notices } = parseFunnelSet(set({
      benchmarks: {
        rate: { floor: 5, target: 9, floor_source: 'book', target_source: 's'.repeat(MAX_SOURCE_CHARS + 5) },
        cpl: { floor: 5, target: 3, better: 'lower' },
        dir: { better: 'lower' },
        odd: { floor: 1, better: 'sideways' },
        orphan: { target_source: 'book' },
      },
    }));
    expect(parsed.benchmarks!.rate.floor_source).toBe('book');
    expect(parsed.benchmarks!.rate.target_source).toHaveLength(MAX_SOURCE_CHARS);
    expect(parsed.benchmarks!.cpl).toEqual({ floor: 5, target: 3, better: 'lower' });
    expect(parsed.benchmarks!.dir).toEqual({ better: 'lower' });
    expect(parsed.benchmarks!.odd).toEqual({ floor: 1 });
    expect(parsed.benchmarks!.orphan).toBeUndefined();
    expect(notices.join(' ')).toMatch(/unknown better "sideways"/);
  });

  it('re-parsing a parsed set is a fixed point (doctor re-validates the cache)', () => {
    const raw = set({ segment_mode: 'lookup', benchmarks: { rate: { floor: 5, floor_source: 'book', better: 'lower' } } }, {
      daily: [{ t: '2026-01-01', m: { rate: 3 } }],
      segments: [
        { dims: { platform: 'A' }, users: 5, steps: [], measured: false, reason: 'thin' },
        { dims: { platform: 'B' }, users: 50, steps: [{ key: 'visit', users: 50 }], metrics: { rate: { v: 1, format: 'pct', measured: false, reason: 'r' } } },
      ],
    });
    const once = parseFunnelSet(raw).set;
    const twice = parseFunnelSet(once);
    expect(twice.set).toEqual(once);
    expect(twice.notices).toEqual([]);
  });
});

describe('lookup never sums (parse level)', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => `lang-${i}`);

  it('a 12-value dim in lookup mode is not folded into Other', () => {
    const segments = twelve.map((language, i) => ({ dims: { language }, users: 100 + i, steps: [{ key: 'visit', users: 100 + i }] }));
    const { set: parsed, notices } = parseFunnelSet(set({ segment_mode: 'lookup' }, { segments }));
    const values = parsed.funnels[0].segments!.map((s) => s.dims.language);
    expect(values).toEqual(twelve);
    expect(values).not.toContain(OTHER_VALUE);
    expect(notices).toEqual([]);
  });

  it('the same 12-value dim in cells mode still folds (regression guard)', () => {
    const segments = twelve.map((language, i) => ({ dims: { language }, users: 100 + i, steps: [{ key: 'visit', users: 100 + i }] }));
    const values = parseFunnelSet(set({}, { segments })).set.funnels[0].segments!.map((s) => s.dims.language);
    expect(values).toContain(OTHER_VALUE);
  });

  it('an intersection path is kept exactly as sent, beside its one-axis paths', () => {
    const cross = { dims: { platform: 'B', language: 'en' }, users: 300, steps: [{ key: 'visit', users: 300 }, { key: 'lead', users: 77 }, { key: 'buy', users: 13 }] };
    const { set: parsed } = parseFunnelSet(set({ segment_mode: 'lookup' }, {
      segments: [
        { dims: { platform: 'B' }, users: 900, steps: [{ key: 'visit', users: 900 }, { key: 'lead', users: 300 }, { key: 'buy', users: 70 }] },
        { dims: { language: 'en' }, users: 700, steps: [{ key: 'visit', users: 700 }, { key: 'lead', users: 250 }, { key: 'buy', users: 60 }] },
        cross,
      ],
    }));
    const found = parsed.funnels[0].segments!.find((s) => s.dims.platform === 'B' && s.dims.language === 'en');
    expect(found).toEqual(cross);
  });

  it('a repeated selection is not merged: the first path wins, with a notice', () => {
    const { set: parsed, notices } = parseFunnelSet(set({ segment_mode: 'lookup' }, {
      segments: [
        { dims: { platform: 'A' }, users: 10, steps: [{ key: 'visit', users: 10 }] },
        { dims: { platform: 'A' }, users: 99, steps: [{ key: 'visit', users: 99 }] },
      ],
    }));
    expect(parsed.funnels[0].segments).toEqual([{ dims: { platform: 'A' }, users: 10, steps: [{ key: 'visit', users: 10 }] }]);
    expect(notices.join(' ')).toMatch(/repeat an earlier selection/);
  });

  it('past MAX_SEGMENTS the tail is dropped, never merged into an Other path', () => {
    const segments = Array.from({ length: MAX_SEGMENTS + 6 }, (_, i) => ({ dims: { platform: `p${i}` }, users: i + 1, steps: [{ key: 'visit', users: i + 1 }] }));
    const { set: parsed, notices } = parseFunnelSet(set({ segment_mode: 'lookup' }, { segments }));
    const kept = parsed.funnels[0].segments!;
    expect(kept).toHaveLength(MAX_SEGMENTS);
    expect(kept[MAX_SEGMENTS - 1].dims.platform).toBe(`p${MAX_SEGMENTS - 1}`);
    expect(kept.some((s) => s.dims.platform === OTHER_VALUE)).toBe(false);
    expect(notices.join(' ')).toMatch(/dropped 6/);
  });

  it('cells mode: an unmeasured cell never adds to a measured sum', () => {
    const { set: parsed } = parseFunnelSet(set({}, {
      segments: [
        { dims: { platform: 'A' }, users: 40, steps: [], measured: false, reason: 'thin' },
        { dims: { platform: 'A' }, users: 100, steps: [{ key: 'visit', users: 100 }] },
        { dims: { platform: 'A' }, users: 50, steps: [{ key: 'visit', users: 50 }] },
      ],
    }));
    expect(parsed.funnels[0].segments).toEqual([{ dims: { platform: 'A' }, users: 150, steps: [{ key: 'visit', users: 150 }] }]);
  });
});

describe('byte cap trim order: segment daily, then funnel daily, then segments', () => {
  const longDaily = (n: number) => Array.from({ length: n }, (_, i) => ({ t: day(i), m: { rate: 12.3456789 + i } }));
  const bigSegments = (n: number, withDaily: boolean) => Array.from({ length: n }, (_, i) => ({
    dims: { platform: `p${i}` }, users: 10, steps: [{ key: 'visit', users: 10 }],
    metrics: { rate: { v: 1, format: 'pct' } },
    ...(withDaily ? { daily: longDaily(MAX_DAILY_DAYS) } : {}),
    meta_pad: 'x',
  }));

  it('drops segment daily first and keeps the funnel daily and the segments', () => {
    const funnels = Array.from({ length: 4 }, (_, f) => ({
      id: `f${f}`, name: `F${f}`, metrics: { rate: { v: 1, format: 'pct' } }, steps: STEPS,
      daily: longDaily(30), segments: bigSegments(MAX_SEGMENTS, true),
    }));
    const { set: parsed, notices } = parseFunnelSet({ kind: 'funnel-set/v1', segment_mode: 'lookup', funnels });
    expect(JSON.stringify(parsed).length).toBeLessThanOrEqual(MAX_FUNNEL_BYTES);
    expect(parsed.funnels.every((f) => f.daily?.length === 30)).toBe(true);
    expect(parsed.funnels.every((f) => f.segments?.length === MAX_SEGMENTS)).toBe(true);
    expect(parsed.funnels.some((f) => f.segments!.every((s) => s.daily === undefined))).toBe(true);
    expect(notices.join(' ')).toMatch(/segment daily trends dropped/);
    expect(notices.join(' ')).not.toMatch(/segments dropped/);
  });

  it('then the funnel daily, before any segments', () => {
    const keys = ['rate', 'visit_to_lead', 'lead_to_checkout', 'cost_per_lead'];
    const wideDaily = Array.from({ length: MAX_DAILY_DAYS }, (_, i) => ({ t: day(i), m: Object.fromEntries(keys.map((k) => [k, 12.3456789 + i])) }));
    const funnels = Array.from({ length: 40 }, (_, f) => ({
      id: `f${f}`, name: `F${f}`, metrics: Object.fromEntries(keys.map((k) => [k, { v: 1, format: 'pct' }])), steps: STEPS,
      daily: wideDaily, segments: bigSegments(20, false),
    }));
    const { set: parsed, notices } = parseFunnelSet({ kind: 'funnel-set/v1', segment_mode: 'lookup', funnels });
    expect(JSON.stringify(parsed).length).toBeLessThanOrEqual(MAX_FUNNEL_BYTES);
    expect(parsed.funnels.some((f) => f.daily === undefined)).toBe(true);
    expect(parsed.funnels.every((f) => f.segments?.length === 20)).toBe(true);
    expect(notices.join(' ')).toMatch(/daily trend dropped/);
    expect(notices.join(' ')).not.toMatch(/segments dropped/);
  });
});

describe('dataset/v1 funnel member', () => {
  const table = { key: 'declines', dims: [{ key: 'reason' }], rows: [{ d: { reason: 'expired' }, v: 4 }], total: { v: 4 } };

  it('is parsed beside the bundle, never inside it; its notices are prefixed', () => {
    const parsed = parseDatasetBundle({ kind: 'dataset/v1', datasets: [table], funnel: set({ segment_mode: 'bogus' }) });
    expect(parsed.bundle).not.toHaveProperty('funnel');
    expect(parsed.bundle.datasets.map((d) => d.key)).toEqual(['declines']);
    expect(parsed.funnel?.set.funnels[0].id).toBe('f');
    expect(parsed.notices.some((n) => n.startsWith('funnel: unknown segment_mode'))).toBe(true);
  });

  it('is absent when the bundle carries none (old bundles unchanged)', () => {
    const parsed = parseDatasetBundle({ kind: 'dataset/v1', datasets: [table] });
    expect(parsed).not.toHaveProperty('funnel');
  });

  it.each([
    ['wrong kind', { kind: 'matrix/v1', funnels: [] }],
    ['no funnels array', { kind: 'funnel-set/v1' }],
    ['no valid funnel', { kind: 'funnel-set/v1', funnels: [{ id: 'x', steps: [] }] }],
    ['not an object', 'funnel'],
  ])('a malformed member (%s) fails the whole payload', (_label, member) => {
    expect(() => parseDatasetBundle({ kind: 'dataset/v1', datasets: [table], funnel: member })).toThrow(LabError);
    expect(() => parseDatasetBundle({ kind: 'dataset/v1', datasets: [table], funnel: member })).toThrow(/`funnel` member/);
  });
});

describe('sync writes both caches from one explorer payload', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dc-lab-explorer-'));
    mkdirSync(join(root, 'core'), { recursive: true });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeScript(body: string): void {
    mkdirSync(join(root, 'lab', 'scripts'), { recursive: true });
    writeFileSync(join(root, 'lab', 'scripts', 'explorer.mjs'), body, 'utf-8');
  }

  function setup(): void {
    createInsight(root, { slug: 'explorer', title: 'Explorer' });
    const path = join(root, 'lab', 'insights', 'explorer.md');
    const { data, content } = readFrontmatter(path);
    writeFrontmatter(path, { ...data, source: { adapter: 'script', script: { file: 'scripts/explorer.mjs' } } }, content);
  }

  const payload = (funnel: unknown) => `export default async () => ({ data: {
    kind: 'dataset/v1', primary: 'declines',
    datasets: [{ key: 'declines', dims: [{ key: 'reason' }], rows: [{ d: { reason: 'expired' }, v: 7 }], total: { v: 7 } }],
    funnel: ${JSON.stringify(funnel)},
  } });\n`;

  it('stores cache.datasets (without the member) and cache.funnel with history; latest is the primary dataset\'s', async () => {
    setup();
    writeScript(payload(set({ segment_mode: 'lookup' })));
    const first = await syncInsight(root, 'explorer', { force: true });
    expect(first.status).toBe('ok');
    const cache = readCache(root, 'explorer')!;
    expect(cache.latest).toBe(7);
    expect(cache.datasets?.bundle).not.toHaveProperty('funnel');
    expect(cache.datasets?.bundle.datasets[0].key).toBe('declines');
    expect(cache.funnel?.set.segment_mode).toBe('lookup');
    expect(cache.funnel?.set.funnels[0].steps).toEqual(STEPS);
    expect(cache.funnelHistory).toHaveLength(1);
    expect(cache.datasetHistory).toHaveLength(1);

    await syncInsight(root, 'explorer', { force: true });
    expect(readCache(root, 'explorer')!.funnelHistory).toHaveLength(2);
  });

  it('a malformed member fails the sync loudly and keeps the prior cache', async () => {
    setup();
    writeScript(payload(set()));
    await syncInsight(root, 'explorer', { force: true });
    const before = readCache(root, 'explorer')!;

    writeScript(payload({ kind: 'funnel-set/v1', funnels: 'nope' }));
    const failed = await syncInsight(root, 'explorer', { force: true });
    expect(failed.status).toBe('failed');
    const after = readCache(root, 'explorer')!;
    expect(after.error).toMatch(/`funnel` member/);
    expect(after.funnel).toEqual(before.funnel);
    expect(after.datasets).toEqual(before.datasets);
    expect(after.funnelHistory).toEqual(before.funnelHistory);
  });
});
