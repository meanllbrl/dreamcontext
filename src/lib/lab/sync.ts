import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { getObjective, updateObjectiveMetric } from '../objectives-store.js';
import { getAdapter, scriptFilePath } from './adapters/index.js';
import { readCredentials, redactSecrets } from './credentials.js';
import { getInsight, listInsights, readCache, writeCache, writeInsightBinding } from './store.js';
import { resolveTweaks } from './tweaks.js';
import { rollupSeries } from './rollup.js';
import {
  LabError,
  type Agg,
  type Binding,
  type InsightCache,
  type InsightManifest,
  type Series,
  type SyncEvent,
} from './types.js';

/**
 * Lab sync engine — the shared core the CLI and `/api/lab*` both call.
 *
 * Per insight: TTL staleness skip (unless force; the skip is REPORTED, never
 * silent) → script-hash tripwire → resolve tweaks → adapter fetch → capped
 * rollup → cache write → optional bound-objective `metric.current` write. On
 * failure the prior series is preserved, error+errorAt are set from the REDACTED
 * message (never the raw Error object), and the result is flagged `failed` so
 * `syncAll` can aggregate a non-empty `failed[]` and the CLI can exit non-zero.
 *
 * Sleep does NOT call this (credential exposure, latency, non-determinism).
 */

export type SyncStatus = 'ok' | 'fresh' | 'failed';

export interface SyncResult {
  slug: string;
  status: SyncStatus;
  latest?: number | null;
  granularity?: string;
  error?: string;
}

export interface SyncOptions {
  force?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
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

/** Sync one insight by slug. */
export async function syncInsight(
  contextRoot: string,
  slug: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const manifest = getInsight(contextRoot, slug);
  if (!manifest) throw new LabError(`Insight not found: ${slug}`);

  const nowMs = opts.now ? opts.now() : Date.now();
  const prior = readCache(contextRoot, slug);

  // ── TTL staleness skip (reported, never silent). ──
  if (!opts.force && prior?.fetchedAt) {
    const ageMin = (nowMs - Date.parse(prior.fetchedAt)) / 60_000;
    if (Number.isFinite(ageMin) && ageMin >= 0 && ageMin < manifest.refresh.ttl_minutes) {
      console.log(`[lab] ${slug}: fresh (age ${Math.round(ageMin)}m < ttl ${manifest.refresh.ttl_minutes}m) — skipping; use --force to refetch.`);
      return { slug, status: 'fresh', latest: prior.latest };
    }
  }

  const resolvedTweaks = resolveTweaks(manifest);
  const credentials = readCredentials(contextRoot);
  const secretValues = Object.values(credentials);

  // ── Script-hash tripwire: LOUD notice BEFORE executing a changed script. ──
  const newHash = computeScriptHash(manifest);
  if (newHash && prior?.scriptHash && prior.scriptHash !== newHash) {
    console.warn(`[lab] script changed since last run for ${slug} — review lab/scripts before trusting this sync.`);
  }

  try {
    const adapter = getAdapter(manifest);
    const rawSeries = await adapter.fetch({
      manifest,
      resolvedTweaks,
      credentials,
      fetchImpl: opts.fetchImpl,
    });
    const { series, granularity } = rollupSeries(rawSeries, resolvedTweaks.spanDays, aggFor(manifest));
    const latest = computeLatest(series, manifest.binding);

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
    writeCache(contextRoot, slug, cache);

    if (manifest.binding) writeBinding(contextRoot, slug, manifest.binding, latest);

    return { slug, status: 'ok', latest, granularity };
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
    writeCache(contextRoot, slug, failCache);

    return { slug, status: 'failed', error: message };
  }
}

export interface SyncAllResult {
  results: SyncResult[];
  failed: SyncResult[];
}

/** Sync a set of insights sequentially, aggregating failures. */
export async function syncAll(
  contextRoot: string,
  opts: SyncOptions = {},
): Promise<SyncAllResult> {
  const results: SyncResult[] = [];
  for (const manifest of listInsights(contextRoot)) {
    try {
      results.push(await syncInsight(contextRoot, manifest.slug, opts));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[lab] sync failed for ${manifest.slug}: ${message}`);
      results.push({ slug: manifest.slug, status: 'failed', error: message });
    }
  }
  return { results, failed: results.filter((r) => r.status === 'failed') };
}
