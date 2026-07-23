import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SyncLedger } from './sync-state.js';
import { TASKS_MAP_REL, TASKS_QUEUE_REL, TASKS_SYNC_REL } from './paths.js';
import { ensureGitignoreEntries } from '../gitignore.js';
import type { SyncOptions, SyncReport, TaskBackend } from './types.js';

export interface HardRefreshResult {
  /** Where the pre-refresh task mirrors were moved (null when there were none). */
  backupDir: string | null;
  /** How many mirror files were moved into the backup. */
  movedMirrors: number;
  /** The full re-pull's report. */
  report: SyncReport;
}

/** Matches the backends' LOCK_STALE_MS — a lock older than this is a dead process. */
const LOCK_STALE_MS = 3 * 60 * 1000;

/**
 * HARD REFRESH — throw away every locally derived piece of cloud-task state and
 * rebuild the mirror from the remote, which for a remote-backed project IS the
 * source of truth (see the layout note in paths.ts). Steps:
 *
 *   1. take the sync lock (refuse if a sync is mid-flight — wiping under it
 *      would corrupt the run)
 *   2. move `state/*.md` mirrors into `state/.hard-refresh-<stamp>/` — backed
 *      up, never deleted (`state/archive/` and subfolders are left alone)
 *   3. delete the ledger: id-map, watermarks/base snapshots, offline queue
 *   4. full PULL (null watermark ⇒ the remote returns everything)
 *
 * Push is deliberately NOT part of the operation: with the id-map gone and the
 * mirrors moved aside, a push would have nothing to send — and must not, since
 * anything it did send would materialise as a remote duplicate.
 */
export async function hardRefreshTasks(
  backend: TaskBackend,
  contextRoot: string,
  opts: SyncOptions = {},
  nowMs: () => number = () => Date.now(),
): Promise<HardRefreshResult> {
  if (backend.name === 'local') {
    throw new Error('hard refresh needs a remote task backend — with the local backend, state/ already is the source of truth.');
  }

  const ledger = new SyncLedger(contextRoot);
  if (!ledger.acquireSyncLock(nowMs(), LOCK_STALE_MS)) {
    throw new Error('a task sync is currently running — try again once it finishes.');
  }

  const stateDir = join(contextRoot, 'state');
  let backupDir: string | null = null;
  let movedMirrors = 0;
  try {
    // Self-heal a previous crashed run: files stranded in a `.partial` staging
    // dir were mid-backup when the process died — nothing destructive had
    // happened yet (the ledger delete only runs after the staging rename), so
    // restoring them is safe. On a name collision (a later pull re-created the
    // mirror) the live file wins and the stranded copy stays in the dir.
    if (existsSync(stateDir)) {
      for (const d of readdirSync(stateDir).filter((n) => n.startsWith('.hard-refresh-') && n.endsWith('.partial'))) {
        const dir = join(stateDir, d);
        for (const f of readdirSync(dir)) {
          const target = join(stateDir, f);
          if (!existsSync(target)) renameSync(join(dir, f), target);
        }
        try { rmdirSync(dir); } catch { /* kept: still holds collided copies */ }
      }
    }
    const mirrors = existsSync(stateDir)
      ? readdirSync(stateDir).filter((f) => f.endsWith('.md') && statSync(join(stateDir, f)).isFile())
      : [];
    if (mirrors.length > 0) {
      const stamp = new Date(nowMs()).toISOString().slice(0, 19).replace(/[:T]/g, '-');
      // Same-second repeat refresh: the stamp collides with an existing backup
      // and the promote-rename below would throw ENOTEMPTY with the mirrors
      // stranded in staging — uniquify instead (re-review Major).
      backupDir = join(stateDir, `.hard-refresh-${stamp}`);
      for (let n = 2; existsSync(backupDir); n++) backupDir = join(stateDir, `.hard-refresh-${stamp}-${n}`);
      // Stage → atomic rename: the finished backup dir appears as one unit, and
      // the destructive ledger delete below only ever runs after it exists.
      const staging = `${backupDir}.partial`;
      mkdirSync(staging, { recursive: true });
      for (const f of mirrors) renameSync(join(stateDir, f), join(staging, f));
      renameSync(staging, backupDir);
      movedMirrors = mirrors.length;
    }
    for (const rel of [TASKS_MAP_REL, TASKS_SYNC_REL, TASKS_QUEUE_REL]) {
      rmSync(join(contextRoot, rel), { force: true });
    }
    try {
      ensureGitignoreEntries(dirname(contextRoot), ['_dream_context/state/.hard-refresh-*/'], {
        comment: 'dreamcontext hard-refresh backups',
      });
    } catch { /* not a git project — nothing to ignore */ }
  } finally {
    // The pull below takes the lock itself; release ours first. The release→
    // re-acquire gap is sub-millisecond with no I/O between — a rival slipping
    // in would only run a redundant (harmless) sync, so the window is accepted.
    ledger.releaseSyncLock();
  }

  const report = await backend.sync('pull', opts);
  return { backupDir, movedMirrors, report };
}
