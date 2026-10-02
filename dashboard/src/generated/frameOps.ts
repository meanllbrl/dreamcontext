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
  /** True only when every band came from the set (the path has none of its own). */
  bandsInherited: boolean;
  /** Metric keys whose band came from the set, per metric (a path may band some metrics itself). Absent = all when `bandsInherited`. */
  inheritedBands?: string[];
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

// ─── Funnel explorer ────────────────────────────────────────────────────────
//
// A funnel frame answers ONE exact selection (`funnelSlice`). In `lookup` mode
// each segment is its own measured path, looked up and never summed; in
// `cells` mode (the default) the matching disjoint cells' step users are
// summed and rates are left empty (they cannot be summed). Not measured is not
// zero: an unmeasured slice has no steps, no metrics and no users to draw.

/** Rows whose users fall below this read as low sample when the frame names none. */
export const DEFAULT_LOW_SAMPLE = 30;

/** `a=1&b=2`: sorted `dim=value` pairs, the stable key of a selection. */
export function selectionKey(sel: Selection): string {
  return Object.keys(sel)
    .sort()
    .map((k) => `${k}=${sel[k]}`)
    .join('&');
}

/** LENIENT: `"a=b,c=d"` -> `{a: 'b', c: 'd'}`. Parts without a key or value are skipped; the last wins per dim. */
export function parseSelection(s: string): Selection {
  const out: Selection = {};
  if (typeof s !== 'string') return out;
  for (const part of s.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

/** The chip toggle: the active value clears its dim, any other value replaces it. */
export function toggleSelection(sel: Selection, dim: string, value: string): Selection {
  const out: Selection = { ...sel };
  if (out[dim] === value) delete out[dim];
  else out[dim] = value;
  return out;
}

/** The picked funnel; null or an unknown id falls back to the first (the caller compares ids to say so). */
function pickFunnel(frame: FunnelFrame, funnelId: string | null): FunnelFrameFunnel | null {
  if (funnelId !== null) {
    const found = frame.funnels.find((f) => f.id === funnelId);
    if (found) return found;
  }
  return frame.funnels[0] ?? null;
}

/** The dims a selection may name: the frame's declared dimensions, else every dim a segment carries. */
function declaredDims(frame: FunnelFrame): string[] {
  if (frame.dimensions) return frame.dimensions.map((d) => d.key);
  const out: string[] = [];
  for (const f of frame.funnels) {
    for (const seg of f.segments ?? []) for (const k of Object.keys(seg.dims)) if (out.indexOf(k) === -1) out.push(k);
  }
  return out;
}

function sameSelection(a: Selection, b: Selection): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => b[k] === a[k]);
}

function lowSampleOf(frame: FunnelFrame, users: number): boolean {
  const threshold = typeof frame.lowSample === 'number' ? frame.lowSample : DEFAULT_LOW_SAMPLE;
  return users < threshold;
}

/**
 * The funnel as one exact selection sees it. An empty selection is the funnel
 * level. Selection dims the frame does not declare are dropped into `ignored`.
 */
