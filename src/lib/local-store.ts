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

// ─── An agent's sessions on this machine (AI Team history) ──────────────────────

/**
 * Every conversation this machine opened with an agent: its stage's sessions and every Chat-tab
 * talk. A NEW file rather than a reshaped `agent-stage.json`, which an older build would overwrite.
 * `hadTurns` is set by the server's history reader the first time it finds the transcript, so a
 * glance (opened, never spoken to) is pruned instead of probed forever.
 */
const SESSIONS_FILE = 'agent-sessions.json';
/** Entries with turns kept per agent; the oldest go first. Turnless entries do not count. */
export const AGENT_SESSIONS_CAP = 500;

export interface AgentSessionEntry {
  id: string;
  at: string;
  kind: 'stage' | 'chat';
  hadTurns: boolean;
}

interface SessionsRecord {
  agents: Record<string, AgentSessionEntry[]>;
}

const EMPTY_SESSIONS = (): SessionsRecord => ({ agents: {} });
let corruptSessionsLogged = false;

function cleanEntries(raw: unknown): AgentSessionEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentSessionEntry[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const { id, at, kind, hadTurns } = e as Partial<AgentSessionEntry>;
    if (typeof id !== 'string' || !id || typeof at !== 'string') continue;
    out.push({ id, at, kind: kind === 'stage' ? 'stage' : 'chat', hadTurns: hadTurns === true });
  }
  return out;
}

function readSessions(projectRoot: string, home?: string): SessionsRecord {
  const path = filePath(projectRoot, SESSIONS_FILE, home);
  const rec = readParsed<SessionsRecord | null>(path, null);
  if (rec === null) {
    // Missing is normal; present but unreadable is corrupt: read as empty, rewritten on the next write.
    let present = false;
    try { present = lstatSync(path).isFile(); } catch { /* missing */ }
    if (present && !corruptSessionsLogged) {
      corruptSessionsLogged = true;
      console.warn(`[local-store] ${SESSIONS_FILE} is unreadable; reading it as empty.`);
    }
    return EMPTY_SESSIONS();
  }
  return rec;
}

function mutateSessions(
  projectRoot: string,
  agent: string,
  home: string | undefined,
  change: (list: AgentSessionEntry[]) => AgentSessionEntry[] | null,
): void {
  updateLocalJson<SessionsRecord>(projectRoot, SESSIONS_FILE, EMPTY_SESSIONS(), (cur) => {
    const agents: Record<string, AgentSessionEntry[]> = {};
    const src = cur.agents && typeof cur.agents === 'object' && !Array.isArray(cur.agents) ? cur.agents : {};
    for (const [k, v] of Object.entries(src)) agents[k] = cleanEntries(v);
    const next = change(agents[agent] ?? []);
    if (next === null) return { agents: src as Record<string, AgentSessionEntry[]> };
    if (next.length === 0) delete agents[agent]; else agents[agent] = next;
    return { agents };
  }, home);
}

/** This machine's sessions with `agent`, oldest first. Never throws. */
export function listAgentSessions(projectRoot: string, agent: string, home?: string): AgentSessionEntry[] {
  try {
    return cleanEntries(readSessions(projectRoot, home).agents?.[agent]);
  } catch {
    return [];
  }
}

/** Record an accepted conversation with `agent`. An UPSERT by id that keeps the first `at`, so a
 *  respawn of the same session or a reopened Chat tab never adds a second entry. */
export function recordAgentSession(
  projectRoot: string,
  agent: string,
  id: string,
  kind: 'stage' | 'chat',
  home?: string,
  now: Date = new Date(),
): void {
  if (!id) return;
  mutateSessions(projectRoot, agent, home, (list) => {
    if (list.some((e) => e.id === id)) return null;
    const next = [...list, { id, at: now.toISOString(), kind, hadTurns: false }];
    // The cap counts conversations that happened; turnless glances are pruned by the reader.
    let withTurns = next.filter((e) => e.hadTurns).length;
    while (withTurns > AGENT_SESSIONS_CAP) {
      const i = next.findIndex((e) => e.hadTurns);
      next.splice(i, 1);
      withTurns--;
    }
    return next;
  });
}

/** The history reader found `id`'s transcript: it is a conversation, never pruned as a glance. */
export function markSessionHadTurns(projectRoot: string, agent: string, ids: readonly string[], home?: string): void {
  if (ids.length === 0) return;
  const want = new Set(ids);
  mutateSessions(projectRoot, agent, home, (list) => {
    if (!list.some((e) => want.has(e.id) && !e.hadTurns)) return null;
    const next = list.map((e) => (want.has(e.id) ? { ...e, hadTurns: true } : e));
    let withTurns = next.filter((e) => e.hadTurns).length;
    while (withTurns > AGENT_SESSIONS_CAP) {
      const i = next.findIndex((e) => e.hadTurns);
      next.splice(i, 1);
      withTurns--;
    }
    return next;
  });
}

/** Drop turnless glances the reader confirmed have no transcript and are not live. */
export function pruneAgentSessions(projectRoot: string, agent: string, ids: readonly string[], home?: string): void {
  if (ids.length === 0) return;
  const drop = new Set(ids);
  mutateSessions(projectRoot, agent, home, (list) => {
    if (!list.some((e) => drop.has(e.id) && !e.hadTurns)) return null;
    return list.filter((e) => !(drop.has(e.id) && !e.hadTurns));
  });
}

/** The stage's latest session from the index (null before any). */
export function latestStageSession(projectRoot: string, agent: string, home?: string): string | null {
  const stage = listAgentSessions(projectRoot, agent, home).filter((e) => e.kind === 'stage');
  return stage.length ? stage[stage.length - 1].id : null;
}

/** The death of an agent's machine-local entries: deleted or renamed. Never throws. */
export function forgetAgentLocal(projectRoot: string, agent: string, home?: string): void {
  try {
    if (listAgentSessions(projectRoot, agent, home).length > 0) {
      mutateSessions(projectRoot, agent, home, () => []);
    }
  } catch {
    // a stale entry only lists conversations nobody can open from this agent any more
  }
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

/** An agent renamed: its stage home session and its session index follow it. Never throws. */
export function renameAgentStage(projectRoot: string, from: string, to: string, home?: string): void {
  try {
    if (listAgentSessions(projectRoot, from, home).length > 0) {
      updateLocalJson<SessionsRecord>(projectRoot, SESSIONS_FILE, EMPTY_SESSIONS(), (cur) => {
        const agents = { ...(cur.agents ?? {}) };
        const moved = cleanEntries(agents[from]);
        const kept = cleanEntries(agents[to]);
        const have = new Set(kept.map((e) => e.id));
        agents[to] = [...kept, ...moved.filter((e) => !have.has(e.id))].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
        delete agents[from];
        return { agents };
      }, home);
    }
  } catch {
    // the renamed agent's history starts over on this machine
  }
  try {
    const rec = readLocalJson<StageRecord>(projectRoot, STAGE_FILE, { agents: {} }, home);
    if (!rec.agents?.[from]) return;
    updateLocalJson<StageRecord>(projectRoot, STAGE_FILE, { agents: {} }, (cur) => {
      const agents = { ...(cur.agents ?? {}) };
      if (agents[from] && !agents[to]) agents[to] = agents[from];
      delete agents[from];
      return { agents };
    }, home);
  } catch {
    // the renamed agent's stage opens a fresh conversation
  }
}
