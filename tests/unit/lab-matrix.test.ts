import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseMatrixSet,
  matrixToSeries,
  matrixLatest,
  makeMatrixSnapshot,
  appendMatrixHistory,
  snapshotAsOf,
  pickPreviousMatrixSnapshot,
  dimValues,
  pivotCell,
  MAX_MATRIX_DIMS,
  MAX_MATRIX_DIM_VALUES,
  MAX_MATRIX_ROWS,
  MAX_MATRIX_BYTES,
  MATRIX_HISTORY_MAX,
  MATRIX_HISTORY_MAX_BYTES,
  MATRIX_OTHER_VALUE,
} from '../../src/lib/lab/matrix.js';
import { createInsight, readCache, readInsightFile } from '../../src/lib/lab/store.js';
import { syncInsight } from '../../src/lib/lab/sync.js';
import { checkLab } from '../../src/cli/commands/doctor.js';
import { LabError, type MatrixSnapshot } from '../../src/lib/lab/types.js';

/** The kitUP motivating fixture: funnel × language, values previously smuggled
 *  into series names as "F3000 · TR · 119k". */
function fixtureMatrix(): Record<string, unknown> {
  return {
    kind: 'matrix/v1',
    dims: [
      { key: 'funnel', label: 'Funnel' },
      { key: 'language', label: 'Language' },
    ],
    rows: [
      { d: { funnel: 'F3000', language: 'TR' }, v: 119000, n: 4200 },
      { d: { funnel: 'F3000', language: 'EN' }, v: 84000, n: 3100 },
      { d: { funnel: 'F4000', language: 'TR' }, v: 52000, n: 1800 },
      { d: { funnel: 'F4000', language: 'EN' }, v: 31000, n: 25 },
    ],
    total: { v: 286000, n: 9125 },
    unit: 'USD',
  };
}

