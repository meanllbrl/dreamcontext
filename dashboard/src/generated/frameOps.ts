/**
 * Board frames and the ONE pipeline that shapes them for a block.
 *
 * A FRAME is what a data-bound block draws: the resolved slice of one insight's
 * cache (`frames.ts` builds them from the hardened readers). The server returns
 * frames UN-limited; every static option (`where`, `sort`, `limit`, series
 * pick, `topN`, `normalize`) and the interactive `filter` block run HERE, in
 * this fixed order:
 *
 *   tables: where -> interactive filter -> sort -> topN -> limit -> normalize
 *   series: pick -> limit -> topN -> normalize
 *
 * and a table's `total` is computed after filtering, before the limit, so a
 * filtered board never shows the total of a pre-cut list. `topN` keeps the N
 * largest and folds the rest into ONE row/series named `Other` that carries
 * `other: <how many it folds>`; `normalize` turns each bucket into shares of
 * 100 (the unit becomes `%`) and runs last, so the visible parts sum to 100. `lab board show` and
 * the dashboard run this same code, so they print the same values.
 *
 * PURE and SELF-CONTAINED: no imports, types declared inline, ES2020 only.
 * `scripts/gen-lab-mirrors.mjs` copies this file BYTE-IDENTICAL to
 * `dashboard/src/generated/frameOps.ts`; `tests/unit/lab-mirrors-drift.test.ts`
 * fails when the copies differ. Edit this file, then re-run the generator.
 */

// ─── Frames ─────────────────────────────────────────────────────────────────

export const FRAME_KINDS = ['series', 'table', 'funnel', 'value', 'empty'] as const;
export type FrameKind = (typeof FRAME_KINDS)[number];

/** Why a block has nothing to draw. */
export const EMPTY_REASONS = ['no-cache', 'missing-insight', 'missing-dataset', 'kind-mismatch', 'unsafe-ref'] as const;
export type EmptyReason = (typeof EMPTY_REASONS)[number];

export interface FramePoint {
  t: string;
  v: number;
}

export interface FrameSeries {
  name: string;
  points: FramePoint[];
  /** Set on the `Other` series `topN` folds: how many series it holds. */
  other?: number;
}

export interface SeriesFrame {
  kind: 'series';
  insight: string;
  series: FrameSeries[];
  unit: string | null;
  granularity: string | null;
}

export interface TableDim {
  key: string;
  label: string;
}

export interface TableRow {
  d: Record<string, string>;
  v: number | null;
  n?: number | null;
  prev?: number | null;
  /** Set on the `Other` row `topN` folds: how many rows it holds. */
  other?: number;
}

/** A table's total as the block shows it: rows and sums AFTER filtering, BEFORE the limit. */
export interface TableTotal {
  /** Rows left after `where` + the interactive filter (not capped by `limit`). */
  count: number;
  /** The source's own grand total when nothing was filtered out, else the sum of `v`. */
  v: number | null;
  /** Sum of `n` over the same rows, or null when no row carries one. */
  n: number | null;
}

export interface TableFrame {
  kind: 'table';
  insight: string;
  /** The dataset key this table came from, or null for a matrix/v1 set. */
  dataset: string | null;
  label: string | null;
  dims: TableDim[];
  rows: TableRow[];
  /** The adapter's own grand total, untouched by any op. */
  sourceTotal: { v: number | null; n?: number | null; prev?: number | null } | null;
  total: TableTotal;
  unit: string | null;
}

/** One value per dimension. */
export type Selection = Record<string, string>;

export type FunnelMetricFormat = 'count' | 'pct' | 'usd' | 'x' | 'seconds' | 'number';

export interface FunnelFrameStep {
  key: string;
  label: string;
  users: number;
  prev?: number | null;
}

export interface FunnelFrameMetric {
  v: number | null;
  prev: number | null;
  format: FunnelMetricFormat;
  label: string | null;
  measured: boolean;
  reason: string | null;
}

