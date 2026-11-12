import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { closeInboxRows, raiseInboxRow } from '../owner-inbox.js';
import { CLOUD_META_FILE } from '../recall-cloud-config.js';
import { ensureSelfIgnoredDir } from './ignored-dir.js';

/**
 * Why the automatic cloud index stopped updating, and whether the owner was told.
 *
 * The owner's rule (2026-11-12): the index NEVER stops updating on its own judgement. Money is held by
 * the per-build cap and the rolling 24 h index cap; when one of those (or a permanent failure, a bad
 * key) stops an automatic build, the index goes stale, and a stale index must never sit silent. This
 * record is that state: written when an automatic build is stopped, removed by the next build that
 * lands. While it exists the prompt banner says the meaning index is stale, status and doctor say
 * why, and the owner gets ONE inbox row (the Super's agenda) with an Update he presses himself.
 *
 * `<root>/.embeddings/voyage-4.stop.json`: machine-local like the index (the folder is self-ignored).
 */

export type IndexStopReason = 'daily_index_cap' | 'max_usd' | 'failed';

export interface IndexStop {
  reason: IndexStopReason;
  /** When this stop began (the first stopped build of the run). */
  since: string;
  /** The last stopped build. */
  lastAt: string;
  /** When the index last landed (the meta's `updatedAt`), or null when it was never built. */
  asOf: string | null;
  /** The estimate a `max_usd` stop refused, so Update can name its cost. */
  estUsd: number | null;
  /** A failed build's machine code (`auth`, `policy`, …), never a message. */
  error: string | null;
  /** When the owner's inbox row was raised; null until it is. One row per stop, never one per build. */
  notifiedAt: string | null;
}

export const INDEX_STOP_FILE = 'voyage-4.stop.json';
export const INDEX_STOP_INBOX_KIND = 'recall-index-stopped';
const DEDUPE_KEY = 'recall-index-stopped';

const stopPath = (root: string): string => join(root, '.embeddings', INDEX_STOP_FILE);

const REASONS: readonly string[] = ['daily_index_cap', 'max_usd', 'failed'];

export function readIndexStop(contextRoot: string): IndexStop | null {
  try {
    const s = JSON.parse(readFileSync(stopPath(contextRoot), 'utf-8')) as IndexStop;
    return s && REASONS.includes(s.reason) && typeof s.since === 'string' ? s : null;
  } catch {
    return null;
  }
}

function indexAsOf(contextRoot: string): string | null {
  try {
    const m = JSON.parse(readFileSync(join(contextRoot, '.embeddings', CLOUD_META_FILE), 'utf-8')) as { updatedAt?: unknown };
    return typeof m.updatedAt === 'string' ? m.updatedAt : null;
  } catch {
    return null;
  }
}

/** The inbox row's words. English like every inbox title; the dashboard draws its own localised line from `detail`. */
function rowTitle(stop: IndexStop): string {
  const asOf = stop.asOf ? stop.asOf.slice(0, 10) : 'never built';
  const why = stop.reason === 'daily_index_cap'
    ? 'the 24 h index spend cap was reached'
    : stop.reason === 'max_usd'
      ? `the update would cost about $${(stop.estUsd ?? 0).toFixed(2)}, over the per-build cap`
      : `the last update failed (${stop.error ?? 'error'})`;
  return `Recall's meaning index stopped updating (as of ${asOf}): ${why}. Update runs it now.`;
}

/**
 * Record that an automatic build was stopped. Raises the owner's row on the first stop of a run (and
 * again only when the reason changes), never on every stopped build. Never throws: a courtesy write
 * must not fail the build that called it.
 */
export function noteIndexStop(
  contextRoot: string,
  what: { reason: IndexStopReason; estUsd?: number; error?: string; asOf?: string | null },
  home?: string,
  now: Date = new Date(),
): IndexStop | null {
  try {
    const prior = readIndexStop(contextRoot);
    const at = now.toISOString();
    const stop: IndexStop = {
      reason: what.reason,
      since: prior?.since ?? at,
      lastAt: at,
      // When the index last LANDED: kept from the run's first stop, or the caller's pre-build meta. A
      // stopped build may still rewrite the meta (a checkpoint), so the meta read is the last resort.
      asOf: prior ? prior.asOf : what.asOf !== undefined ? what.asOf : indexAsOf(contextRoot),
      estUsd: what.estUsd ?? null,
      error: what.error ?? null,
      notifiedAt: prior && prior.reason === what.reason ? prior.notifiedAt : null,
    };
    if (stop.notifiedAt === null) {
      raiseInboxRow(dirname(contextRoot), {
        kind: INDEX_STOP_INBOX_KIND, ref: 'recall', agent: null,
        title: rowTitle(stop),
        detail: JSON.stringify({ reason: stop.reason, asOf: stop.asOf, estUsd: stop.estUsd, error: stop.error }),
        actions: ['update-index', 'dismiss'], dedupeKey: DEDUPE_KEY,
      }, home, now);
      stop.notifiedAt = at;
    }
    ensureSelfIgnoredDir(join(contextRoot, '.embeddings'));
    const tmp = `${stopPath(contextRoot)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(stop));
    renameSync(tmp, stopPath(contextRoot));
    return stop;
  } catch {
    return null;
  }
}

/**
 * The owner pressed Update: his row stays open until a build lands (clearIndexStop closes it), and the
 * next stop raises a fresh row even for the same reason, so a failed Update never goes quiet.
 */
export function rearmIndexStop(contextRoot: string): void {
  try {
    const prior = readIndexStop(contextRoot);
    if (prior === null || prior.notifiedAt === null) return;
    const tmp = `${stopPath(contextRoot)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...prior, notifiedAt: null }));
    renameSync(tmp, stopPath(contextRoot));
  } catch { /* the row is still open; the next stop finds it by its dedupe key */ }
}

/** A build landed: the index is current again, its row goes. Never throws. */
export function clearIndexStop(contextRoot: string, home?: string): void {
  try {
    if (existsSync(stopPath(contextRoot))) rmSync(stopPath(contextRoot), { force: true });
  } catch { /* the next landed build removes it */ }
  closeInboxRows(dirname(contextRoot), (r) => r.kind === INDEX_STOP_INBOX_KIND, home);
}
