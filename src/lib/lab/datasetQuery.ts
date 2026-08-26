import {
  type DatasetBundle,
  type DatasetSnapshot,
  type InsightCache,
} from './types.js';
import { findDataset, seriesToDatasetBundle } from './dataset.js';

/**
 * Dataset query + as-of resolution — the read path `lab query` and the
 * dashboard bridge's `lab.data()` share, over a cached `dataset/v1` bundle
 * (or one synthesized from legacy `Series[]`, see `seriesToDatasetBundle`).
 * Cache-only: nothing here fetches or mutates.
 *
 * Everything is pure — no fs, no fetch, no DOM — so the CLI and any future
 * bridge/route consumer share one implementation. Mirrors dataset.ts/
 * matrix.ts in spirit: caps degrade to notices, never a silent drop.
 */

export interface DatasetQuery {
  /** Dataset key (default: `findDataset`'s resolution — bundle.primary, else
   *  the first dataset). A named key that isn't in the bundle is an honest
   *  miss (empty result + notice), never a silent fallback to another one. */
  dataset?: string | null;
  /** Exact-match filter: dim key -> value. A key not declared on the
   *  resolved dataset is NOTICED and ignored, never silently dropped. */
  where?: Record<string, string>;
  /** Collapse to one row per value of this dim, summing v/n (prev only when
   *  every collapsed row carries one — a partial sum would fake a delta). */
  groupBy?: string | null;
  /** Keep only the highest-`v` N rows (after filter/group-by). */
  top?: number | null;
}

export interface DatasetQueryResultRow {
  d: Record<string, string>;
  v: number | null;
  n: number | null;
  prev: number | null;
}

export interface DatasetQueryResult {
  /** The resolved dataset's key (echoes the requested key on a miss, or ''
   *  when the bundle itself has no datasets). */
  dataset: string;
  label: string | null;
  unit: string | null;
  /** Dim keys the rows are coordinated by — one when `groupBy` applied,
   *  else every dim the dataset declares. */
  dims: string[];
  rows: DatasetQueryResultRow[];
  total: { v: number | null; n: number | null } | null;
  /** Cap/coercion/miss notices — surfaced, never swallowed. */
  notices: string[];
}

/** Sum rows sharing one dim's value into a single row per distinct value —
 *  same aggregation rule matrix.ts's row-merge uses (prev only when every
 *  bucket member has one). */
function groupRows(rows: DatasetQueryResultRow[], key: string): DatasetQueryResultRow[] {
  const buckets = new Map<string, DatasetQueryResultRow[]>();
  for (const row of rows) {
    const value = row.d[key] ?? '';
    const bucket = buckets.get(value);
    if (bucket) bucket.push(row);
    else buckets.set(value, [row]);
  }
  return [...buckets.entries()].map(([value, bucket]) => {
    const vs = bucket.map((r) => r.v).filter((v): v is number => v !== null);
    const ns = bucket.map((r) => r.n).filter((n): n is number => n !== null);
    const v = vs.length > 0 ? vs.reduce((a, b) => a + b, 0) : null;
    const n = ns.length > 0 ? ns.reduce((a, b) => a + b, 0) : null;
    const prev = bucket.every((r) => r.prev !== null) ? bucket.reduce((a, r) => a + (r.prev as number), 0) : null;
    return { d: { [key]: value }, v, n, prev };
  });
}

/**
 * Slice/aggregate one dataset out of a bundle. Every rejected input (unknown
 * dataset key, unknown `where`/`groupBy` dim, invalid `top`) degrades to a
 * `notices` entry and the rest of the query still runs on what's left —
 * never a silent no-op, and never a throw for a cache-only read.
 */
