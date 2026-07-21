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

/** The dashboard render modes. `funnel` is the first multi-page render: its
 *  card routes to `/lab/<slug>` (overview) + `/lab/<slug>/f/<funnelId>` (detail). */
export const RENDERS = ['number', 'line', 'pie', 'raw', 'funnel'] as const;
export type Render = (typeof RENDERS)[number];

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
  /** Dashboard section grouping, or null (renders under "Ungrouped"). */
  group: string | null;
  render: Render;
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

/** What an adapter may return: time series, or one funnel-set payload. */
export type AdapterResult = RawSeries[] | RawFunnelSet;

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