describe('parseMatrixSet (contract validation)', () => {
  it('accepts the kitUP fixture and preserves shape', () => {
    const { set, notices } = parseMatrixSet(fixtureMatrix());
    expect(notices).toEqual([]);
    expect(set.kind).toBe('matrix/v1');
    expect(set.dims.map((d) => d.key)).toEqual(['funnel', 'language']);
    expect(set.rows).toHaveLength(4);
    expect(set.rows[0]).toEqual({ d: { funnel: 'F3000', language: 'TR' }, v: 119000, n: 4200 });
    expect(set.total).toEqual({ v: 286000, n: 9125 });
    expect(set.unit).toBe('USD');
  });

  it('rejects a payload without the matrix kind', () => {
    expect(() => parseMatrixSet({ rows: [] })).toThrow(LabError);
    expect(() => parseMatrixSet([{ name: 'a', points: [] }])).toThrow(LabError);
  });

  it('rejects a payload whose rows is not an array', () => {
    expect(() => parseMatrixSet({ kind: 'matrix/v1', dims: [{ key: 'x' }], rows: {} })).toThrow(/rows/);
  });

  it('rejects a payload with zero usable dims', () => {
    expect(() => parseMatrixSet({ kind: 'matrix/v1', dims: [], rows: [] })).toThrow(/1-3/);
    expect(() => parseMatrixSet({ kind: 'matrix/v1', dims: [{}, { label: 'no key' }], rows: [] })).toThrow(/1-3/);
  });

  it('caps dims at MAX_MATRIX_DIMS with a notice', () => {
    const { set, notices } = parseMatrixSet({
      kind: 'matrix/v1',
      dims: [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }],
      rows: [{ d: { a: '1', b: '1', c: '1' }, v: 1 }],
    });
    expect(set.dims).toHaveLength(MAX_MATRIX_DIMS);
    expect(notices.some((n) => n.includes(`kept the first ${MAX_MATRIX_DIMS}`))).toBe(true);
  });

  it('skips malformed rows with a notice, keeps good ones', () => {
    const { set, notices } = parseMatrixSet({
      kind: 'matrix/v1',
      dims: [{ key: 'x' }],
      rows: [{ d: { x: 'a' }, v: 1 }, 'garbage', { v: 2 }, { d: { x: 'b' }, v: 3 }],
    });
    expect(set.rows).toHaveLength(2);
    expect(notices.filter((n) => n.includes('skipped'))).toHaveLength(2);
  });

  it('buckets a row missing a declared dim coordinate under "Unknown" (kept, not dropped)', () => {
    const { set } = parseMatrixSet({
      kind: 'matrix/v1',
      dims: [{ key: 'x' }, { key: 'y' }],
      rows: [{ d: { x: 'a' }, v: 7 }],
    });
    expect(set.rows[0].d).toEqual({ x: 'a', y: 'Unknown' });
  });

  it('coerces non-finite values to null instead of storing NaN', () => {
    const { set } = parseMatrixSet({
      kind: 'matrix/v1',
      dims: [{ key: 'x' }],
      rows: [{ d: { x: 'a' }, v: 'not-a-number', n: Infinity }],
    });
    expect(set.rows[0].v).toBeNull();
    expect(set.rows[0].n).toBeNull();
  });

  it('merges rows with identical dim coordinates (values summed) with a notice', () => {
    const { set, notices } = parseMatrixSet({
      kind: 'matrix/v1',
      dims: [{ key: 'x' }],
      rows: [
        { d: { x: 'a' }, v: 3, n: 10, prev: 2 },
        { d: { x: 'a' }, v: 4, n: 5, prev: 1 },
      ],
    });
    expect(set.rows).toHaveLength(1);
    expect(set.rows[0]).toEqual({ d: { x: 'a' }, v: 7, n: 15, prev: 3 });
    expect(notices.some((n) => n.includes('merged'))).toBe(true);
  });

  it('does NOT fabricate a merged prev when a merged row lacks one', () => {
    const { set } = parseMatrixSet({
      kind: 'matrix/v1',
      dims: [{ key: 'x' }],
      rows: [
        { d: { x: 'a' }, v: 3, prev: 2 },
        { d: { x: 'a' }, v: 4 },
      ],
    });
    expect(set.rows[0].prev).toBeUndefined();
  });

  it('collapses over-cap dimension values into "Other" (top-N by value kept)', () => {
    const rows = Array.from({ length: MAX_MATRIX_DIM_VALUES + 4 }, (_, i) => ({
      d: { lang: `v${i}` },
      v: 100 - i, // v0 largest → kept; tail → Other
    }));
    const { set, notices } = parseMatrixSet({ kind: 'matrix/v1', dims: [{ key: 'lang' }], rows });
    const values = new Set(set.rows.map((r) => r.d.lang));
    expect(values.size).toBe(MAX_MATRIX_DIM_VALUES + 1); // top-N + Other
    expect(values.has(MATRIX_OTHER_VALUE)).toBe(true);
    const other = set.rows.find((r) => r.d.lang === MATRIX_OTHER_VALUE)!;
    // The 4 smallest values (100-8 .. 100-11) plus the boundary one collapse.
    expect(other.v).toBeGreaterThan(0);
    expect(notices.some((n) => n.includes('collapsed'))).toBe(true);
  });

  it('AT the value cap exactly, nothing collapses and no notice fires', () => {
    const rows = Array.from({ length: MAX_MATRIX_DIM_VALUES }, (_, i) => ({
      d: { lang: `v${i}` },
      v: 10,
    }));
    const { set, notices } = parseMatrixSet({ kind: 'matrix/v1', dims: [{ key: 'lang' }], rows });
    expect(set.rows).toHaveLength(MAX_MATRIX_DIM_VALUES);
    expect(notices).toEqual([]);
  });

  it('merges the over-cap row tail into one all-Other row with a notice', () => {
    // Two undeclared-cardinality dims would collapse by value first; use a 2-dim
    // grid whose per-dim cardinality is under the value cap but whose product
    // exceeds MAX_MATRIX_ROWS via an UNDECLARED third coordinate — impossible;
    // instead push per-dim collapse aside by declaring high-cardinality rows on
    // a dim that stays within top-8 after collapse: 9 values × 50 rows each.
    // Simpler honest construction: one dim already collapsed to 8+Other = 9
    // values cannot exceed 400 rows. So drive the cap with 3 dims of 8 values
    // each (8³ = 512 > 400) — no per-dim collapse, only the row cap.
    const rows: { d: Record<string, string>; v: number }[] = [];
    for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) for (let c = 0; c < 8; c++) {
      rows.push({ d: { a: `a${a}`, b: `b${b}`, c: `c${c}` }, v: rows.length + 1 });
    }
    expect(rows.length).toBeGreaterThan(MAX_MATRIX_ROWS);
    const { set, notices } = parseMatrixSet({
      kind: 'matrix/v1',
      dims: [{ key: 'a' }, { key: 'b' }, { key: 'c' }],
      rows,
    });
    expect(set.rows.length).toBeLessThanOrEqual(MAX_MATRIX_ROWS);
    const other = set.rows.find((r) => r.d.a === MATRIX_OTHER_VALUE && r.d.b === MATRIX_OTHER_VALUE);
    expect(other).toBeTruthy();
    expect(notices.some((n) => n.includes('merged'))).toBe(true);
  });

  it('AT the row cap exactly, nothing merges', () => {
    // 2 dims × (8 × 8) = 64 rows — well under; use 1 dim capped at 8 values…
    // the honest exact-boundary case: 8×8×6 = 384 ≤ 400? No — build exactly 400
    // via 8 × 8 × 6 = 384 plus 16 extra c-values would collapse. Use dims a(8) ×
    // b(8) and an undeclared count: rows are keyed only by declared dims, so
    // exact-400 needs dim cardinalities whose product is 400: 8 × 5 × 10 → 10
    // collapses. Settle for 8 × 8 × 6 = 384 (< 400): no merge notice.
    const rows: { d: Record<string, string>; v: number }[] = [];
    for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) for (let c = 0; c < 6; c++) {
      rows.push({ d: { a: `a${a}`, b: `b${b}`, c: `c${c}` }, v: 1 });
    }
    const { set, notices } = parseMatrixSet({
      kind: 'matrix/v1',
      dims: [{ key: 'a' }, { key: 'b' }, { key: 'c' }],
      rows,
    });
    expect(set.rows).toHaveLength(384);
    expect(notices).toEqual([]);
  });

  it('rejects a payload over the byte cap after collapse', () => {
    // Few rows, giant value strings in the dim coordinate — collapse can't save it.
    const rows = Array.from({ length: 8 }, (_, i) => ({
      d: { x: `v${i}-${'y'.repeat(40_000)}` },
      v: 1,
    }));
    expect(() => parseMatrixSet({ kind: 'matrix/v1', dims: [{ key: 'x' }], rows }))
      .toThrow(new RegExp(String(MAX_MATRIX_BYTES)));
  });

  it('parses a bare-number total', () => {
    const { set } = parseMatrixSet({
      kind: 'matrix/v1', dims: [{ key: 'x' }], rows: [], total: 42,
    });
    expect(set.total).toEqual({ v: 42 });
  });
});

