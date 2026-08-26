import {
  LabError,
  type Dataset,
  type DatasetBundle,
  type DatasetSnapshot,
  type MatrixRow,
  type Series,
} from './types.js';
import { MATRIX_SET_KIND, MAX_MATRIX_BYTES, matrixLatest, matrixToSeries, parseMatrixSet } from './matrix.js';

/**
 * Dataset-bundle contract (`dataset/v1`) — validation, caps, lookup,
 * snapshots. The plural successor to `matrix/v1`: N named tables instead of
 * one, so a multi-page app can give each page (or `lab.data(key)` / `lab
 * query --dataset`) its own dimensional dataset.
 *
 * Each dataset carries the SAME grammar as a matrix/v1 set (dims/rows/total)
 * — `parseDataset` DELEGATES each one to `parseMatrixSet` (matrix.ts) rather
 * than re-implementing the dimensional contract, so there is exactly one
 * dimensional grammar and one cap set behind both the singular
 * (matrix/v1, grandfathered) and plural (dataset/v1) authoring shapes.
 *
 * BYTE BUDGET (deliberate, not a copy-paste bug): the whole bundle reuses
 * `MAX_MATRIX_BYTES` (200_000) as its OWN cap, on top of each dataset being
 * separately capped at that same figure inside `parseMatrixSet`. The
 * per-dataset cap stops one runaway dataset; the bundle cap is the TOTAL
 * response budget — reusing the single-set figure means an app of
 * `MAX_DATASETS` datasets costs a reader no more bytes than one old
 * matrix/v1 insight did, instead of multiplying the budget by 12.
 *
 * Everything here is pure — no fs, no fetch, no DOM — so the CLI, the sync
 * engine, the routes, and tests all share one implementation. Mirrors
 * matrix.ts throughout.
 */

export const DATASET_BUNDLE_KIND = 'dataset/v1';

export const MAX_DATASETS = 12;
/** Bounded per-sync snapshot trail — count cap AND byte cap enforced TOGETHER
 *  (the same 2026-07-06 lesson matrixHistory carries: a count cap alone is
 *  not a size cap). */
export const DATASET_HISTORY_MAX = 60;
export const DATASET_HISTORY_MAX_BYTES = 1_000_000;

