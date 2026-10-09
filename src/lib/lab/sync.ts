import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getObjective, updateObjectiveMetric } from '../objectives-store.js';
import { getAdapter, scriptFilePath } from './adapters/index.js';
import { readCredentials, redactSecrets } from './credentials.js';
import { getInsight, listInsights, readCache, writeCache, writeInsightBinding } from './store.js';
import { resolveTweaks } from './tweaks.js';
import { rollupSeries } from './rollup.js';
import {
  appendFunnelHistory,
  funnelLatest,
  funnelSetRange,
  funnelToSeries,
  makeFunnelSnapshot,
  parseFunnelSet,
} from './funnel.js';
import {
  appendMatrixHistory,
  makeMatrixSnapshot,
  matrixLatest,
  matrixToSeries,
  parseMatrixSet,
} from './matrix.js';
import { parseAppSpec } from './app.js';
import {
  appendDatasetHistory,
  datasetLatest,
  datasetToSeries,
  makeDatasetSnapshot,
  parseDatasetBundle,
} from './dataset.js';
import {
  FRESHNESS_PROBE_TIMEOUT_MS,
  isRawDatasetBundle,
  isRawFunnelSet,
  isRawMatrixSet,
  isRawPayloadEnvelope,
  LabError,
  MAX_HTML_BYTES,
  type Agg,
  type AdapterContext,
  type AppCacheEntry,
  type Binding,
  type DatasetCacheEntry,
  type DatasetSnapshot,
  type FunnelCacheEntry,
  type FunnelSnapshot,
  type Granularity,
  type InsightCache,
  type InsightManifest,
  type MatrixCacheEntry,
  type MatrixSnapshot,
  type RawDatasetBundle,
  type RawFunnelSet,
  type RawMatrixSet,
  type RawSeries,
  type ResolvedTweaks,
  type Series,
  type SourceFreshness,
  type SyncEvent,
} from './types.js';

/**
 * Lab sync engine — the shared core the CLI and `/api/lab*` both call.
 *
 * Per insight: freshness gate (below; every skip is REPORTED with its reason,
 * never silent) → script-hash tripwire → resolve tweaks → adapter fetch → capped
 * rollup → cache write → optional bound-objective `metric.current` write. On
 * failure the prior series is preserved, error+errorAt are set from the REDACTED
 * message (never the raw Error object), and the result is flagged `failed` so
 * `syncAll` can aggregate a non-empty `failed[]` and the CLI can exit non-zero.
 *
 * Sleep does NOT call this (credential exposure, latency, non-determinism).
 */

export type SyncStatus = 'ok' | 'fresh' | 'failed' | 'skipped';

/** Why a `fresh` result did not fetch: the TTL has not run out, or the source's
 *  probe answered with the same marker for the same request fingerprint. */
export type FreshReason = 'ttl' | 'upstream-unchanged';
/** Why a `skipped` result did not run: an automatic run backing off a slug
 *  whose last attempt failed recently. */
export type SkipReason = 'error-backoff';

export interface SyncResult {
  slug: string;
  status: SyncStatus;
  latest?: number | null;
  granularity?: string;
  error?: string;
  /** Set on `fresh` and `skipped` results — shown on the card and in the CLI. */
  reason?: FreshReason | SkipReason;
  /** The source's own freshness note (plain text) when it gave one. */
  freshnessNote?: string;
}

/**
 * How hard a sync pushes past the freshness gate.
 *
 * - absent: AUTOMATIC (board open, timers). TTL applies, a stale slug consults
 *   the upstream probe, a slug that failed recently is backed off.
 * - `'user'`: someone asked (↻, Sync board, tweak save). The TTL is skipped but
 *   the probe is still consulted: unchanged upstream = no fetch.
 * - `'hard'`: skip the TTL AND the probe (CLI `--force-hard`, "Force full refresh").
 *
 * `true` is read as `'user'` for one release (old clients and scripts); `false`
 * is automatic.
 */
export type SyncForce = 'user' | 'hard';

/** Normalize a request/CLI force value; anything unrecognised is automatic. */
export function normalizeSyncForce(force: unknown): SyncForce | undefined {
  if (force === true || force === 'user') return 'user';
  if (force === 'hard') return 'hard';
  return undefined;
}

export interface SyncOptions {
  force?: boolean | SyncForce;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Freshness-probe budget override in ms (tests); default FRESHNESS_PROBE_TIMEOUT_MS. */
  probeTimeoutMs?: number;
}

/** One insight settled during a `syncAll` run — emitted as it happens, not at the end. */
export interface LabSyncProgress {
  /** Insights settled so far (ok + fresh + failed). */
  done: number;
  /** Insights in this run. Fixed at the start; never grows mid-run. */
  total: number;
  /** The insight that just settled. */
  slug: string;
  status: SyncStatus;
  error?: string;
  reason?: FreshReason | SkipReason;
}

export interface SyncAllOptions extends SyncOptions {
  /** How many insights may be in flight at once (default LAB_SYNC_CONCURRENCY). */
  concurrency?: number;
  /** Restrict the run to these slugs (used by the job layer's retry pass). */
  only?: string[];
  /** Called as each insight settles — the caller's live progress feed. */
  onProgress?: (ev: LabSyncProgress) => void;
  /** Per-insight watchdog in ms (default LAB_INSIGHT_TIMEOUT_MS). */
  insightTimeoutMs?: number;
}