export function funnelSlice(frame: FunnelFrame, funnelId: string | null, sel: Selection): FunnelSlice {
  const f = pickFunnel(frame, funnelId);
  const declared = declaredDims(frame);
  const effective: Selection = {};
  const ignored: string[] = [];
  for (const k of Object.keys(sel).sort()) {
    const v = sel[k];
    if (typeof v !== 'string' || v === '') continue;
    if (declared.indexOf(k) === -1) ignored.push(k);
    else effective[k] = v;
  }
  const frameBands = frame.bands ?? {};
  const unmeasured = (reason: string | null): FunnelSlice => ({
    funnelId: f ? f.id : '',
    funnelName: f ? f.name : '',
    selection: effective,
    measured: false,
    reason,
    users: 0,
    steps: [],
    metrics: {},
    bands: frameBands,
    bandsInherited: true,
    inheritedBands: Object.keys(frameBands),
    daily: [],
    lowSample: false,
    ignored,
  });
  if (!f) return unmeasured(null);

  if (Object.keys(effective).length === 0) {
    const users = f.steps[0]?.users ?? 0;
    return {
      funnelId: f.id,
      funnelName: f.name,
      selection: effective,
      measured: true,
      reason: null,
      users,
      steps: f.steps.map((s) => ({ ...s })),
      metrics: f.metrics ?? {},
      bands: frameBands,
      bandsInherited: false,
      inheritedBands: [],
      daily: f.daily ?? [],
      lowSample: lowSampleOf(frame, users),
      ignored,
    };
  }

  const labelOf = (key: string) => f.steps.find((s) => s.key === key)?.label ?? key;
  const segments = f.segments ?? [];

  if (frame.segmentMode === 'lookup') {
    const seg = segments.find((s) => sameSelection(s.dims, effective));
    if (!seg || !seg.measured) return unmeasured(seg ? seg.reason : null);
    // Per metric: the path's own band, else the set's (marked inherited for that metric).
    const own = seg.bands && Object.keys(seg.bands).length > 0 ? seg.bands : null;
    const bands: Record<string, FunnelFrameBand> = { ...frameBands, ...(own ?? {}) };
    return {
      funnelId: f.id,
      funnelName: f.name,
      selection: effective,
      measured: true,
      reason: null,
      users: seg.users,
      steps: seg.steps.map((s) => ({ key: s.key, label: labelOf(s.key), users: s.users })),
      metrics: seg.metrics ?? {},
      bands,
      bandsInherited: own === null,
      inheritedBands: Object.keys(frameBands).filter((k) => !own || !own[k]),
      daily: seg.daily ?? [],
      lowSample: lowSampleOf(frame, seg.users),
      ignored,
    };
  }

  // cells: sum the matching measured cells; an unmeasured cell never adds to the sum.
  const matching = segments.filter((seg) => Object.keys(effective).every((k) => seg.dims[k] === effective[k]));
  const measured = matching.filter((seg) => seg.measured);
  if (measured.length === 0) return unmeasured(matching.find((seg) => seg.reason !== null)?.reason ?? null);
  const byStep = new Map<string, number>();
  let users = 0;
  for (const seg of measured) {
    users += seg.users;
    for (const s of seg.steps) byStep.set(s.key, (byStep.get(s.key) ?? 0) + s.users);
  }
  return {
    funnelId: f.id,
    funnelName: f.name,
    selection: effective,
    measured: true,
    reason: null,
    users,
    steps: f.steps.map((s) => ({ key: s.key, label: s.label, users: byStep.get(s.key) ?? 0 })),
    metrics: {},
    bands: frameBands,
    bandsInherited: true,
    inheritedBands: Object.keys(frameBands),
    daily: [],
    lowSample: lowSampleOf(frame, users),
    ignored,
  };
}

/**
 * One chip row per declared dimension. A chip is enabled when toggling it
 * yields a measured slice, or when it is the active chip (it must stay
 * clearable); users and reason come from the slice the chip leads to (the
 * active chip reports the current slice).
 */
export function breakdownAxes(frame: FunnelFrame, funnelId: string | null, sel: Selection): BreakdownAxis[] {
  return (frame.dimensions ?? []).map((dim) => ({
    key: dim.key,
    label: dim.label,
    chips: dim.values.map((value) => {
      const active = sel[dim.key] === value;
      const slice = funnelSlice(frame, funnelId, active ? sel : toggleSelection(sel, dim.key, value));
      return {
        value,
        active,
        enabled: active || slice.measured,
        users: slice.measured ? slice.users : null,
        reason: slice.measured ? null : slice.reason,
      };
    }),
  }));
}

/**
 * Per-step rates, 0-100: `ofTop` of the first step, `ofPrev` of the previous
 * one, `dropPct` = 100 - ofPrev. The worst step is the largest drop (ties to
 * the first); with fewer than 2 steps nothing is worst. A 0-user previous
 * step gives null rates, never Infinity.
 */