export interface ParsedDatasetBundle {
  bundle: DatasetBundle;
  /** Human-readable cap/coercion notices — surface them, never swallow. */
  notices: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate one dataset by delegating its dims/rows/total to `parseMatrixSet`
 *  — a dataset IS a matrix/v1 row set, just named and one of several. */
function parseDataset(raw: unknown, index: number, notices: string[]): Dataset {
  if (!isRecord(raw)) {
    throw new LabError(`Dataset bundle datasets[${index}] must be an object with { key, dims, rows }.`);
  }
  const key = typeof raw.key === 'string' ? raw.key.trim() : '';
  if (!key) {
    throw new LabError(`Dataset bundle datasets[${index}] has no \`key\`.`);
  }

  let parsed;
  try {
    parsed = parseMatrixSet({
      kind: MATRIX_SET_KIND,
      dims: raw.dims,
      rows: raw.rows,
      total: raw.total,
      unit: raw.unit,
    });
  } catch (err) {
    const msg = err instanceof LabError ? err.message : String(err);
    throw new LabError(`Dataset bundle datasets[${index}] ("${key}"): ${msg}`);
  }
  for (const notice of parsed.notices) notices.push(`dataset "${key}": ${notice}`);

  const dataset: Dataset = { key, dims: parsed.set.dims, rows: parsed.set.rows };
  if (typeof raw.label === 'string' && raw.label.trim()) dataset.label = raw.label.trim();
  if (parsed.set.unit !== undefined) dataset.unit = parsed.set.unit;
  if (parsed.set.total) dataset.total = parsed.set.total;
  return dataset;
}

/**
 * Validate + cap a raw dataset bundle. Throws `LabError` when the bundle is
 * fundamentally not one (wrong kind, no usable datasets, over the dataset
 * count or byte cap) or when any one dataset fails `parseMatrixSet`;
 * individual malformed rows within a dataset degrade to notices exactly as
 * they do for a bare matrix/v1 payload.
 */
export function parseDatasetBundle(raw: unknown): ParsedDatasetBundle {
  if (!isRecord(raw) || raw.kind !== DATASET_BUNDLE_KIND) {
    throw new LabError(`Dataset payload must be an object with kind "${DATASET_BUNDLE_KIND}".`);
  }
  if (!Array.isArray(raw.datasets) || raw.datasets.length === 0) {
    throw new LabError('Dataset payload must have a non-empty `datasets` array.');
  }
  if (raw.datasets.length > MAX_DATASETS) {
    throw new LabError(`Dataset payload declares ${raw.datasets.length} datasets — the cap is ${MAX_DATASETS}. Split into a linked set of insights, or drop unused datasets.`);
  }

  const notices: string[] = [];
  const datasets = raw.datasets.map((d, i) => parseDataset(d, i, notices));

  const seen = new Set<string>();
  for (const dataset of datasets) {
    if (seen.has(dataset.key)) throw new LabError(`Dataset payload has two datasets with key "${dataset.key}" — keys must be unique.`);
    seen.add(dataset.key);
  }

  const bundle: DatasetBundle = { kind: DATASET_BUNDLE_KIND, datasets };
  if (typeof raw.primary === 'string' && raw.primary.trim()) {
    const primary = raw.primary.trim();
    if (!seen.has(primary)) {
      throw new LabError(`Dataset payload's \`primary\` ("${primary}") is not one of the declared datasets[].key.`);
    }
    bundle.primary = primary;
  }

  if (JSON.stringify(bundle).length > MAX_MATRIX_BYTES) {
    throw new LabError(`Dataset payload exceeds the ${MAX_MATRIX_BYTES}-byte cap even after per-dataset collapse — return fewer datasets/rows.`);
  }

  return { bundle, notices };
}

// ─── Lookup + series synthesis + latest (backward compat, bridge default) ───

/** Which dataset a keyless call resolves to: the named `key`, else the
 *  bundle's declared `primary`, else the first dataset — so `lab.data()` /
 *  `lab query` with no key and the CLI/dashboard never disagree on the
 *  default. A named key that doesn't exist resolves to `null` (honest miss,
 *  never a silent fallback to a different dataset). */
export function findDataset(bundle: DatasetBundle, key?: string | null): Dataset | null {
  if (key) {
    return bundle.datasets.find((d) => d.key === key) ?? null;
  }
  if (bundle.primary) {
    const found = bundle.datasets.find((d) => d.key === bundle.primary);
    if (found) return found;
  }
  return bundle.datasets[0] ?? null;
}

/** Synthesize legacy `Series[]` from the primary dataset — same treatment
 *  `matrixToSeries` gives a single matrix/v1 set. Keeps NumberCard/snapshot/
 *  raw-fallback consumers working for an `app` insight's `data` half. */
export function datasetToSeries(bundle: DatasetBundle): Series[] {
  const primary = findDataset(bundle);
  if (!primary) return [];
  return matrixToSeries({ kind: MATRIX_SET_KIND, dims: primary.dims, rows: primary.rows, total: primary.total, unit: primary.unit });
}

/** The card/binding `latest`: the primary dataset's grand total — finite or
 *  null, NEVER NaN/Infinity, exactly `matrixLatest`'s contract. */
export function datasetLatest(bundle: DatasetBundle): number | null {
  const primary = findDataset(bundle);
  if (!primary) return null;
  return matrixLatest({ kind: MATRIX_SET_KIND, dims: primary.dims, rows: primary.rows, total: primary.total });
}

/**
 * Read-side convenience: synthesize a `dataset/v1` bundle from a legacy
 * `Series[]` cache so `lab.data()` / `lab query` have ONE surface over every
 * insight, not just `app`-rendered ones. This is NOT an authoring path — it
 * does not un-smuggle dimensions that were baked into series names, it only
 * gives the bridge/CLI something to answer with. dims are `[series, date]`
 * because a legacy series' identity IS its name, and its points are dated.
 *
 * PINNED (tests/unit/lab-app.test.ts): key `"series"`, `primary: "series"`,
 * `dims: [{key:'series'},{key:'date'}]` — so `lab.data()` and `lab query`
 * with no key resolve to this exact shape on every legacy cache, and the
 * dashboard bridge (labAppRuntime.ts) and the CLI (datasetQuery.ts) can never
 * disagree about it.
 */
export function seriesToDatasetBundle(series: Series[]): DatasetBundle {
  const rows: MatrixRow[] = [];
  for (const s of series) {
    for (const p of s.points) {
      rows.push({ d: { series: s.name, date: p.t }, v: p.v });
    }
  }
  return {
    kind: DATASET_BUNDLE_KIND,
    primary: 'series',
    datasets: [{
      key: 'series',
      label: 'Series',
      dims: [{ key: 'series' }, { key: 'date' }],
      rows,
    }],
  };
}

// ─── History snapshots (the app's time axis) ────────────────────────────────

function compactDataset(d: Dataset): Dataset {
  const out: Dataset = {
    key: d.key,
    dims: d.dims,
    rows: d.rows.map((r) => {
      const row: MatrixRow = { d: r.d, v: r.v };
      if (r.n !== undefined && r.n !== null) row.n = r.n;
      return row;
    }),
  };
  if (d.label !== undefined) out.label = d.label;
  if (d.unit !== undefined) out.unit = d.unit;
  if (d.total) {
    out.total = { v: d.total.v };
    if (d.total.n !== undefined && d.total.n !== null) out.total.n = d.total.n;
  }
  return out;
}

/** Compact snapshot of one sync (dim coordinates + value + n only, per
 *  dataset — no `prev`, same reasoning as `makeMatrixSnapshot`: it is either
 *  adapter-provided every sync or history-derived, and storing it here would
 *  let a future Δ compare against a Δ). */
export function makeDatasetSnapshot(
  bundle: DatasetBundle,
  range: { fromISO: string; toISO: string },
  at: string,
): DatasetSnapshot {
  const snapshotBundle: DatasetBundle = { kind: DATASET_BUNDLE_KIND, datasets: bundle.datasets.map(compactDataset) };
  if (bundle.primary !== undefined) snapshotBundle.primary = bundle.primary;
  return { at, range, bundle: snapshotBundle };
}

/** Append one snapshot, enforcing the count cap AND the byte cap together —
 *  oldest snapshots drop first. Tolerates a malformed prior trail (non-array),
 *  mirroring `appendMatrixHistory`. The newest snapshot always survives. */
export function appendDatasetHistory(
  prior: DatasetSnapshot[] | undefined,
  snapshot: DatasetSnapshot,
): DatasetSnapshot[] {
  const priorTrail = Array.isArray(prior) ? prior : [];
  let trail = [...priorTrail, snapshot];
  if (trail.length > DATASET_HISTORY_MAX) trail = trail.slice(trail.length - DATASET_HISTORY_MAX);
  while (trail.length > 1 && JSON.stringify(trail).length > DATASET_HISTORY_MAX_BYTES) {
    trail = trail.slice(1);
  }
  return trail;
}
