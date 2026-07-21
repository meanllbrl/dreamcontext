import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseFunnelSet,
  funnelToSeries,
  funnelLatest,
  makeFunnelSnapshot,
  appendFunnelHistory,
  pickPreviousSnapshot,
  computeFunnelPrev,
  computeStepRows,
  worstDropIndex,
  MAX_FUNNELS,
  MAX_STEPS,
  MAX_DIMENSION_VALUES,
  MAX_SEGMENTS,
  FUNNEL_HISTORY_MAX,
  OTHER_VALUE,
} from '../../src/lib/lab/funnel.js';
import { createInsight, readCache, readInsightFile } from '../../src/lib/lab/store.js';
import { syncInsight } from '../../src/lib/lab/sync.js';
import { LabError, type FunnelSnapshot } from '../../src/lib/lab/types.js';

/** The funnel-516 hand-read dataset (the motivating real fixture): 33 users,
 *  0 leads, but 1 finish — contradictory rates only visible with the sequence. */
function fixture516(): Record<string, unknown> {
  return {
    kind: 'funnel-set/v1',
    dimensions: [
      { key: 'language', label: 'Language', mode: 'client' },
      { key: 'country', label: 'Country', mode: 'refetch', tweak: 'country' },
    ],
    primary: 'users',
    funnels: [
      {
        id: '516',
        name: 'en-start-516',
        meta: { url: 'https://x.example/f/516' },
        metrics: {
          users: { v: 33, format: 'count' },
          spend: { v: 831, format: 'usd' },
          lead_rate: { v: 0, format: 'pct' },
          finish_rate: { v: 3.03, format: 'pct' },
        },
        steps: [
          { key: 'session_start', label: 'session_start', users: 33 },
          { key: 'email_input', label: 'Step 01 email_input', users: 23 },
          { key: 'plan_select', label: 'Step 02 plan_select', users: 4 },
          { key: 'finish', label: 'Finish', users: 1 },
        ],
        segments: [
          {
            dims: { language: 'en' },
            users: 21,
            steps: [
              { key: 'session_start', users: 21 },
              { key: 'email_input', users: 15 },
              { key: 'plan_select', users: 3 },
              { key: 'finish', users: 1 },
            ],
          },
          {
            dims: { language: 'de' },
            users: 12,
            steps: [
              { key: 'session_start', users: 12 },
              { key: 'email_input', users: 8 },
              { key: 'plan_select', users: 1 },
              { key: 'finish', users: 0 },
            ],
          },
        ],
      },
    ],
  };
}