/** Sync history is bounded — the cache stays an insight snapshot, not a log file. */
const HISTORY_MAX = 50;
/** Per-event error cap: HISTORY_MAX bounds count, this bounds size — a custom
 *  script that throws a payload-sized message must not inflate a cache that is
 *  re-parsed on every sync, snapshot, and API response. */
const HISTORY_ERROR_MAX = 300;

/** Append one run to the prior cache's history, keeping the newest HISTORY_MAX.
 *  Tolerates a malformed prior cache (non-array history) — readCache does not
 *  validate the field, and this also runs from the failure path, so throwing
 *  here would leave the bad file permanently unsyncable. */
function appendHistory(prior: InsightCache | null, event: SyncEvent): SyncEvent[] {
  const bounded: SyncEvent = event.error && event.error.length > HISTORY_ERROR_MAX
    ? { ...event, error: `${event.error.slice(0, HISTORY_ERROR_MAX)}…` }
    : event;
  const priorHistory = Array.isArray(prior?.history) ? prior.history : [];
  const history = [...priorHistory, bounded];
  return history.length > HISTORY_MAX ? history.slice(history.length - HISTORY_MAX) : history;
}

function aggFor(manifest: InsightManifest): Agg {
  const source = manifest.source;
  return source && source.adapter === 'http' ? source.extract.agg : 'last';
}

/** The bound value: the last point of the binding series (or the default). */
function computeLatest(series: Series[], binding: Binding | null): number | null {
  if (series.length === 0) return null;
  let target: Series | undefined;
  if (binding && binding.value.startsWith('series:')) {
    const name = binding.value.slice('series:'.length).trim();
    target = series.find((s) => s.name === name);
  }
  target = target ?? series[0];
  const pts = target.points;
  return pts.length > 0 ? pts[pts.length - 1].v : null;
}

/** sha256 of the custom-script file, or null (non-script / missing file). */
function computeScriptHash(manifest: InsightManifest): string | null {
  if (!manifest.source || manifest.source.adapter !== 'script') return null;
  try {
    const abs = scriptFilePath(manifest);
    if (!existsSync(abs)) return null;
    return createHash('sha256').update(readFileSync(abs)).digest('hex');
  } catch {
    return null;
  }
}

/** Write the bound objective's `metric.current` — only when finite and the KR exists. */
function writeBinding(
  contextRoot: string,
  slug: string,
  binding: Binding,
  latest: number | null,
): void {
  const objective = getObjective(contextRoot, binding.objective);
  if (!objective) {
    console.warn(`[lab] ${slug}: binding skipped — objective "${binding.objective}" not found (wrote nothing).`);
    return;
  }
  if (!objective.metric) {
    console.warn(`[lab] ${slug}: binding skipped — objective "${binding.objective}" has no Key Result metric (wrote nothing).`);
    return;
  }
  if (latest === null || !Number.isFinite(latest)) {
    console.warn(`[lab] ${slug}: binding skipped — latest value is non-finite/empty (wrote nothing to "${binding.objective}").`);
    return;
  }
  try {
    updateObjectiveMetric(contextRoot, binding.objective, { current: latest });
    console.log(`[lab] ${slug}: wrote metric.current=${latest} to objective "${binding.objective}".`);
  } catch (err) {
    console.warn(`[lab] ${slug}: binding write to "${binding.objective}" failed: ${(err as Error).message}`);
  }
}

export interface BindResult {
  manifest: InsightManifest;
  /** Other insights whose binding to the same objective was cleared (single feeder). */
  unbound: string[];
  /** metric.current seeded from the cached latest on connect, or null if nothing was written. */
  seededCurrent: number | null;
}

/**
 * Connect (or disconnect, binding=null) an insight to an objective's Key Result.
 * The write-path counterpart of the sync-time binding: validates the objective
 * exists, enforces the single-feeder invariant (an objective's metric.current
 * must have ONE writer — any other insight bound to it is unbound and reported),
 * and immediately seeds `metric.current` from the cached latest so the roadmap
 * reflects the measured value without waiting for the next sync.
 */
export function bindInsight(
  contextRoot: string,
  slug: string,
  binding: Binding | null,
): BindResult {
  if (!binding) {
    return { manifest: writeInsightBinding(contextRoot, slug, null), unbound: [], seededCurrent: null };
  }
  const objective = getObjective(contextRoot, binding.objective);
  if (!objective) throw new LabError(`Objective not found: ${binding.objective}`);

  const manifest = writeInsightBinding(contextRoot, slug, binding);

  const unbound: string[] = [];
  for (const other of listInsights(contextRoot)) {
    if (other.slug !== slug && other.binding?.objective === binding.objective) {
      writeInsightBinding(contextRoot, other.slug, null);
      unbound.push(other.slug);
    }
  }

  let seededCurrent: number | null = null;
  const cache = readCache(contextRoot, slug);
  if (objective.metric && cache) {
    const latest = computeLatest(Array.isArray(cache.series) ? cache.series : [], manifest.binding);
    if (latest !== null && Number.isFinite(latest)) {
      try {
        updateObjectiveMetric(contextRoot, binding.objective, { current: latest });
        seededCurrent = latest;
      } catch (err) {
        console.warn(`[lab] ${slug}: seeding metric.current on "${binding.objective}" failed: ${(err as Error).message}`);
      }
    }
  }
  return { manifest, unbound, seededCurrent };
}

