/**
 * Lab (analytics insights) — shared types.
 *
 * An INSIGHT is a curated metric (never a raw data dump) backed by an external
 * source: any HTTP JSON API or a local custom script. Manifests live at
 * `_dream_context/lab/insights/<slug>.md` (frontmatter config + `## Meaning`
 * prose); post-rollup snapshots at `_dream_context/lab/cache/<slug>.json`.
 *
 * This mirrors the objectives subsystem (objectives-store.ts) — markdown-first,
 * recall-indexed, dashboard-renderable — with a sync engine layered on top.
 */

/** A single time/value observation. */
export interface SeriesPoint {
  /** Time key: YYYY-MM-DD (daily), YYYY-Www (weekly), or YYYY-MM (monthly). */
  t: string;
  v: number;
}

/** A named, granularity-capped series (post-rollup). */
export interface Series {
  name: string;
  points: SeriesPoint[];
}

/** A named series of RAW (un-aggregated, un-capped) points straight from an adapter. */
export interface RawSeries {
  name: string;
  points: SeriesPoint[];
}

/** How a bucket of same-period points collapses to one value. */
export type Agg = 'last' | 'sum' | 'mean' | 'max';

/** Time resolution of a rolled-up series. */
export type Granularity = 'daily' | 'weekly' | 'monthly';

/** The dashboard render modes — the SINGLE source of truth for the render list:
 *  the CLI `--render` enum, doctor's validation, the lenient manifest read and
 *  the dashboard's chart registry (mirrored + drift-tested) all derive from it.
 *  Adding a render = one entry here + one component + one registry entry.
 *
 *  All of them read the cached `Series[]` (`funnel`/`breakdown`/`app` read
 *  their own typed cache entries — `cache.funnel` / `cache.matrix` /
 *  `cache.app`+`cache.datasets` — with the series as synthesized fallback);
 *  `funnel` and `app` are multi-page renders (`funnel`'s card routes to
 *  `/lab/<slug>` overview + `/lab/<slug>/f/<id>`; `app`'s to `/lab/<slug>` +
 *  `/lab/<slug>/p/<pageId>`). `breakdown` (matrix/v1) is DEPRECATED as an
 *  authoring path in favor of `app` + dataset/v1 — existing breakdown
 *  insights are grandfathered and keep rendering (tasks-and-features.md). */
export const RENDERS = [
  'number',
  'line',
  'pie',
  'raw',
  'funnel',
  'bar',
  'bar_compare',
  'stacked',
  'table',
  'heatmap',
  'breakdown',
  'app',
] as const;
export type Render = (typeof RENDERS)[number];

/** Optional manifest override for how much board a card takes: `s`/`m` = one
 *  column, `l` = two. Absent = the render's own default span decides. */
export const INSIGHT_SIZES = ['s', 'm', 'l'] as const;
export type InsightSize = (typeof INSIGHT_SIZES)[number];

/** Tweak kinds. There is NO `range` type: a relative range is an `enum` tweak
 *  whose key is `range`; an explicit range is two `date` tweaks (`from`/`to`). */
export const TWEAK_TYPES = ['enum', 'date', 'string'] as const;
export type TweakType = (typeof TWEAK_TYPES)[number];

/** A declared, user-editable knob on an insight (feeds `{{tweak:key}}`). */
export interface TweakDecl {
  key: string;
  type: TweakType;
  label?: string;
  /** Allowed values (enum only). */
  options?: string[];
  /** Default value when none is set. */
  default?: string;
  /** The currently-set value (persisted by `writeInsightTweaks`). */
  value?: string;
}

/** JSON-path extraction config for the generic-HTTP adapter. */
export interface ExtractConfig {
  /** Dot/bracket path to the array of rows (e.g. `data.results`). */
  seriesPath: string;
  /** Row field that names the series — splits multi-series (A/B). null = single. */
  seriesKey: string | null;
  /** Row field for the time key. */
  x: string;
  /** Row field for the value. */
  y: string;
  agg: Agg;
}