export interface FunnelFrameBand {
  floor: number | null;
  target: number | null;
  floorSource: string | null;
  targetSource: string | null;
  better: 'higher' | 'lower';
}

export interface FunnelFrameDay {
  t: string;
  m: Record<string, number | null>;
}

export interface FunnelFrameSegment {
  dims: Selection;
  users: number;
  steps: { key: string; users: number }[];
  measured: boolean;
  reason: string | null;
  metrics?: Record<string, FunnelFrameMetric>;
  bands?: Record<string, FunnelFrameBand>;
  daily?: FunnelFrameDay[];
}

export interface FunnelFrameFunnel {
  id: string;
  name: string;
  steps: FunnelFrameStep[];
  metrics?: Record<string, FunnelFrameMetric>;
  daily?: FunnelFrameDay[];
  segments?: FunnelFrameSegment[];
}

export interface FunnelFrameDimension {
  key: string;
  label: string;
  values: string[];
}

export interface FunnelFrame {
  kind: 'funnel';
  insight: string;
  funnels: FunnelFrameFunnel[];
  dimensions?: FunnelFrameDimension[];
  segmentMode?: 'cells' | 'lookup';
  bands?: Record<string, FunnelFrameBand>;
  lowSample?: number;
}

/** The funnel as one exact selection sees it (`funnelSlice`). */
export interface FunnelSlice {
  funnelId: string;
  funnelName: string;
  selection: Selection;
  measured: boolean;
  reason: string | null;
  users: number;
  steps: FunnelFrameStep[];
  metrics: Record<string, FunnelFrameMetric>;
  bands: Record<string, FunnelFrameBand>;
  bandsInherited: boolean;
  daily: FunnelFrameDay[];
  lowSample: boolean;
  ignored: string[];
}

export interface BreakdownChip {
  value: string;
  active: boolean;
  enabled: boolean;
  users: number | null;
  reason: string | null;
}

export interface BreakdownAxis {
  key: string;
  label: string;
  chips: BreakdownChip[];
}

export interface StepDrop {
  key: string;
  label: string;
  users: number;
  ofTop: number | null;
  ofPrev: number | null;
  dropPct: number | null;
  worst: boolean;
}

export interface BenchmarkRow {
  key: string;
  label: string;
  format: FunnelMetricFormat;
  current: number | null;
  prev: number | null;
  delta: number | null;
  floor: number | null;
  target: number | null;
  floorSource: string | null;
  targetSource: string | null;
  better: 'higher' | 'lower';
  status: 'below' | 'between' | 'above' | 'no-band' | 'unmeasured';
  trend: 'improving' | 'worsening' | 'flat' | null;
  reason: string | null;
  inherited: boolean;
}

export interface SegmentRow {
  value: string;
  selection: Selection;
  measured: boolean;
  reason: string | null;
  users: number;
  lowSample: boolean;
  cells: Record<string, { v: number | null; prev: number | null; tone: 'below' | 'between' | 'above' | null }>;
}

export interface ValueFrame {
  kind: 'value';
  insight: string;
  value: number | null;
  /** The previous point of the same series (stat `delta: prev`), or null. */
  prev: number | null;
  /** The default series' values, oldest first (stat `spark`). */
  spark: number[];
  unit: string | null;
}

export interface EmptyFrame {
  kind: 'empty';
  reason: EmptyReason;
  /** The binding as written, when there was one. */
  ref: string | null;
}

export type Frame = SeriesFrame | TableFrame | FunnelFrame | ValueFrame | EmptyFrame;

/**
 * The key a resolved frame is stored under in a board response: the card id,
 * the block path (top-level index, or `index.tab.index` inside `tabs`) and,
 * for an `html` block, the declared input name.
 */
export function frameKey(cardId: string, path: readonly number[], input?: string): string {
  return `${cardId}:${path.join('.')}${input ? `#${input}` : ''}`;
}