// ─── Freshness gate ─────────────────────────────────────────────────────────
//
// Sync only pays for change. An automatic run skips a slug inside its TTL and
// backs off a slug that failed recently; past the TTL (or under 'user') it asks
// the source a cheap question first — the http `refresh.freshness` probe or the
// script's `freshness()` export — and skips the fetch when the marker AND the
// request fingerprint (`queryKey`) match the last real fetch. Any probe failure
// is a full fetch, and a real fetch is forced once the last one is older than
// the max age, so a probe can never pin stale data forever.

/** Floor of the automatic error backoff: max(TTL, this). */
export const ERROR_BACKOFF_FLOOR_MINUTES = 15;
/** Floor of the max age that forces a real fetch: max(this, 10 × TTL). */
export const MAX_AGE_FLOOR_MINUTES = 24 * 60;
/** TTL assumed when a manifest carries none (the store's default). */
const DEFAULT_TTL_MINUTES = 1440;
/** Caps on what a source may say about itself (after redaction). */
export const FRESHNESS_MARKER_MAX = 256;
const FRESHNESS_AS_OF_MAX = 64;
const FRESHNESS_NOTE_MAX = 280;

function ttlOf(manifest: InsightManifest): number {
  const ttl = manifest.refresh?.ttl_minutes;
  return typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_MINUTES;
}

/** Automatic runs leave a failed slug alone for this long. */
export function errorBackoffMinutes(manifest: InsightManifest): number {
  return Math.max(ttlOf(manifest), ERROR_BACKOFF_FLOOR_MINUTES);
}

/** A real fetch is forced once the last one is older than this. */
export function maxAgeMinutes(manifest: InsightManifest): number {
  return Math.max(MAX_AGE_FLOOR_MINUTES, 10 * ttlOf(manifest));
}

/** Plain text only: control characters and runs of whitespace fold to one space. */
function plainText(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
}

/**
 * Normalize what a source said about its own freshness. The marker must be a
 * string or finite number of at most FRESHNESS_MARKER_MAX chars AFTER
 * `redactSecrets`, else there is no marker (null) and the insight is TTL-only.
 * `asOf`/`note` are capped plain text.
 */
export function normalizeFreshness(
  raw: unknown,
  secretValues: string[],
): Omit<SourceFreshness, 'queryKey'> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as { marker?: unknown; asOf?: unknown; note?: unknown };
  const str = (v: unknown): string | null => {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return null;
  };
  const rawMarker = str(r.marker);
  if (rawMarker === null || rawMarker.trim() === '') return null;
  const marker = redactSecrets(rawMarker, secretValues);
  if (marker.length > FRESHNESS_MARKER_MAX) return null;
  const text = (v: unknown, max: number): string | null => {
    const t = str(v);
    if (t === null) return null;
    const clean = plainText(redactSecrets(t, secretValues)).slice(0, max);
    return clean || null;
  };
  return { marker, asOf: text(r.asOf, FRESHNESS_AS_OF_MAX), note: text(r.note, FRESHNESS_NOTE_MAX) };
}

/**
 * The request fingerprint: the resolved tweak values, the resolved window and
 * the source definition (the script file's hash, or the http source template).
 * An unchanged marker only skips a fetch when THIS is unchanged too — a tweak
 * edit asks a different question of the same upstream data.
 */
export function computeQueryKey(
  manifest: InsightManifest,
  resolvedTweaks: ResolvedTweaks,
  scriptHash: string | null,
): string {
  const source = manifest.source;
  const sourceKey = !source
    ? 'none'
    : source.adapter === 'script'
      ? `script:${scriptHash ?? 'missing'}`
      : `http:${createHash('sha256').update(JSON.stringify({
        endpoint: source.endpoint,
        method: source.method,
        headers: source.headers,
        body: source.body,
        extract: source.extract,
      })).digest('hex')}`;
  const tweaks = Object.keys(resolvedTweaks.values).sort().map((k) => [k, resolvedTweaks.values[k]]);
  return createHash('sha256')
    .update(JSON.stringify({ tweaks, range: resolvedTweaks.range, source: sourceKey }))
    .digest('hex')
    .slice(0, 32);
}

// ─── Machine-local freshness sidecar ────────────────────────────────────────
//
// `state/.lab-freshness.json` records WHEN this machine last confirmed each
// insight unchanged upstream. It is machine-local (brain-sync ignored) so an
// unchanged probe never dirties the synced cache: the cache only changes on a
// real fetch. An entry counts only while its marker + queryKey still match the
// cache's (a teammate's newer fetch makes it moot).

/** Relative path of the sidecar under `_dream_context/`. */
export const LAB_FRESHNESS_SIDECAR_REL = 'state/.lab-freshness.json';

export interface FreshnessCheck {
  checkedAt: string;
  marker: string;
  queryKey: string;
}

function sidecarPath(contextRoot: string): string {
  return join(contextRoot, 'state', '.lab-freshness.json');
}

