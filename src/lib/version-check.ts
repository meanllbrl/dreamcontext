import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

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
const AUTO_UPGRADE_MARKER_REL_PATH = '_dream_context/state/.auto-upgrade.json';
const DEFAULT_TTL_HOURS = 24;
const NPM_TIMEOUT_MS = 5_000;
/** Cooldown before re-attempting auto-upgrade for the SAME target version. */
const AUTO_UPGRADE_RETRY_MS = 24 * 60 * 60 * 1000;
/** Window after an attempt during which the manual upgrade nudge stays suppressed. */
const AUTO_UPGRADE_INFLIGHT_MS = 60 * 60 * 1000;

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
export interface NudgeOpts {
  /**
   * When true, suppress the manual "run dreamcontext upgrade" CLI line because
   * background auto-upgrade (on by default; see shouldSuppressCliNudge) is
   * handling it. The new-skill-packs line is still emitted — auto-upgrade only
   * reinstalls the CLI, not skill packs.
   */
  suppressCliNudge?: boolean;
}

export function buildNudge(
  installedCli: string,
  cache: VersionCache | null,
  installedPacks: string[],
  catalogPackNames: string[],
  opts: NudgeOpts = {},
): string | null {
  if (!cache || cache.latestCli === null) return null;

  const cliOutdated = compareVersions(installedCli, cache.latestCli) < 0;
  const showCliNudge = cliOutdated && !opts.suppressCliNudge;
  const newPacks = catalogPackNames.filter((p) => !installedPacks.includes(p));
  const hasNewPacks = newPacks.length > 0;

  if (!showCliNudge && !hasNewPacks) return null;

  const lines: string[] = ['## Update Available\n'];

  if (showCliNudge) {
    lines.push(`- **New version available: v${installedCli} → v${cache.latestCli}.** A new release can add, update, or remove hooks, prompts, sub-agents, and skills. Run \`dreamcontext upgrade\` to get it, then \`dreamcontext update\` to apply those changes to this project.`);
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

// ─── Auto-upgrade (DEFAULT ON, opt-out) ───────────────────────────────────────
//
// Faz 0 of the auto-update epic. The version-check cache already detects when a
// newer CLI is published; the SessionStart snapshot turns that into a manual
// nudge ("run dreamcontext upgrade"). On top of that, we fire the upgrade in the
// background — DETACHED and non-blocking — so the running prompt never stalls.
// The new global version takes effect on the NEXT session.
//
// This is ON BY DEFAULT. Opt out with DREAMCONTEXT_AUTO_UPGRADE=0, or the master
// kill-switch DREAMCONTEXT_VERSION_CHECK=0. The background install is best-effort:
// on systems where the global npm prefix needs elevated permissions it will fail
// silently — the in-flight-window logic (shouldSuppressCliNudge) then re-surfaces
// the manual nudge after AUTO_UPGRADE_INFLIGHT_MS so the user is never stranded.

/** Records the last auto-upgrade attempt so we never hammer npm every prompt. */
export interface AutoUpgradeMarker {
  attemptedFor: string; // the target (latest) version we last attempted
  at: number;           // Unix ms timestamp of that attempt
}

/** Fire-and-forget detached spawner. Injectable for tests. */
export type DetachedSpawner = (cmd: string, args: string[]) => void;

export interface AutoUpgradeDeps {
  readMarker?: (root: string) => AutoUpgradeMarker | null;
  writeMarker?: (root: string, m: AutoUpgradeMarker) => void;
  spawner?: DetachedSpawner;
  now?: number;
}

function markerPath(root: string): string {
  return join(root, AUTO_UPGRADE_MARKER_REL_PATH);
}

/** Read the auto-upgrade marker. Returns null on any error. Never throws. */
export function readAutoUpgradeMarker(root: string): AutoUpgradeMarker | null {
  const path = markerPath(root);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AutoUpgradeMarker>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.attemptedFor !== 'string' || typeof parsed.at !== 'number') return null;
    return { attemptedFor: parsed.attemptedFor, at: parsed.at };
  } catch {
    return null;
  }
}

/** Write the auto-upgrade marker. Creates parent dirs. Never throws. */
export function writeAutoUpgradeMarker(root: string, marker: AutoUpgradeMarker): void {
  const path = markerPath(root);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(marker, null, 2) + '\n', 'utf-8');
  } catch {
    // Best-effort — marker write failure just means we may re-attempt sooner.
  }
}

/**
 * Whether background auto-upgrade is enabled. ON BY DEFAULT.
 * Opt out with DREAMCONTEXT_AUTO_UPGRADE=0, or the master kill-switch
 * DREAMCONTEXT_VERSION_CHECK=0 (which also disables the network refresh).
 */
