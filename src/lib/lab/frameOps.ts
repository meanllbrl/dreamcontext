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

/** Which input won a ladder-derived band bound: the book value, or this level's own percentile. */
export type BandSourceKind = 'book' | 'own';

/** Why a looked-up path is missing: its axis combination was never pulled, or it fell under the declared user floor. */
export type SliceReasonCode = 'not-pulled' | 'below-floor';

/** A count over a count (`k` of `n`): what a rate shows instead when its denominator is small. */
export interface Kn {
  k: number;
  n: number;
}

/** Under this denominator a rate is shown as k/n, never as a percentage. */
export const KN_THRESHOLD = 100;
/** The user floors the ranking offers; the default is the last. */
export const RANKING_FLOORS = [30, 100, 300] as const;
export const RANKING_DEFAULT_FLOOR = 300;
/** An intersection holding at least this share of a one-axis parent's users ... */
export const RANKING_DUP_SHARE = 0.9;
/** ... with a value within this relative distance of the parent's is the same cohort: a duplicate. */
export const RANKING_DUP_VALUE_TOL = 0.05;

export interface FunnelFrameStep {
  key: string;
  label: string;
  users: number;
  prev?: number | null;
  /** 'derived' = rate x first-step users, labelled on screen. Absent = measured. */
  basis?: 'measured' | 'derived';
  /** False = not measured for this funnel: drawn "not measured", never 0, skipped by the drop math. */
  measured?: boolean;
  reason?: string | null;
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
  /** Ladder-derived bands only: which input won each bound, and the weeks behind the own percentiles. */
  floorFrom?: BandSourceKind;
  targetFrom?: BandSourceKind;
  weeks?: number;
}

/** A reading trap or note, shown once as one line (never a wall of text). */
export interface FunnelFrameNote {
  code: string | null;
  text: string;
  level: 'trap' | 'info';
  /** Step keys, metric keys or `dim:<key>` this note concerns (their cells get a marker). */
  keys: string[];
  scope: 'funnel' | 'set';
}

export type PaymentCohort = 'first' | 'renewal' | 'all';

export interface FunnelFramePaymentCell {
  /** {} = the total; else one value per dim. */
  dims: Selection;
  cohort: PaymentCohort;
  attempts: number;
  declines: number;
  /** reason key -> declines with that reason. */
  reasons: Record<string, number>;
}

export interface FunnelFramePayment {
  measured: boolean;
  reason: string | null;
  cells: FunnelFramePaymentCell[];
}

export interface FunnelFrameAccess {
  stages: { key: string; label: string }[];
  rows: { funnel: string | null; dims: Selection; counts: Record<string, number | null> }[];
  asOf: string | null;
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
  /** The funnel's own bands (ladder-derived or authored); paths inherit them before the set's. */
  bands?: Record<string, FunnelFrameBand>;
  notes?: FunnelFrameNote[];
  payment?: FunnelFramePayment;
  /** Part key ('segments', 'payment', `dim:<key>`, ...) -> why THIS funnel does not carry it. */
  unmeasured?: Record<string, string>;
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
  /** The window the set describes (from the snapshot, not the range tweak). */
  window?: { from: string; to: string; prevFrom: string | null; prevTo: string | null };
  provenance?: { source: string; pulledAt: string | null; freshness: string | null; filters: string[] };
  /** Set-level notes (traps that hold for every funnel). */
  notes?: FunnelFrameNote[];
  /** Part key -> how to fill it when absent. */
  hints?: Record<string, string>;
  /** Rate metric key -> its numerator and denominator step keys (k/n under a small denominator). */
  rates?: Record<string, { num: string; den: string }>;
  /** The axis combinations the source was asked for, and the user floor it applied. */
  intersections?: { dims: string[]; minUsers: number | null }[];
  /** The benchmark ladder's stage metric keys, in order. */
  ladder?: string[];
  /** The all-funnels payment (a funnel without its own payment shows this one). */
  payment?: FunnelFramePayment;
  paymentReasons?: { key: string; label: string; note: string | null }[];
  access?: FunnelFrameAccess;
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
  /** Set on an unmeasured slice whose path is missing: why (never pulled, or under the floor). */
  reasonCode?: SliceReasonCode | null;
  /** Per metric: which level its band came from. */
  bandOrigin?: Record<string, 'set' | 'funnel' | 'path'>;
}