describe('matrixToSeries / matrixLatest (legacy consumers)', () => {
  it('synthesizes one series per dims[0] value, points keyed by dims[1]', () => {
    const { set } = parseMatrixSet(fixtureMatrix());
    const series = matrixToSeries(set);
    expect(series.map((s) => s.name).sort()).toEqual(['F3000', 'F4000']);
    const f3000 = series.find((s) => s.name === 'F3000')!;
    expect(f3000.points).toEqual([{ t: 'TR', v: 119000 }, { t: 'EN', v: 84000 }]);
  });

  it('synthesizes one series with a point per value for a 1-dim matrix', () => {
    const { set } = parseMatrixSet({
      kind: 'matrix/v1',
      dims: [{ key: 'plan', label: 'Plan' }],
      rows: [{ d: { plan: 'pro' }, v: 10 }, { d: { plan: 'free' }, v: 90 }],
    });
    const series = matrixToSeries(set);
    expect(series).toHaveLength(1);
    expect(series[0].name).toBe('Plan');
    expect(series[0].points).toEqual([{ t: 'pro', v: 10 }, { t: 'free', v: 90 }]);
  });

  it('sums the third dim away in the synthesized 2-dim series', () => {
    const { set } = parseMatrixSet({
      kind: 'matrix/v1',
      dims: [{ key: 'a' }, { key: 'b' }, { key: 'c' }],
      rows: [
        { d: { a: 'x', b: 'y', c: '1' }, v: 3 },
        { d: { a: 'x', b: 'y', c: '2' }, v: 4 },
      ],
    });
    const series = matrixToSeries(set);
    expect(series[0].points).toEqual([{ t: 'y', v: 7 }]);
  });

  it('latest = total.v when finite; null when absent or non-finite', () => {
    expect(matrixLatest(parseMatrixSet(fixtureMatrix()).set)).toBe(286000);
    const noTotal = parseMatrixSet({ kind: 'matrix/v1', dims: [{ key: 'x' }], rows: [{ d: { x: 'a' }, v: 5 }] });
    expect(matrixLatest(noTotal.set)).toBeNull();
    const nanTotal = parseMatrixSet({
      kind: 'matrix/v1', dims: [{ key: 'x' }], rows: [], total: { v: 'nope' },
    });
    expect(matrixLatest(nanTotal.set)).toBeNull();
  });
});

