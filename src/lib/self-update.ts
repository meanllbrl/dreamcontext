import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { acquireFileLock, reclaimDeadHolderLock, releaseFileLock } from './file-lock.js';
import { readDreamcontextVersionFromDisk } from './manifest.js';
import { cliPackageVersion, npmInstallCommand, resolveNpmTarget, targetCliEntry } from './npm-target.js';
import { cliAutoUpdateOffPath, compareVersions, selfUpdateLockPath } from './version-check.js';

/**
 * The desktop app keeps its own CLI current (task auto-update-reaches-users…, 2026-10-27).
 *
 * 0.35.0 reached nobody on its own: the app runs the global npm CLI, and the only thing that
 * upgraded it was the Claude prompt hook — at most once a day, only when a message was typed in
 * a project. This is the app-side trigger: the app-owned server asks here ~90 s after launch and
 * every half hour after, a 6 h throttle on a shared state file decides whether a check runs, and
 * a newer CLI is installed by the ONE existing upgrade path (`dreamcontext upgrade --yes`, the
 * job behind the "Upgrade everything" badge, src/server/upgrade-job.ts), which installs into the
 * prefix of the CLI the app runs (src/lib/npm-target.ts) and refreshes every project.
 *
 * Safety, each its own rule:
 * - one run at a time: an O_EXCL lock in ~/.dreamcontext (the prompt hook stands back while it
 *   is held), plus one in-flight promise per process;
 * - never under a running chat: a busy chat defers the run to the next tick (and the relaunch
 *   waits too, src/server/routes/health.ts);
 * - never a loop: a target that failed is retried at most once a day, and the relaunch only
 *   follows a strictly newer version on disk;
 * - opt-out: Settings (a marker file), DREAMCONTEXT_AUTO_UPGRADE=0, DREAMCONTEXT_VERSION_CHECK=0;
 * - every outcome lands in ~/.dreamcontext/self-update.json (what Settings shows) and one line
 *   in ~/.dreamcontext/logs/self-update.log.
 */

export type SelfUpdateState = 'current' | 'updating' | 'updated' | 'failed' | 'deferred' | 'disabled' | 'unknown';

export interface SelfUpdateRecord {
  /** When the last real check STARTED (the throttle reads it). 0 = never checked. */
  checkedAt: number;
  /** When this record was written. */
  at: number;
  installed: string | null;
  latest: string | null;
  state: SelfUpdateState;
  /** The version the last upgrade attempt aimed at, and when. */
  attemptedFor?: string;
  lastAttemptAt?: number;
  /** The target whose upgrade last FAILED, and when. Kept through deferred, unknown and
   *  disabled records (they overwrite `state`), cleared only by a success or a current check,
   *  so the once-a-day retry limit cannot be stepped around. */
  failedFor?: string;
  failedAt?: number;
  from?: string;
  to?: string;
  /** A failure's output tail, or why it was skipped (deferred/disabled). */
  error?: string;
  reason?: string;
}

export interface SelfUpdateResult {
  /** Whether a check ran (false: throttled, joined, or another process holds the lock). */
  ran: boolean;
  state: SelfUpdateState | 'skipped';
  message: string;
}

export interface SelfUpdateDeps {
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  intervalMs?: number;
  /** A chat is mid-turn (default: never; the server injects its own). */
  busy?: () => boolean;
  /** The version of the CLI install the upgrade targets, read fresh. */
  installedVersion?: () => string | null;
  /** The latest published version, or null when npm cannot be reached. */
  latestVersion?: () => Promise<string | null>;
  /** Run the upgrade job and report how it ended. Required for a real run. */
  runUpgrade?: () => Promise<{ ok: boolean; output: string }>;
}

export const SELF_UPDATE_INTERVAL_MS = 6 * 60 * 60_000;
/** A target that failed is tried again after a day, not on every tick. */
export const SELF_UPDATE_RETRY_MS = 24 * 60 * 60_000;
/** The lock outlives the longest upgrade (12 min) with room; a live holder is never broken. */
const LOCK_STALE_MS = 20 * 60_000;
const LATEST_TIMEOUT_MS = 30_000;
const LOG_MAX_BYTES = 1024 * 1024;

