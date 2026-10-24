import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { acquireFileLock } from './file-lock.js';

/**
 * M0, the machine-local store: `~/.dreamcontext/local/<projectKey>/`.
 *
 * Every record a safety check or a machine-only fact reads lives HERE, never in the brain.
 * Anything under `_dream_context/state/` syncs unless the generated ignore lists it, and even a
 * listed file is overwritten by a teammate's force-added copy on merge, so a record that decides
 * whether something runs on THIS machine cannot sit in a synced folder.
 *
 * `projectKey` is the first 16 hex of sha256 of the realpath of the project root: the same
 * "keyed by project root" convention as `~/.dreamcontext/automations.json`, but usable as a
 * directory name. Directory mode 0700; every write is atomic (tmp + rename) under a per-file PID
 * lock, so two processes (the server and a tick) never lose each other's update.
 *
 * Every key needs a death: the owner of each record names when its entries go (an agent's when
 * it is deleted or renamed, a task's when it is unassigned, completed, cancelled or deleted).
 */

/** File names a caller may use: one flat folder, no paths. */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}\.json$/;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 3_000;

function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** First 16 hex of sha256(realpath(projectRoot)). */
export function projectKey(projectRoot: string): string {
  return createHash('sha256').update(realOr(projectRoot), 'utf8').digest('hex').slice(0, 16);
}

/** `~/.dreamcontext/local/<projectKey>/`. Not created here. */
export function localDir(projectRoot: string, home: string = homedir()): string {
  return join(home, '.dreamcontext', 'local', projectKey(projectRoot));
}

function filePath(projectRoot: string, name: string, home?: string): string {
  if (!NAME_RE.test(name)) throw new Error(`Invalid local-store file name "${name}".`);
  return join(localDir(projectRoot, home), name);
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best effort on an existing dir */ }
}

function readParsed<T>(path: string, fallback: T): T {
  try {
    // A symlink is never followed: the folder is ours, nothing legitimate links into it.
    if (!lstatSync(path).isFile()) return fallback;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return parsed === null || typeof parsed !== 'object' ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

/** Read one record file, or `fallback` when it is missing, unreadable or not an object. Never throws. */
export function readLocalJson<T extends object>(projectRoot: string, name: string, fallback: T, home?: string): T {
  return readParsed(filePath(projectRoot, name, home), fallback);
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read, change and write one record file under its PID lock. `mutate` gets the current value
 * (or `fallback`) and returns the next one; returning `null` deletes the file. Throws when the
 * lock cannot be had within a few seconds (a live holder) or the write fails: a safety record
 * that silently failed to write is worse than a refused action.
 */
export function updateLocalJson<T extends object>(
  projectRoot: string,
  name: string,
  fallback: T,
  mutate: (current: T) => T | null,
  home?: string,
): T | null {
  const path = filePath(projectRoot, name, home);
  const dir = localDir(projectRoot, home);
  ensureDir(dir);
  const lock = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!acquireFileLock(lock, Date.now(), LOCK_STALE_MS, { verifyPidLiveness: true })) {
    if (Date.now() > deadline) throw new Error(`The local record ${name} is busy; try again.`);
    sleepMs(25);
  }
  try {
    const next = mutate(readParsed(path, fallback));
    if (next === null) {
      rmSync(path, { force: true });
      return null;
    }
    const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, path);
    return next;
  } finally {
    rmSync(lock, { force: true });
  }
}

// ─── The stage's home session (A1-4) ─────────────────────────────────────────

const STAGE_FILE = 'agent-stage.json';

interface StageRecord {
  agents: Record<string, { homeSessionId: string; at: string }>;
}

/** The conversation the agent's stage opens, or null before its first accepted stage chat. */
export function readStageHomeSession(projectRoot: string, agent: string, home?: string): string | null {
  const rec = readLocalJson<StageRecord>(projectRoot, STAGE_FILE, { agents: {} }, home);
  const entry = rec.agents?.[agent];
  return entry && typeof entry.homeSessionId === 'string' ? entry.homeSessionId : null;
}

/** Record the stage's home session ONCE: a later call for the same agent keeps the first id. */
export function recordStageHomeSession(projectRoot: string, agent: string, sessionId: string, home?: string, now: Date = new Date()): string {
  let kept = sessionId;
  updateLocalJson<StageRecord>(projectRoot, STAGE_FILE, { agents: {} }, (cur) => {
    const agents = cur.agents && typeof cur.agents === 'object' ? { ...cur.agents } : {};
    const existing = agents[agent];
    if (existing && typeof existing.homeSessionId === 'string') {
      kept = existing.homeSessionId;
      return { agents };
    }
    agents[agent] = { homeSessionId: sessionId, at: now.toISOString() };
    return { agents };
  }, home);
  return kept;
}

/** The death of an agent's machine-local entries: deleted or renamed. Never throws. */
export function forgetAgentLocal(projectRoot: string, agent: string, home?: string): void {
  try {
    const rec = readLocalJson<StageRecord>(projectRoot, STAGE_FILE, { agents: {} }, home);
    if (!rec.agents?.[agent]) return;
    updateLocalJson<StageRecord>(projectRoot, STAGE_FILE, { agents: {} }, (cur) => {
      const agents = { ...(cur.agents ?? {}) };
      delete agents[agent];
      return { agents };
    }, home);
  } catch {
    // a stale entry only names a conversation the stage can no longer open
  }
}