// ─── Ops ────────────────────────────────────────────────────────────────────

export interface FrameSort {
  /** `v`, `n`, `prev`, or a dim key. */
  by: string;
  dir: 'asc' | 'desc';
}

export interface FrameOps {
  /** Static filter: dim key -> allowed value(s). */
  where?: Record<string, string[]>;
  /** The interactive filter block's current choice. */
  filter?: { dim: string; value: string } | null;
  sort?: FrameSort | null;
  /** Rows kept (tables) or trailing points kept per series (series). */
  limit?: number | null;
  /** Series names kept, in the given order (series frames). */
  series?: string[] | null;
  /** Keep the N largest rows/series by value; the rest fold into one `Other`. */
  topN?: number | null;
  /** Each bucket as shares of 100 (stacked `normalize`). */
  normalize?: boolean;
}

/** The name `topN` gives the folded remainder (the dashboard shows its own word for it). */
export const OTHER_NAME = 'Other';

/** Engine cap on rows a frame may carry (the same 400 the dataset parser applies). */
export const FRAME_ROW_CAP = 400;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function stringList(v: unknown): string[] | null {
  if (typeof v === 'string' && v.trim() !== '') return [v.trim()];
  if (typeof v === 'number' && Number.isFinite(v)) return [String(v)];
  if (!Array.isArray(v)) return null;
  const out = v
    .filter((s) => typeof s === 'string' || (typeof s === 'number' && Number.isFinite(s)))
    .map((s) => String(s).trim())
    .filter((s) => s !== '');
  return out.length > 0 ? out : null;
}

/**
 * LENIENT sort parse: `"-v"` (desc), `"label"` (asc) or `{by, dir}`. The chart
 * shorthands sort by value: `"desc"`, `"asc"`; `"none"` keeps the source order.
 */
export function parseSort(v: unknown): FrameSort | null {
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s || s === '-' || s === 'none') return null;
    if (s === 'desc' || s === 'asc') return { by: 'v', dir: s };
    return s.startsWith('-') ? { by: s.slice(1), dir: 'desc' } : { by: s, dir: 'asc' };
  }
  const r = asRecord(v);
  if (!r || typeof r.by !== 'string' || !r.by.trim()) return null;
  return { by: r.by.trim(), dir: r.dir === 'desc' ? 'desc' : 'asc' };
}

/** LENIENT: a block's options -> the static ops it asks for. Malformed parts are ignored. */
export function frameOpsFromOptions(options: Record<string, unknown> | null | undefined): FrameOps {
  const o = options ?? {};
  const ops: FrameOps = {};
  const where = asRecord(o.where);
  if (where) {
    const out: Record<string, string[]> = {};
    for (const [dim, values] of Object.entries(where)) {
      const list = stringList(values);
      if (list) out[dim] = list;
    }
    if (Object.keys(out).length > 0) ops.where = out;
  }
  const sort = parseSort(o.sort);
  if (sort) ops.sort = sort;
  const limit = typeof o.limit === 'number' ? o.limit : Number.NaN;
  if (Number.isFinite(limit) && limit >= 1) ops.limit = Math.min(FRAME_ROW_CAP, Math.floor(limit));
  const series = stringList(o.series);
  if (series) ops.series = series;
  const topN = typeof o.topN === 'number' ? o.topN : Number.NaN;
  if (Number.isFinite(topN) && topN >= 1) ops.topN = Math.min(FRAME_ROW_CAP, Math.floor(topN));
  if (o.normalize === true) ops.normalize = true;
  return ops;
}

function rowMatches(row: TableRow, where: Record<string, string[]>): boolean {
  for (const [dim, allowed] of Object.entries(where)) {
    const value = row.d[dim];
    if (value === undefined || allowed.indexOf(value) === -1) return false;
  }
  return true;
}

function sortValue(row: TableRow, by: string): number | string | null {
  if (by === 'v') return row.v;
  if (by === 'n') return row.n ?? null;
  if (by === 'prev') return row.prev ?? null;
  return row.d[by] ?? null;
}