// ─── Paths, opt-out ──────────────────────────────────────────────────────────────

export function selfUpdateStatePath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'self-update.json');
}

export function selfUpdateLogPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'logs', 'self-update.log');
}

/** Why automatic updates are off, or null when they are on. */
export function selfUpdateDisabledBy(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | null {
  if (env.DREAMCONTEXT_VERSION_CHECK === '0') return 'DREAMCONTEXT_VERSION_CHECK=0';
  if (env.DREAMCONTEXT_AUTO_UPGRADE === '0') return 'DREAMCONTEXT_AUTO_UPGRADE=0';
  if (existsSync(cliAutoUpdateOffPath(home))) return 'turned off in Settings';
  return null;
}

/** Is the Settings switch off (its marker on disk)? Separate from the variables, which a
 *  Settings view reports beside the switch rather than as its state. */
export function selfUpdateMarkerOff(home: string = homedir()): boolean {
  return existsSync(cliAutoUpdateOffPath(home));
}

/** The Settings switch: remove the marker (on) or write it (off). Returns the resulting state. */
export function setSelfUpdateEnabled(enabled: boolean, home: string = homedir()): boolean {
  const marker = cliAutoUpdateOffPath(home);
  if (enabled) {
    rmSync(marker, { force: true });
  } else {
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, 'Written by Settings → This machine → Update dreamcontext automatically. Delete it to turn updates back on.\n');
  }
  return !existsSync(marker);
}

// ─── Record + log ────────────────────────────────────────────────────────────────

const STATES: readonly SelfUpdateState[] = ['current', 'updating', 'updated', 'failed', 'deferred', 'disabled', 'unknown'];
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function readSelfUpdateRecord(home: string = homedir()): SelfUpdateRecord | null {
  try {
    const raw = JSON.parse(readFileSync(selfUpdateStatePath(home), 'utf-8')) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const checkedAt = num(raw.checkedAt);
    const state = STATES.includes(raw.state as SelfUpdateState) ? (raw.state as SelfUpdateState) : null;
    if (checkedAt === undefined || !state) return null;
    const rec: SelfUpdateRecord = {
      checkedAt,
      at: num(raw.at) ?? checkedAt,
      installed: str(raw.installed) ?? null,
      latest: str(raw.latest) ?? null,
      state,
    };
    for (const k of ['attemptedFor', 'failedFor', 'from', 'to', 'error', 'reason'] as const) {
      const v = str(raw[k]);
      if (v) rec[k] = v;
    }
    const lastAttemptAt = num(raw.lastAttemptAt);
    if (lastAttemptAt !== undefined) rec.lastAttemptAt = lastAttemptAt;
    const failedAt = num(raw.failedAt);
    if (failedAt !== undefined) rec.failedAt = failedAt;
    return rec;
  } catch {
    return null;
  }
}

/** tmp + rename so a reader (Settings) never sees half a file. Never throws. */
export function writeSelfUpdateRecord(home: string, record: SelfUpdateRecord): void {
  const path = selfUpdateStatePath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n');
    renameSync(tmp, path);
  } catch {
    /* unwritable home: the next tick simply checks again */
  }
}

/** One stamped line in ~/.dreamcontext/logs/self-update.log (rotated past 1 MiB). Never throws. */
export function appendSelfUpdateLog(home: string, line: string, now: number = Date.now()): void {
  const path = selfUpdateLogPath(home);
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && statSync(path).size > LOG_MAX_BYTES) renameSync(path, `${path}.1`);
    appendFileSync(path, `${new Date(now).toISOString()} ${line}\n`);
  } catch {
    /* best-effort */
  }
}

/** Last `n` non-empty lines of a command's output. */
export function outputTail(output: string, n = 6): string {
  return output.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-n).join('\n');
}

// ─── Defaults ───────────────────────────────────────────────────────────────────

