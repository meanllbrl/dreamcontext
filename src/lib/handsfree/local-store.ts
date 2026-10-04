/**
 * The laptop's own hands-free files in `~/.dreamcontext/handsfree/` (injectable home):
 *
 *   credentials.json  0600: the handsfree GitHub token (scopes `repo` + `codespace`, apart
 *                     from the brain-sync token) and the 32-byte transfer secret (base64url).
 *   config.json       0600: laptop id, repo + codespace, the verifier push and its pending
 *                     state, the uptime count, queued cloud finalization, the last trip.
 *
 * Writes are atomic renames under a small lock; reads never throw (a missing file is empty).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireFileLockWithin, releaseFileLock } from '../file-lock.js';
import { atomicWriteFile } from './paths.js';
import { handsfreeDir } from './trip-state.js';
import type { VerifierPush } from '../../server/handsfree-auth.js';

export interface HandsfreeCredentials {
  version: 1;
  githubToken?: string;
  githubLogin?: string;
  transferSecret?: string;
}

export type LastTripStatus = 'away' | 'sealed' | 'abandoned' | 'lost' | 'superseded';

export interface QueuedFinalization {
  tripId: string;
  epoch: number;
  steps: Array<'wipe-secrets' | 'seal' | 'stop'>;
  since: string;
}

export interface HandsfreeConfig {
  version: 1;
  laptopId: string;
  machine: string;
  owner?: string;
  repo?: { fullName: string; fileShas: Record<string, string> };
  codespace?: { name: string; machine: string; url: string; webUrl: string; retentionExpiresAt: string | null };
  verifier?: {
    push: VerifierPush;
    /** Highest generation the cloud confirmed. */
    confirmed: number;
    /** A password change / revoke-all not yet confirmed by the cloud (AC3: shown as pending). */
    pending: null | { kind: 'password' | 'revoke'; generation: number; since: string };
  };
  /** The laptop's own uptime count (W0 item 8: GitHub's quota is unreadable). */
  uptime: { period: string; coreMinutes: number; runningSince: number | null };
  /** Monthly budget in core-minutes (GitHub Free: 120 core-hours). */
  budgetCoreMinutes: number;
  /** Estimated length of a trip in hours (the AC23 check), plus a fixed Return reserve. */
  tripEstimateHours: number;
  queued?: QueuedFinalization | null;
  lastTrip?: { tripId: string; status: LastTripStatus; recovered?: boolean; at: string; epoch?: number } | null;
}

export const DEFAULT_BUDGET_CORE_MINUTES = 120 * 60;
export const RETURN_RESERVE_MINUTES = 30;

export const credentialsPath = (home?: string) => join(handsfreeDir(home), 'credentials.json');
export const configPath = (home?: string) => join(handsfreeDir(home), 'config.json');

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function readCredentials(home?: string): HandsfreeCredentials {
  const c = readJson<HandsfreeCredentials>(credentialsPath(home));
  return c && c.version === 1 ? c : { version: 1 };
}

function periodOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

export function readConfig(home?: string, now: number = Date.now()): HandsfreeConfig | null {
  const c = readJson<HandsfreeConfig>(configPath(home));
  if (!c || c.version !== 1 || typeof c.laptopId !== 'string') return null;
  c.uptime ??= { period: periodOf(now), coreMinutes: 0, runningSince: null };
  c.budgetCoreMinutes ??= DEFAULT_BUDGET_CORE_MINUTES;
  c.tripEstimateHours ??= 4;
  c.machine ??= 'basicLinux32gb';
  return c;
}

async function locked<T>(home: string | undefined, fn: () => T): Promise<T> {
  const lock = join(handsfreeDir(home), 'config.lock');
  if (!(await acquireFileLockWithin(lock, { waitMs: 5000, staleMs: 10_000 }))) throw new Error('hands-free config is locked by another process');
  try {
    return fn();
  } finally {
    releaseFileLock(lock);
  }
}

export function updateCredentials(home: string | undefined, fn: (c: HandsfreeCredentials) => HandsfreeCredentials): Promise<HandsfreeCredentials> {
  return locked(home, () => {
    const next = fn(readCredentials(home));
    atomicWriteFile(credentialsPath(home), JSON.stringify(next, null, 2) + '\n', 0o600);
    return next;
  });
}

/** Ensure the transfer secret exists (created once, never rotated silently). */
export async function ensureTransferSecret(home?: string): Promise<string> {
  const cur = readCredentials(home).transferSecret;
  if (cur) return cur;
  const next = await updateCredentials(home, (c) => (c.transferSecret ? c : { ...c, transferSecret: randomBytes(32).toString('base64url') }));
  return next.transferSecret!;
}

export function updateConfig(home: string | undefined, fn: (c: HandsfreeConfig) => HandsfreeConfig, now: number = Date.now()): Promise<HandsfreeConfig> {
  return locked(home, () => {
    const cur = readConfig(home, now) ?? {
      version: 1 as const,
      laptopId: `lp-${randomBytes(8).toString('hex')}`,
      machine: 'basicLinux32gb',
      uptime: { period: periodOf(now), coreMinutes: 0, runningSince: null },
      budgetCoreMinutes: DEFAULT_BUDGET_CORE_MINUTES,
      tripEstimateHours: 4,
    };
    const next = fn(structuredClone(cur));
    atomicWriteFile(configPath(home), JSON.stringify(next, null, 2) + '\n', 0o600);
    return next;
  });
}

/** Core-minutes used this month by the laptop's own count (a running machine counts up to now). */
export function usedCoreMinutes(c: HandsfreeConfig, cores: number, now: number = Date.now()): number {
  const sameMonth = c.uptime.period === periodOf(now);
  const base = sameMonth ? c.uptime.coreMinutes : 0;
  const running = c.uptime.runningSince !== null ? Math.max(0, now - c.uptime.runningSince) / 60_000 * cores : 0;
  return base + running;
}

/** Record a start (`running`) or a stop observed at `at` into the uptime count. */
export function countUptime(c: HandsfreeConfig, running: boolean, cores: number, at: number): HandsfreeConfig {
  const period = periodOf(at);
  if (c.uptime.period !== period) c.uptime = { period, coreMinutes: 0, runningSince: c.uptime.runningSince };
  if (running) {
    if (c.uptime.runningSince === null) c.uptime.runningSince = at;
  } else if (c.uptime.runningSince !== null) {
    c.uptime.coreMinutes += Math.max(0, at - c.uptime.runningSince) / 60_000 * cores;
    c.uptime.runningSince = null;
  }
  return c;
}