describe('parseFunnelSet (contract validation)', () => {
  it('accepts the funnel-516 fixture and preserves shape', () => {
    const { set, notices } = parseFunnelSet(fixture516());
    expect(notices).toEqual([]);
    expect(set.kind).toBe('funnel-set/v1');
    expect(set.dimensions).toHaveLength(2);
    expect(set.dimensions[1].mode).toBe('refetch');
    expect(set.dimensions[1].tweak).toBe('country');
    expect(set.funnels).toHaveLength(1);
    const f = set.funnels[0];
    expect(f.id).toBe('516');
    expect(f.metrics.finish_rate).toEqual({ v: 3.03, format: 'pct' });
    expect(f.steps.map((s) => s.key)).toEqual(['session_start', 'email_input', 'plan_select', 'finish']);
    expect(f.segments).toHaveLength(2);
  });

  it('rejects a payload without the funnel-set kind', () => {
    expect(() => parseFunnelSet({ funnels: [] })).toThrow(LabError);
    expect(() => parseFunnelSet([{ name: 'a', points: [] }])).toThrow(LabError);
  });

  it('rejects a payload whose funnels is not an array', () => {
    expect(() => parseFunnelSet({ kind: 'funnel-set/v1', funnels: {} })).toThrow(/funnels/);
  });

  it('skips malformed funnels with a notice instead of throwing', () => {
    const { set, notices } = parseFunnelSet({
      kind: 'funnel-set/v1',
      funnels: [
        { id: 'ok', steps: [{ key: 'a', users: 5 }] },
        { steps: [{ key: 'a', users: 1 }] }, // no id
        'garbage',
        { id: 'no-steps', steps: [] },
      ],
    });
    expect(set.funnels.map((f) => f.id)).toEqual(['ok']);
    expect(notices.length).toBe(3);
  });

  it('drops duplicate step keys and duplicate funnel ids with notices', () => {
    const { set, notices } = parseFunnelSet({
      kind: 'funnel-set/v1',
      funnels: [
        { id: 'a', steps: [{ key: 's1', users: 10 }, { key: 's1', users: 9 }, { key: 's2', users: 5 }] },
        { id: 'a', steps: [{ key: 's1', users: 3 }] },
      ],
    });
    expect(set.funnels).toHaveLength(1);
    expect(set.funnels[0].steps).toHaveLength(2);
    expect(notices.some((n) => n.includes('duplicate step key'))).toBe(true);
    expect(notices.some((n) => n.includes('duplicate funnel id'))).toBe(true);
  });

  it('caps funnels and steps with notices — the FINAL step always survives', () => {
    const many = {
      kind: 'funnel-set/v1',
      funnels: Array.from({ length: MAX_FUNNELS + 5 }, (_, i) => ({
        id: `f${i}`,
        steps: Array.from({ length: MAX_STEPS + 4 }, (_, j) => ({ key: `s${j}`, users: 100 - j })),
      })),
    };
    const { set, notices } = parseFunnelSet(many);
    expect(set.funnels).toHaveLength(MAX_FUNNELS);
    expect(set.funnels[0].steps).toHaveLength(MAX_STEPS);
    // Keep-first-and-last: the funnel's outcome step is never dropped.
    expect(set.funnels[0].steps[MAX_STEPS - 1].key).toBe(`s${MAX_STEPS + 3}`);
    expect(set.funnels[0].steps[MAX_STEPS - 2].key).toBe(`s${MAX_STEPS - 2}`);
    expect(notices.some((n) => n.includes(`kept the first ${MAX_FUNNELS}`))).toBe(true);
    expect(notices.some((n) => n.includes(`the final step "s${MAX_STEPS + 3}"`))).toBe(true);
  });

  it('collapses over-cap dimension values into "Other" (top-N by users kept)', () => {
    const values = Array.from({ length: MAX_DIMENSION_VALUES + 4 }, (_, i) => `v${i}`);
    const payload = {
      kind: 'funnel-set/v1',
      dimensions: [{ key: 'lang', label: 'Lang', mode: 'client' }],
      funnels: [{
        id: 'f',
        steps: [{ key: 'top', users: 1000 }],
        segments: values.map((v, i) => ({
          dims: { lang: v },
          users: 100 - i, // v0 largest → kept; tail → Other
          steps: [{ key: 'top', users: 100 - i }],
        })),
      }],
    };
    const { set, notices } = parseFunnelSet(payload);
    const segs = set.funnels[0].segments!;
    const langValues = new Set(segs.map((s) => s.dims.lang));
    expect(langValues.size).toBeLessThanOrEqual(MAX_DIMENSION_VALUES + 1); // top-N + Other
    expect(langValues.has(OTHER_VALUE)).toBe(true);
    const other = segs.find((s) => s.dims.lang === OTHER_VALUE)!;
    // 4 collapsed values (and the smallest kept boundary): sum of the tail users.
    expect(other.users).toBeGreaterThan(0);
    expect(notices.some((n) => n.includes('collapsed'))).toBe(true);
  });

  it('merges over-cap segment cells into one Other cell', () => {
    const payload = {
      kind: 'funnel-set/v1',
      dimensions: [{ key: 'c', label: 'C', mode: 'client' }],
      funnels: [{
        id: 'f',
        steps: [{ key: 'top', users: 10_000 }],
        // Use one dimension with few values but many cells via a second free dim key
        // (not declared → no value collapse), to hit the MAX_SEGMENTS cap directly.
        segments: Array.from({ length: MAX_SEGMENTS + 10 }, (_, i) => ({
          dims: { c: 'x', page: `p${i}` },
          users: 10 + i,
          steps: [{ key: 'top', users: 10 + i }],
        })),
      }],
    };
    const { set, notices } = parseFunnelSet(payload);
    expect(set.funnels[0].segments!.length).toBeLessThanOrEqual(MAX_SEGMENTS);
    expect(notices.some((n) => n.includes('merged'))).toBe(true);
  });

  it('drops segments (not the set) when over the byte cap', () => {
    const bigLabel = 'x'.repeat(4000);
    const payload = {
      kind: 'funnel-set/v1',
      dimensions: [{ key: 'd', label: 'D', mode: 'client' }],
      funnels: Array.from({ length: 20 }, (_, i) => ({
        id: `f${i}`,
        steps: Array.from({ length: 25 }, (_, j) => ({ key: `s${j}`, label: `step ${j}`, users: 100 })),
        segments: Array.from({ length: 8 }, (_, k) => ({
          dims: { d: `${bigLabel}${k}` },
          users: 10,
          steps: [{ key: 's0', users: 10 }],
        })),
      })),
    };
    const { set, notices } = parseFunnelSet(payload);
    expect(set.funnels.length).toBe(20);
    expect(notices.some((n) => n.includes('byte'))).toBe(true);
  });

  it('coerces metric shapes and keeps prev when provided', () => {
    const { set } = parseFunnelSet({
      kind: 'funnel-set/v1',
      funnels: [{
        id: 'f',
        steps: [{ key: 'a', users: 10 }],
        metrics: {
          plain: 42, // bare number → { v, format: number }
          rate: { v: '3.5', format: 'pct', prev: 2.5 },
          broken: { v: 'NaNish', format: 'nope' },
        },
      }],
    });
    const m = set.funnels[0].metrics;
    expect(m.plain).toEqual({ v: 42, format: 'number' });
    expect(m.rate.v).toBe(3.5);
    expect(m.rate.prev).toBe(2.5);
    expect(m.broken.v).toBeNull();
    expect(m.broken.format).toBe('number');
  });

  it('reads low_sample_threshold and benchmarks', () => {
    const { set } = parseFunnelSet({
      kind: 'funnel-set/v1',
      low_sample_threshold: 50,
      benchmarks: { finish_rate: { floor: 1, target: 3 }, junk: 'no' },
      funnels: [{ id: 'f', steps: [{ key: 'a', users: 1 }] }],
    });
    expect(set.low_sample_threshold).toBe(50);
    expect(set.benchmarks).toEqual({ finish_rate: { floor: 1, target: 3 } });
  });
});