/** The targeted install's version (its package.json), else this build's own stamp. */
export function defaultInstalledVersion(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = cliPackageVersion(targetCliEntry(env)) ?? readDreamcontextVersionFromDisk();
  return v && v !== '0.0.0' ? v : null;
}

/** The last `x.y.z` line of `npm view dreamcontext version`. */
export function parseLatestVersion(output: string): string | null {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(l));
  return lines.length ? lines[lines.length - 1] : null;
}

/**
 * `npm view dreamcontext version` with the npm the upgrade will install with, through the
 * user's login shell (a Finder-started app has no PATH to find npm or node on). Null on any
 * failure.
 */
export function defaultLatestVersion(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const cmd = npmInstallCommand(['view', 'dreamcontext', 'version'], resolveNpmTarget(targetCliEntry(env)));
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (v: string | null) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    let timer: NodeJS.Timeout | undefined;
    try {
      const child = spawn(env.SHELL || '/bin/zsh', ['-ilc', 'exec "$0" "$@"', cmd.file, ...cmd.args], {
        env: { ...env },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      child.stdout?.on('data', (c: Buffer) => { out = (out + c.toString('utf-8')).slice(-4000); });
      timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } done(null); }, LATEST_TIMEOUT_MS);
      timer.unref?.();
      child.on('error', () => done(null));
      child.on('close', (code) => done(code === 0 ? parseLatestVersion(out) : null));
    } catch {
      done(null);
    }
  });
}

// ─── The check ──────────────────────────────────────────────────────────────────

let inFlight: Promise<SelfUpdateResult> | null = null;

/** True while a check (or its upgrade) runs in this process. */
export function selfUpdateInFlight(): boolean {
  return inFlight !== null;
}

/**
 * Check for a newer CLI and, when there is one, run the upgrade. One per process: a second
 * call joins the one in flight. `force` skips the 6 h throttle (not the opt-out, the busy
 * deferral, the lock or the daily retry limit). Never throws.
 */
export function runSelfUpdateCheck(opts: { force?: boolean } = {}, deps: SelfUpdateDeps = {}): Promise<SelfUpdateResult> {
  if (inFlight) return inFlight;
  const promise = checkOnce(opts.force === true, deps).finally(() => {
    if (inFlight === promise) inFlight = null;
  });
  inFlight = promise;
  return promise;
}

