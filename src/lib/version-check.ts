import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface VersionCache {
  checkedAt: number;       // Unix ms timestamp
  latestCli: string | null;
  availablePacks: string[];
  ttlHours: number;
}

/** Injectable runner for refreshVersionCache — receives same interface as execFileSync. */
export type NpmRunner = (args: string[]) => string;

export interface RefreshOpts {
  runner?: NpmRunner;
  catalogPackNames?: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CACHE_REL_PATH = '_dream_context/state/.version-check.json';
const DEFAULT_TTL_HOURS = 24;
const NPM_TIMEOUT_MS = 5_000;

// ─── Cache path ──────────────────────────────────────────────────────────────

function cachePath(root: string): string {
  return join(root, CACHE_REL_PATH);
}

// ─── Read / Write ────────────────────────────────────────────────────────────

/**
 * Read the version cache synchronously.
 * Returns null on any error (missing file, malformed JSON, etc.).
 * Never throws.
 */
export function readVersionCache(root: string): VersionCache | null {
  const path = cachePath(root);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<VersionCache>;
    if (!parsed || typeof parsed !== 'object') return null;
    // Validate required fields
    if (typeof parsed.checkedAt !== 'number') return null;
    return {
      checkedAt: parsed.checkedAt,
      latestCli: typeof parsed.latestCli === 'string' ? parsed.latestCli : null,
      availablePacks: Array.isArray(parsed.availablePacks)
        ? parsed.availablePacks.filter((p): p is string => typeof p === 'string')
        : [],
      ttlHours: typeof parsed.ttlHours === 'number' ? parsed.ttlHours : DEFAULT_TTL_HOURS,
    };
  } catch {
    return null;
  }
}

/**
 * Write the version cache. Creates parent directories as needed.
 * Never throws.
 */
export function writeVersionCache(root: string, cache: VersionCache): void {
  const path = cachePath(root);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache, null, 2) + '\n', 'utf-8');
  } catch {
    // Silently ignore write failures — version check is best-effort
  }
}

// ─── TTL / Freshness ─────────────────────────────────────────────────────────

/**
 * Returns true if the cache was written within the TTL window.
 * Returns false for any malformed/missing field — treats malformed as stale.
 * Never throws.
 */
export function isCacheFresh(cache: VersionCache | null, nowMs?: number): boolean {
  if (!cache) return false;
  try {
    if (typeof cache.checkedAt !== 'number' || !isFinite(cache.checkedAt)) return false;
    const ttlHours = typeof cache.ttlHours === 'number' && isFinite(cache.ttlHours) && cache.ttlHours > 0
      ? cache.ttlHours
      : DEFAULT_TTL_HOURS;
    const ttlMs = ttlHours * 60 * 60 * 1000;
    const now = nowMs ?? Date.now();
    return now - cache.checkedAt < ttlMs;
  } catch {
    return false;
  }
}

// ─── Version comparison ──────────────────────────────────────────────────────

/**
 * Semver-lite comparison: numeric segment compare, ignores pre-release suffixes.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 * Handles '0.0.0' sentinel — always equal to itself.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  // Strip pre-release suffixes (anything after a '-' in a segment or after the patch)
  const clean = (v: string) => v.replace(/[-+].*$/, '').trim();
  const parseSegments = (v: string): number[] =>
    clean(v).split('.').map((s) => {
      const n = parseInt(s, 10);
      return isFinite(n) ? n : 0;
    });

  const segA = parseSegments(a);
  const segB = parseSegments(b);
  const len = Math.max(segA.length, segB.length);

  for (let i = 0; i < len; i++) {
    const sa = segA[i] ?? 0;
    const sb = segB[i] ?? 0;
    if (sa < sb) return -1;
    if (sa > sb) return 1;
  }
  return 0;
}

// ─── Nudge builder (PURE — no I/O) ──────────────────────────────────────────

/**
 * Build an update nudge string or return null.
 *
 * Returns null when:
 *   - latestCli is null (offline / unknown)
 *   - installed CLI is current and no new packs exist
 *
 * @param installedCli  Currently installed CLI version string
 * @param cache         The cached version info (may be null → returns null)
 * @param installedPacks Pack names already installed in the project
 * @param catalogPackNames All pack names available in the catalog
 */
export function buildNudge(
  installedCli: string,
  cache: VersionCache | null,
  installedPacks: string[],
  catalogPackNames: string[],
): string | null {
  if (!cache || cache.latestCli === null) return null;

  const cliOutdated = compareVersions(installedCli, cache.latestCli) < 0;
  const newPacks = catalogPackNames.filter((p) => !installedPacks.includes(p));
  const hasNewPacks = newPacks.length > 0;

  if (!cliOutdated && !hasNewPacks) return null;

  const lines: string[] = ['## Update Available\n'];

  if (cliOutdated) {
    lines.push(`- CLI: v${installedCli} → v${cache.latestCli} — run \`dreamcontext upgrade\` then \`dreamcontext update\``);
  }
  if (hasNewPacks) {
    lines.push(`- New skill pack${newPacks.length > 1 ? 's' : ''} available: ${newPacks.join(', ')} — run \`dreamcontext install-skill --packs\``);
  }

  return lines.join('\n');
}

// ─── Network refresh (ONLY networked function) ────────────────────────────────

/**
 * Fetch the latest dreamcontext version from npm and write the cache.
 * This is the ONLY function that touches the network.
 * - Calls `npm view dreamcontext version` with a 5s timeout.
 * - On ANY failure, writes latestCli: null (offline sentinel) and never throws.
 * - availablePacks are injected by the caller (no catalog import in this lib).
 */
export function refreshVersionCache(root: string, opts?: RefreshOpts): void {
  const runner: NpmRunner = opts?.runner ?? ((args: string[]) =>
    execFileSync('npm', args, {
      timeout: NPM_TIMEOUT_MS,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as unknown as string
  );

  const catalogPackNames = opts?.catalogPackNames ?? [];

  let latestCli: string | null = null;

  try {
    const raw = runner(['view', 'dreamcontext', 'version']);
    const trimmed = (typeof raw === 'string' ? raw : '').trim();
    // Validate it looks like a version string
    if (/^\d+\.\d+/.test(trimmed)) {
      latestCli = trimmed;
    }
  } catch {
    // Network failure, npm not found, timeout — write null sentinel
    latestCli = null;
  }

  const cache: VersionCache = {
    checkedAt: Date.now(),
    latestCli,
    availablePacks: catalogPackNames,
    ttlHours: DEFAULT_TTL_HOURS,
  };

  writeVersionCache(root, cache);
}