describe('series synthesis + latest', () => {
  it('synthesizes one series per funnel from step users', () => {
    const { set } = parseFunnelSet(fixture516());
    const series = funnelToSeries(set);
    expect(series).toHaveLength(1);
    expect(series[0].name).toBe('en-start-516');
    expect(series[0].points.map((p) => p.v)).toEqual([33, 23, 4, 1]);
  });

  it('latest = primary metric of the first funnel, else top-step users', () => {
    const { set } = parseFunnelSet(fixture516());
    expect(funnelLatest(set)).toBe(33); // primary: users

    const noPrimary = parseFunnelSet({ ...fixture516(), primary: undefined }).set;
    expect(funnelLatest(noPrimary)).toBe(33); // falls back to top step

    expect(funnelLatest({ kind: 'funnel-set/v1', dimensions: [], funnels: [] })).toBeNull();
  });
});

describe('history snapshots + previous-period deltas', () => {
  const range = (fromISO: string, toISO: string) => ({ fromISO, toISO });

  function snap(at: string, fromISO: string, toISO: string, users: number): FunnelSnapshot {
    return {
      at,
      range: range(fromISO, toISO),
      funnels: [{ id: '516', metrics: { users, finish_rate: 2 }, steps: [{ key: 'session_start', users }] }],
    };
  }

  it('appendFunnelHistory bounds the trail', () => {
    let trail: FunnelSnapshot[] | undefined;
    for (let i = 0; i < FUNNEL_HISTORY_MAX + 7; i++) {
      trail = appendFunnelHistory(trail, snap(`2026-01-01T00:00:0${i % 10}Z`, '2026-01-01', '2026-01-08', i));
    }
    expect(trail!).toHaveLength(FUNNEL_HISTORY_MAX);
    expect(trail![trail!.length - 1].funnels[0].metrics.users).toBe(FUNNEL_HISTORY_MAX + 6);
  });

  it('appendFunnelHistory tolerates a malformed prior trail', () => {
    const out = appendFunnelHistory(('junk' as unknown) as FunnelSnapshot[], snap('2026-01-01T00:00:00Z', '2026-01-01', '2026-01-08', 1));
    expect(out).toHaveLength(1);
  });

  it('picks the equal-length snapshot ending closest before the current window', () => {
    const history = [
      snap('t1', '2026-05-01', '2026-05-29', 10), // 28d, ends long before
      snap('t2', '2026-06-03', '2026-07-01', 20), // 28d, ends exactly at current start ✔
      snap('t3', '2026-06-20', '2026-06-27', 30), // 7d — wrong span
      snap('t4', '2026-07-05', '2026-08-02', 40), // overlaps current — excluded
    ];
    const picked = pickPreviousSnapshot(range('2026-07-01', '2026-07-29'), history);
    expect(picked?.at).toBe('t2');
  });

  it('returns null when no equal-length prior snapshot exists', () => {
    const history = [snap('t3', '2026-06-20', '2026-06-27', 30)]; // 7d vs 28d current
    expect(pickPreviousSnapshot(range('2026-07-01', '2026-07-29'), history)).toBeNull();
    expect(pickPreviousSnapshot(range('2026-07-01', '2026-07-29'), [])).toBeNull();
    expect(pickPreviousSnapshot(range('2026-07-01', '2026-07-29'), undefined)).toBeNull();
  });

  it('computeFunnelPrev: adapter prev wins, history fills the rest, unknown stays null', () => {
    const { set } = parseFunnelSet({
      kind: 'funnel-set/v1',
      funnels: [{
        id: '516',
        metrics: {
          users: { v: 33, format: 'count', prev: 44 }, // adapter-provided
          finish_rate: { v: 3.03, format: 'pct' },     // from history
          novel: { v: 1, format: 'count' },            // nowhere → null
        },
        steps: [
          { key: 'session_start', users: 33 },
          { key: 'email_input', users: 23, prev: 30 },
        ],
      }],
    });
    const entry = { set, notices: [], range: range('2026-07-01', '2026-07-29') };
    const history = [snap('t2', '2026-06-03', '2026-07-01', 99)];
    const prev = computeFunnelPrev(entry, history);
    expect(prev.metrics['516'].users).toBe(44);
    expect(prev.metrics['516'].finish_rate).toBe(2);
    expect(prev.metrics['516'].novel).toBeNull();
    expect(prev.steps['516'].session_start).toBe(99);
    expect(prev.steps['516'].email_input).toBe(30);
    expect(prev.source?.at).toBe('t2');
  });
});