export interface HttpSource {
  adapter: 'http';
  /** May contain `{{tweak:key}}` / `{{cred:key}}` placeholders. */
  endpoint: string;
  method: 'GET' | 'POST';
  /** Header values may contain `{{cred:key}}`. */
  headers: Record<string, string>;
  /** POST body template — MUST resolve to valid JSON. null for GET. */
  body: string | null;
  extract: ExtractConfig;
}

export interface ScriptSource {
  adapter: 'script';
  /** `scripts/<slug>.mjs` relative to `lab/`; exports `default async (ctx) => RawSeries[]`. */
  file: string;
}

export type InsightSource = HttpSource | ScriptSource;

/** Optional binding that writes a bound objective's KR `metric.current` on sync. */
export interface Binding {
  objective: string;
  /** `latest` → the default series' last point; `series:<name>` → that series'. */
  value: string;
}

/** The parsed manifest for one insight. */
export interface InsightManifest {
  slug: string;
  title: string;
  description: string | null;
  /** Top-level dashboard category (side-menu tab, e.g. "Marketing"), or null. */
  category: string | null;
  /** Dashboard section grouping, or null (renders under "Ungrouped"). */
  group: string | null;
  render: Render;
  /** Board footprint override, or null (the render's default span wins). */
  size: InsightSize | null;
  /** null when the `source:` block is malformed (read stays lenient). */
  source: InsightSource | null;
  refresh: { ttl_minutes: number };
  tweaks: TweakDecl[];
  binding: Binding | null;
  credentials_used: string[];
  unit: string | null;
  /** Absolute path of the manifest file. */
  path: string;
  /** The `## Meaning` prose (recall-indexed). */
  body: string;
}

/** One entry in the bounded per-insight sync history (real runs only — TTL
 *  "fresh" skips don't append; nothing changed). */
export interface SyncEvent {
  /** ISO timestamp of the run. */
  at: string;
  status: 'ok' | 'failed';
  /** The bound value produced by an ok run, null on failure. */
  latest: number | null;
  granularity: Granularity | null;
  /** Redacted error message (failed runs only). */
  error: string | null;
}

// ─── Funnel-set payload (`render: funnel`) ──────────────────────────────────
//
// An adapter for a funnel insight returns ONE funnel-set object (not Series[]):
// `{ kind: 'funnel-set/v1', dimensions, funnels: [{ id, name, meta, metrics,
// steps, segments? }] }`. The engine validates + caps it (see funnel.ts) and
// stores it in `cache.funnel`, synthesizing legacy `series` from step users so
// every series consumer (latest, snapshot, KR binding) keeps working. Legacy
// `Series[]` payloads under `render: funnel` stay valid — they skip `cache.funnel`
// and the dashboard renders the compact bar fallback.

/** Format hint for a funnel metric column (drives table cell rendering). */
export type FunnelMetricFormat = 'count' | 'pct' | 'usd' | 'x' | 'seconds' | 'number';

/** One overview-table metric value on a funnel. */
export interface FunnelMetricValue {
  v: number | null;
  format: FunnelMetricFormat;
  /** Column label override (else the key is prettified). */
  label?: string;
  /** Previous equal-length period value — adapter-provided; wins over history-derived deltas. */
  prev?: number | null;
}

/** One step in a funnel. Array ORDER is step order; `key` aligns steps across
 *  funnels (compare) and periods (deltas) — never align by index. */
export interface FunnelStep {
  key: string;
  label: string;
  users: number;
  /** Previous-period users (adapter-provided; optional). */
  prev?: number | null;
  /** Median seconds from the previous step (reserved for arc labels; optional). */
  median_seconds?: number | null;
}

/** One disjoint segment cell (client-mode filters/breakdowns). Cells must not
 *  overlap: for any dimension value combination there is at most one cell. */
export interface FunnelSegment {
  /** dimension key → value for this cell (e.g. { language: 'en' }). */
  dims: Record<string, string>;
  users: number;
  steps: { key: string; users: number }[];
}

/** A declared breakdown/filter dimension. */
export interface FunnelDimension {
  key: string;
  label: string;
  /** `client` = segments carried in the payload, filtering is instant;
   *  `refetch` = the chosen value is written into a tweak and the insight re-syncs. */
  mode: 'client' | 'refetch';
  /** refetch mode: the tweak key the chosen value is written into (defaults to `key`). */
  tweak?: string;
  /** Declared values (with user counts when known) — drives the filter chips. */
  values?: { value: string; count?: number }[];
}

