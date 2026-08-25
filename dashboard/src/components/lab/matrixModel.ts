/**
 * Matrix (`matrix/v1`) client model — types mirroring the backend contract
 * (src/lib/lab/matrix.ts) plus every PURE view computation the breakdown render
 * needs: pivot axis ordering, cell aggregation, heat scaling, low-sample checks,
 * Δ-vs-previous-snapshot lookup (equal-window guard), and copy-as-Markdown.
 *
 * No React, no fetch — keep this importable from any component and from
 * tests/unit/lab-breakdown-model.test.ts.
 */

// ─── Types (mirror src/lib/lab/types.ts — the API returns these shapes) ─────

export interface MatrixDim {
  key: string;
  label?: string;
}

export interface MatrixRow {
  d: Record<string, string>;
  v: number | null;
  n?: number | null;
  prev?: number | null;
}

export interface MatrixTotal {
  v: number | null;
  n?: number | null;
  prev?: number | null;
}

export interface MatrixSet {
  kind: 'matrix/v1';
  dims: MatrixDim[];
  rows: MatrixRow[];
  total?: MatrixTotal;
  unit?: string;
}

export interface MatrixCacheEntry {
  set: MatrixSet;
  notices: string[];
  range: { fromISO: string; toISO: string };
}

export interface MatrixSnapshot {
  at: string;
  range: { fromISO: string; toISO: string };
  /** The set's dims at snapshot time (absent on pre-dims snapshots). */
  dims?: MatrixDim[];
  rows: { d: Record<string, string>; v: number | null; n?: number | null }[];
  total?: { v: number | null; n?: number | null };
}

/** Rebuild a renderable MatrixSet from a dated snapshot — dims from the
 *  snapshot when carried, else derived from the first row's coordinate keys. */
export function snapshotToSet(snapshot: MatrixSnapshot): MatrixSet {
  const dims = snapshot.dims && snapshot.dims.length > 0
    ? snapshot.dims
    : Object.keys(snapshot.rows[0]?.d ?? {}).map((key) => ({ key }));
  const set: MatrixSet = { kind: 'matrix/v1', dims, rows: snapshot.rows };
  if (snapshot.total) set.total = { v: snapshot.total.v, n: snapshot.total.n ?? null };
  return set;
}

/** Mirrors MATRIX_LOW_SAMPLE_THRESHOLD (src/lib/lab/matrix.ts) — funnel F4 idiom. */
export const LOW_SAMPLE_THRESHOLD = 30;
/** Collapsed-value label the engine writes for over-cap dim values. */
export const OTHER_VALUE = 'Other';

// ─── Pivot math (mirrors dimValues/pivotCell in src/lib/lab/matrix.ts) ──────