describe('step math (computeStepRows / worstDropIndex)', () => {
  it('computes of-top, of-prev, and drops for the 516 fixture', () => {
    const { set } = parseFunnelSet(fixture516());
    const rows = computeStepRows(set.funnels[0].steps);
    expect(rows[0].ofTop).toBeCloseTo(100);
    expect(rows[0].ofPrev).toBeNull();
    expect(rows[0].drop).toBeNull();
    expect(rows[1].ofTop).toBeCloseTo((23 / 33) * 100);
    expect(rows[1].ofPrev).toBeCloseTo((23 / 33) * 100);
    expect(rows[2].drop).toBe(19);
    // Worst RATE drop: 23 → 4 (17.4%) is worse than 4 → 1 (25%).
    expect(worstDropIndex(rows)).toBe(2);
  });

  it('handles a 0-user mid-step without dividing by zero', () => {
    const rows = computeStepRows([
      { key: 'a', label: 'a', users: 10 },
      { key: 'b', label: 'b', users: 0 },
      { key: 'c', label: 'c', users: 0 },
    ]);
    expect(rows[1].ofPrev).toBe(0);
    expect(rows[2].ofPrev).toBeNull(); // prev is 0 → no rate, not Infinity
    expect(rows[2].drop).toBe(0);
  });

  it('renders users INCREASING between steps as a negative drop (not clamped)', () => {
    const rows = computeStepRows([
      { key: 'a', label: 'a', users: 10 },
      { key: 'b', label: 'b', users: 14 }, // re-entry / tracking artifact
    ]);
    expect(rows[1].drop).toBe(-4);
    expect(rows[1].ofPrev).toBeCloseTo(140);
  });

  it('single-step funnel yields one row with no drop and no worst index', () => {
    const rows = computeStepRows([{ key: 'only', label: 'only', users: 5 }]);
    expect(rows).toHaveLength(1);
    expect(worstDropIndex(rows)).toBeNull();
  });

  it('all-zero funnel yields null of-top', () => {
    const rows = computeStepRows([{ key: 'a', label: 'a', users: 0 }, { key: 'b', label: 'b', users: 0 }]);
    expect(rows[0].ofTop).toBeNull();
  });
});

