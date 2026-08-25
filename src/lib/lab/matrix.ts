import {
  LabError,
  type MatrixCacheEntry,
  type MatrixDim,
  type MatrixRow,
  type MatrixSet,
  type MatrixSnapshot,
  type MatrixTotal,
  type Series,
} from './types.js';

/**
 * Matrix contract (`matrix/v1`) — validation, caps, snapshots, deltas.
 *
 * A breakdown insight's adapter returns ONE matrix object instead of Series[]:
 * a dimensional snapshot (1-3 dims, one value per dim-coordinate row). This
 * module is the contract's enforcement point: `parseMatrixSet` validates the
 * shape, applies every cap (dims, per-dim value cardinality → top-N + "Other",
 * total rows, total bytes), and reports every truncation as a NOTICE — caps are
 * never silent (doctor re-parses the cache and flags surviving violations).
 * `makeMatrixSnapshot`/`appendMatrixHistory` keep a bounded DATED trail — the
 * breakdown's time axis, since the set itself is a snapshot, not a series.
 *
 * Everything here is pure — no fs, no fetch — so the CLI, the sync engine, the
 * routes, and tests all share one implementation. Mirrors funnel.ts throughout.
 */

export const MATRIX_SET_KIND = 'matrix/v1';

// ─── Caps (structural — enforced, not advised; every hit produces a notice) ──
export const MAX_MATRIX_DIMS = 3;
/** Per dimension: values beyond the top-N (by value) collapse into "Other". */
export const MAX_MATRIX_DIM_VALUES = 8;
/** Total row cap after value collapse; the tail merges into one all-Other row. */
export const MAX_MATRIX_ROWS = 400;
/** Byte cap on the stored matrix JSON. Over-cap after collapsing is rejected. */
export const MAX_MATRIX_BYTES = 200_000;
/** Bounded per-sync snapshot trail — count cap AND byte cap enforced TOGETHER
 *  (2026-07-06 lesson: a count cap alone is not a size cap). */
export const MATRIX_HISTORY_MAX = 60;
export const MATRIX_HISTORY_MAX_BYTES = 1_000_000;
/** Collapsed-value label for over-cap dimension values / merged tail rows. */
export const MATRIX_OTHER_VALUE = 'Other';
/** Rows with n below this render de-emphasized ("low sample") — funnel F4 idiom. */
export const MATRIX_LOW_SAMPLE_THRESHOLD = 30;