/** One funnel in a funnel-set. */
export interface FunnelDef {
  id: string;
  name: string;
  /** Free-form context shown in the detail rail (product, url, hypothesis, …). */
  meta: Record<string, string>;
  /** Overview-table columns, format-hinted. Key order is column order. */
  metrics: Record<string, FunnelMetricValue>;
  steps: FunnelStep[];
  segments?: FunnelSegment[];
}

/** Optional per-metric benchmark thresholds (colors rate cells; off when absent). */
export interface FunnelBenchmark {
  /** Below this → critical tint. */
  floor?: number;
  /** At/above this → good tint. */
  target?: number;
}

/** The versioned funnel-set payload an adapter returns for `render: funnel`. */
export interface FunnelSet {
  kind: 'funnel-set/v1';
  dimensions: FunnelDimension[];
  funnels: FunnelDef[];
  /** Metric key that drives the card `latest`, default sort, and preview. */
  primary?: string;
  /** Rows with first-step users below this render de-emphasized ("low sample"). Default 30. */
  low_sample_threshold?: number;
  /** metric key → thresholds. Absent = benchmarks off. */
  benchmarks?: Record<string, FunnelBenchmark>;
}

/** A compact per-sync snapshot kept for deltas/trends (bounded — see funnel.ts). */
export interface FunnelSnapshot {
  /** ISO timestamp of the sync that took this snapshot. */
  at: string;
  /** The resolved date window the snapshot covers. */
  range: { fromISO: string; toISO: string };
  funnels: {
    id: string;
    metrics: Record<string, number | null>;
    steps: { key: string; users: number }[];
  }[];
}

/** What `cache.funnel` stores after a successful funnel sync. */
export interface FunnelCacheEntry {
  set: FunnelSet;
  /** Cap/truncation notices from validation — surfaced, never silent. */
  notices: string[];
  /** The resolved date window this set covers (from the range tweaks). */
  range: { fromISO: string; toISO: string };
}

// ─── Matrix payload (`render: breakdown`) ───────────────────────────────────
//
// An adapter for a breakdown insight returns ONE matrix object (not Series[]):
// `{ kind: 'matrix/v1', dims: [{key,label?}] (1-3), rows: [{ d: {dimKey: value},
// v, n?, prev? }], total?, unit? }`. It carries a DIMENSIONAL snapshot — a pivot
// over 1-3 dimensions — not a time series: the time axis of a breakdown lives in
// `cache.matrixHistory` (one dated snapshot per successful sync). The engine
// validates + caps it (see matrix.ts) and stores it in `cache.matrix`,
// synthesizing legacy `series` from the rows so series consumers keep working.

/** One declared matrix dimension (order = pivot order: rows, columns, filter). */
export interface MatrixDim {
  key: string;
  /** Display label (else the key is prettified). */
  label?: string;
}

/** One cell/row of a matrix: dimension coordinates + value (+ sample size, prev). */
export interface MatrixRow {
  /** dimension key → value for this row (every declared dim key present). */
  d: Record<string, string>;
  v: number | null;
  /** Sample size behind `v` (drives the low-sample de-emphasis). */
  n?: number | null;
  /** Previous equal-length period value — adapter-provided; wins over history. */
  prev?: number | null;
}

/** The grand total across all rows (drives the card `latest` / KR binding). */
export interface MatrixTotal {
  v: number | null;
  n?: number | null;
  prev?: number | null;
}

/** The versioned matrix payload an adapter returns for `render: breakdown`. */
export interface MatrixSet {
  kind: 'matrix/v1';
  /** 1-3 dimensions; order is meaningful (dim1 = pivot rows, dim2 = columns, dim3 = filter chips). */
  dims: MatrixDim[];
  rows: MatrixRow[];
  total?: MatrixTotal;
  /** Value unit override (else the manifest's `unit`). */
  unit?: string;
}

