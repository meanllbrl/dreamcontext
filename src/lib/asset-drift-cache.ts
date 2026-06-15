/**
 * Used-asset drift cache.
 *
 * The SessionStart "stale project assets" nag (see setup-drift.ts) fires on a
 * cheap version comparison (`setupVersion < cliVersion`). But a CLI version bump
 * does NOT necessarily change any asset THIS project actually uses — the release
 * may only have touched packs the project never installed. Nagging then is a
 * false positive: `dreamcontext update` would be a content no-op for the user.
 *
 * Deciding that requires a content comparison of the project's used assets
 * (core + installed packs) against what the current CLI would install — which is
 * async + writes installer logs to stdout, so it can't run inside the sync,
 * stdout-sensitive SessionStart snapshot. Instead a detached process recomputes
 * it on the ≤once/24h hook tick and persists the verdict here; the snapshot reads
 * this cache synchronously.
 *
 * Machine-local: lives under `_dream_context/state/` (gitignored), never shared.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface AssetDriftCache {
  /** CLI version the verdict was computed for. */
  cliVersion: string;
  /** Project setupVersion the verdict was computed for. */
  setupVersion: string;
  /** True iff an update would add/modify a file this project uses. */
  usedAssetsChanged: boolean;
  /** Epoch ms the verdict was computed (advisory; staleness is keyed on versions). */
  checkedAt: number;
}

/** Cache path: `<contextRoot>/state/.asset-drift.json` (contextRoot = `_dream_context`). */
export function assetDriftCachePath(contextRoot: string): string {
  return join(contextRoot, 'state', '.asset-drift.json');
}

export function readAssetDriftCache(contextRoot: string): AssetDriftCache | null {
  try {
    const p = assetDriftCachePath(contextRoot);
    if (!existsSync(p)) return null;
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as Partial<AssetDriftCache>;
    if (
      !parsed ||
      typeof parsed.cliVersion !== 'string' ||
      typeof parsed.setupVersion !== 'string' ||
      typeof parsed.usedAssetsChanged !== 'boolean'
    ) {
      return null;
    }
    return {
      cliVersion: parsed.cliVersion,
      setupVersion: parsed.setupVersion,
      usedAssetsChanged: parsed.usedAssetsChanged,
      checkedAt: typeof parsed.checkedAt === 'number' ? parsed.checkedAt : 0,
    };
  } catch {
    return null;
  }
}

export function writeAssetDriftCache(contextRoot: string, cache: AssetDriftCache): void {
  const p = assetDriftCachePath(contextRoot);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cache, null, 2) + '\n', 'utf-8');
}

/**
 * Confident-clean test: returns true ONLY when the cache was computed for the
 * exact cli+setup versions being evaluated now AND recorded "no used asset
 * changed". Every other state — absent, version-mismatched (recomputed since an
 * upgrade/update), or changed=true — is NOT a confident suppression, so callers
 * must fail open and show the drift nag rather than risk hiding a real update.
 */
export function cacheConfidentlyClean(
  cache: AssetDriftCache | null,
  cliVersion: string,
  setupVersion: string,
): boolean {
  return (
    cache !== null &&
    cache.cliVersion === cliVersion &&
    cache.setupVersion === setupVersion &&
    cache.usedAssetsChanged === false
  );
}