/** Stable sort; nulls always last whichever the direction. */
function sortRows(rows: TableRow[], sort: FrameSort): TableRow[] {
  const sign = sort.dir === 'desc' ? -1 : 1;
  return rows
    .map((row, idx) => ({ row, idx, key: sortValue(row, sort.by) }))
    .sort((a, b) => {
      if (a.key === null && b.key === null) return a.idx - b.idx;
      if (a.key === null) return 1;
      if (b.key === null) return -1;
      let cmp: number;
      if (typeof a.key === 'number' && typeof b.key === 'number') cmp = a.key - b.key;
      else cmp = String(a.key).localeCompare(String(b.key));
      return cmp !== 0 ? cmp * sign : a.idx - b.idx;
    })
    .map((e) => e.row);
}

function sumOf(values: Array<number | null | undefined>): number | null {
  let seen = false;
  let sum = 0;
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      seen = true;
      sum += v;
    }
  }
  return seen ? sum : null;
}

/** The total of `rows`, honouring the source's own total when nothing was filtered out. */
export function tableTotal(
  rows: readonly TableRow[],
  sourceTotal: TableFrame['sourceTotal'],
  filtered: boolean,
): TableTotal {
  const n = sumOf(rows.map((r) => r.n));
  if (!filtered && sourceTotal && typeof sourceTotal.v === 'number') {
    return { count: rows.length, v: sourceTotal.v, n: typeof sourceTotal.n === 'number' ? sourceTotal.n : n };
  }
  return { count: rows.length, v: sumOf(rows.map((r) => r.v)), n };
}

/** Distinct values of `dim` after the static `where` (the filter block's chips), in first-seen order. */
export function distinctValues(frame: Frame, dim: string, where?: Record<string, string[]>): string[] {
  if (frame.kind !== 'table') return [];
  const seen: string[] = [];
  for (const row of frame.rows) {
    if (where && !rowMatches(row, where)) continue;
    const value = row.d[dim];
    if (value !== undefined && seen.indexOf(value) === -1) seen.push(value);
  }
  return seen;
}