/** A compact per-sync matrix snapshot kept for the date axis (bounded — see matrix.ts). */
export interface MatrixSnapshot {
  /** ISO timestamp of the sync that took this snapshot. */
  at: string;
  /** The resolved date window the snapshot covers. */
  range: { fromISO: string; toISO: string };
  /** The set's dims at snapshot time — lets a dated snapshot re-render as a
   *  real pivot (reports date navigation). Absent on pre-dims snapshots. */
  dims?: MatrixDim[];
  rows: { d: Record<string, string>; v: number | null; n?: number | null }[];
  total?: { v: number | null; n?: number | null };
}

/** What `cache.matrix` stores after a successful breakdown sync. */
export interface MatrixCacheEntry {
  set: MatrixSet;
  /** Cap/truncation notices from validation — surfaced, never silent. */
  notices: string[];
  /** The resolved date window this set covers (from the range tweaks). */
  range: { fromISO: string; toISO: string };
}

// ─── Dataset bundle (`dataset/v1`) ──────────────────────────────────────────
//
// The plural successor to `matrix/v1`: N named tables instead of one, so a
// multi-page app can give each page (or `lab.data(key)` / `lab query
// --dataset`) its own dimensional dataset. Each dataset carries the SAME
// grammar as a matrix/v1 set (dims/rows/total) — dataset.ts delegates each
// one to `parseMatrixSet` (matrix.ts) rather than re-implementing the
// dimensional contract, so there is one grammar and one cap set for both the
// singular (matrix/v1, grandfathered) and plural (dataset/v1) shapes.

/** One named table in a dataset bundle — identical grammar to `MatrixSet`. */
export interface Dataset {
  key: string;
  /** Display label (else the key is prettified, same as MatrixDim). */
  label?: string;
  dims: MatrixDim[];
  rows: MatrixRow[];
  total?: MatrixTotal;
  /** Value unit override (else the manifest's `unit`). */
  unit?: string;
}

/** The versioned dataset-bundle payload: an adapter's `data` may be one (any
 *  render), and an `app/v1` page may name one via `AppPage.dataset`. */
export interface DatasetBundle {
  kind: 'dataset/v1';
  /** Dataset key `lab.data()` / `lab query` resolve to when none is named. */
  primary?: string;
  datasets: Dataset[];
}

/** A compact per-sync dataset-bundle snapshot kept for the date axis
 *  (bounded — see dataset.ts). The app's time axis, the same role
 *  `matrixHistory` plays for a single matrix/v1 set. */
export interface DatasetSnapshot {
  at: string;
  range: { fromISO: string; toISO: string };
  bundle: DatasetBundle;
}

/** What `cache.datasets` stores after a successful sync whose `data` (or an
 *  `app`-paired dataset) is a dataset/v1 bundle. */
export interface DatasetCacheEntry {
  bundle: DatasetBundle;
  /** Cap/coercion notices from validation — surfaced, never silent. */
  notices: string[];
  /** The resolved date window this bundle covers (from range tweaks). */
  range: { fromISO: string; toISO: string };
}

// ─── App payload (`render: app`) ────────────────────────────────────────────
//
// An adapter for a multi-page insight returns `{ data, app }` (never `app`
// bare — `data` stays mandatory, see the html/v1 hybrid envelope below, which
// `app` extends the same way `html` does). `app` is ONE app/v1 object: an
// ordered list of pages, each a sandboxed html fragment wired to the host via
// a postMessage bridge (dashboard-side — see labAppRuntime.ts). The engine
// validates + caps the SHAPE (see app.ts) and stores it in `cache.app`; it
// never substitutes for `data`, which keeps feeding `latest`, KR bindings,
// `lab show`/`lab query` and the Rule-13 read ladder exactly as it does today.

/** One page of an app/v1 body. `id` is the route segment
 *  (`/lab/<slug>/p/<id>`) and the bridge `navigate` target. */
export interface AppPage {
  id: string;
  title: string;
  /** The page's sandboxed markup — drawn exactly like an html/v1 body. */
  html: string;
  /** Dataset key (from the paired `dataset/v1` bundle) this page's
   *  `lab.data()` resolves to when the author calls it with no key. */
  dataset?: string;
}

/** Markup/script appended around the runtime shim — CSS after the kit
 *  (override-wins-by-order, the labHtmlKit precedent), JS after the shim. */
