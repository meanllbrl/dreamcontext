import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireFileLock, releaseFileLock } from './file-lock.js';

/**
 * sleep-state-lock — the read-modify-write mutex for `.sleep.json`.
 *
 * SEPARATE FROM `task-file-lock` FOR ONE REASON: the failure policy is the
 * opposite. A task write that cannot get its lock fails loudly. A Stop hook
 * that cannot get this lock must PROCEED ANYWAY — a hook that hangs or throws
 * blocks the user's turn, and no amount of bookkeeping is worth that. So this
 * fails OPEN, and says so on the way past rather than swallowing it.
 *
 * The lock must span the WHOLE read-modify-write, not just the write: the
 * session ledger is rebuilt from a snapshot on every Stop, so two hooks that
 * both read before either writes lose one session's score entirely.
 */

export const SLEEP_STATE_LOCK_STALE_MS = 15_000;
export const SLEEP_STATE_WAIT_MS = 3_000;
const POLL_MS = 50;

export function sleepStateLockPath(contextRoot: string): string {
  return join(contextRoot, 'state', '.locks', 'sleep-state.lock');
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface SleepStateLockResult<T> {
  value: T;
  /** False when the wait timed out and `fn` ran WITHOUT the lock. */
  locked: boolean;
}

/**
 * Run `fn` holding the `.sleep.json` lock, waiting up to {@link SLEEP_STATE_WAIT_MS}.
 *
 * Returns `locked: false` when it gave up and ran anyway, so the caller can
 * decide how loud to be: `sleep start` / `sleep done` should fail on that, while
 * the Stop hook should carry on (today's behaviour) and merely note it.
 */
export function withSleepStateLock<T>(contextRoot: string, fn: () => T): SleepStateLockResult<T> {
  const path = sleepStateLockPath(contextRoot);
  const deadline = Date.now() + SLEEP_STATE_WAIT_MS;

  let held = acquireFileLock(path, Date.now(), SLEEP_STATE_LOCK_STALE_MS, { verifyPidLiveness: true });
  while (!held && Date.now() < deadline) {
    sleepSync(POLL_MS);
    held = acquireFileLock(path, Date.now(), SLEEP_STATE_LOCK_STALE_MS, { verifyPidLiveness: true });
  }

  if (!held) return { value: fn(), locked: false };
  try {
    return { value: fn(), locked: true };
  } finally {
    releaseFileLock(path);
  }
}

/**
 * Is a background auto-sleep actually running right now?
 *
 * Used to decide how LOUD an unlocked fallback should be. Losing the race
 * against nothing is a curiosity; losing it against a live background cycle is
 * the exact two-writer condition this workstream exists for, and the user
 * should see a line about it rather than have to enable debug logging.
 */
export function autoSleepSidecarRunning(contextRoot: string): boolean {
  const path = join(contextRoot, 'state', '.auto-sleep.json');
  if (!existsSync(path)) return false;
  try {
    const sidecar = JSON.parse(readFileSync(path, 'utf-8'));
    return sidecar?.status === 'running';
  } catch {
    return false;
  }
}
