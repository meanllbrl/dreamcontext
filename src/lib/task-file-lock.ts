import { join } from 'node:path';
import { acquireFileLock, releaseFileLock } from './file-lock.js';

/**
 * task-file-lock — a per-file cross-process mutex for task writes.
 *
 * WHY. Every task mutation is a READ-MODIFY-WRITE of one markdown file. With a
 * single writer that is fine. Workstream C introduces a SECOND writer — a
 * background sleep cycle running while the user keeps working — and two
 * read-modify-writes that interleave lose one side's edit silently: the second
 * writer's `writeFileSync` is built from a snapshot taken before the first
 * writer's change landed. Nothing errors. The edit is just gone.
 *
 * PER FILE, not global: two specialists touching two different tasks must not
 * serialize behind each other, and a lock held on `foo.md` says nothing about
 * `bar.md`.
 *
 * BOUNDED WAIT, then a LOUD failure. A task write that cannot get the lock in
 * {@link LOCK_WAIT_MS} throws rather than proceeding unlocked — silently
 * writing anyway would defeat the entire point. (The Stop hook's `.sleep.json`
 * path is different and deliberately fails OPEN; see `sleep-state-lock.ts`.)
 */

/** A held task lock is stale after this long — far longer than any single write. */
export const TASK_LOCK_STALE_MS = 30_000;

/** How long a writer waits for a busy file before giving up loudly. */
export const LOCK_WAIT_MS = 3_000;

/** Poll interval while waiting. Short: real contention is measured in ms. */
const POLL_MS = 50;

export function taskLockPath(contextRoot: string, slug: string): string {
  return join(contextRoot, 'state', '.locks', `${slug}.lock`);
}

function sleepSync(ms: number): void {
  // A synchronous wait, deliberately: the task backend's write path is sync
  // (`writeFileSync`), and making it async would ripple through every caller.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class TaskFileBusyError extends Error {
  constructor(public readonly slug: string) {
    super(
      `Task file busy: another process is writing "${slug}" (waited ${LOCK_WAIT_MS}ms). `
      + 'A sleep cycle may be running — retry in a moment.',
    );
    this.name = 'TaskFileBusyError';
  }
}

/**
 * Run `fn` holding the write lock for one task slug.
 *
 * The lock is ALWAYS released, including when `fn` throws — a failed write must
 * not leave the file locked for the next 30 seconds.
 */
export function withTaskFileLock<T>(contextRoot: string, slug: string, fn: () => T): T {
  const path = taskLockPath(contextRoot, slug);
  const deadline = Date.now() + LOCK_WAIT_MS;

  let held = acquireFileLock(path, Date.now(), TASK_LOCK_STALE_MS, { verifyPidLiveness: true });
  while (!held && Date.now() < deadline) {
    sleepSync(POLL_MS);
    held = acquireFileLock(path, Date.now(), TASK_LOCK_STALE_MS, { verifyPidLiveness: true });
  }
  if (!held) throw new TaskFileBusyError(slug);

  try {
    return fn();
  } finally {
    releaseFileLock(path);
  }
}