export function queryDataset(bundle: DatasetBundle, query: DatasetQuery): DatasetQueryResult {
  const notices: string[] = [];
  const requestedKey = query.dataset ?? null;
  const dataset = findDataset(bundle, requestedKey);
  if (!dataset) {
    const available = bundle.datasets.map((d) => d.key).join(', ') || '(none)';
    notices.push(requestedKey
      ? `dataset "${requestedKey}" not found — available: ${available}.`
      : 'bundle has no datasets.');
    return { dataset: requestedKey ?? '', label: null, unit: null, dims: [], rows: [], total: null, notices };
  }

  const dimKeys = new Set(dataset.dims.map((d) => d.key));

  // ── where filter — honest about unknown dims, never a silent ignore. ──
  const activeWhere: Record<string, string> = {};
  for (const [key, value] of Object.entries(query.where ?? {})) {
    if (!dimKeys.has(key)) {
      notices.push(`unknown dim "${key}" in --where — ignored (dataset "${dataset.key}" has: ${[...dimKeys].join(', ')}).`);
      continue;
    }
    activeWhere[key] = value;
  }
  let rows: DatasetQueryResultRow[] = dataset.rows
    .filter((r) => Object.entries(activeWhere).every(([key, value]) => r.d[key] === value))
    .map((r) => ({ d: r.d, v: r.v, n: r.n ?? null, prev: r.prev ?? null }));

  // ── group-by — collapse to one row per value of ONE declared dim. ──
  let dims = dataset.dims.map((d) => d.key);
  const groupBy = query.groupBy ?? null;
  if (groupBy !== null) {
    if (!dimKeys.has(groupBy)) {
      notices.push(`unknown dim "${groupBy}" in --group-by — ignored (dataset "${dataset.key}" has: ${[...dimKeys].join(', ')}).`);
    } else {
      rows = groupRows(rows, groupBy);
      dims = [groupBy];
    }
  }

  // ── top — keep the highest-value N rows; an invalid value is noticed. ──
  if (query.top !== undefined && query.top !== null) {
    if (!Number.isFinite(query.top) || query.top <= 0) {
      notices.push(`--top must be a positive number (got ${query.top}) — ignored.`);
    } else {
      const n = Math.floor(query.top);
      rows = [...rows].sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity)).slice(0, n);
    }
  }

  return {
    dataset: dataset.key,
    label: dataset.label ?? null,
    unit: dataset.unit ?? null,
    dims,
    rows,
    total: dataset.total ? { v: dataset.total.v, n: dataset.total.n ?? null } : null,
    notices,
  };
}

// ─── As-of resolution (the reports "as of" rule, over dataset bundles) ──────

export interface DatasetAsOf {
  bundle: DatasetBundle;
  /** ISO timestamp of the sync this bundle was taken at. */
  at: string;
}

/** The newest dataset-bundle snapshot at/before the END of `date`
 *  (YYYY-MM-DD, inclusive) — reimplemented locally rather than imported
 *  because matrix.ts's `snapshotAsOf` is typed to `MatrixSnapshot[]`, not
 *  `DatasetSnapshot[]`; the algorithm is IDENTICAL to reports-store.ts's
 *  as-of rule: cutoff = end of that calendar date, latest `at` <= cutoff
 *  wins, never a reach-forward, never an interpolation. */
function datasetSnapshotAsOf(history: DatasetSnapshot[] | undefined, date: string): DatasetSnapshot | null {
  if (!Array.isArray(history) || history.length === 0) return null;
  const cutoff = Date.parse(`${date}T23:59:59.999Z`);
  if (!Number.isFinite(cutoff)) return null;
  let best: DatasetSnapshot | null = null;
  for (const snap of history) {
    const at = snap ? Date.parse(snap.at) : NaN;
    if (!Number.isFinite(at) || at > cutoff) continue;
    if (!best || at > Date.parse(best.at)) best = snap;
  }
  return best;
}

/**
 * Resolve the dataset bundle to show for an insight: live (`dateISO ===
 * null`) or as-of a calendar date.
 *
 * LIVE prefers `cache.datasets`; when the insight has no `dataset/v1`
 * payload it falls back to a bundle synthesized from `cache.series` (the
 * same read-side convenience `lab.data()` gets over a legacy cache) — a
 * bare `[]` series cache resolves to `null` (nothing to show).
 *
 * DATED queries look ONLY at `cache.datasetHistory` — a legacy series-only
 * insight has no snapshot trail to walk, so a dated query on one is an
 * honest `null`, never a synthesized-from-live substitute (that would be
 * exactly the interpolation this rule exists to forbid).
 */
export function resolveDatasetAsOf(cache: InsightCache, dateISO: string | null): DatasetAsOf | null {
  if (dateISO === null) {
    if (cache.datasets) return { bundle: cache.datasets.bundle, at: cache.fetchedAt || '' };
    if (cache.series.length > 0) return { bundle: seriesToDatasetBundle(cache.series), at: cache.fetchedAt || '' };
    return null;
  }
  const snap = datasetSnapshotAsOf(cache.datasetHistory, dateISO);
  return snap ? { bundle: snap.bundle, at: snap.at } : null;
}