function num(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Indexes of the `n` largest `values` (nulls lowest, ties to the earlier one). */
function largest(values: ReadonlyArray<number | null>, n: number): Set<number> {
  const ranked = values
    .map((v, idx) => ({ v: typeof v === 'number' && Number.isFinite(v) ? v : -Infinity, idx }))
    .sort((a, b) => (b.v !== a.v ? b.v - a.v : a.idx - b.idx));
  return new Set(ranked.slice(0, n).map((e) => e.idx));
}

/** The N largest rows by `v` in their current order, then ONE `Other` row summing the rest. */
function topRows(rows: TableRow[], dims: readonly TableDim[], n: number): TableRow[] {
  if (rows.length <= n) return rows;
  const keep = largest(rows.map((r) => r.v), n);
  const kept = rows.filter((_, i) => keep.has(i));
  const rest = rows.filter((_, i) => !keep.has(i));
  const d: Record<string, string> = {};
  for (const dim of dims) d[dim.key] = OTHER_NAME;
  const other: TableRow = { d, v: sumOf(rest.map((r) => r.v)), other: rest.length };
  const sn = sumOf(rest.map((r) => r.n));
  if (sn !== null) other.n = sn;
  const sp = sumOf(rest.map((r) => r.prev));
  if (sp !== null) other.prev = sp;
  return [...kept, other];
}

/** The N largest series by their summed points, in order, then ONE `Other` series (pointwise sum). */
function topSeries(series: FrameSeries[], n: number): FrameSeries[] {
  if (series.length <= n) return series;
  const keep = largest(series.map((s) => sumOf(s.points.map((p) => p.v))), n);
  const kept = series.filter((_, i) => keep.has(i));
  const rest = series.filter((_, i) => !keep.has(i));
  const order: string[] = [];
  const sums = new Map<string, number>();
  for (const s of rest) {
    for (const p of s.points) {
      if (!sums.has(p.t)) order.push(p.t);
      sums.set(p.t, (sums.get(p.t) ?? 0) + num(p.v));
    }
  }
  order.sort();
  return [...kept, { name: OTHER_NAME, points: order.map((t) => ({ t, v: sums.get(t) as number })), other: rest.length }];
}

/** A share of 100, or 0 when the bucket sums to nothing. */
function share(v: number, total: number): number {
  return total > 0 ? (v / total) * 100 : 0;
}

/**
 * Table rows as shares of 100: per value of the FIRST dim when the table has two
 * or more (the bucket a stacked chart draws), else of the whole table.
 */
function normalizeRows(rows: TableRow[], dims: readonly TableDim[]): TableRow[] {
  const bucketOf = (r: TableRow) => (dims.length >= 2 ? r.d[dims[0].key] ?? '' : '');
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(bucketOf(r), (totals.get(bucketOf(r)) ?? 0) + Math.max(0, num(r.v)));
  return rows.map((r) => ({ ...r, v: r.v === null ? null : share(Math.max(0, r.v), totals.get(bucketOf(r)) as number) }));
}

/** Series as shares of 100 of every series' total at the same `t`. */
function normalizeSeries(series: FrameSeries[]): FrameSeries[] {
  const totals = new Map<string, number>();
  for (const s of series) for (const p of s.points) totals.set(p.t, (totals.get(p.t) ?? 0) + Math.max(0, num(p.v)));
  return series.map((s) => ({
    ...s,
    points: s.points.map((p) => ({ t: p.t, v: share(Math.max(0, num(p.v)), totals.get(p.t) as number) })),
  }));
}

/**
 * Shape a frame for one block. Tables: where -> filter -> sort -> topN ->
 * limit -> normalize, with `total` recomputed after the filter and before the
 * limit (and before normalize: it stays in the source unit). Series: pick,
 * keep the last `limit` points, topN, normalize. Other kinds pass through.
 */
export function applyFrameOps(frame: Frame, ops: FrameOps): Frame {
  if (frame.kind === 'table') {
    let rows = frame.rows.slice();
    const before = rows.length;
    if (ops.where) {
      const where = ops.where;
      rows = rows.filter((row) => rowMatches(row, where));
    }
    if (ops.filter && ops.filter.dim) {
      const f = ops.filter;
      rows = rows.filter((row) => row.d[f.dim] === f.value);
    }
    const total = tableTotal(rows, frame.sourceTotal, rows.length !== before);
    if (ops.sort) rows = sortRows(rows, ops.sort);
    if (typeof ops.topN === 'number' && ops.topN >= 1) rows = topRows(rows, frame.dims, Math.floor(ops.topN));
    if (typeof ops.limit === 'number' && ops.limit >= 1) rows = rows.slice(0, Math.floor(ops.limit));
    if (ops.normalize) return { ...frame, rows: normalizeRows(rows, frame.dims), total, unit: '%' };
    return { ...frame, rows, total };
  }
  if (frame.kind === 'series') {
    let series = frame.series;
    if (ops.series && ops.series.length > 0) {
      const byName = new Map(series.map((s) => [s.name, s] as [string, FrameSeries]));
      series = ops.series.map((name) => byName.get(name)).filter((s): s is FrameSeries => s !== undefined);
    }
    if (typeof ops.limit === 'number' && ops.limit >= 1) {
      const keep = Math.floor(ops.limit);
      series = series.map((s) => ({ ...s, points: s.points.slice(-keep) }));
    }
    if (typeof ops.topN === 'number' && ops.topN >= 1) series = topSeries(series, Math.floor(ops.topN));
    if (ops.normalize) return { ...frame, series: normalizeSeries(series), unit: '%' };
    return { ...frame, series };
  }
  return frame;
}