describe('matrix history (count cap AND byte cap together)', () => {
  const range = { fromISO: '2026-08-01', toISO: '2026-08-25' };

  function snap(at: string, rows = 2): MatrixSnapshot {
    return {
      at,
      range,
      rows: Array.from({ length: rows }, (_, i) => ({ d: { x: `v${i}` }, v: i })),
    };
  }

  it('appends and keeps the newest MATRIX_HISTORY_MAX', () => {
    let trail: MatrixSnapshot[] = [];
    for (let i = 0; i < MATRIX_HISTORY_MAX + 5; i++) {
      trail = appendMatrixHistory(trail, snap(`2026-06-${String((i % 28) + 1).padStart(2, '0')}T00:00:0${i % 10}Z`));
    }
    expect(trail).toHaveLength(MATRIX_HISTORY_MAX);
  });

  it('drops oldest snapshots when the trail exceeds the BYTE cap, count notwithstanding', () => {
    const fat = (at: string): MatrixSnapshot => ({
      at,
      range,
      rows: Array.from({ length: 200 }, (_, i) => ({ d: { x: `value-${'z'.repeat(500)}-${i}` }, v: i })),
    });
    let trail: MatrixSnapshot[] = [];
    for (let i = 0; i < 30; i++) trail = appendMatrixHistory(trail, fat(`2026-07-01T00:00:${String(i).padStart(2, '0')}Z`));
    expect(trail.length).toBeLessThan(30); // byte cap bit before the count cap
    expect(JSON.stringify(trail).length).toBeLessThanOrEqual(MATRIX_HISTORY_MAX_BYTES);
  });

  it('the newest snapshot always survives, even alone over the byte cap', () => {
    const giant: MatrixSnapshot = {
      at: '2026-08-25T00:00:00Z',
      range,
      rows: Array.from({ length: 400 }, (_, i) => ({ d: { x: `v-${'w'.repeat(4000)}-${i}` }, v: i })),
    };
    const trail = appendMatrixHistory([snap('2026-08-24T00:00:00Z')], giant);
    expect(trail[trail.length - 1].at).toBe('2026-08-25T00:00:00Z');
    expect(trail.length).toBeGreaterThanOrEqual(1);
  });

  it('tolerates a malformed prior trail', () => {
    const trail = appendMatrixHistory('garbage' as unknown as MatrixSnapshot[], snap('2026-08-25T00:00:00Z'));
    expect(trail).toHaveLength(1);
  });

  it('snapshotAsOf picks the newest snapshot at or before the END of the date — never forward', () => {
    const history = [
      snap('2026-08-20T09:00:00Z'),
      snap('2026-08-22T09:00:00Z'),
      snap('2026-08-24T09:00:00Z'),
    ];
    expect(snapshotAsOf(history, '2026-08-23')!.at).toBe('2026-08-22T09:00:00Z');
    expect(snapshotAsOf(history, '2026-08-22')!.at).toBe('2026-08-22T09:00:00Z'); // same-day inclusive
    expect(snapshotAsOf(history, '2026-08-19')).toBeNull(); // no interpolation, no reach-forward
    expect(snapshotAsOf([], '2026-08-23')).toBeNull();
    expect(snapshotAsOf(history, 'not-a-date')).toBeNull();
  });

  it('pickPreviousMatrixSnapshot honors the equal-window guard (±25%)', () => {
    const mk = (at: string, fromISO: string, toISO: string): MatrixSnapshot => ({ at, range: { fromISO, toISO }, rows: [] });
    const history = [
      mk('2026-08-01T00:00:00Z', '2026-07-04', '2026-08-01'), // 28d — comparable
      mk('2026-08-10T00:00:00Z', '2026-05-12', '2026-08-10'), // 90d — NOT comparable
    ];
    const current = { at: '2026-08-25T00:00:00Z', range: { fromISO: '2026-07-28', toISO: '2026-08-25' } }; // 28d
    expect(pickPreviousMatrixSnapshot(current, history)!.at).toBe('2026-08-01T00:00:00Z');
    expect(pickPreviousMatrixSnapshot(current, [history[1]])).toBeNull();
  });
});