export interface ParsedMatrixSet {
  set: MatrixSet;
  /** Human-readable cap/coercion notices — surface them, never swallow. */
  notices: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toFiniteOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseDim(raw: unknown): MatrixDim | null {
  if (typeof raw === 'string') {
    const key = raw.trim();
    return key ? { key } : null;
  }
  if (!isRecord(raw)) return null;
  const key = typeof raw.key === 'string' ? raw.key.trim() : '';
  if (!key) return null;
  const dim: MatrixDim = { key };
  if (typeof raw.label === 'string' && raw.label.trim()) dim.label = raw.label.trim();
  return dim;
}

function parseTotal(raw: unknown): MatrixTotal | undefined {
  if (!isRecord(raw)) {
    const v = toFiniteOrNull(raw);
    return v === null ? undefined : { v };
  }
  const total: MatrixTotal = { v: toFiniteOrNull(raw.v) };
  if ('n' in raw) total.n = toFiniteOrNull(raw.n);
  if ('prev' in raw) total.prev = toFiniteOrNull(raw.prev);
  return total;
}

function parseRow(raw: unknown, dims: MatrixDim[], notices: string[], index: number): MatrixRow | null {
  if (!isRecord(raw) || !isRecord(raw.d)) {
    notices.push(`rows[${index}] has no \`d\` dimension record — skipped.`);
    return null;
  }
  const d: Record<string, string> = {};
  for (const dim of dims) {
    const v = raw.d[dim.key];
    // A row missing a declared dim coordinate is still a real observation —
    // bucket it honestly rather than dropping the value.
    d[dim.key] = v === undefined || v === null || String(v).trim() === '' ? 'Unknown' : String(v);
  }
  const row: MatrixRow = { d, v: toFiniteOrNull(raw.v) };
  if ('n' in raw) row.n = toFiniteOrNull(raw.n);
  if ('prev' in raw) row.prev = toFiniteOrNull(raw.prev);
  return row;
}

/** Merge rows that share identical dim coordinates (sums v/n; prev sums only
 *  when every merged row carries one — a partial prev sum would fake a delta). */
function mergeRows(rows: MatrixRow[]): MatrixRow[] {
  const byDims = new Map<string, MatrixRow[]>();
  for (const row of rows) {
    const key = Object.keys(row.d).sort().map((k) => `${k}=${row.d[k]}`).join('|');
    const bucket = byDims.get(key);
    if (bucket) bucket.push(row);
    else byDims.set(key, [row]);
  }
  const out: MatrixRow[] = [];
  for (const bucket of byDims.values()) {
    if (bucket.length === 1) {
      out.push(bucket[0]);
      continue;
    }
    const vs = bucket.map((r) => r.v).filter((v): v is number => v !== null);
    const ns = bucket.map((r) => r.n).filter((n): n is number => n !== null && n !== undefined);
    const merged: MatrixRow = {
      d: { ...bucket[0].d },
      v: vs.length > 0 ? vs.reduce((a, b) => a + b, 0) : null,
    };
    if (ns.length > 0) merged.n = ns.reduce((a, b) => a + b, 0);
    if (bucket.every((r) => r.prev !== undefined && r.prev !== null)) {
      merged.prev = bucket.reduce((a, r) => a + (r.prev as number), 0);
    }
    out.push(merged);
  }
  return out;
}

/** Collapse over-cap dimension values to "Other", then the over-cap row tail
 *  into one all-Other row — same shape capSegments has in funnel.ts. */
function capRows(rows: MatrixRow[], dims: MatrixDim[], notices: string[]): MatrixRow[] {
  let out = rows;

  for (const dim of dims) {
    const valueWeight = new Map<string, number>();
    for (const row of out) {
      const v = row.d[dim.key];
      valueWeight.set(v, (valueWeight.get(v) ?? 0) + (row.v ?? 0));
    }
    if (valueWeight.size <= MAX_MATRIX_DIM_VALUES) continue;
    const kept = new Set(
      [...valueWeight.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_MATRIX_DIM_VALUES).map(([v]) => v),
    );
    const collapsed = valueWeight.size - kept.size;
    out = mergeRows(out.map((row) =>
      kept.has(row.d[dim.key]) ? row : { ...row, d: { ...row.d, [dim.key]: MATRIX_OTHER_VALUE } },
    ));
    notices.push(`dimension "${dim.key}" had ${valueWeight.size} values — kept top ${MAX_MATRIX_DIM_VALUES}, collapsed ${collapsed} into "${MATRIX_OTHER_VALUE}".`);
  }

  if (out.length > MAX_MATRIX_ROWS) {
    const sorted = [...out].sort((a, b) => (b.v ?? 0) - (a.v ?? 0));
    const kept = sorted.slice(0, MAX_MATRIX_ROWS - 1);
    const tail = sorted.slice(MAX_MATRIX_ROWS - 1);
    const otherDims: Record<string, string> = {};
    for (const dim of dims) otherDims[dim.key] = MATRIX_OTHER_VALUE;
    notices.push(`${out.length} rows — kept top ${MAX_MATRIX_ROWS - 1}, merged ${tail.length} into "${MATRIX_OTHER_VALUE}".`);
    // One final merge so a kept all-Other row and the merged tail can't coexist.
    out = mergeRows([...kept, ...tail.map((row) => ({ ...row, d: otherDims }))]);
  }

  return out;
}

/**
 * Validate + cap a raw matrix payload. Throws `LabError` only when the payload
 * is fundamentally not a matrix (wrong kind, no usable dims, rows not an array,
 * or irrecoverably over the byte cap); individual malformed rows degrade to
 * notices, mirroring the store's lenient-read philosophy.
 */
export function parseMatrixSet(raw: unknown): ParsedMatrixSet {
  if (!isRecord(raw) || raw.kind !== MATRIX_SET_KIND) {
    throw new LabError(`Matrix payload must be an object with kind "${MATRIX_SET_KIND}".`);
  }
  if (!Array.isArray(raw.rows)) {
    throw new LabError('Matrix payload must have a `rows` array.');
  }

  const notices: string[] = [];

  const dims: MatrixDim[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw.dims)) {
    for (const d of raw.dims) {
      const dim = parseDim(d);
      if (!dim || seen.has(dim.key)) continue;
      seen.add(dim.key);
      dims.push(dim);
    }
  }
  if (dims.length === 0) {
    throw new LabError('Matrix payload must declare 1-3 `dims` (e.g. [{ key: "funnel" }, { key: "language" }]).');
  }
  if (dims.length > MAX_MATRIX_DIMS) {
    notices.push(`${dims.length} dimensions declared — kept the first ${MAX_MATRIX_DIMS}.`);
    dims.length = MAX_MATRIX_DIMS;
  }