export function stepDrops(steps: ReadonlyArray<{ key: string; label?: string; users: number }>): StepDrop[] {
  const top = steps[0]?.users ?? 0;
  const out: StepDrop[] = steps.map((s, i) => {
    const prev = i > 0 ? steps[i - 1].users : null;
    const ofPrev = prev === null || !(prev > 0) ? null : (s.users / prev) * 100;
    return {
      key: s.key,
      label: s.label ?? s.key,
      users: s.users,
      ofTop: top > 0 ? (s.users / top) * 100 : null,
      ofPrev,
      dropPct: ofPrev === null ? null : 100 - ofPrev,
      worst: false,
    };
  });
  let worst = -1;
  for (let i = 1; i < out.length; i++) {
    const d = out[i].dropPct;
    if (d !== null && (worst === -1 || d > (out[worst].dropPct as number))) worst = i;
  }
  if (worst !== -1) out[worst].worst = true;
  return out;
}

type BandTone = 'below' | 'between' | 'above';

/** Where `v` sits against a band, in goodness terms (`better: 'lower'` flips the comparisons). */
function bandTone(v: number, band: FunnelFrameBand | undefined): BandTone | null {
  if (!band || (band.floor === null && band.target === null)) return null;
  const worse = (a: number, b: number) => (band.better === 'lower' ? a > b : a < b);
  if (band.floor !== null && worse(v, band.floor)) return 'below';
  if (band.target !== null && !worse(v, band.target)) return 'above';
  return 'between';
}

