/**
 * Board frames and the ONE pipeline that shapes them for a block.
 *
 * A FRAME is what a data-bound block draws: the resolved slice of one insight's
 * cache (`frames.ts` builds them from the hardened readers). The server returns
 * frames UN-limited; every static option (`where`, `sort`, `limit`, series
 * pick) and the interactive `filter` block run HERE, in this fixed order:
 *
 *   where -> interactive filter -> sort -> limit
 *
 * and a table's `total` is computed after filtering, before the limit, so a
 * filtered board never shows the total of a pre-cut list. `lab board show` and
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

export interface FunnelFrameStep {
  key: string;
  label: string;
  users: number;
}

export interface FunnelFrame {
  kind: 'funnel';
  insight: string;
  funnels: Array<{ id: string; name: string; steps: FunnelFrameStep[] }>;
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
}

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

/** LENIENT sort parse: `"-v"` (desc), `"label"` (asc) or `{by, dir}`. */
export function parseSort(v: unknown): FrameSort | null {
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s || s === '-') return null;
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

/**
 * Shape a frame for one block. Tables: where -> filter -> sort -> limit, with
 * `total` recomputed after the filter and before the limit. Series: pick, then
 * keep the last `limit` points. Other kinds pass through untouched.
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
    if (typeof ops.limit === 'number' && ops.limit >= 1) rows = rows.slice(0, Math.floor(ops.limit));
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
      series = series.map((s) => ({ name: s.name, points: s.points.slice(-keep) }));
    }
    return { ...frame, series };
  }
  return frame;
}