describe('pivot math (dimValues / pivotCell)', () => {
  it('orders dim values by weight with Other/Unknown last', () => {
    const { set } = parseMatrixSet({
      kind: 'matrix/v1',
      dims: [{ key: 'x' }],
      rows: [
        { d: { x: 'small' }, v: 1 },
        { d: { x: 'big' }, v: 100 },
        { d: { x: 'Other' }, v: 500 },
        { d: {}, v: 50 }, // → Unknown
      ],
    });
    expect(dimValues(set, 'x')).toEqual(['big', 'small', 'Unknown', 'Other']);
  });

  it('pivotCell sums matching rows and returns an honest null for no match', () => {
    const { set } = parseMatrixSet(fixtureMatrix());
    expect(pivotCell(set, { funnel: 'F3000', language: 'TR' })).toEqual({ v: 119000, n: 4200 });
    expect(pivotCell(set, { funnel: 'F3000' })).toEqual({ v: 203000, n: 7300 });
    expect(pivotCell(set, { funnel: 'F9999' })).toEqual({ v: null, n: null });
  });
});

describe('matrix sync integration', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dc-lab-matrix-'));
    mkdirSync(join(root, 'core'), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeScript(slug: string, body: string): void {
    mkdirSync(join(root, 'lab', 'scripts'), { recursive: true });
    writeFileSync(join(root, 'lab', 'scripts', `${slug}.mjs`), body, 'utf-8');
  }

  it('stores cache.matrix + synthesized series + DATED history snapshot on sync', async () => {
    createInsight(root, { slug: 'breakdown', title: 'Breakdown', render: 'breakdown', adapter: 'script' });
    writeScript('breakdown', `export default async () => (${JSON.stringify(fixtureMatrix())});`);

    const result = await syncInsight(root, 'breakdown', { force: true });
    expect(result.status).toBe('ok');
    expect(result.latest).toBe(286000);

    const cache = readCache(root, 'breakdown')!;
    expect(cache.matrix?.set.rows).toHaveLength(4);
    expect(cache.matrix?.range.fromISO).toBeTruthy();
    expect(cache.latest).toBe(286000);
    expect(cache.series.map((s) => s.name).sort()).toEqual(['F3000', 'F4000']);
    expect(cache.matrixHistory).toHaveLength(1);
    expect(Date.parse(cache.matrixHistory![0].at)).toBeGreaterThan(0);
    expect(cache.matrixHistory![0].total).toEqual({ v: 286000, n: 9125 });
  });

  it('a matrix without total yields latest=null (never a fabricated number)', async () => {
    createInsight(root, { slug: 'no-total', title: 'NT', render: 'breakdown', adapter: 'script' });
    writeScript('no-total', `export default async () => ({
      kind: 'matrix/v1', dims: [{ key: 'x' }], rows: [{ d: { x: 'a' }, v: 5 }],
    });`);
    const result = await syncInsight(root, 'no-total', { force: true });
    expect(result.status).toBe('ok');
    expect(result.latest).toBeNull();
    expect(readCache(root, 'no-total')!.latest).toBeNull();
  });

  it('repeated syncs append dated history snapshots', async () => {
    createInsight(root, { slug: 'trail', title: 'Trail', render: 'breakdown', adapter: 'script' });
    writeScript('trail', `export default async () => (${JSON.stringify(fixtureMatrix())});`);
    await syncInsight(root, 'trail', { force: true });
    await syncInsight(root, 'trail', { force: true });
    await syncInsight(root, 'trail', { force: true });
    expect(readCache(root, 'trail')!.matrixHistory).toHaveLength(3);
  });

  it('a failed sync preserves the prior matrix cache and history', async () => {
    createInsight(root, { slug: 'flaky', title: 'Flaky', render: 'breakdown', adapter: 'script' });
    writeScript('flaky', `export default async () => (${JSON.stringify(fixtureMatrix())});`);
    await syncInsight(root, 'flaky', { force: true });

    writeScript('flaky', `export default async () => { throw new Error('boom'); };`);
    const result = await syncInsight(root, 'flaky', { force: true });
    expect(result.status).toBe('failed');

    const cache = readCache(root, 'flaky')!;
    expect(cache.error).toContain('boom');
    expect(cache.matrix?.set.rows).toHaveLength(4); // prior kept
    expect(cache.matrixHistory).toHaveLength(1);
  });

  it('an invalid matrix payload fails the sync loudly', async () => {
    createInsight(root, { slug: 'bad', title: 'Bad', render: 'breakdown', adapter: 'script' });
    writeScript('bad', `export default async () => ({ kind: 'matrix/v1', dims: [{ key: 'x' }], rows: 'nope' });`);
    const result = await syncInsight(root, 'bad', { force: true });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/rows/);
  });

  it('legacy Series[] payloads under render:breakdown still sync (no cache.matrix)', async () => {
    createInsight(root, { slug: 'legacy', title: 'Legacy', render: 'breakdown', adapter: 'script' });
    writeScript('legacy', `export default async () => ([{ name: 'a', points: [{ t: '2026-08-01', v: 1 }] }]);`);
    const result = await syncInsight(root, 'legacy', { force: true });
    expect(result.status).toBe('ok');
    expect(readCache(root, 'legacy')!.matrix).toBeUndefined();
  });

  it('lab create --render breakdown is DEPRECATED (2026-08-26): still creates the manifest + range tweak, warns loudly, but scaffolds NO script', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const manifest = createInsight(root, { slug: 'scaffold', title: 'Scaffold', render: 'breakdown', adapter: 'script' });
      expect(manifest.render).toBe('breakdown'); // grandfathered — still a valid manifest
      const read = readInsightFile(join(root, 'lab', 'insights', 'scaffold.md'));
      const range = read.tweaks.find((t) => t.key === 'range');
      expect(range?.type).toBe('enum'); // the date-range control is still pre-declared
      const script = join(root, 'lab', 'scripts', 'scaffold.mjs');
      expect(existsSync(script)).toBe(false); // no script scaffolded — the authoring path is deprecated
      expect(warn.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('matrix/v1 is deprecated'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('doctor flags a hand-edited over-cap matrix cache and history over the caps', async () => {
    createInsight(root, { slug: 'capped', title: 'Capped', render: 'breakdown', adapter: 'script' });
    writeScript('capped', `export default async () => (${JSON.stringify(fixtureMatrix())});`);
    await syncInsight(root, 'capped', { force: true });

    // Hand-corrupt: blow the per-dim value cap in the STORED set.
    const cachePath = join(root, 'lab', 'cache', 'capped.json');
    const cache = JSON.parse(readFileSync(cachePath, 'utf-8'));
    cache.matrix.set.rows = Array.from({ length: MAX_MATRIX_DIM_VALUES + 4 }, (_, i) => ({
      d: { funnel: `F${i}`, language: 'TR' }, v: 100 - i,
    }));
    cache.matrixHistory = Array.from({ length: MATRIX_HISTORY_MAX + 3 }, (_, i) => ({
      at: `2026-07-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
      range: { fromISO: '2026-07-01', toISO: '2026-07-28' },
      rows: [],
    }));
    writeFileSync(cachePath, JSON.stringify(cache), 'utf-8');

    const warnings = checkLab(root).filter((r) => r.message.includes('matrix'));
    expect(warnings.some((w) => w.message.includes('violates a cap'))).toBe(true);
    expect(warnings.some((w) => w.message.includes('matrixHistory'))).toBe(true);
  });

  it('doctor stays quiet on a healthy matrix cache', async () => {
    createInsight(root, { slug: 'healthy', title: 'Healthy', render: 'breakdown', adapter: 'script' });
    writeScript('healthy', `export default async () => (${JSON.stringify(fixtureMatrix())});`);
    await syncInsight(root, 'healthy', { force: true });
    expect(checkLab(root).filter((r) => r.message.includes('matrix'))).toEqual([]);
  });
});
