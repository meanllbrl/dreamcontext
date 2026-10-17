import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isSafeTaskSlug } from './task-backend/local.js';
import { isSafeSessionId } from './transcript-locate.js';
import { safeResolveInside } from './safe-resolve.js';

/**
 * Session → task binding. A session that starts from a task (a Develop run,
 * a handoff, an agent assigned the task) records it here, so the task's
 * context packet comes back after a compaction instead of being guessed from
 * `state/.active-task`.
 *
 * One file per session (`state/.session-task/<session-id>.json`, the
 * per-session-live-state-files pattern), never a shared pointer two panes
 * would fight over. Lifetime: nothing is removed on Stop (that fires every
 * turn); SessionEnd moves the file to `.ended/` (the tombstone a later
 * `--resume` re-binds from); `/clear` unbinds; a binding idle for more than 7
 * days is reaped. Every hit of the Read hook and every prompt refreshes it.
 * Machine-local: the directory is gitignored.
 */
export const SESSION_TASK_DIR = '.session-task';
export const SESSION_TASK_ENDED_DIR = '.ended';
export const SESSION_TASK_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionBinding {
  session: string;
  task: string;
  boundAt: string;
  /** What bound it: develop | handoff | env | cli | resume. */
  via: string;
}

function stateDir(contextRoot: string): string {
  return join(contextRoot, 'state');
}

/** The binding file of a session (live or `ended`); throws on an unsafe id or a symlinked dir. */
function bindingPath(contextRoot: string, sessionId: string, ended = false): string {
  if (!isSafeSessionId(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);
  const rel = ended
    ? join(SESSION_TASK_DIR, SESSION_TASK_ENDED_DIR, `${sessionId}.json`)
    : join(SESSION_TASK_DIR, `${sessionId}.json`);
  return safeResolveInside(stateDir(contextRoot), rel);
}

function parse(path: string): SessionBinding | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SessionBinding>;
    if (typeof raw.task !== 'string' || !isSafeTaskSlug(raw.task)) return null;
    if (typeof raw.session !== 'string' || !isSafeSessionId(raw.session)) return null;
    return {
      session: raw.session,
      task: raw.task,
      boundAt: typeof raw.boundAt === 'string' ? raw.boundAt : '',
      via: typeof raw.via === 'string' ? raw.via : 'unknown',
    };
  } catch {
    return null;
  }
}

function writeAtomic(path: string, data: SessionBinding): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  rmSync(tmp, { force: true }); // a leftover (or planted link) is removed, never written through
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8', flag: 'wx' });
  renameSync(tmp, path);
}

/** Bind `sessionId` to `task` (a live task card). Returns null when either is invalid or unsafe. */
export function bindSession(contextRoot: string, sessionId: string, task: string, via: string): SessionBinding | null {
  if (!isSafeSessionId(sessionId) || !isSafeTaskSlug(task)) return null;
  try {
    if (!existsSync(safeResolveInside(stateDir(contextRoot), `${task}.md`))) return null;
    const binding: SessionBinding = { session: sessionId, task, boundAt: new Date().toISOString(), via };
    writeAtomic(bindingPath(contextRoot, sessionId), binding);
    const tomb = bindingPath(contextRoot, sessionId, true);
    if (existsSync(tomb)) rmSync(tomb, { force: true });
    return binding;
  } catch {
    return null;
  }
}

/** The live binding of a session, or null. */
export function readBinding(contextRoot: string, sessionId: string | null | undefined): SessionBinding | null {
  if (!sessionId || !isSafeSessionId(sessionId)) return null;
  try {
    const path = bindingPath(contextRoot, sessionId);
    if (!existsSync(path)) return null;
    const b = parse(path);
    return b && b.session === sessionId ? b : null;
  } catch {
    return null;
  }
}

/** Refresh a live binding's idle clock (Read-hook hit, prompt). */
export function touchBinding(contextRoot: string, sessionId: string | null | undefined): void {
  if (!sessionId || !isSafeSessionId(sessionId)) return;
  try {
    const path = bindingPath(contextRoot, sessionId);
    if (!existsSync(path)) return;
    const now = new Date();
    utimesSync(path, now, now);
  } catch { /* the clock is housekeeping, never a failure */ }
}

/** SessionEnd: the binding becomes a tombstone a `--resume` can re-bind from. */
export function endBinding(contextRoot: string, sessionId: string | null | undefined): boolean {
  if (!sessionId || !isSafeSessionId(sessionId)) return false;
  try {
    const path = bindingPath(contextRoot, sessionId);
    if (!existsSync(path)) return false;
    const tomb = bindingPath(contextRoot, sessionId, true);
    mkdirSync(dirname(tomb), { recursive: true });
    renameSync(path, tomb);
    return true;
  } catch {
    return false;
  }
}

/** `/clear`: the session starts over, unbound (live file and tombstone both go). */
export function unbindSession(contextRoot: string, sessionId: string | null | undefined): void {
  if (!sessionId || !isSafeSessionId(sessionId)) return;
  for (const ended of [false, true]) {
    try { rmSync(bindingPath(contextRoot, sessionId, ended), { force: true }); } catch { /* unsafe dir: nothing of ours there */ }
  }
}

/** SessionStart(resume): bring an ended binding back. */
export function rebindFromTombstone(contextRoot: string, sessionId: string | null | undefined): SessionBinding | null {
  if (!sessionId || !isSafeSessionId(sessionId)) return null;
  try {
    const tomb = bindingPath(contextRoot, sessionId, true);
    if (!existsSync(tomb)) return null;
    const b = parse(tomb);
    if (!b || b.session !== sessionId) return null;
    return bindSession(contextRoot, sessionId, b.task, 'resume');
  } catch {
    return null;
  }
}

/** Remove live bindings and tombstones idle longer than {@link SESSION_TASK_IDLE_MS}. */
export function reapBindings(contextRoot: string, now: number = Date.now()): number {
  let removed = 0;
  let base: string;
  try {
    base = safeResolveInside(stateDir(contextRoot), SESSION_TASK_DIR);
  } catch {
    return 0;
  }
  // `.ended/` goes through the same symlink refusal: a planted link there would aim the reaper
  // at a directory outside the brain.
  let ended: string | null = null;
  try { ended = safeResolveInside(stateDir(contextRoot), join(SESSION_TASK_DIR, SESSION_TASK_ENDED_DIR)); } catch { /* symlinked: skip */ }
  for (const dir of ended ? [base, ended] : [base]) {
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const p = join(dir, name);
      try {
        const st = lstatSync(p); // never follow an entry
        if (st.isFile() && now - st.mtimeMs > SESSION_TASK_IDLE_MS) {
          rmSync(p, { force: true });
          removed++;
        }
      } catch { /* raced away */ }
    }
  }
  return removed;
}