describe('sync integration (script adapter → funnel cache)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dc-lab-funnel-'));
    mkdirSync(join(root, 'core'), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeScript(slug: string, body: string): void {
    mkdirSync(join(root, 'lab', 'scripts'), { recursive: true });
    writeFileSync(join(root, 'lab', 'scripts', `${slug}.mjs`), body, 'utf-8');
  }

  it('stores cache.funnel + synthesized series + snapshot history on sync', async () => {
    createInsight(root, { slug: 'funnels', title: 'Funnels', render: 'funnel', adapter: 'script' });
    writeScript('funnels', `export default async () => (${JSON.stringify(fixture516())});`);

    const result = await syncInsight(root, 'funnels', { force: true });
    expect(result.status).toBe('ok');
    expect(result.latest).toBe(33);

    const cache = readCache(root, 'funnels')!;
    expect(cache.funnel?.set.funnels[0].id).toBe('516');
    expect(cache.funnel?.range.fromISO).toBeTruthy();
    expect(cache.series[0].points.map((p) => p.v)).toEqual([33, 23, 4, 1]);
    expect(cache.funnelHistory).toHaveLength(1);
    expect(cache.funnelHistory![0].funnels[0].steps[0]).toEqual({ key: 'session_start', users: 33 });
  });

  it('legacy Series[] payloads under render:funnel still sync (no cache.funnel)', async () => {
    createInsight(root, { slug: 'legacy', title: 'Legacy', render: 'funnel', adapter: 'script' });
    writeScript('legacy', `export default async () => ([{ name: 'f516', points: [
      { t: 'session_start', v: 33 }, { t: 'email_input', v: 23 }
    ]}]);`);

    const result = await syncInsight(root, 'legacy', { force: true });
    expect(result.status).toBe('ok');
    const cache = readCache(root, 'legacy')!;
    expect(cache.funnel).toBeUndefined();
    expect(cache.series).toHaveLength(1);
  });

  it('a failed sync preserves the prior funnel cache and history', async () => {
    createInsight(root, { slug: 'flaky', title: 'Flaky', render: 'funnel', adapter: 'script' });
    writeScript('flaky', `export default async () => (${JSON.stringify(fixture516())});`);
    await syncInsight(root, 'flaky', { force: true });

    writeScript('flaky', `export default async () => { throw new Error('boom'); };`);
    const result = await syncInsight(root, 'flaky', { force: true });
    expect(result.status).toBe('failed');

    const cache = readCache(root, 'flaky')!;
    expect(cache.error).toContain('boom');
    expect(cache.funnel?.set.funnels[0].id).toBe('516'); // prior kept
    expect(cache.funnelHistory).toHaveLength(1);
  });

  it('an invalid funnel payload fails the sync loudly', async () => {
    createInsight(root, { slug: 'bad', title: 'Bad', render: 'funnel', adapter: 'script' });
    writeScript('bad', `export default async () => ({ kind: 'funnel-set/v1', funnels: 'nope' });`);
    const result = await syncInsight(root, 'bad', { force: true });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/funnels/);
  });

  it('repeated syncs append bounded history snapshots for deltas', async () => {
    createInsight(root, { slug: 'trail', title: 'Trail', render: 'funnel', adapter: 'script' });
    writeScript('trail', `export default async () => (${JSON.stringify(fixture516())});`);
    await syncInsight(root, 'trail', { force: true });
    await syncInsight(root, 'trail', { force: true });
    await syncInsight(root, 'trail', { force: true });
    const cache = readCache(root, 'trail')!;
    expect(cache.funnelHistory).toHaveLength(3);
  });

  it('lab create --render funnel scaffolds the range tweak + documented script template', () => {
    createInsight(root, { slug: 'scaffold', title: 'Scaffold', render: 'funnel', adapter: 'script' });
    const manifest = readInsightFile(join(root, 'lab', 'insights', 'scaffold.md'));
    const range = manifest.tweaks.find((t) => t.key === 'range');
    expect(range?.type).toBe('enum');
    expect(range?.options).toContain('last_7_days');
    expect(range?.default).toBe('last_28_days');

    const scriptFile = join(root, 'lab', 'scripts', 'scaffold.mjs');
    expect(existsSync(scriptFile)).toBe(true);
    const content = readFileSync(scriptFile, 'utf-8');
    expect(content).toContain("kind: 'funnel-set/v1'");
    expect(content).toContain('dimensions');
    expect(content).toContain('resolvedTweaks.range');
  });

  it('does not overwrite an existing script on create', () => {
    writeScript('keep', 'export default async () => [];');
    createInsight(root, { slug: 'keep', title: 'Keep', render: 'funnel', adapter: 'script' });
    expect(readFileSync(join(root, 'lab', 'scripts', 'keep.mjs'), 'utf-8')).toBe('export default async () => [];');
  });
});