  const rows: MatrixRow[] = [];
  for (let i = 0; i < raw.rows.length; i++) {
    const row = parseRow(raw.rows[i], dims, notices, i);
    if (row) rows.push(row);
  }
  const merged = mergeRows(rows);
  if (merged.length < rows.length) {
    notices.push(`${rows.length - merged.length} row(s) shared identical dim coordinates — merged (values summed).`);
  }

  const set: MatrixSet = { kind: MATRIX_SET_KIND, dims, rows: capRows(merged, dims, notices) };
  const total = parseTotal(raw.total);
  if (total) set.total = total;
  if (typeof raw.unit === 'string' && raw.unit.trim()) set.unit = raw.unit.trim();

  if (JSON.stringify(set).length > MAX_MATRIX_BYTES) {
    throw new LabError(`Matrix payload exceeds the ${MAX_MATRIX_BYTES}-byte cap even after value collapse — return fewer rows/dims (Lab stores insights, not raw dumps).`);
  }

  return { set, notices };
}

// ─── Series synthesis + latest (backward compat with every series consumer) ──

/** Prettified dim label (shared by CLI + dashboard rendering). */
export function dimLabel(dim: MatrixDim): string {
  return dim.label ?? dim.key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Synthesize legacy `Series[]` from matrix rows — dims[0] values become series,
 *  dims[1] values become points (t = the dim value, funnel precedent: t need not
 *  be a date). A 1-dim matrix becomes one series with a point per value. Keeps
 *  NumberCard/snapshot/raw-fallback consumers working. */
export function matrixToSeries(set: MatrixSet): Series[] {
  const [dim1, dim2] = set.dims;
  if (!dim2) {
    return [{
      name: dimLabel(dim1),
      points: set.rows.map((r) => ({ t: r.d[dim1.key], v: r.v ?? 0 })),
    }];
  }
  const byFirst = new Map<string, { t: string; v: number }[]>();
  for (const row of set.rows) {
    const name = row.d[dim1.key];
    const points = byFirst.get(name) ?? [];
    if (points.length === 0) byFirst.set(name, points);
    // Sum over any remaining dims so the synthesized point is one per dim2 value.
    const existing = points.find((p) => p.t === row.d[dim2.key]);
    if (existing) existing.v += row.v ?? 0;
    else points.push({ t: row.d[dim2.key], v: row.v ?? 0 });
  }
  return [...byFirst.entries()].map(([name, points]) => ({ name, points }));
}

/** The card/binding `latest` for a matrix: the grand total's value — finite or
 *  null, NEVER NaN/Infinity (a non-finite latest must not reach a KR binding). */
export function matrixLatest(set: MatrixSet): number | null {
  const v = set.total?.v;
  return v !== null && v !== undefined && Number.isFinite(v) ? v : null;
}

// ─── History snapshots (the breakdown's time axis) ──────────────────────────

/** Compact snapshot of one sync (dim coordinates + value + n only — no prev). */
export function makeMatrixSnapshot(
  set: MatrixSet,
  range: { fromISO: string; toISO: string },
  at: string,
): MatrixSnapshot {
  const snapshot: MatrixSnapshot = {
    at,
    range,
    dims: set.dims,
    rows: set.rows.map((r) => {
      const row: MatrixSnapshot['rows'][number] = { d: r.d, v: r.v };
      if (r.n !== undefined && r.n !== null) row.n = r.n;
      return row;
    }),
  };
  if (set.total) {
    snapshot.total = { v: set.total.v };
    if (set.total.n !== undefined && set.total.n !== null) snapshot.total.n = set.total.n;
  }
  return snapshot;
}

/** Append one snapshot, enforcing the count cap AND the byte cap together —
 *  oldest snapshots drop first. Tolerates a malformed prior trail (non-array),
 *  mirroring appendHistory in sync.ts. The newest snapshot always survives. */
export function appendMatrixHistory(
  prior: MatrixSnapshot[] | undefined,
  snapshot: MatrixSnapshot,
): MatrixSnapshot[] {
  const priorTrail = Array.isArray(prior) ? prior : [];
  let trail = [...priorTrail, snapshot];
  if (trail.length > MATRIX_HISTORY_MAX) trail = trail.slice(trail.length - MATRIX_HISTORY_MAX);
  while (trail.length > 1 && JSON.stringify(trail).length > MATRIX_HISTORY_MAX_BYTES) {
    trail = trail.slice(1);
  }
  return trail;
}

/** The newest snapshot taken at or before the END of the given calendar date
 *  (YYYY-MM-DD, inclusive), or null — the reports layer's "as of" resolution.
 *  Honest by construction: never interpolates, never reaches forward in time. */
export function snapshotAsOf(
  history: MatrixSnapshot[] | undefined,
  date: string,
): MatrixSnapshot | null {
  if (!Array.isArray(history) || history.length === 0) return null;
  const cutoff = Date.parse(`${date}T23:59:59.999Z`);
  if (!Number.isFinite(cutoff)) return null;
  let best: MatrixSnapshot | null = null;
  for (const snap of history) {
    const at = snap ? Date.parse(snap.at) : NaN;
    if (!Number.isFinite(at) || at > cutoff) continue;
    if (!best || at > Date.parse(best.at)) best = snap;
  }
  return best;
}

/** The previous snapshot for Δ derivation: the newest history entry strictly
 *  OLDER than the current entry's sync (equal-window guard: its range must span
 *  within ±25% of the current one, the funnel idiom — comparing a 7-day window
 *  to a 90-day one fakes a trend). Adapter-provided `prev` on a row wins. */
export function pickPreviousMatrixSnapshot(
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

const DAY_MS = 86_400_000;

function rangeSpanDays(range: { fromISO: string; toISO: string }): number | null {
  const from = Date.parse(`${range.fromISO}T00:00:00Z`);
  const to = Date.parse(`${range.toISO}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return Math.round((to - from) / DAY_MS);
}

// ─── Pivot math (shared by CLI `lab show` and tests; the dashboard mirrors it) ──

/** Distinct values of one dim, ordered by total value weight (descending),
 *  with "Other"/"Unknown" always last — the stable pivot axis order. */
export function dimValues(set: MatrixSet, dimKey: string): string[] {
  const weight = new Map<string, number>();
  for (const row of set.rows) {
    const v = row.d[dimKey];
    if (v === undefined) continue;
    weight.set(v, (weight.get(v) ?? 0) + (row.v ?? 0));
  }
  const tail = (v: string): number => (v === MATRIX_OTHER_VALUE ? 2 : v === 'Unknown' ? 1 : 0);
  return [...weight.entries()]
    .sort((a, b) => tail(a[0]) - tail(b[0]) || b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([v]) => v);
}

/** One pivot cell: rows matching the coordinates, values/n summed. Null when no
 *  row matches (an honest hole, not a zero). */
export interface PivotCell {
  v: number | null;
  n: number | null;
}

/** Sum the rows matching a partial dim-coordinate filter into one cell. */
export function pivotCell(set: MatrixSet, coords: Record<string, string>): PivotCell {
  let v: number | null = null;
  let n: number | null = null;
  for (const row of set.rows) {
    let match = true;
    for (const [key, value] of Object.entries(coords)) {
      if (row.d[key] !== value) { match = false; break; }
    }
    if (!match) continue;
    if (row.v !== null) v = (v ?? 0) + row.v;
    if (row.n !== undefined && row.n !== null) n = (n ?? 0) + row.n;
  }
  return { v, n };
}