export interface AppShell {
  style?: string;
  script?: string;
}

/** The versioned app payload an adapter returns for `render: app`. */
export interface AppSpec {
  kind: 'app/v1';
  /** Page id shown at `/lab/<slug>` and, absent `card`, on the board card. */
  entry: string;
  /** Page id override for the CARD body only (defaults to `entry`). */
  card?: string;
  pages: AppPage[];
  shell?: AppShell;
}

/** What `cache.app` stores after a successful app sync. */
export interface AppCacheEntry {
  spec: AppSpec;
  /** Cap/coercion notices from validation — surfaced, never silent. */
  notices: string[];
  /** The resolved date window this spec was built under (from range tweaks). */
  range: { fromISO: string; toISO: string };
}

/** The cached, post-rollup snapshot written after each successful sync. */
export interface InsightCache {
  slug: string;
  /** ISO timestamp of the last SUCCESSFUL fetch (drives TTL staleness). */
  fetchedAt: string;
  /** The resolved tweak values that produced this snapshot. */
  tweaks: Record<string, string>;
  granularity: Granularity;
  unit: string | null;
  series: Series[];
  /** The bound value (last point of the binding series), or null. */
  latest: number | null;
  /** Redacted error message from the last failed sync, or null. */
  error: string | null;
  /** ISO timestamp of the last failure, or null. */
  errorAt: string | null;
  /** sha256 of the custom-script file at last successful run (tripwire), or null. */
  scriptHash: string | null;
  /** Bounded sync history, oldest→newest. Absent on caches written pre-history. */
  history?: SyncEvent[];
  /** Funnel-set snapshot (`render: funnel` with a funnel-set payload only). */
  funnel?: FunnelCacheEntry;
  /** Bounded per-sync funnel snapshots for deltas/trends, oldest→newest. */
  funnelHistory?: FunnelSnapshot[];
  /** Matrix snapshot (`render: breakdown` with a matrix/v1 payload only). */
  matrix?: MatrixCacheEntry;
  /** Bounded per-sync matrix snapshots (the breakdown's time axis), oldest→newest. */
  matrixHistory?: MatrixSnapshot[];
  /** App spec (`render: app` with an app/v1 payload only). */
  app?: AppCacheEntry;
  /** Dataset bundle (a `dataset/v1` data payload — typically an `app`
   *  insight's data half, but the shape is render-agnostic like matrix/v1). */
  datasets?: DatasetCacheEntry;
  /** Bounded per-sync dataset-bundle snapshots (the app's time axis), oldest→newest. */
  datasetHistory?: DatasetSnapshot[];
  /** Optional script-authored card body (html/v1 hybrid) — drawn in a
   *  network-less sandboxed iframe; NEVER a substitute for the typed data. */
  html?: string;
}

/** Resolved-tweak bundle handed to adapters and the rollup. */
export interface ResolvedTweaks {
  /** key → concrete string value (for `{{tweak:key}}` substitution). */
  values: Record<string, string>;
  /** The concrete time window derived from the range/from/to tweaks. */
  range: { fromISO: string; toISO: string };
  /** Whole days spanned by `range` (drives `deriveGranularity`). */
  spanDays: number;
}

/** Everything an adapter needs to fetch. `fetchImpl` is injected in tests. */
export interface AdapterContext {
  manifest: InsightManifest;
  resolvedTweaks: ResolvedTweaks;
  /** key → secret value (resolved from lab/credentials.json). */
  credentials: Record<string, string>;
  fetchImpl?: typeof fetch;
}

/** A raw (pre-validation) funnel-set payload passed through by an adapter.
 *  The engine validates + caps it via `parseFunnelSet` (funnel.ts). */
export type RawFunnelSet = { kind: 'funnel-set/v1' } & Record<string, unknown>;

/** Is this adapter result a funnel-set payload (vs legacy RawSeries[])? */
export function isRawFunnelSet(result: unknown): result is RawFunnelSet {
  return (
    typeof result === 'object' && result !== null && !Array.isArray(result)
    && (result as { kind?: unknown }).kind === 'funnel-set/v1'
  );
}

/** A raw (pre-validation) matrix payload passed through by an adapter.
 *  The engine validates + caps it via `parseMatrixSet` (matrix.ts). */