/** Read the sidecar. Missing/malformed → `{}` (never throws). */
export function readFreshnessChecks(contextRoot: string): Record<string, FreshnessCheck> {
  try {
    const parsed = JSON.parse(readFileSync(sidecarPath(contextRoot), 'utf-8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, FreshnessCheck> = {};
    for (const [slug, v] of Object.entries(parsed as Record<string, unknown>)) {
      const e = v as Partial<FreshnessCheck> | null;
      if (e && typeof e.checkedAt === 'string' && typeof e.marker === 'string' && typeof e.queryKey === 'string') {
        out[slug] = { checkedAt: e.checkedAt, marker: e.marker, queryKey: e.queryKey };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Record one confirmed-unchanged probe. Merge-on-write: re-read, set, tmp + rename. */
function recordFreshnessCheck(contextRoot: string, slug: string, check: FreshnessCheck): void {
  try {
    const path = sidecarPath(contextRoot);
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    const all = readFreshnessChecks(contextRoot);
    all[slug] = check;
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', 'utf-8');
    renameSync(tmp, path);
  } catch (err) {
    // The check is an optimisation; failing to record it costs one more probe.
    console.warn(`[lab] ${slug}: could not record the freshness check: ${(err as Error).message}`);
  }
}

/** This machine's last confirmation that `cache` is still current, or null. */
export function lastCheckedAt(contextRoot: string, slug: string, cache: InsightCache | null): string | null {
  const sf = cache?.sourceFreshness;
  if (!sf) return null;
  const check = readFreshnessChecks(contextRoot)[slug];
  if (!check || check.marker !== sf.marker || check.queryKey !== sf.queryKey) return null;
  return check.checkedAt;
}

/** ms of the newest evidence the cache is current: max(fetchedAt, checkedAt). NaN when none. */
export function lastConfirmedMs(contextRoot: string, slug: string, cache: InsightCache | null): number {
  const fetched = cache?.fetchedAt ? Date.parse(cache.fetchedAt) : Number.NaN;
  const checkedIso = lastCheckedAt(contextRoot, slug, cache);
  const checked = checkedIso ? Date.parse(checkedIso) : Number.NaN;
  if (Number.isNaN(fetched)) return checked;
  if (Number.isNaN(checked)) return fetched;
  return Math.max(fetched, checked);
}

/** Race a probe against a deadline — an adapter that ignores its own budget
 *  still cannot hold the sync open. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new LabError(`timed out after ${ms}ms.`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The automatic gate (absent force only): a `fresh`/`skipped` result when the
 * run must not touch the source, else null. PURE decision (the caller logs);
 * `syncInsight` and the dry-run plan share it.
 * Staleness age = now − max(fetchedAt, this machine's last unchanged probe).
 */
function automaticGate(
  contextRoot: string,
  slug: string,
  manifest: InsightManifest,
  prior: InsightCache,
  nowMs: number,
): { result: SyncResult; detail: string } | null {
  const ttl = ttlOf(manifest);
  const ageMin = (nowMs - lastConfirmedMs(contextRoot, slug, prior)) / 60_000;
  if (Number.isFinite(ageMin) && ageMin >= 0 && ageMin < ttl) {
    return {
      result: { slug, status: 'fresh', reason: 'ttl', latest: prior.latest },
      detail: `age ${Math.round(ageMin)}m < ttl ${ttl}m`,
    };
  }
  // A slug that failed recently is left alone by automatic runs — a board
  // open must not hammer a broken source every minute. A user run retries.
  const errorAgeMin = prior.errorAt ? (nowMs - Date.parse(prior.errorAt)) / 60_000 : Number.NaN;
  if (Number.isFinite(errorAgeMin) && errorAgeMin >= 0 && errorAgeMin < errorBackoffMinutes(manifest)) {
    return {
      result: { slug, status: 'skipped', reason: 'error-backoff', latest: prior.latest, error: prior.error ?? undefined },
      detail: `failed ${Math.round(errorAgeMin)}m ago`,
    };
  }
  return null;
}

/**
 * Whether the upstream probe runs, and whether its answer could save the
 * fetch. A skip needs the last real fetch's marker for THIS queryKey, that
 * fetch to have succeeded (a cache carrying an error is re-fetched), to be
 * inside the max age, and the script unchanged (the tripwire: a changed script
 * is never probed — its hash is in the queryKey, so it always fetches). An
 * http probe also runs when a skip is impossible, to capture the marker
 * BEFORE the data; a script captures its own inside the fetch child.
 */
function probePlan(
  manifest: InsightManifest,
  prior: InsightCache | null,
  queryKey: string,
  scriptChanged: boolean,
  nowMs: number,
): { skipEligible: boolean; wantsProbe: boolean } {
  const priorMarker = prior?.sourceFreshness;
  const fetchedMs = prior?.fetchedAt ? Date.parse(prior.fetchedAt) : Number.NaN;
  const withinMaxAge = Number.isFinite(fetchedMs) && (nowMs - fetchedMs) / 60_000 < maxAgeMinutes(manifest);
  const skipEligible = Boolean(
    priorMarker && priorMarker.queryKey === queryKey && !prior?.error && withinMaxAge && !scriptChanged,
  );
  const wantsProbe = manifest.source?.adapter === 'http'
    ? Boolean(manifest.refresh.freshness)
    : skipEligible;
  return { skipEligible, wantsProbe };
}

/** What `lab sync --dry-run` says a run would do for one insight. */
export interface SyncPlan {
  slug: string;
  /**
   * skip  - no request at all (inside the TTL, or backing off a recent error);
   * probe - one cheap freshness probe; the fetch happens only if upstream changed;
   * fetch - a real fetch (`probe: true` = a probe runs first to record the marker).
   */
  action: 'skip' | 'probe' | 'fetch';
  /** Machine-readable why: the fresh/skip reason, or why a fetch is due. */
  reason: FreshReason | SkipReason | 'force-hard' | 'no-cache' | 'stale' | 'user' | 'script-changed' | 'no-source';
  probe: boolean;
  /** One human sentence. */
  detail: string;
}

/**
 * Plan one insight's sync WITHOUT running it: the same gate and probe
 * decisions `syncInsight` makes, from local files only (manifest, cache, the
 * freshness sidecar, the script's hash). Never calls an adapter, so it fires
 * ZERO upstream requests.
 */
export function planSyncInsight(contextRoot: string, slug: string, opts: Pick<SyncOptions, 'force' | 'now'> = {}): SyncPlan {
  const manifest = getInsight(contextRoot, slug);
  if (!manifest) throw new LabError(`Insight not found: ${slug}`);
  const force = normalizeSyncForce(opts.force);
  const nowMs = opts.now ? opts.now() : Date.now();
  const prior = readCache(contextRoot, slug);

  if (!force && prior) {
    const gate = automaticGate(contextRoot, slug, manifest, prior, nowMs);
    if (gate) {
      return { slug, action: 'skip', reason: gate.result.reason!, probe: false, detail: gate.result.reason === 'ttl' ? `fresh (${gate.detail})` : `backing off (${gate.detail})` };
    }
  }
  if (!manifest.source) {
    return { slug, action: 'fetch', reason: 'no-source', probe: false, detail: 'no valid source block: the run would fail' };
  }
  const newHash = computeScriptHash(manifest);
  const scriptChanged = Boolean(newHash && prior?.scriptHash && prior.scriptHash !== newHash);
  const why: SyncPlan['reason'] = force === 'hard'
    ? 'force-hard'
    : scriptChanged
      ? 'script-changed'
      : !prior
        ? 'no-cache'
        : force === 'user' ? 'user' : 'stale';
  if (force === 'hard') {
    return { slug, action: 'fetch', reason: why, probe: false, detail: 'forced full refresh: fetch, no probe' };
  }
  const queryKey = computeQueryKey(manifest, resolveTweaks(manifest), newHash);
  const { skipEligible, wantsProbe } = probePlan(manifest, prior, queryKey, scriptChanged, nowMs);
  const canProbe = Boolean(getAdapter(manifest).probe) && wantsProbe;
  if (canProbe && skipEligible) {
    return { slug, action: 'probe', reason: why, probe: true, detail: 'probe upstream; fetch only if the marker changed' };
  }
  return {
    slug,
    action: 'fetch',
    reason: why,
    probe: canProbe,
    detail: canProbe ? 'probe to record the marker, then fetch' : 'fetch',
  };
}

/** Sync one insight by slug. */
export async function syncInsight(
  contextRoot: string,
  slug: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const manifest = getInsight(contextRoot, slug);
  if (!manifest) throw new LabError(`Insight not found: ${slug}`);

  const force = normalizeSyncForce(opts.force);
  const nowMs = opts.now ? opts.now() : Date.now();
  const prior = readCache(contextRoot, slug);

  // ── Automatic gate (reported, never silent). ──
  if (!force && prior) {
    const gate = automaticGate(contextRoot, slug, manifest, prior, nowMs);
    if (gate) {
      console.log(gate.result.status === 'fresh'
        ? `[lab] ${slug}: fresh (${gate.detail}) — skipping; use --force to refetch.`
        : `[lab] ${slug}: ${gate.detail} — automatic sync backing off; use --force to retry now.`);
      return gate.result;
    }
  }

  const resolvedTweaks = resolveTweaks(manifest);
  const credentials = readCredentials(contextRoot);
  const secretValues = Object.values(credentials);

  // ── Script-hash tripwire: LOUD notice BEFORE executing a changed script. ──
  const newHash = computeScriptHash(manifest);
  const scriptChanged = Boolean(newHash && prior?.scriptHash && prior.scriptHash !== newHash);
  if (scriptChanged) {
    console.warn(`[lab] script changed since last run for ${slug} — review lab/scripts before trusting this sync.`);
  }

  const adapterCtx: AdapterContext = {
    manifest,
    resolvedTweaks,
    credentials,
    fetchImpl: opts.fetchImpl,
    probeTimeoutMs: opts.probeTimeoutMs,
  };
  const queryKey = computeQueryKey(manifest, resolvedTweaks, newHash);

  // ── Upstream probe ('user' and stale automatic runs; never 'hard'). Skip
  // only when marker AND queryKey match the last real fetch (probePlan). ──
  let captured: Omit<SourceFreshness, 'queryKey'> | null = null;
  if (force !== 'hard' && manifest.source) {
    const priorMarker = prior?.sourceFreshness;
    const { skipEligible, wantsProbe } = probePlan(manifest, prior, queryKey, scriptChanged, nowMs);
    const adapter = getAdapter(manifest);
    if (adapter.probe && wantsProbe) {
      const budgetMs = opts.probeTimeoutMs ?? FRESHNESS_PROBE_TIMEOUT_MS;
      try {
        const raw = await withDeadline(adapter.probe(adapterCtx), budgetMs + 3_000);
        captured = normalizeFreshness(raw, secretValues);
        if (raw !== null && !captured) {
          console.warn(`[lab] ${slug}: freshness probe returned no usable marker — fetching.`);
        }
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        console.warn(`[lab] ${slug}: freshness probe failed — fetching: ${redactSecrets(raw, secretValues)}`);
      }
      if (captured && skipEligible && priorMarker && captured.marker === priorMarker.marker) {
        recordFreshnessCheck(contextRoot, slug, {
          checkedAt: new Date(nowMs).toISOString(),
          marker: priorMarker.marker,
          queryKey,
        });
        console.log(`[lab] ${slug}: upstream unchanged (marker ${captured.marker}) — skipping the fetch.`);
        const note = captured.note ?? priorMarker.note;
        return {
          slug,
          status: 'fresh',
          reason: 'upstream-unchanged',
          latest: prior?.latest ?? null,
          ...(note ? { freshnessNote: note } : {}),
        };
      }
    }
  }

  try {
    const adapter = getAdapter(manifest);
    const fetched = await adapter.fetch(adapterCtx);

    // ── html/v1 hybrid + app/v1: unwrap the optional envelope. `data` carries
    // the numbers exactly as a bare return would; `html` is an optional capped
    // single-page card body (over-cap fails the sync LOUDLY, never truncates);
    // `app` is an optional capped multi-page body — ONE body contract per
    // insight, never both. `app`'s caps/rejects live in `parseAppSpec`
    // (app.ts) — this is just the wiring point, mirroring how matrix/funnel
    // parsing is called from here rather than reimplemented here. ──
    let html: string | undefined;
    let app: AppCacheEntry | undefined;
    let result: RawSeries[] | RawFunnelSet | RawMatrixSet | RawDatasetBundle;
    // The source's own word on this data wins over the pre-fetch probe.
    const freshness = (isRawPayloadEnvelope(fetched) ? normalizeFreshness(fetched.freshness, secretValues) : null)
      ?? captured;
    if (isRawPayloadEnvelope(fetched)) {
      if (typeof fetched.html === 'string' && fetched.html.length > 0) {
        const bytes = Buffer.byteLength(fetched.html, 'utf-8');
        if (bytes > MAX_HTML_BYTES) {
          throw new LabError(`Script html body is ${bytes} bytes — over the ${MAX_HTML_BYTES}-byte cap. Slim the markup (the data is cached separately; html is presentation only).`);
        }
        html = fetched.html;
      }
      if (fetched.app !== undefined) {
        if (html !== undefined) {
          throw new LabError('An insight declares ONE body contract — `app` or `html`, not both. Drop whichever body the insight is migrating away from.');
        }
        if (manifest.render !== 'app') {
          console.warn(`[lab] ${slug}: adapter returned an app spec but render is "${manifest.render}" — set \`render: app\` in the manifest for the routed multi-page UI.`);
        }
        const parsedApp = parseAppSpec(fetched.app);
        for (const notice of parsedApp.notices) console.warn(`[lab] ${slug}: ${notice}`);
        app = { spec: parsedApp.spec, notices: parsedApp.notices, range: resolvedTweaks.range };
      }
      result = fetched.data;
    } else {
      result = fetched;
    }

    let series: Series[];
    let granularity: Granularity;
    let latest: number | null;
    let funnel: FunnelCacheEntry | undefined;
    let funnelHistory: FunnelSnapshot[] | undefined;
    let matrix: MatrixCacheEntry | undefined;
    let matrixHistory: MatrixSnapshot[] | undefined;
    let datasets: DatasetCacheEntry | undefined;
    let datasetHistory: DatasetSnapshot[] | undefined;

    if (isRawFunnelSet(result)) {
      // ── Funnel-set payload: validate + cap; NO time rollup (steps aren't a
      // time series). Legacy series are synthesized from step users so every
      // series consumer (latest, snapshot, binding) keeps working. ──
      if (manifest.render !== 'funnel') {
        console.warn(`[lab] ${slug}: adapter returned a funnel-set but render is "${manifest.render}" — set \`render: funnel\` in the manifest for the full funnel UI.`);
      }
      const parsed = parseFunnelSet(result);
      for (const notice of parsed.notices) console.warn(`[lab] ${slug}: ${notice}`);
      series = funnelToSeries(parsed.set);
      granularity = 'daily';
      latest = funnelLatest(parsed.set);
      // A set that declares its own window (a snapshot) is cached under that window, not the range tweak.
      const funnelRange = funnelSetRange(parsed.set) ?? resolvedTweaks.range;
      funnel = { set: parsed.set, notices: parsed.notices, range: funnelRange };
      funnelHistory = appendFunnelHistory(
        prior?.funnelHistory,
        makeFunnelSnapshot(parsed.set, funnelRange, new Date(nowMs).toISOString()),
      );
    } else if (isRawMatrixSet(result)) {
      // ── Matrix payload: validate + cap; NO time rollup (the set is a
      // dimensional snapshot). Legacy series are synthesized from the rows;
      // the time axis is the DATED matrixHistory trail, one entry per sync. ──
      if (manifest.render !== 'breakdown') {
        console.warn(`[lab] ${slug}: adapter returned a matrix but render is "${manifest.render}" — set \`render: breakdown\` in the manifest for the pivot UI.`);
      }
      const parsed = parseMatrixSet(result);
      for (const notice of parsed.notices) console.warn(`[lab] ${slug}: ${notice}`);
      series = matrixToSeries(parsed.set);
      granularity = 'daily';
      // `latest` comes from total.v ONLY — finite or null, never a fabrication.
      latest = matrixLatest(parsed.set);
      if (latest === null && manifest.binding) {
        console.warn(`[lab] ${slug}: matrix payload has no finite \`total.v\` — the KR binding to "${manifest.binding.objective}" gets nothing this sync (return a \`total\` to feed it).`);
      }
      matrix = { set: parsed.set, notices: parsed.notices, range: resolvedTweaks.range };
      matrixHistory = appendMatrixHistory(
        prior?.matrixHistory,
        makeMatrixSnapshot(parsed.set, resolvedTweaks.range, new Date(nowMs).toISOString()),
      );
    } else if (isRawDatasetBundle(result)) {
      // ── Dataset-bundle payload: validate + cap; NO time rollup (a bundle is
      // a dimensional snapshot, like matrix/v1). No render-mismatch warning —
      // unlike funnel/matrix, dataset/v1 is RENDER-AGNOSTIC (types.ts): it is
      // typically an `app` insight's data half, but any render may return one
      // and get its legacy series synthesized from the primary dataset. ──
      const parsed = parseDatasetBundle(result);
      for (const notice of parsed.notices) console.warn(`[lab] ${slug}: ${notice}`);
      series = datasetToSeries(parsed.bundle);
      granularity = 'daily';
      // `latest` comes from the PRIMARY dataset's total.v ONLY — finite or
      // null, never a fabrication (matrixLatest's contract, one level up).
      latest = datasetLatest(parsed.bundle);
      if (latest === null && manifest.binding) {
        console.warn(`[lab] ${slug}: dataset bundle has no finite primary \`total.v\` — the KR binding to "${manifest.binding.objective}" gets nothing this sync (return a \`total\` on the primary dataset to feed it).`);
      }
      datasets = { bundle: parsed.bundle, notices: parsed.notices, range: resolvedTweaks.range };
      datasetHistory = appendDatasetHistory(
        prior?.datasetHistory,
        makeDatasetSnapshot(parsed.bundle, resolvedTweaks.range, new Date(nowMs).toISOString()),
      );
      // A funnel explorer's bundle carries one funnel-set/v1 member: it is
      // stored as cache.funnel (with its history) exactly as a bare funnel-set
      // would be; latest + series stay the primary dataset's.
      if (parsed.funnel) {
        const funnelRange = funnelSetRange(parsed.funnel.set) ?? resolvedTweaks.range;
        funnel = { set: parsed.funnel.set, notices: parsed.funnel.notices, range: funnelRange };
        funnelHistory = appendFunnelHistory(
          prior?.funnelHistory,
          makeFunnelSnapshot(parsed.funnel.set, funnelRange, new Date(nowMs).toISOString()),
        );
      }
    } else {
      const rolled = rollupSeries(result, resolvedTweaks.spanDays, aggFor(manifest));
      series = rolled.series;
      granularity = rolled.granularity;
      latest = computeLatest(series, manifest.binding);
    }

    const cache: InsightCache = {
      slug,
      fetchedAt: new Date(nowMs).toISOString(),
      tweaks: resolvedTweaks.values,
      granularity,
      unit: manifest.unit,
      series,
      latest,
      error: null,
      errorAt: null,
      // Record the hash ONLY on a successful run (so the tripwire fires next change).
      scriptHash: newHash,
      history: appendHistory(prior, {
        at: new Date(nowMs).toISOString(),
        status: 'ok',
        latest,
        granularity,
        error: null,
      }),
    };
    if (funnel) {
      cache.funnel = funnel;
      cache.funnelHistory = funnelHistory;
    }
    if (matrix) {
      cache.matrix = matrix;
      cache.matrixHistory = matrixHistory;
    }
    if (datasets) {
      cache.datasets = datasets;
      cache.datasetHistory = datasetHistory;
    }
    // The html/app body is written ALONGSIDE the data (never instead of it),
    // and a run without one clears any prior body — stale presentation is
    // worse than none. TTL/history/latest semantics are untouched by its
    // presence (the html/v1 rule, extended to app/v1 the same way).
    if (html !== undefined) cache.html = html;
    if (app) cache.app = app;
    // Marker + fingerprint of THIS fetch (no checkedAt: that is machine-local).
    if (freshness) cache.sourceFreshness = { ...freshness, queryKey };
    writeCache(contextRoot, slug, cache);

    if (manifest.binding) writeBinding(contextRoot, slug, manifest.binding, latest);

    return {
      slug,
      status: 'ok',
      latest,
      granularity,
      ...(freshness?.note ? { freshnessNote: freshness.note } : {}),
    };
  } catch (err) {
    // Build the stored/logged message from the REDACTED string only — never the
    // raw Error object (a stack could carry an un-redacted URL/header).
    const rawMsg = err instanceof LabError ? err.message : (err instanceof Error ? err.message : String(err));
    const message = redactSecrets(rawMsg, secretValues);
    console.error(`[lab] sync failed for ${slug}: ${message}`);

    const failCache: InsightCache = {
      slug,
      fetchedAt: prior?.fetchedAt ?? '',
      tweaks: prior?.tweaks ?? resolvedTweaks.values,
      granularity: prior?.granularity ?? 'daily',
      unit: prior?.unit ?? manifest.unit,
      series: prior?.series ?? [],
      latest: prior?.latest ?? null,
      error: message,
      errorAt: new Date(nowMs).toISOString(),
      // Keep the prior hash — this run failed, so the tripwire baseline is unchanged.
      scriptHash: prior?.scriptHash ?? null,
      history: appendHistory(prior, {
        at: new Date(nowMs).toISOString(),
        status: 'failed',
        latest: null,
        granularity: null,
        error: message,
      }),
    };
    // Preserve the prior funnel/matrix/dataset snapshots + trails, and the
    // prior html/app body — same keep-prior contract as series.
    if (prior?.funnel) failCache.funnel = prior.funnel;
    if (prior?.funnelHistory) failCache.funnelHistory = prior.funnelHistory;
    if (prior?.matrix) failCache.matrix = prior.matrix;
    if (prior?.matrixHistory) failCache.matrixHistory = prior.matrixHistory;
    if (prior?.datasets) failCache.datasets = prior.datasets;
    if (prior?.datasetHistory) failCache.datasetHistory = prior.datasetHistory;
    if (prior?.html !== undefined) failCache.html = prior.html;
    if (prior?.app) failCache.app = prior.app;
    // The kept data still belongs to the kept marker.
    if (prior?.sourceFreshness) failCache.sourceFreshness = prior.sourceFreshness;
    writeCache(contextRoot, slug, failCache);

    return { slug, status: 'failed', error: message };
  }
}

export interface SyncAllResult {
  results: SyncResult[];
  failed: SyncResult[];
}

/**
 * How many insights run at once. Bounded on purpose: a script insight spawns a
 * whole Node child process, so an unbounded fan-out over a large board forks
 * dozens of them at once. Override with DREAMCONTEXT_LAB_SYNC_CONCURRENCY.
 */
export const LAB_SYNC_CONCURRENCY = 4;

/**
 * Per-insight watchdog. The adapters have their own ceilings (script child:
 * SCRIPT_TIMEOUT_MS; HTTP: 15s per attempt), but a 429 `Retry-After` can park an
 * HTTP insight for an unbounded stretch — and one parked insight must never hold
 * the whole run open, because the caller (the dashboard job) can then never
 * settle and the user is left watching a spinner that never resolves.
 *
 * The watchdog reports; it cannot cancel. An orphaned adapter that finishes
 * later still writes its cache, and that late write is the truthful one — the
 * timed-out RESULT is only this run's report, never a cache mutation.
 * Override with DREAMCONTEXT_LAB_INSIGHT_TIMEOUT_MS.
 */
export const LAB_INSIGHT_TIMEOUT_MS = 180_000;

/** Read a positive-integer env override, falling back to `fallback`. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Sync one insight, converting a throw or a hang into a `failed` result.
 *  Never rejects — the pool below relies on that to keep draining. */
async function settleInsight(
  contextRoot: string,
  slug: string,
  opts: SyncOptions,
  timeoutMs: number,
): Promise<SyncResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const watchdog = new Promise<SyncResult>((resolve) => {
      timer = setTimeout(() => {
        const message = `timed out after ${timeoutMs}ms — the adapter never settled `
          + '(raise DREAMCONTEXT_LAB_INSIGHT_TIMEOUT_MS if this source is legitimately slow).';
        console.error(`[lab] sync failed for ${slug}: ${message}`);
        resolve({ slug, status: 'failed', error: message });
      }, timeoutMs);
      // The timer must not hold the process open once the run is done — the CLI
      // would sit idle for the full window after printing its report.
      timer.unref?.();
    });
    const work = syncInsight(contextRoot, slug, opts).catch((err: unknown) => {
      // syncInsight only throws for engine-level faults (missing manifest,
      // unreadable store) — adapter failures already come back as `failed`.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[lab] sync failed for ${slug}: ${message}`);
      return { slug, status: 'failed', error: message } satisfies SyncResult;
    });
    return await Promise.race([work, watchdog]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Sync a set of insights with bounded concurrency, aggregating failures.
 *
 * Results come back in MANIFEST order regardless of completion order, so the CLI
 * report and the cached-order assumptions of callers are stable across runs.
 * `onProgress` fires as each insight settles — that live feed is what lets a
 * long run report partial progress instead of going dark until the end.
 */
export async function syncAll(
  contextRoot: string,
  opts: SyncAllOptions = {},
): Promise<SyncAllResult> {
  const only = opts.only ? new Set(opts.only) : null;
  const slugs = listInsights(contextRoot)
    .map((m) => m.slug)
    .filter((slug) => !only || only.has(slug));

  const total = slugs.length;
  const timeoutMs = opts.insightTimeoutMs
    ?? envInt('DREAMCONTEXT_LAB_INSIGHT_TIMEOUT_MS', LAB_INSIGHT_TIMEOUT_MS);
  const concurrency = Math.max(
    1,
    Math.min(opts.concurrency ?? envInt('DREAMCONTEXT_LAB_SYNC_CONCURRENCY', LAB_SYNC_CONCURRENCY), total || 1),
  );

  const results = new Array<SyncResult>(total);
  let next = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= total) return;
      const result = await settleInsight(contextRoot, slugs[i], opts, timeoutMs);
      results[i] = result;
      done++;
      // A throwing progress callback is the CALLER's bug and must not abort the
      // run — half the board would silently go unsynced.
      try {
        opts.onProgress?.({
          done,
          total,
          slug: result.slug,
          status: result.status,
          error: result.error,
          ...(result.reason ? { reason: result.reason } : {}),
        });
      } catch (err) {
        console.warn(`[lab] sync progress callback threw: ${(err as Error).message}`);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return { results, failed: results.filter((r) => r.status === 'failed') };
}