async function checkOnce(force: boolean, deps: SelfUpdateDeps): Promise<SelfUpdateResult> {
  const home = deps.home ?? homedir();
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const busy = deps.busy ?? (() => false);
  const intervalMs = deps.intervalMs ?? SELF_UPDATE_INTERVAL_MS;
  const log = (line: string) => appendSelfUpdateLog(home, line, now());
  const prev = readSelfUpdateRecord(home);
  const keep = (rec: SelfUpdateRecord | null) => ({
    checkedAt: rec?.checkedAt ?? 0,
    installed: rec?.installed ?? null,
    latest: rec?.latest ?? null,
    ...(rec?.attemptedFor ? { attemptedFor: rec.attemptedFor } : {}),
    ...(rec?.lastAttemptAt !== undefined ? { lastAttemptAt: rec.lastAttemptAt } : {}),
    ...(rec?.failedFor ? { failedFor: rec.failedFor } : {}),
    ...(rec?.failedAt !== undefined ? { failedAt: rec.failedAt } : {}),
    ...(rec?.error && rec.failedFor ? { error: rec.error } : {}),
  });
  /** A success or a current check ends the failure it carried. */
  const cleared = <T extends Partial<SelfUpdateRecord>>(r: T): T => {
    const { failedFor: _f, failedAt: _a, error: _e, ...rest } = r;
    return rest as T;
  };
  // A state that only repeats (still off, still deferred) is written and logged once, so a
  // half-hourly tick cannot fill the log.
  const note = (state: 'disabled' | 'deferred', reason: string, message: string): SelfUpdateResult => {
    if (prev?.state !== state || prev.reason !== reason) {
      writeSelfUpdateRecord(home, { ...keep(prev), at: now(), state, reason });
      log(message);
    }
    return { ran: false, state, message };
  };

  try {
    const disabledBy = selfUpdateDisabledBy(env, home);
    if (disabledBy) return note('disabled', disabledBy, `off: ${disabledBy}`);

    const startedAt = now();
    const sinceLast = prev ? startedAt - prev.checkedAt : Infinity;
    if (!force && prev && prev.checkedAt > 0 && sinceLast >= 0 && sinceLast < intervalMs) {
      return { ran: false, state: 'skipped', message: 'Checked recently, skipped.' };
    }
    if (busy()) return note('deferred', 'a chat is mid-turn', 'deferred: a chat is mid-turn; trying again on the next tick');

    const lock = selfUpdateLockPath(home);
    reclaimDeadHolderLock(lock);
    if (!acquireFileLock(lock, startedAt, LOCK_STALE_MS, { verifyPidLiveness: true })) {
      return { ran: false, state: 'skipped', message: 'Another self-update is running.' };
    }
    try {
      const installed = (deps.installedVersion ?? (() => defaultInstalledVersion(env)))();
      const latest = await (deps.latestVersion ?? (() => defaultLatestVersion(env)))();
      const base = { ...keep(prev), checkedAt: startedAt, installed, latest };
      const finish = (rec: SelfUpdateRecord, message: string): SelfUpdateResult => {
        writeSelfUpdateRecord(home, rec);
        log(message);
        return { ran: true, state: rec.state, message };
      };

      if (!latest) return finish({ ...base, at: now(), state: 'unknown', reason: 'npm could not be reached' }, "unknown: couldn't reach npm for the latest version");
      if (!installed) return finish({ ...base, at: now(), state: 'unknown', reason: 'the installed version could not be read' }, "unknown: couldn't read the installed CLI version");
      if (compareVersions(installed, latest) >= 0) return finish(cleared({ ...base, at: now(), state: 'current' as const }), `current: ${installed} is the latest`);

      const recentFail = prev?.failedFor === latest && prev.failedAt !== undefined && startedAt - prev.failedAt < SELF_UPDATE_RETRY_MS;
      if (recentFail) {
        return finish({ ...base, at: now(), state: 'failed' }, `failed earlier: ${installed} → ${latest} is retried a day after the last attempt`);
      }
      // The version lookup took a while; a turn may have started since.
      if (busy()) return note('deferred', 'a chat is mid-turn', 'deferred: a chat is mid-turn; trying again on the next tick');
      if (!deps.runUpgrade) return finish({ ...base, at: now(), state: 'unknown', reason: 'no upgrade runner' }, 'unknown: no upgrade runner');

      const attemptAt = now();
      writeSelfUpdateRecord(home, { ...base, at: attemptAt, state: 'updating', attemptedFor: latest, lastAttemptAt: attemptAt, from: installed });
      log(`updating: ${installed} → ${latest} (dreamcontext upgrade --yes)`);
      const result = await deps.runUpgrade();
      const after = (deps.installedVersion ?? (() => defaultInstalledVersion(env)))();
      const reached = !!after && compareVersions(after, latest) >= 0;
      const rec: SelfUpdateRecord = { ...base, at: now(), installed: after ?? installed, attemptedFor: latest, lastAttemptAt: attemptAt, from: installed, state: 'failed' };
      if (after) rec.to = after;
      if (result.ok && reached) {
        return finish(cleared({ ...rec, state: 'updated' as const }), `updated: ${installed} → ${after}`);
      }
      rec.failedFor = latest;
      rec.failedAt = attemptAt;
      rec.error = outputTail(result.output) || (result.ok ? `the install still reads ${after ?? 'unknown'}` : 'the upgrade failed');
      return finish(rec, `failed: ${installed} → ${latest}\n${rec.error.split('\n').map((l) => `    ${l}`).join('\n')}`);
    } finally {
      releaseFileLock(lock);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'self-update check failed';
    log(`error: ${message}`);
    return { ran: true, state: 'unknown', message };
  }
}