export interface BreakdownChip {
  value: string;
  active: boolean;
  enabled: boolean;
  users: number | null;
  reason: string | null;
  /** The slice the chip leads to: why its path is missing, when known. */
  reasonCode?: SliceReasonCode | null;
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
  /** Users of the last measured step before this one (the denominator of `ofPrev`), or null. */
  prevUsers: number | null;
  measured: boolean;
  basis: 'measured' | 'derived';
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
  floorFrom: BandSourceKind | null;
  targetFrom: BandSourceKind | null;
  weeks: number | null;
  /** When `inherited`: the level the band came from. */
  inheritedFrom: 'set' | 'funnel' | null;
}

export interface SegmentRow {
  value: string;
  selection: Selection;
  measured: boolean;
  reason: string | null;
  users: number;
  lowSample: boolean;
  cells: Record<string, { v: number | null; prev: number | null; tone: 'below' | 'between' | 'above' | null; kn: Kn | null }>;
}

/** One funnel's best breakdown on the ranked metric. */
export interface RankingRow {
  funnelId: string;
  funnelName: string;
  selection: Selection;
  users: number;
  value: number;
  prev: number | null;
  format: FunnelMetricFormat;
  /** The rate as counts, when the metric has a rate definition (show it when `n < KN_THRESHOLD`). */
  kn: Kn | null;
  lowSample: boolean;
  tone: 'below' | 'between' | 'above' | null;
  /** The funnel level's own value, for context. */
  total: number | null;
}

export interface RankingView {
  metric: string;
  label: string;
  better: 'higher' | 'lower';
  minUsers: number;
  /** Best first. */
  rows: RankingRow[];
  dropped: { funnelId: string; funnelName: string; why: 'no-path' | 'no-value' }[];
}

export interface PaymentReasonShare {
  key: string;
  label: string;
  count: number;
  /** Share of the declines, 0-100, or null when there are none. */
  share: number | null;
  note: string | null;
}

export interface PaymentRow {
  dims: Selection;
  cohort: PaymentCohort;
  attempts: number;
  declines: number;
  /** Decline rate, 0-100, or null with no attempts. */
  rate: number | null;
  /** declines of attempts (show it when `n < KN_THRESHOLD`). */
  kn: Kn | null;
  reasons: PaymentReasonShare[];
  /** Declines no named reason accounts for (never negative). */
  other: number;
  /** The reasons add up to more than the declines: the source is inconsistent. */
  clipped: boolean;
  lowSample: boolean;
}

export interface PaymentView {
  /** 'set' = the funnel has no payment of its own, the all-funnels one is shown. */
  scope: 'funnel' | 'set' | 'none';
  measured: boolean;
  reason: string | null;
  cohorts: PaymentCohort[];
  cohort: PaymentCohort;
  /** The cell for exactly the selection, or null. */
  current: PaymentRow | null;
  /** The `{}` cell, never a sum. */
  total: PaymentRow | null;
  byDim: { dim: string; rows: PaymentRow[] }[];
}

export interface AccessCell {
  key: string;
  label: string;
  users: number | null;
  /** Share of the row's base stage, 0-100. */
  ofBase: number | null;
  kn: Kn | null;
}

export interface AccessView {
  asOf: string | null;
  stages: { key: string; label: string }[];
  rows: { funnel: string | null; dims: Selection; base: number | null; cells: AccessCell[] }[];
}

/** How a block's funnel frame is projected (see `projectFunnelFrame`). */
export interface ProjectContext {
  /** The card has a funnel picker: blocks without their own funnel option carry every funnel in full. */
  allFunnels?: boolean;
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
  const funnelBands = f && f.bands && Object.keys(f.bands).length > 0 ? f.bands : null;
  // Per metric: the funnel's own band, else the set's.
  const levelBands: Record<string, FunnelFrameBand> = { ...frameBands, ...(funnelBands ?? {}) };
  const originOf = (own: Record<string, FunnelFrameBand> | null): Record<string, 'set' | 'funnel' | 'path'> => {
    const out: Record<string, 'set' | 'funnel' | 'path'> = {};
    for (const k of Object.keys(frameBands)) out[k] = 'set';
    for (const k of Object.keys(funnelBands ?? {})) out[k] = 'funnel';
    for (const k of Object.keys(own ?? {})) out[k] = 'path';
    return out;
  };
  const unmeasured = (reason: string | null, reasonCode: SliceReasonCode | null = null): FunnelSlice => ({
    funnelId: f ? f.id : '',
    funnelName: f ? f.name : '',
    selection: effective,
    measured: false,
    reason,
    users: 0,
    steps: [],
    metrics: {},
    bands: levelBands,
    bandsInherited: true,
    inheritedBands: Object.keys(levelBands),
    daily: [],
    lowSample: false,
    ignored,
    reasonCode,
    bandOrigin: originOf(null),
  });
  if (!f) return unmeasured(null);