export function autoUpgradeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DREAMCONTEXT_VERSION_CHECK === '0') return false;
  return env.DREAMCONTEXT_AUTO_UPGRADE !== '0';
}

/**
 * PURE gate: decide whether an auto-upgrade should run.
 * Returns the target version to upgrade to, or null.
 *
 * Triggers only when ALL hold:
 *   - auto-upgrade is enabled (default on; opt out with DREAMCONTEXT_AUTO_UPGRADE=0)
 *   - cache exists with a non-null latestCli (we know what's out there)
 *   - the installed CLI is strictly older than latestCli
 */
export function shouldAutoUpgrade(
  installedCli: string,
  cache: VersionCache | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!autoUpgradeEnabled(env)) return null;
  if (!cache || cache.latestCli === null) return null;
  if (compareVersions(installedCli, cache.latestCli) >= 0) return null;
  return cache.latestCli;
}

/**
 * PURE: should the manual "run dreamcontext upgrade" nudge be suppressed?
 *
 * Only while a background auto-upgrade for the CURRENT target is freshly in
 * flight (attempted within AUTO_UPGRADE_INFLIGHT_MS). If we attempted long ago
 * and are STILL behind, the upgrade likely failed (e.g. global npm needs sudo)
 * — surface the nudge so the user can act. This is the faithful reading of
 * "don't nag IF we manage to auto-update": stay quiet only while it's plausibly
 * working, not forever.
 */
export function shouldSuppressCliNudge(
  target: string | null,
  marker: AutoUpgradeMarker | null,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): boolean {
  if (!autoUpgradeEnabled(env)) return false;
  if (!target || !marker) return false;
  if (marker.attemptedFor !== target) return false;
  return now - marker.at < AUTO_UPGRADE_INFLIGHT_MS;
}

/** Default detached spawner: `npm install -g dreamcontext@latest`, fire-and-forget. */
function defaultSpawner(cmd: string, args: string[]): void {
  // Windows: npm is npm.cmd, and since the CVE-2024-27980 hardening Node
  // throws EINVAL on spawning .cmd files without a shell — auto-upgrade
  // silently never ran there. Args are fixed literals, so shell:true is safe.
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: process.platform === 'win32' });
  child.unref();
}

/**
 * Orchestrate the (default-on, opt-out) auto-upgrade. Returns a one-line notice
 * string when an upgrade was triggered this call, or null when nothing happened.
 *
 * Idempotency: triggers at most once per distinct target version. A repeat for
 * the same target is suppressed until AUTO_UPGRADE_RETRY_MS has elapsed (so a
 * failed attempt is retried next day, not every prompt). Never throws.
 */
export function maybeAutoUpgrade(
  root: string,
  installedCli: string,
  cache: VersionCache | null,
  env: NodeJS.ProcessEnv = process.env,
  deps: AutoUpgradeDeps = {},
): string | null {
  try {
    const target = shouldAutoUpgrade(installedCli, cache, env);
    if (!target) return null;

    const now = deps.now ?? Date.now();
    const readMarker = deps.readMarker ?? readAutoUpgradeMarker;
    const writeMarker = deps.writeMarker ?? writeAutoUpgradeMarker;

    const marker = readMarker(root);
    const recentlyAttempted =
      marker !== null &&
      marker.attemptedFor === target &&
      now - marker.at < AUTO_UPGRADE_RETRY_MS;
    if (recentlyAttempted) return null;

    // Claim the slot BEFORE spawning. Writing the marker first means a near-
    // simultaneous second hook process (rapid successive prompts) reads it and
    // backs off, so we don't fire two concurrent `npm install -g`. This narrows
    // the race to just the marker write round-trip; it does NOT fully eliminate
    // a true TOCTOU (two processes both reading null before either writes). That
    // residual window is tiny and concurrent global installs of the same package
    // are tolerable, so we accept it rather than add a cross-process file lock.
    // Trade-off: if the spawn below throws, we've recorded an attempt that did
    // not happen — but the in-flight-window fallback re-surfaces the manual
    // nudge after AUTO_UPGRADE_INFLIGHT_MS, so the user is not stranded.
    writeMarker(root, { attemptedFor: target, at: now });

    const spawner = deps.spawner ?? defaultSpawner;
    spawner('npm', ['install', '-g', 'dreamcontext@latest']);

    return `⬆ Auto-upgrading dreamcontext v${installedCli} → v${target} in the background (takes effect next session).`;
  } catch {
    // Auto-upgrade is best-effort; never break the caller.
    return null;
  }
}