/** Prettified dim label. */
export function dimLabel(dim: MatrixDim): string {
  return dim.label ?? dim.key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Distinct values of one dim, ordered by total value weight (descending),
 *  with "Other"/"Unknown" always last — the stable pivot axis order. */
export function dimValues(set: MatrixSet, dimKey: string): string[] {
  const weight = new Map<string, number>();
  for (const row of set.rows) {
    const v = row.d[dimKey];
    if (v === undefined) continue;
    weight.set(v, (weight.get(v) ?? 0) + (row.v ?? 0));
  }
  const tail = (v: string): number => (v === OTHER_VALUE ? 2 : v === 'Unknown' ? 1 : 0);
  return [...weight.entries()]
    .sort((a, b) => tail(a[0]) - tail(b[0]) || b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([v]) => v);
}

export interface PivotCell {
  v: number | null;
  n: number | null;
  /** Adapter-provided previous value, summed — only when EVERY matched row has one. */
  prev: number | null;
}

/** Sum the rows matching a partial dim-coordinate filter into one cell.
 *  `v: null` = no matching row — an honest hole, not a zero. */
export function pivotCell(set: MatrixSet, coords: Record<string, string>): PivotCell {
  let v: number | null = null;
  let n: number | null = null;
  let prev: number | null = null;
  let prevComplete = true;
  let matched = 0;
  for (const row of set.rows) {
    let match = true;
    for (const [key, value] of Object.entries(coords)) {
      if (row.d[key] !== value) { match = false; break; }
    }
    if (!match) continue;
    matched += 1;
    if (row.v !== null) v = (v ?? 0) + row.v;
    if (row.n !== undefined && row.n !== null) n = (n ?? 0) + row.n;
    if (row.prev !== undefined && row.prev !== null) prev = (prev ?? 0) + row.prev;
    else prevComplete = false;
  }
  return { v, n, prev: matched > 0 && prevComplete ? prev : null };
}

/** Is this cell's sample too small to trust its rate/value? (funnel F4 idiom) */
export function isLowSample(cell: { n: number | null }): boolean {
  return cell.n !== null && cell.n < LOW_SAMPLE_THRESHOLD;
}

/** 0..1 heat intensity of a value against the visible max (0 for null/≤0/no max). */
export function heatFrac(v: number | null, max: number): number {
  if (v === null || v <= 0 || max <= 0) return 0;
  return Math.min(1, v / max);
}

// ─── Δ vs the previous snapshot (equal-window guard, funnel idiom) ──────────

const DAY_MS = 86_400_000;

function rangeSpanDays(range: { fromISO: string; toISO: string }): number | null {
  const from = Date.parse(`${range.fromISO}T00:00:00Z`);
  const to = Date.parse(`${range.toISO}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return Math.round((to - from) / DAY_MS);
}

/** The newest history snapshot strictly OLDER than the current sync whose window
 *  spans within ±25% of the current one — comparing a 7-day window to a 90-day
 *  one fakes a trend. Null = no comparable previous period; show no Δ. */
export function pickPreviousSnapshot(
  current: { at: string; range: { fromISO: string; toISO: string } },
  history: MatrixSnapshot[] | undefined,
): MatrixSnapshot | null {
  if (!Array.isArray(history) || history.length === 0) return null;
  const currentAt = Date.parse(current.at);
  const span = rangeSpanDays(current.range);
  if (!Number.isFinite(currentAt) || span === null) return null;
  let best: MatrixSnapshot | null = null;
  for (const snap of history) {
    const at = snap ? Date.parse(snap.at) : NaN;
    if (!Number.isFinite(at) || at >= currentAt) continue;
    const snapSpan = snap.range ? rangeSpanDays(snap.range) : null;
    if (snapSpan === null || Math.abs(snapSpan - span) > Math.max(1, span * 0.25)) continue;
    if (!best || at > Date.parse(best.at)) best = snap;
  }
  return best;
}

/** Previous value for a cell's coordinates from a history snapshot (summed over
 *  matching rows, null when none match). */
export function snapshotCell(
  snapshot: MatrixSnapshot | null,
  coords: Record<string, string>,
): number | null {
  if (!snapshot) return null;
  let v: number | null = null;
  for (const row of snapshot.rows) {
    let match = true;
    for (const [key, value] of Object.entries(coords)) {
      if (row.d[key] !== value) { match = false; break; }
    }
    if (!match) continue;
    if (row.v !== null) v = (v ?? 0) + row.v;
  }
  return v;
}

/** A cell's Δ source: the adapter's own `prev` wins; else the guarded history
 *  snapshot; null = honestly unknown. */
export function cellPrev(
  cell: PivotCell,
  snapshot: MatrixSnapshot | null,
  coords: Record<string, string>,
): number | null {
  if (cell.prev !== null) return cell.prev;
  return snapshotCell(snapshot, coords);
}

// ─── Copy as Markdown ────────────────────────────────────────────────────────

function fmtCell(v: number | null): string {
  return v === null ? '—' : v.toLocaleString('en-US');
}

/** The visible pivot as a GitHub-flavored Markdown table (2-dim), or a label →
 *  value list (1-dim). `filter` narrows a 3-dim set the way the chips do. */
export function pivotToMarkdown(
  set: MatrixSet,
  opts: { rowDim: string; colDim?: string; filter?: Record<string, string>; title?: string } ,
): string {
  const filter = opts.filter ?? {};
  const lines: string[] = [];
  if (opts.title) lines.push(`## ${opts.title}`, '');
  const filterBits = Object.entries(filter).map(([k, v]) => `${k}=${v}`);
  if (filterBits.length > 0) lines.push(`_Filter: ${filterBits.join(', ')}_`, '');

  const rowValues = dimValues(set, opts.rowDim);
  const colDim = opts.colDim;
  if (!colDim) {
    const rowDim = set.dims.find((d) => d.key === opts.rowDim);
    lines.push(`| ${rowDim ? dimLabel(rowDim) : opts.rowDim} | Value |`);
    lines.push('| --- | ---: |');
    for (const value of rowValues) {
      const cell = pivotCell(set, { ...filter, [opts.rowDim]: value });
      lines.push(`| ${value} | ${fmtCell(cell.v)} |`);
    }
  } else {
    const colValues = dimValues(set, colDim);
    lines.push(`| | ${colValues.join(' | ')} |`);
    lines.push(`| --- |${colValues.map(() => ' ---: |').join('')}`);
    for (const rowValue of rowValues) {
      const cells = colValues.map((colValue) =>
        fmtCell(pivotCell(set, { ...filter, [opts.rowDim]: rowValue, [colDim]: colValue }).v));
      lines.push(`| ${rowValue} | ${cells.join(' | ')} |`);
    }
  }
  if (set.total && set.total.v !== null) {
    lines.push('', `**Total:** ${fmtCell(set.total.v)}${set.unit ? ` ${set.unit}` : ''}`);
  }
  return lines.join('\n');
}