  if (Object.keys(effective).length === 0) {
    const users = f.steps[0]?.users ?? 0;
    // Without a ladder the set's bands ARE the funnel's (authored for every funnel), so nothing is
    // "inherited" at this level; under a ladder a funnel without its own weeks inherits the total's.
    const inherited = frame.ladder ? Object.keys(frameBands).filter((k) => !funnelBands || !funnelBands[k]) : [];
    return {
      funnelId: f.id,
      funnelName: f.name,
      selection: effective,
      measured: true,
      reason: null,
      users,
      steps: f.steps.map((s) => ({ ...s })),
      metrics: f.metrics ?? {},
      bands: levelBands,
      bandsInherited: inherited.length > 0 && funnelBands === null,
      inheritedBands: inherited,
      daily: f.daily ?? [],
      lowSample: lowSampleOf(frame, users),
      ignored,
      reasonCode: null,
      bandOrigin: originOf(null),
    };
  }

  const stepOf = (key: string) => f.steps.find((s) => s.key === key);
  const segments = f.segments ?? [];

  if (frame.segmentMode === 'lookup') {
    const seg = segments.find((s) => sameSelection(s.dims, effective));
    if (!seg) return unmeasured(funnelPartReason(f, effective), missingPathCode(frame, effective));
    if (!seg.measured) return unmeasured(seg.reason);
    // Per metric: the path's own band, else the funnel's, else the set's (marked inherited for that metric).
    const own = seg.bands && Object.keys(seg.bands).length > 0 ? seg.bands : null;
    const bands: Record<string, FunnelFrameBand> = { ...levelBands, ...(own ?? {}) };
    return {
      funnelId: f.id,
      funnelName: f.name,
      selection: effective,
      measured: true,
      reason: null,
      users: seg.users,
      steps: seg.steps.map((s) => pathStep(stepOf(s.key), s.key, s.users)),
      metrics: seg.metrics ?? {},
      bands,
      bandsInherited: own === null,
      inheritedBands: Object.keys(levelBands).filter((k) => !own || !own[k]),
      daily: seg.daily ?? [],
      lowSample: lowSampleOf(frame, seg.users),
      ignored,
      reasonCode: null,
      bandOrigin: originOf(own),
    };
  }

  // cells: sum the matching measured cells; an unmeasured cell never adds to the sum.
  const matching = segments.filter((seg) => Object.keys(effective).every((k) => seg.dims[k] === effective[k]));
  const measured = matching.filter((seg) => seg.measured);
  if (measured.length === 0) {
    const cellReason = matching.find((seg) => seg.reason !== null)?.reason ?? null;
    return unmeasured(cellReason ?? (matching.length === 0 ? funnelPartReason(f, effective) : null));
  }
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
    steps: f.steps.map((s) => pathStep(s, s.key, byStep.get(s.key) ?? 0)),
    metrics: {},
    bands: levelBands,
    bandsInherited: true,
    inheritedBands: Object.keys(levelBands),
    daily: [],
    lowSample: lowSampleOf(frame, users),
    ignored,
    reasonCode: null,
    bandOrigin: originOf(null),
  };
}

/** A path's step: its own users, with the funnel step's label, basis and not-measured mark. */
function pathStep(funnelStep: FunnelFrameStep | undefined, key: string, users: number): FunnelFrameStep {
  const out: FunnelFrameStep = { key, label: funnelStep ? funnelStep.label : key, users };
  if (funnelStep && funnelStep.basis !== undefined) out.basis = funnelStep.basis;
  if (funnelStep && funnelStep.measured === false) {
    out.measured = false;
    out.reason = funnelStep.reason ?? null;
    out.users = 0;
  }
  return out;
}

