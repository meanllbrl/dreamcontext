import type { InsightSummary, LabSyncJob, SyncResult } from '../../../hooks/useLab';

/**
 * WHEN A BOARD SYNCS ON ITS OWN (plan D6, r3.2), as pure functions.
 *
 * Opening a board starts ONE automatic job over the insights whose data has
 * expired, and nothing when every card is fresh. While the board is visible a
 * 60 s timer and every return to the tab re-ask the same question of the
 * summaries already loaded; nothing is fetched to answer it.
 *
 * "Expired" is the engine's rule, read client-side: age counts from the newer
 * of the last real fetch (`fetchedAt`) and this machine's last "upstream
 * unchanged" confirmation (`checkedAt`), against the insight's TTL. An insight
 * whose last run failed within max(TTL, 15 min) is left alone, the same backoff
 * the server applies to automatic runs, so a failing source never flickers
 * "syncing" every minute. A slug this page already asked for automatically is
 * not asked again within that same window (the server may have had a reason
 * to skip it that the summary does not show).
 *
 * Automatic requests carry NO `force`: absent is what tells the server this is
 * not a person asking. Sync board and ↻ send `'user'`; that is not decided here.
 */

/** The error backoff floor, in minutes (the server's `max(TTL, 15 min)`). */
export const ERROR_BACKOFF_FLOOR_MINUTES = 15;
/** How often a visible board re-checks staleness. */
export const RECHECK_MS = 60_000;

const MINUTE = 60_000;

function time(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** The backoff / re-ask window for one insight, in ms. */
export function backoffMs(summary: Pick<InsightSummary, 'ttlMinutes'>): number {
  const ttl = Number.isFinite(summary.ttlMinutes) ? Math.max(0, summary.ttlMinutes) : 0;
  return Math.max(ttl, ERROR_BACKOFF_FLOOR_MINUTES) * MINUTE;
}

/** When the data was last known good: max(fetchedAt, checkedAt), or null (never fetched). */
export function lastConfirmedAt(summary: Pick<InsightSummary, 'fetchedAt' | 'checkedAt'>): number | null {
  const fetched = time(summary.fetchedAt);
  if (fetched === null) return null;
  const checked = time(summary.checkedAt ?? null);
  return checked !== null && checked > fetched ? checked : fetched;
}

/** Past its TTL (or never fetched). */
export function isExpired(summary: Pick<InsightSummary, 'fetchedAt' | 'checkedAt' | 'ttlMinutes'>, now: number): boolean {
  const at = lastConfirmedAt(summary);
  if (at === null) return true;
  return now - at > Math.max(0, summary.ttlMinutes) * MINUTE;
}

/** Its last run failed recently enough that an automatic run must leave it alone. */
export function inErrorBackoff(summary: Pick<InsightSummary, 'errorAt' | 'ttlMinutes'>, now: number): boolean {
  const at = time(summary.errorAt);
  return at !== null && now - at < backoffMs(summary);
}

export interface ExpiredOptions {
  /** slug -> when this page last asked for it automatically (ms). */
  recent?: ReadonlyMap<string, number>;
  /** Slugs a running or queued job already covers, or 'all' (an unscoped job). */
  busy?: ReadonlySet<string> | 'all';
}

/** The slugs an automatic job should sync now, sorted. Empty = start no job at all. */
export function expiredSlugs(
  summaries: Readonly<Record<string, InsightSummary>>,
  now: number,
  { recent, busy }: ExpiredOptions = {},
): string[] {
  if (busy === 'all') return [];
  const out: string[] = [];
  for (const [slug, s] of Object.entries(summaries)) {
    if (!isExpired(s, now) || inErrorBackoff(s, now)) continue;
    if (busy?.has(slug)) continue;
    const asked = recent?.get(slug);
    if (asked !== undefined && now - asked < backoffMs(s)) continue;
    out.push(slug);
  }
  return out.sort();
}

/** The body of an automatic `POST /api/lab/sync-jobs`: slugs only, never a force. Null = no job. */
export function automaticSyncRequest(slugs: readonly string[]): { slugs: string[] } | null {
  return slugs.length > 0 ? { slugs: [...slugs] } : null;
}

/** Board open, the 60 s timer and a return to the tab all ask this: the automatic request, or null (no job). */
export function planAutomaticSync(
  summaries: Readonly<Record<string, InsightSummary>>,
  now: number,
  opts: ExpiredOptions = {},
): { slugs: string[] } | null {
  return automaticSyncRequest(expiredSlugs(summaries, now, opts));
}

/** What a job covers: its slugs, or 'all' (unscoped). Settled jobs cover nothing. */
export function jobCoverage(job: LabSyncJob | null | undefined): ReadonlySet<string> | 'all' {
  if (!job || (job.status !== 'running' && job.status !== 'queued')) return new Set();
  return job.slugs === null ? 'all' : new Set(job.slugs);
}

function covers(coverage: ReadonlySet<string> | 'all', slug: string): boolean {
  return coverage === 'all' || coverage.has(slug);
}

/** Both slots' coverage, as one busy set for `expiredSlugs`. */
export function busySlugs(running: LabSyncJob | null | undefined, pending: LabSyncJob | null | undefined): ReadonlySet<string> | 'all' {
  const a = jobCoverage(running);
  const b = jobCoverage(pending);
  if (a === 'all' || b === 'all') return 'all';
  return new Set([...a, ...b]);
}

export type CardSyncState = 'syncing' | 'queued' | null;

/** A card's live sync state: queued behind the running job, being synced now, or neither. */
export function cardSyncState(
  slug: string | undefined,
  running: LabSyncJob | null | undefined,
  pending: LabSyncJob | null | undefined,
): CardSyncState {
  if (!slug) return null;
  if (covers(jobCoverage(pending), slug)) return 'queued';
  if (running?.status === 'running' && covers(jobCoverage(running), slug)
    && !running.results.some((r) => r.slug === slug)) return 'syncing';
  return null;
}

export type FreshReason = 'ttl' | 'upstream-unchanged';

/**
 * Why the card's data is current without a new fetch, when that is known: the
 * last job's own word for this slug, else "upstream unchanged" when this
 * machine's last confirmation is newer than the data itself.
 */
export function freshReason(
  summary: Pick<InsightSummary, 'fetchedAt' | 'checkedAt'> | undefined,
  lastResult?: Pick<SyncResult, 'status' | 'reason'> | null,
): FreshReason | null {
  if (lastResult?.status === 'fresh' && (lastResult.reason === 'ttl' || lastResult.reason === 'upstream-unchanged')) {
    return lastResult.reason;
  }
  if (!summary) return null;
  const fetched = time(summary.fetchedAt);
  const checked = time(summary.checkedAt ?? null);
  return fetched !== null && checked !== null && checked > fetched ? 'upstream-unchanged' : null;
}