export type RawMatrixSet = { kind: 'matrix/v1' } & Record<string, unknown>;

/** Is this adapter result a matrix payload (vs legacy RawSeries[])? */
export function isRawMatrixSet(result: unknown): result is RawMatrixSet {
  return (
    typeof result === 'object' && result !== null && !Array.isArray(result)
    && (result as { kind?: unknown }).kind === 'matrix/v1'
  );
}

/** A raw (pre-validation) dataset-bundle payload passed through by an adapter.
 *  The engine validates + caps it via `parseDatasetBundle` (dataset.ts). */
export type RawDatasetBundle = { kind: 'dataset/v1' } & Record<string, unknown>;

/** Is this adapter result a dataset-bundle payload (vs legacy RawSeries[])? */
export function isRawDatasetBundle(result: unknown): result is RawDatasetBundle {
  return (
    typeof result === 'object' && result !== null && !Array.isArray(result)
    && (result as { kind?: unknown }).kind === 'dataset/v1'
  );
}

// ─── html/v1 hybrid + app/v1 envelope ───────────────────────────────────────
//
// A script may return `{ data, html? }` OR `{ data, app? }` instead of a bare
// payload — never both `html` and `app` (one body contract per insight; the
// sync engine rejects the combination loudly). `data` is MANDATORY either way
// and is exactly what a bare return would have been (RawSeries[], funnel-set,
// matrix, or dataset bundle) — the numbers keep feeding snapshots, KR
// bindings, deltas, reports and `lab show`. `html` is an OPTIONAL single card
// body; `app` is an OPTIONAL multi-page body — both are drawn by the
// dashboard in a network-less sandboxed iframe and never replace `data`.

/** Byte cap on a script's optional `html` body — over-cap is a LOUD sync error. */
export const MAX_HTML_BYTES = 300_000;

/** A raw (pre-validation) app-spec payload, passed through inside an
 *  envelope's `app` field. The engine validates + caps it via `parseAppSpec`
 *  (app.ts). */
export type RawAppSpec = { kind: 'app/v1' } & Record<string, unknown>;

/** Is this an app/v1 payload (bare, or as an envelope's `app` field)? */
export function isRawAppSpec(result: unknown): result is RawAppSpec {
  return (
    typeof result === 'object' && result !== null && !Array.isArray(result)
    && (result as { kind?: unknown }).kind === 'app/v1'
  );
}

/** A `{ data, html?, app? }` envelope from a script (pre-validation). */
export interface RawPayloadEnvelope {
  data: RawSeries[] | RawFunnelSet | RawMatrixSet | RawDatasetBundle;
  html?: string;
  app?: RawAppSpec;
}

/** Is this adapter result a `{ data, html?, app? }` envelope (vs a bare
 *  payload)? An object carrying `data`, `html`, OR `app` without a payload
 *  `kind` is one — a bare typed payload always has `kind`, a legacy return is
 *  an array. `app` MUST be checked here too: `{ app }` alone also has no
 *  `kind`, and without this arm it is never recognised as an envelope at all
 *  — the data-is-mandatory reject below can't fire for a shape it never sees
 *  (see sync.ts, which calls this before either reject runs). */
export function isRawPayloadEnvelope(result: unknown): result is RawPayloadEnvelope {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return false;
  const r = result as { kind?: unknown; data?: unknown; html?: unknown; app?: unknown };
  return r.kind === undefined && ('data' in r || 'html' in r || 'app' in r);
}

/** What an adapter may return: time series, one funnel-set, one matrix
 *  payload, one dataset bundle, or a `{ data, html?, app? }` envelope
 *  wrapping one of those. */
export type AdapterResult = RawSeries[] | RawFunnelSet | RawMatrixSet | RawDatasetBundle | RawPayloadEnvelope;

/** The adapter contract. Implementations return RAW data; the engine rolls up
 *  series and validates/caps funnel-sets. */
export interface LabAdapter {
  fetch(ctx: AdapterContext): Promise<AdapterResult>;
}

/** All lab failures throw this so callers can map it (400/404 in routes, exit 1 in CLI). */
export class LabError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LabError';
  }
}