/** Why THIS funnel carries no path for a selection, from its `unmeasured` map: the axis, then the intersections, then all segments. */
function funnelPartReason(f: FunnelFrameFunnel, sel: Selection): string | null {
  const parts = f.unmeasured;
  if (!parts) return null;
  const dims = Object.keys(sel);
  if (dims.length >= 2 && parts.intersections) return parts.intersections;
  for (const k of dims) if (parts[`dim:${k}`]) return parts[`dim:${k}`];
  return parts.segments ?? null;
}

function sameDimSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((k) => b.indexOf(k) !== -1);
}

/**
 * Why a lookup path is missing, from the declared intersections: a combination
 * the source was never asked for is 'not-pulled'; a declared one is 'below-floor'.
 * A set that declares nothing gets no code (the generic wording stays).
 */
function missingPathCode(frame: FunnelFrame, sel: Selection): SliceReasonCode | null {
  if (!frame.intersections) return null;
  const dims = Object.keys(sel);
  const declared = frame.intersections.some((i) => sameDimSet(i.dims, dims));
  if (declared) return 'below-floor';
  return dims.length >= 2 ? 'not-pulled' : null;
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
      const chip: BreakdownChip = {
        value,
        active,
        enabled: active || slice.measured,
        users: slice.measured ? slice.users : null,
        reason: slice.measured ? null : slice.reason,
      };
      if (!slice.measured && slice.reasonCode) chip.reasonCode = slice.reasonCode;
      return chip;
    }),
  }));
}

/**
 * Per-step rates, 0-100: `ofTop` of the first step, `ofPrev` of the previous
 * one, `dropPct` = 100 - ofPrev. The worst step is the largest drop (ties to
 * the first); with fewer than 2 steps nothing is worst. A 0-user previous
 * step gives null rates, never Infinity.
 *
 * A step marked `measured: false` is not a count: it gets no rates, is never
 * the worst, and the next measured step is compared with the last measured
 * one (so a dead event never fabricates a 100% drop and a 0 -> N rise).
 */