function finite(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * One benchmark row per metric (the slice's own keys, or `metricKeys` in that
 * order). A key the slice lacks is skipped on a measured slice and reads as
 * unmeasured (with the slice's reason) on an unmeasured one. `inherited` is
 * per metric: a path that bands some metrics itself inherits the set's band
 * for each metric it lacks, and only those rows say so.
 */
export function benchmarkRows(slice: FunnelSlice, metricKeys: readonly string[] | null): BenchmarkRow[] {
  const keys = metricKeys ?? Object.keys(slice.metrics);
  const rows: BenchmarkRow[] = [];
  for (const key of keys) {
    const m = slice.metrics[key];
    if (!m && slice.measured) continue;
    const band = slice.bands[key];
    const better = band ? band.better : 'higher';
    const measured = !!m && m.measured && finite(m.v) !== null;
    const current = measured ? finite(m.v) : null;
    const prev = measured ? finite(m.prev) : null;
    const delta = current !== null && prev !== null ? current - prev : null;
    let status: BenchmarkRow['status'] = 'unmeasured';
    if (current !== null) status = bandTone(current, band) ?? 'no-band';
    rows.push({
      key,
      label: m?.label ?? key,
      format: m ? m.format : 'number',
      current,
      prev,
      delta,
      floor: band ? band.floor : null,
      target: band ? band.target : null,
      floorSource: band ? band.floorSource : null,
      targetSource: band ? band.targetSource : null,
      better,
      status,
      trend: delta === null ? null : delta === 0 ? 'flat' : (delta > 0) === (better === 'higher') ? 'improving' : 'worsening',
      reason: measured ? null : m ? m.reason : slice.reason,
      inherited: !!band && (slice.inheritedBands ? slice.inheritedBands.indexOf(key) !== -1 : slice.bandsInherited),
    });
  }
  return rows;
}

/**
 * One row per value of dim `by`, each the exact slice of that value under the
 * current selection on the other axes. Cells carry the value, its previous
 * window and its band tone; an unmeasured metric (or slice) is a null cell.
 */
export function segmentRows(
  frame: FunnelFrame,
  funnelId: string | null,
  by: string,
  sel: Selection,
  metricKeys: readonly string[] | null,
): SegmentRow[] {
  const dim = (frame.dimensions ?? []).find((d) => d.key === by);
  if (!dim) return [];
  const f = pickFunnel(frame, funnelId);
  const keys = metricKeys ?? Object.keys(f?.metrics ?? {});
  return dim.values.map((value) => {
    const selection: Selection = { ...sel, [by]: value };
    const slice = funnelSlice(frame, funnelId, selection);
    const cells: SegmentRow['cells'] = {};
    for (const key of keys) {
      const m = slice.metrics[key];
      const v = m && m.measured ? finite(m.v) : null;
      const prev = m && m.measured ? finite(m.prev) : null;
      cells[key] = { v, prev, tone: v === null ? null : bandTone(v, slice.bands[key]) };
    }
    return {
      value,
      selection: slice.selection,
      measured: slice.measured,
      reason: slice.reason,
      users: slice.users,
      lowSample: slice.lowSample,
      cells,
    };
  });
}

const FORMAT_UNITS: Record<FunnelMetricFormat, string | null> = {
  count: null,
  number: null,
  pct: '%',
  usd: 'USD',
  x: 'x',
  seconds: 's',
};

/**
 * The slice's daily trend as a series frame, one series per metric (the
 * slice's metric keys, else every key the days carry). A null day is a gap,
 * never a 0. The unit is the metrics' shared format unit, else null.
 */
export function dailySeries(slice: FunnelSlice, metricKeys: readonly string[] | null, insight = ''): SeriesFrame {
  let keys: string[];
  if (metricKeys) keys = metricKeys.slice();
  else {
    keys = Object.keys(slice.metrics);
    for (const day of slice.daily) for (const k of Object.keys(day.m)) if (keys.indexOf(k) === -1) keys.push(k);
  }
  const formats = keys.map((k) => slice.metrics[k]?.format ?? null);
  const unit = formats.length > 0 && formats[0] !== null && formats.every((x) => x === formats[0])
    ? FORMAT_UNITS[formats[0] as FunnelMetricFormat]
    : null;
  return {
    kind: 'series',
    insight,
    series: keys.map((key) => ({
      name: slice.metrics[key]?.label ?? key,
      points: slice.daily
        .filter((day) => finite(day.m[key]) !== null)
        .map((day) => ({ t: day.t, v: day.m[key] as number })),
    })),
    unit,
    granularity: 'daily',
  };
}

/** Block types that draw ONE funnel (the pick, else the first): the others travel as id, name and steps only. */
const ONE_FUNNEL_BLOCKS = ['breakdown', 'trend', 'benchmark', 'segments'];

/** A funnel's other levels stripped: what a pick list and the unknown-pick note read. */
function funnelHead(f: FunnelFrameFunnel): FunnelFrameFunnel {
  return { id: f.id, name: f.name, steps: f.steps };
}

/**
 * Days trimmed to what a trend draws: only `keys` (when the block picks
 * metrics), and no null entry for a metric the level itself lists (a null day
 * is a gap either way, and the key stays known through `metrics`).
 */
function trimDaily(
  days: readonly FunnelFrameDay[],
  keys: readonly string[] | null,
  known: Record<string, FunnelFrameMetric> | undefined,
): FunnelFrameDay[] {
  return days.map((day) => {
    const m: Record<string, number | null> = {};
    for (const k of Object.keys(day.m)) {
      if (keys && keys.indexOf(k) === -1) continue;
      if (day.m[k] === null && known && known[k]) continue;
      m[k] = day.m[k];
    }
    return { t: day.t, m };
  });
}

/** The `metrics` pick as the blocks read it (`stringListOption`): a list, or one comma-separated string. */
function pickMetricKeys(options: Record<string, unknown> | null | undefined): string[] | null {
  const raw = options ? options.metrics : undefined;
  const list = typeof raw === 'string' ? raw.split(',') : Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : [];
  const keys = list.map((k) => k.trim()).filter((k) => k !== '');
  return keys.length > 0 ? keys : null;
}

function keepMetrics(metrics: Record<string, FunnelFrameMetric>, keys: readonly string[]): Record<string, FunnelFrameMetric> {
  const out: Record<string, FunnelFrameMetric> = {};
  for (const k of keys) if (metrics[k]) out[k] = metrics[k];
  return out;
}

/**
 * The part of a funnel frame one block reads (bounds the board response; every
 * selection still resolves on the client, so a chip click needs no request):
 *   - a known `funnel` pick keeps only that funnel; a one-funnel block
 *     (breakdown, trend, benchmark, segments) without one keeps the first in
 *     full and the rest as id, name and steps (an unknown pick falls back to
 *     the first, the block notes it);
 *   - daily trends travel only to `trend`, trimmed to its `metrics` pick and
 *     without null entries the level's metrics already name;
 *   - metrics go only to trend, benchmark and segments; bands only to
 *     benchmark and segments (the two that tone by them);
 *   - a segments block keeps only the paths that name its `by` dim (the
 *     option, else the first dim): the only ones its rows look up.
 * `funnelSlice` and the view functions give the same answers on the projected
 * frame as on the full one for the block's own options (`segmentRows` for
 * the block's `by`).
 */
export function projectFunnelFrame(
  frame: FunnelFrame,
  blockType: string,
  options: Record<string, unknown> | null | undefined,
): FunnelFrame {
  const pick = options && typeof options.funnel === 'string' ? options.funnel.trim() : '';
  const picked = pick !== '' ? frame.funnels.filter((f) => f.id === pick) : [];
  const oneFunnel = ONE_FUNNEL_BLOCKS.indexOf(blockType) !== -1;
  const shown = picked.length > 0 ? picked[0] : oneFunnel ? frame.funnels[0] ?? null : null;
  const isTrend = blockType === 'trend';
  const keepRates = isTrend || blockType === 'benchmark' || blockType === 'segments';
  const keepBands = blockType === 'benchmark' || blockType === 'segments';
  const trendKeys = isTrend ? pickMetricKeys(options) : null;
  // A segments block only ever looks up paths that name its `by` dim (the option, else the first dim).
  const dims = frame.dimensions ?? [];
  const byOpt = blockType === 'segments' && options && typeof options.by === 'string' ? options.by.trim() : '';
  const by = blockType !== 'segments' ? null : dims.some((d) => d.key === byOpt) ? byOpt : dims[0]?.key ?? null;

  const full = (f: FunnelFrameFunnel): FunnelFrameFunnel => {
    const next: FunnelFrameFunnel = { ...f };
    if (!isTrend || !f.daily) delete next.daily;
    else next.daily = trimDaily(f.daily, trendKeys, f.metrics);
    if (!keepRates) delete next.metrics;
    if (f.segments) {
      const reachable = by === null ? f.segments : f.segments.filter((seg) => seg.dims[by] !== undefined);
      next.segments = reachable.map((seg) => {
        const s: FunnelFrameSegment = { ...seg };
        if (!isTrend || !seg.daily) delete s.daily;
        else s.daily = trimDaily(seg.daily, trendKeys, seg.metrics);
        if (!keepRates) delete s.metrics;
        else if (trendKeys && seg.metrics) s.metrics = keepMetrics(seg.metrics, trendKeys);
        if (!keepBands) delete s.bands;
        return s;
      });
    }
    return next;
  };

  const funnels = picked.length > 0
    ? picked.map(full)
    : frame.funnels.map((f) => (shown === null || f === shown ? full(f) : funnelHead(f)));
  const out: FunnelFrame = { ...frame, funnels };
  if (!keepBands) delete out.bands;
  return out;
}

// ─── Shared frames (board response) ─────────────────────────────────────────

/** A board response's frames with identical funnel frames sent once: `aliases[key]` names the key holding the copy. */
export interface SharedFrames {
  frames: Record<string, Frame>;
  aliases: Record<string, string>;
}

/**
 * Identical funnel frames (the heavy kind: blocks of one insight with the same
 * projection) travel once; every other key names the first key that carries
 * the copy. `expandFrames` restores every key, so a block reads its frame as
 * before. Other kinds are small and always sent as they are.
 */
export function shareFrames(frames: Record<string, Frame>): SharedFrames {
  const out: Record<string, Frame> = {};
  const aliases: Record<string, string> = {};
  const seen = new Map<string, string>();
  for (const key of Object.keys(frames)) {
    const frame = frames[key];
    if (frame.kind !== 'funnel') {
      out[key] = frame;
      continue;
    }
    const sig = JSON.stringify(frame);
    const first = seen.get(sig);
    if (first !== undefined) aliases[key] = first;
    else {
      seen.set(sig, key);
      out[key] = frame;
    }
  }
  return { frames: out, aliases };
}

/** Every key of a shared response back (an alias whose copy is missing stays absent: the block reads no frame). */
export function expandFrames(frames: Record<string, Frame>, aliases: Record<string, string> | null | undefined): Record<string, Frame> {
  if (!aliases) return frames;
  const keys = Object.keys(aliases);
  if (keys.length === 0) return frames;
  const out: Record<string, Frame> = { ...frames };
  for (const key of keys) {
    const copy = frames[aliases[key]];
    if (copy && !Object.prototype.hasOwnProperty.call(frames, key)) out[key] = copy;
  }
  return out;
}
