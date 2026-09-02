import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { labDir, isSafeInsightSlug } from './store.js';
import type { InsightCache } from './types.js';

/**
 * Transient window cache — the storage half of report window inheritance.
 *
 * A report's date navigator IS its measurement window (owner decision,
 * 2026-09-01): picking a week re-measures every item over that week. Those
 * re-measurements must NEVER touch the canonical cache — the canonical cache
 * backs the board, the KR bindings and the snapshot history, and silently
 * moving it is exactly the 42.31→0 refund-KR corruption the window task
 * documented. So a window-overridden sync lands HERE instead:
 *
 *   lab/cache/.windows/<slug>/<fromISO>_<toISO>.json
 *
 * One full InsightCache per (slug, window), with `history`/`*History` left
 * out — trails belong to the canonical timeline, a transient measurement has
 * none. Entries are pruned per slug (newest WINDOW_CACHE_MAX_PER_SLUG kept by
 * mtime). Freshness is the READER's policy (reports-store compares fetchedAt
 * against the manifest's ttl_minutes — past windows still go stale because
 * attribution lags backfill the past); storage stays dumb.
 */

export interface WindowRange {
  fromISO: string;
  toISO: string;
}

/** Per-slug entry cap — a report reader walks a handful of weeks, not a year. */
export const WINDOW_CACHE_MAX_PER_SLUG = 12;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** True for a structurally valid, path-safe window. */
export function isValidWindow(w: WindowRange): boolean {
  return ISO_DAY.test(w.fromISO) && ISO_DAY.test(w.toISO)
    && !Number.isNaN(Date.parse(`${w.fromISO}T00:00:00Z`))
    && !Number.isNaN(Date.parse(`${w.toISO}T00:00:00Z`))
    && w.fromISO <= w.toISO;
}

export function windowKey(w: WindowRange): string {
  return `${w.fromISO}_${w.toISO}`;
}

export function windowCacheDir(contextRoot: string, slug: string): string {
  return join(labDir(contextRoot), 'cache', '.windows', slug);
}

export function windowCachePath(contextRoot: string, slug: string, w: WindowRange): string {
  return join(windowCacheDir(contextRoot, slug), `${windowKey(w)}.json`);
}

/** The cached measurement for (slug, window), or null. Lenient: unreadable → null. */
export function readWindowCache(
  contextRoot: string,
  slug: string,
  w: WindowRange,
): InsightCache | null {
  if (!isSafeInsightSlug(slug) || !isValidWindow(w)) return null;
  const path = windowCachePath(contextRoot, slug, w);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as InsightCache;
  } catch {
    return null;
  }
}

/** Atomic write + per-slug prune (keep the newest entries by mtime). */
export function writeWindowCache(
  contextRoot: string,
  slug: string,
  w: WindowRange,
  cache: InsightCache,
): void {
  if (!isSafeInsightSlug(slug) || !isValidWindow(w)) return;
  const dir = windowCacheDir(contextRoot, slug);
  mkdirSync(dir, { recursive: true });
  const path = windowCachePath(contextRoot, slug, w);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path); // atomic replace
  pruneWindowCache(dir);
}

function pruneWindowCache(dir: string): void {
  let files: { path: string; mtime: number }[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const path = join(dir, f);
        return { path, mtime: statSync(path).mtimeMs };
      });
  } catch {
    return; // pruning is best-effort — a read race must not fail the write
  }
  if (files.length <= WINDOW_CACHE_MAX_PER_SLUG) return;
  files.sort((a, b) => b.mtime - a.mtime);
  for (const stale of files.slice(WINDOW_CACHE_MAX_PER_SLUG)) {
    try {
      rmSync(stale.path, { force: true });
    } catch {
      // best-effort
    }
  }
}
