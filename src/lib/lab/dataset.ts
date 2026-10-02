import {
  LabError,
  type Dataset,
  type DatasetBundle,
  type DatasetSnapshot,
  type MatrixDim,
  type MatrixRow,
  type Series,
} from './types.js';
import { MATRIX_OTHER_VALUE, MATRIX_SET_KIND, MAX_MATRIX_BYTES, matrixLatest, matrixToSeries, parseMatrixSet } from './matrix.js';
import { parseFunnelSet, type ParsedFunnelSet } from './funnel.js';

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
  /** The bundle WITHOUT its `funnel` member (that one is stored as cache.funnel). */
  bundle: DatasetBundle;
  /** Human-readable cap/coercion notices — surface them, never swallow. */
  notices: string[];
  /** The optional `funnel` member (a funnel-set/v1), parsed by `parseFunnelSet`
   *  with its own caps; its notices are also in `notices`, prefixed "funnel: ". */
  funnel?: ParsedFunnelSet;
}

/** The optional `funnel` member: one funnel-set/v1 riding in a dataset bundle
 *  (a funnel explorer needs step paths AND tables). Its caps are the funnel
 *  contract's own; a malformed member fails the whole payload, never degrades. */
function parseFunnelMember(raw: unknown, notices: string[]): ParsedFunnelSet {
  let parsed: ParsedFunnelSet;
  try {
    parsed = parseFunnelSet(raw);
  } catch (err) {
    const msg = err instanceof LabError ? err.message : String(err);
    throw new LabError(`Dataset payload's \`funnel\` member: ${msg}`);
  }
  if (parsed.set.funnels.length === 0) {
    const why = parsed.notices.length > 0 ? ` (${parsed.notices.join(' ')})` : '';
    throw new LabError(`Dataset payload's \`funnel\` member has no valid funnel${why}.`);
  }
  for (const notice of parsed.notices) notices.push(`funnel: ${notice}`);
  return parsed;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The ingestion caps (parseMatrixSet: top values per dim, then the row tail)
 * fold source rows into `Other` rows but keep no count. Recount them from the
 * raw rows and stamp each folding row with `other: <distinct source rows it
 * holds>`, the same marker frameOps' `topN` sets, so every consumer reads an
 * ingested cap and a block's topN the same way ("Other (3)", the Other grey).
 * A source row that was itself named `Other` is not a fold and is not counted.
 */
function markFolded(rawRows: unknown, dims: readonly MatrixDim[], rows: MatrixRow[]): MatrixRow[] {
  if (!Array.isArray(rawRows) || !rows.some((r) => dims.some((d) => r.d[d.key] === MATRIX_OTHER_VALUE))) return rows;
  const coord = (d: Record<string, string>) => dims.map((dim) => `${dim.key}=${d[dim.key]}`).join('|');
  const byCoord = new Map(rows.map((r) => [coord(r.d), r] as [string, MatrixRow]));
  const kept = dims.map((dim) => new Set(rows.map((r) => r.d[dim.key])));
  const allOther = coord(Object.fromEntries(dims.map((dim) => [dim.key, MATRIX_OTHER_VALUE])));
  const folded = new Map<string, Set<string>>();
  for (const raw of rawRows) {
    if (!isRecord(raw) || !isRecord(raw.d)) continue;
    const src = raw.d;
    // The same coordinate parseMatrixSet gives the row (a blank dim is `Unknown`).
    const own: Record<string, string> = {};
    dims.forEach((dim) => {
      const v = src[dim.key];
      own[dim.key] = v === undefined || v === null || String(v).trim() === '' ? 'Unknown' : String(v);
    });
    const ownKey = coord(own);
    if (byCoord.has(ownKey)) continue;
    const mapped = coord(Object.fromEntries(dims.map((dim, i) => [dim.key, kept[i].has(own[dim.key]) ? own[dim.key] : MATRIX_OTHER_VALUE])));
    // A coordinate the per-dim collapse kept but the row-tail cap merged lands in the all-Other row.
    const target = byCoord.has(mapped) ? mapped : allOther;
    if (!byCoord.has(target)) continue;
    const set = folded.get(target) ?? new Set<string>();
    set.add(ownKey);
    folded.set(target, set);
  }
  if (folded.size === 0) return rows;
  return rows.map((r) => {
    const n = folded.get(coord(r.d))?.size ?? 0;
    return n > 0 ? ({ ...r, other: n } as MatrixRow) : r;
  });
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

  const dataset: Dataset = { key, dims: parsed.set.dims, rows: markFolded(raw.rows, parsed.set.dims, parsed.set.rows) };
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
 * they do for a bare matrix/v1 payload. An optional `funnel` member is parsed
 * by `parseFunnelSet` and returned beside the bundle (never inside it, so the
 * bundle's byte cap covers only its tables); a malformed one throws.
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

  if (raw.funnel !== undefined) {
    return { bundle, notices, funnel: parseFunnelMember(raw.funnel, notices) };
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
