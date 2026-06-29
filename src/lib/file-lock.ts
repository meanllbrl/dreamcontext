import { mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Acquire an exclusive on-disk lock at `lockPath` via an atomic O_EXCL create
 * (`wx`). At most one holder can succeed across processes — this is the
 * cross-process mutex that an advisory check-then-write on a JSON field cannot
 * provide (two writers can both pass the check before either writes).
 *
 * A crashed holder cannot wedge things forever: a lock whose recorded age
 * exceeds `staleMs` is broken and re-raced (the JSON `at` timestamp first; the
 * file mtime as the fallback for garbage/partial content). This mirrors
 * `SyncLedger.acquireSyncLock`, generalized so the sleep-consolidation start
 * path can reuse the same proven primitive.
 *
 * @returns true if the lock is now held by THIS process; false if a live holder
 *   owns it. `nowMs` is injected so callers and tests stay deterministic.
 */
export function acquireFileLock(lockPath: string, nowMs: number, staleMs: number): boolean {
  mkdirSync(dirname(lockPath), { recursive: true });
  const tryCreate = (): boolean => {
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: nowMs }) + '\n', { flag: 'wx' });
      return true;
    } catch {
      return false;
    }
  };
  if (tryCreate()) return true;

  // Lock exists — genuinely held, or left behind by a dead process?
  let heldSince: number | null = null;
  try {
    const info = JSON.parse(readFileSync(lockPath, 'utf-8'));
    if (typeof info.at === 'number') heldSince = info.at;
  } catch { /* unreadable → fall back to mtime below */ }
  if (heldSince === null) {
    try {
      heldSince = statSync(lockPath).mtimeMs;
    } catch {
      return tryCreate(); // vanished between checks — race resolved by wx
    }
  }
  if (nowMs - heldSince <= staleMs) return false; // genuinely held

  // Stale: break it, then re-race atomically.
  try { rmSync(lockPath, { force: true }); } catch { /* best-effort */ }
  return tryCreate();
}

/**
 * Release a lock acquired by {@link acquireFileLock}. Best-effort and idempotent
 * — safe to call if the lock is already gone (e.g. a stale-break handed it off).
 */
export function releaseFileLock(lockPath: string): void {
  try { rmSync(lockPath, { force: true }); } catch { /* already gone */ }
}