export function stepDrops(
  steps: ReadonlyArray<{ key: string; label?: string; users: number; measured?: boolean; basis?: 'measured' | 'derived' }>,
): StepDrop[] {
  const top = steps.find((s) => s.measured !== false)?.users ?? 0;
  let lastMeasured: number | null = null;
  const out: StepDrop[] = steps.map((s) => {
    const measured = s.measured !== false;
    const prev = lastMeasured;
    const basis: 'measured' | 'derived' = s.basis === 'derived' ? 'derived' : 'measured';
    if (!measured) {
      return { key: s.key, label: s.label ?? s.key, users: s.users, ofTop: null, ofPrev: null, dropPct: null, worst: false, prevUsers: prev, measured, basis };
    }
    lastMeasured = s.users;
    const ofPrev = prev === null || !(prev > 0) ? null : (s.users / prev) * 100;
    return {
      key: s.key,
      label: s.label ?? s.key,
      users: s.users,
      ofTop: top > 0 ? (s.users / top) * 100 : null,
      ofPrev,
      dropPct: ofPrev === null ? null : 100 - ofPrev,
      worst: false,
      prevUsers: prev,
      measured,
      basis,
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
    const inherited = !!band && (slice.inheritedBands ? slice.inheritedBands.indexOf(key) !== -1 : slice.bandsInherited);
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
      inherited,
      floorFrom: band && band.floorFrom ? band.floorFrom : null,
      targetFrom: band && band.targetFrom ? band.targetFrom : null,
      weeks: band && typeof band.weeks === 'number' ? band.weeks : null,
      inheritedFrom: inherited ? (slice.bandOrigin && slice.bandOrigin[key] === 'funnel' ? 'funnel' : 'set') : null,
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
      cells[key] = { v, prev, tone: v === null ? null : bandTone(v, slice.bands[key]), kn: knOf(frame, slice, key) };
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

/**
 * A rate metric as counts (`k` of `n`), read off the slice's own steps through
 * the set's `rates` definition. Null without a definition, on an unmeasured
 * slice, or when either step is missing or not measured. The pair is returned
 * whatever its size; a surface shows it instead of the rate when `isSmallKn`.
 */
export function knOf(frame: FunnelFrame, slice: FunnelSlice, metricKey: string): Kn | null {
  const def = frame.rates ? frame.rates[metricKey] : undefined;
  if (!def || !slice.measured) return null;
  const num = slice.steps.find((s) => s.key === def.num);
  const den = slice.steps.find((s) => s.key === def.den);
  if (!num || !den || num.measured === false || den.measured === false) return null;
  return { k: num.users, n: den.users };
}

/** True when a k/n pair's denominator is under KN_THRESHOLD: show "k/n", not a rate. */
export function isSmallKn(kn: Kn | null | undefined): boolean {
  return !!kn && kn.n < KN_THRESHOLD;
}

/**
 * The notes a reader sees for one funnel, in reading order: the funnel's traps,
 * the set's traps, the funnel's info notes, the set's info notes. Payload order
 * is kept inside each group, so a funnel's own trap is never pushed behind a
 * set-wide one.
 */
export function orderedNotes(frame: FunnelFrame, funnelId: string | null): FunnelFrameNote[] {
  const f = pickFunnel(frame, funnelId);
  const own = (f && f.notes ? f.notes : []).map((n) => ({ ...n, scope: 'funnel' as const }));
  const set = (frame.notes ?? []).map((n) => ({ ...n, scope: 'set' as const }));
  const traps = (list: FunnelFrameNote[]) => list.filter((n) => n.level !== 'info');
  const infos = (list: FunnelFrameNote[]) => list.filter((n) => n.level === 'info');
  return [...traps(own), ...traps(set), ...infos(own), ...infos(set)];
}

/** The metrics a ranking offers: the ladder's stages, else every pct or x metric the funnels carry (first seen first). */
export function rankableMetrics(frame: FunnelFrame): string[] {
  if (frame.ladder && frame.ladder.length > 0) return frame.ladder.slice();
  const out: string[] = [];
  for (const f of frame.funnels) {
    for (const [k, m] of Object.entries(f.metrics ?? {})) {
      if ((m.format === 'pct' || m.format === 'x') && out.indexOf(k) === -1) out.push(k);
    }
  }
  return out;
}

function metricMeta(frame: FunnelFrame, key: string): { label: string; format: FunnelMetricFormat } {
  for (const f of frame.funnels) {
    const m = f.metrics ? f.metrics[key] : undefined;
    if (m) return { label: m.label ?? key, format: m.format };
    for (const seg of f.segments ?? []) {
      const sm = seg.metrics ? seg.metrics[key] : undefined;
      if (sm) return { label: sm.label ?? key, format: sm.format };
    }
  }
  return { label: key, format: 'number' };
}

function betterOf(frame: FunnelFrame, key: string): 'higher' | 'lower' {
  const fromSet = frame.bands ? frame.bands[key] : undefined;
  if (fromSet) return fromSet.better;
  for (const f of frame.funnels) {
    const b = f.bands ? f.bands[key] : undefined;
    if (b) return b.better;
  }
  return 'higher';
}

function measuredValue(m: FunnelFrameMetric | undefined): number | null {
  return m && m.measured ? finite(m.v) : null;
}

/**
 * Each funnel's best breakdown on one metric. Candidates are the funnel's
 * measured lookup paths with at least `minUsers` users and a value. An
 * intersection holding >= 90% of a one-axis parent's users with a value within
 * 5% of the parent's is the same cohort, so it is dropped as a duplicate. Best
 * first by the metric's direction; funnels with no candidate are listed in
 * `dropped`. Nothing is summed: a cells-mode set has no per-path rates, so it
 * ranks nothing.
 */
export function rankingRows(frame: FunnelFrame, metricKey: string, opts: { minUsers?: number } = {}): RankingView {
  const minUsers = typeof opts.minUsers === 'number' && Number.isFinite(opts.minUsers) ? opts.minUsers : RANKING_DEFAULT_FLOOR;
  const { label, format } = metricMeta(frame, metricKey);
  const better = betterOf(frame, metricKey);
  const view: RankingView = { metric: metricKey, label, better, minUsers, rows: [], dropped: [] };
  if (frame.segmentMode !== 'lookup') return view;
  const isBetter = (a: number, b: number) => (better === 'lower' ? a < b : a > b);
  for (const f of frame.funnels) {
    const paths = (f.segments ?? [])
      .filter((seg) => seg.measured && seg.users >= minUsers)
      .map((seg) => funnelSlice(frame, f.id, seg.dims))
      .filter((s) => s.measured);
    if (paths.length === 0) {
      view.dropped.push({ funnelId: f.id, funnelName: f.name, why: 'no-path' });
      continue;
    }
    const valued = paths
      .map((slice) => ({ slice, v: measuredValue(slice.metrics[metricKey]) }))
      .filter((c): c is { slice: FunnelSlice; v: number } => c.v !== null);
    const parents = valued.filter((c) => Object.keys(c.slice.selection).length === 1);
    const kept = valued.filter((c) => {
      const dims = Object.keys(c.slice.selection);
      if (dims.length < 2) return true;
      return !parents.some((p) => {
        const [pk] = Object.keys(p.slice.selection);
        if (c.slice.selection[pk] !== p.slice.selection[pk]) return false;
        const sameUsers = p.slice.users > 0 && c.slice.users >= RANKING_DUP_SHARE * p.slice.users;
        return sameUsers && Math.abs(c.v - p.v) <= RANKING_DUP_VALUE_TOL * Math.abs(p.v);
      });
    });
    if (kept.length === 0) {
      view.dropped.push({ funnelId: f.id, funnelName: f.name, why: 'no-value' });
      continue;
    }
    let best = kept[0];
    for (const c of kept) if (isBetter(c.v, best.v)) best = c;
    const m = best.slice.metrics[metricKey];
    view.rows.push({
      funnelId: f.id,
      funnelName: f.name,
      selection: best.slice.selection,
      users: best.slice.users,
      value: best.v,
      prev: m && m.measured ? finite(m.prev) : null,
      format: m ? m.format : format,
      kn: knOf(frame, best.slice, metricKey),
      lowSample: best.slice.lowSample,
      tone: bandTone(best.v, best.slice.bands[metricKey]),
      total: measuredValue(f.metrics ? f.metrics[metricKey] : undefined),
    });
  }
  // Stable: equal values keep payload order.
  view.rows = view.rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => (a.row.value === b.row.value ? a.i - b.i : isBetter(a.row.value, b.row.value) ? -1 : 1))
    .map((e) => e.row);
  return view;
}

function paymentRow(frame: FunnelFrame, cell: FunnelFramePaymentCell): PaymentRow {
  const declared = frame.paymentReasons ?? [];
  const keys = declared.map((r) => r.key);
  for (const k of Object.keys(cell.reasons)) if (keys.indexOf(k) === -1) keys.push(k);
  const named = keys.filter((k) => typeof cell.reasons[k] === 'number');
  const sum = named.reduce((s, k) => s + cell.reasons[k], 0);
  const threshold = typeof frame.lowSample === 'number' ? frame.lowSample : DEFAULT_LOW_SAMPLE;
  return {
    dims: { ...cell.dims },
    cohort: cell.cohort,
    attempts: cell.attempts,
    declines: cell.declines,
    rate: cell.attempts > 0 ? (cell.declines / cell.attempts) * 100 : null,
    kn: { k: cell.declines, n: cell.attempts },
    reasons: named.map((k) => {
      const meta = declared.find((r) => r.key === k);
      return {
        key: k,
        label: meta ? meta.label : k,
        count: cell.reasons[k],
        share: cell.declines > 0 ? (cell.reasons[k] / cell.declines) * 100 : null,
        note: meta ? meta.note : null,
      };
    }),
    other: Math.max(0, cell.declines - sum),
    clipped: sum > cell.declines,
    lowSample: cell.attempts < threshold,
  };
}

/**
 * The payment page for one funnel and selection: the funnel's own payment,
 * else the set's (scope 'set'). One cohort at a time (never mixed): the asked
 * one when present, else 'all', else the first. `current` is the cell for
 * exactly the selection, `total` the `{}` cell; a total is never a sum.
 */
export function paymentView(frame: FunnelFrame, funnelId: string | null, sel: Selection, cohort?: PaymentCohort | null): PaymentView {
  const f = pickFunnel(frame, funnelId);
  const own = f && f.payment ? f.payment : null;
  const source = own ?? frame.payment ?? null;
  const scope: PaymentView['scope'] = own ? 'funnel' : source ? 'set' : 'none';
  const base: PaymentView = {
    scope,
    measured: false,
    reason: null,
    cohorts: [],
    cohort: cohort ?? 'all',
    current: null,
    total: null,
    byDim: [],
  };
  if (!source) return { ...base, reason: f && f.unmeasured ? f.unmeasured.payment ?? null : null };
  if (!source.measured) return { ...base, reason: source.reason };
  const cohorts: PaymentCohort[] = [];
  for (const c of source.cells) if (cohorts.indexOf(c.cohort) === -1) cohorts.push(c.cohort);
  const chosen: PaymentCohort = cohort && cohorts.indexOf(cohort) !== -1
    ? cohort
    : cohorts.indexOf('all') !== -1 ? 'all' : cohorts[0] ?? 'all';
  const cells = source.cells.filter((c) => c.cohort === chosen);
  const want: Selection = {};
  for (const [k, v] of Object.entries(sel)) if (typeof v === 'string' && v !== '') want[k] = v;
  const exact = cells.find((c) => sameSelection(c.dims, want));
  const totalCell = cells.find((c) => Object.keys(c.dims).length === 0);
  const byDim: PaymentView['byDim'] = [];
  for (const c of cells) {
    const dims = Object.keys(c.dims);
    if (dims.length !== 1) continue;
    let group = byDim.find((g) => g.dim === dims[0]);
    if (!group) {
      group = { dim: dims[0], rows: [] };
      byDim.push(group);
    }
    group.rows.push(paymentRow(frame, c));
  }
  for (const g of byDim) g.rows = g.rows.map((row, i) => ({ row, i })).sort((a, b) => b.row.attempts - a.row.attempts || a.i - b.i).map((e) => e.row);
  return {
    scope,
    measured: true,
    reason: null,
    cohorts,
    cohort: chosen,
    current: exact ? paymentRow(frame, exact) : null,
    total: totalCell ? paymentRow(frame, totalCell) : null,
    byDim,
  };
}

/** The set carries an access ladder with at least one stage and one row. */
export function hasAccess(frame: FunnelFrame): boolean {
  return !!frame.access && frame.access.stages.length > 0 && frame.access.rows.length > 0;
}

/**
 * The access page: rows for this funnel (or for every funnel) whose dims agree
 * with the selection on the dims it names. Each stage as users and share of the
 * row's base (the first stage). Null when the set carries no access: the page
 * is hidden, never drawn with zeros.
 */
export function accessView(frame: FunnelFrame, funnelId: string | null, sel: Selection): AccessView | null {
  if (!hasAccess(frame) || !frame.access) return null;
  const access = frame.access;
  const f = pickFunnel(frame, funnelId);
  const fid = f ? f.id : null;
  const baseKey = access.stages[0].key;
  const rows = access.rows
    .filter((r) => r.funnel === null || r.funnel === fid)
    .filter((r) => Object.keys(r.dims).every((k) => sel[k] === undefined || sel[k] === r.dims[k]))
    .map((r) => {
      const baseRaw = r.counts[baseKey];
      const base = typeof baseRaw === 'number' && Number.isFinite(baseRaw) ? baseRaw : null;
      return {
        funnel: r.funnel,
        dims: { ...r.dims },
        base,
        cells: access.stages.map((st) => {
          const raw = r.counts[st.key];
          const users = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
          return {
            key: st.key,
            label: st.label,
            users,
            ofBase: users !== null && base !== null && base > 0 ? (users / base) * 100 : null,
            kn: users !== null && base !== null ? { k: users, n: base } : null,
          };
        }),
      };
    });
  return { asOf: access.asOf, stages: access.stages.map((s) => ({ ...s })), rows };
}

/** Metric columns no measured row carries a value for: one note, not a column of "not measured" cells. */
export function unmeasuredColumns(rows: readonly SegmentRow[], keys: readonly string[]): string[] {
  const measured = rows.filter((r) => r.measured);
  if (measured.length === 0) return [];
  return keys.filter((k) => measured.every((r) => !r.cells[k] || r.cells[k].v === null));
}

/** How to fill a missing part, as the snapshot says (`hints`), or null. */
export function explorerHint(frame: FunnelFrame, key: string): string | null {
  const h = frame.hints ? frame.hints[key] : undefined;
  return typeof h === 'string' && h !== '' ? h : null;
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
const ONE_FUNNEL_BLOCKS = ['breakdown', 'trend', 'benchmark', 'segments', 'payment'];

/**
 * A funnel's other levels stripped: what a pick list and the unknown-pick note
 * read. Its notes and not-measured reasons stay: the header's trap lines and
 * every "why is this missing" text read them for whichever funnel is picked.
 */
function funnelHead(f: FunnelFrameFunnel): FunnelFrameFunnel {
  const head: FunnelFrameFunnel = { id: f.id, name: f.name, steps: f.steps };
  if (f.notes) head.notes = f.notes;
  if (f.unmeasured) head.unmeasured = f.unmeasured;
  return head;
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
 *
 * The explorer blocks:
 *   - `ranking` always carries every funnel in rates form (it ranks across funnels);
 *   - `payment` carries funnel heads plus the payment, and the set's payment
 *     and reasons (only it does); `access` carries heads plus the set's access
 *     (only it does);
 *   - a `breakdown` with `picker` carries rates and bands (its header shows
 *     the picked funnel's figures).
 * With `ctx.allFunnels` (a card with a funnel picker) and no `funnel` option,
 * every funnel travels in full, by class, so the reader can switch funnels
 * without a request: benchmark, segments (no `by` filter), ranking and a
 * picker breakdown share one rates projection; funnel blocks carry steps only;
 * trend carries the daily series. Notes and not-measured reasons travel on
 * every funnel of every projection, heads included.
 */
export function projectFunnelFrame(
  frame: FunnelFrame,
  blockType: string,
  options: Record<string, unknown> | null | undefined,
  ctx: ProjectContext = {},
): FunnelFrame {
  const pick = options && typeof options.funnel === 'string' ? options.funnel.trim() : '';
  const picked = pick !== '' ? frame.funnels.filter((f) => f.id === pick) : [];
  const all = ctx.allFunnels === true && pick === '';
  const oneFunnel = ONE_FUNNEL_BLOCKS.indexOf(blockType) !== -1;
  const shown = picked.length > 0 ? picked[0] : oneFunnel ? frame.funnels[0] ?? null : null;
  const everyFull = all || blockType === 'ranking';
  const isTrend = blockType === 'trend';
  const isPayment = blockType === 'payment';
  const isAccess = blockType === 'access';
  const pickerBreakdown = blockType === 'breakdown' && !!options && options.picker === true;
  const ratesClass = blockType === 'benchmark' || blockType === 'segments' || blockType === 'ranking' || pickerBreakdown;
  const keepRates = isTrend || ratesClass;
  const keepBands = ratesClass;
  const trendKeys = isTrend ? pickMetricKeys(options) : null;
  // A segments block only ever looks up paths that name its `by` dim (the option, else the first dim);
  // in the all-funnels projection it keeps every path, so it shares the frame with the other rates blocks.
  const dims = frame.dimensions ?? [];
  const byOpt = blockType === 'segments' && options && typeof options.by === 'string' ? options.by.trim() : '';
  const by = blockType !== 'segments' || all ? null : dims.some((d) => d.key === byOpt) ? byOpt : dims[0]?.key ?? null;

  const full = (f: FunnelFrameFunnel): FunnelFrameFunnel => {
    if (isAccess) return funnelHead(f);
    if (isPayment) {
      const head = funnelHead(f);
      if (f.payment) head.payment = f.payment;
      return head;
    }
    const next: FunnelFrameFunnel = { ...f };
    delete next.payment;
    if (!isTrend || !f.daily) delete next.daily;
    else next.daily = trimDaily(f.daily, trendKeys, f.metrics);
    if (!keepRates) delete next.metrics;
    if (!keepBands) delete next.bands;
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
    : frame.funnels.map((f) => (everyFull || shown === null || f === shown ? full(f) : funnelHead(f)));
  const out: FunnelFrame = { ...frame, funnels };
  if (!keepBands) delete out.bands;
  if (!isPayment) {
    delete out.payment;
    delete out.paymentReasons;
  }
  if (!isAccess) delete out.access;
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
