/**
 * Crash safety for go and return (task "Journal (crash safety)", AC11).
 *
 * - Each direction snapshots both sides ONCE and persists
 *   `trips/<trip>/<direction>-journal.json` (ordered ops, each with its full params)
 *   BEFORE any write. A re-run loads it and replays; it never re-diffs.
 * - An op is marked `started` (persisted) before its handler runs and `done` (persisted)
 *   after. On replay an op whose target already holds the expected sha256/ref value counts
 *   as done (the handler's `isDone`); handlers are also written to be idempotent.
 * - Once any WRITE op has started, only Resume or Roll back is offered
 *   ({@link journalStatus}). Roll back undoes ONLY this journal's own started/done ops,
 *   newest first.
 * - A per-trip run lock (`acquireFileLock` + `verifyPidLiveness`) makes go/return
 *   single-flight across the dashboard and the CLI.
 *
 * No module state; every path is passed in by the caller.
 */
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { acquireFileLock, releaseFileLock } from '../file-lock.js';
import { atomicWriteFile, fsyncDir } from './paths.js';
import { assertTripId } from './git-snapshot.js';

export type Direction = 'go' | 'return';
export type OpState = 'pending' | 'started' | 'done' | 'undone';

export interface JournalOp<P = unknown> {
  id: string;
  kind: string;
  /** Everything the op needs, computed once at plan time (replay never re-diffs). */
  params: P;
  /** True when the op changes the receiver (refs, trees, files). */
  writes: boolean;
  state: OpState;
  result?: unknown;
  error?: string;
  /** What the handler's `undo` returned at Roll back (e.g. files kept because the owner changed them). */
  undoResult?: unknown;
}

export interface Journal {
  version: 1;
  trip: string;
  direction: Direction;
  createdAt: string;
  ops: JournalOp[];
}

export interface OpHandler {
  /** True when the target already holds the expected value (counts as done). */
  isDone?(op: JournalOp): Promise<boolean>;
  apply(op: JournalOp): Promise<unknown>;
  /** Undo the op; a returned value is kept on the op as `undoResult` (the Roll back receipt reads it). */
  undo?(op: JournalOp): Promise<unknown>;
}
export type OpHandlers = Record<string, OpHandler>;

export const tripDir = (handsfreeDir: string, trip: string) => join(handsfreeDir, 'trips', assertTripId(trip));
export const journalPath = (dir: string, direction: Direction) => join(dir, `${direction}-journal.json`);
export const backupDir = (dir: string, scope: string) => join(dir, 'backup', scope);
export const conflictsDir = (dir: string, scope: string) => join(dir, 'conflicts', scope);

export class JournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalError';
  }
}

function persist(path: string, j: Journal): void {
  atomicWriteFile(path, JSON.stringify(j, null, 2) + '\n');
}

export function loadJournal(path: string): Journal | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const j = JSON.parse(text) as Journal;
  if (j?.version !== 1 || !Array.isArray(j.ops)) throw new JournalError(`unreadable journal ${path}`);
  return j;
}

/**
 * Persist a NEW journal. Refuses when one exists: a re-run must {@link runJournal} the
 * existing one instead of planning again.
 */
export function createJournal(
  path: string,
  init: { trip: string; direction: Direction; ops: Array<Pick<JournalOp, 'id' | 'kind' | 'params' | 'writes'>> },
): Journal {
  if (loadJournal(path)) throw new JournalError(`journal already exists at ${path}; resume it instead`);
  const ids = new Set<string>();
  for (const op of init.ops) {
    if (ids.has(op.id)) throw new JournalError(`duplicate op id ${op.id}`);
    ids.add(op.id);
  }
  const j: Journal = {
    version: 1,
    trip: assertTripId(init.trip),
    direction: init.direction,
    createdAt: new Date().toISOString(),
    ops: init.ops.map((o) => ({ ...o, state: 'pending' as const })),
  };
  persist(path, j);
  return j;
}

export interface JournalStatus {
  complete: boolean;
  /** A write op has started: only Resume or Roll back may be offered. */
  writeStarted: boolean;
  rolledBack: boolean;
  next: JournalOp | null;
}

export function journalStatus(j: Journal): JournalStatus {
  const writeStarted = j.ops.some((o) => o.writes && o.state !== 'pending');
  const rolledBack = j.ops.some((o) => o.state === 'undone');
  const next = j.ops.find((o) => o.state !== 'done' && o.state !== 'undone') ?? null;
  return { complete: !rolledBack && j.ops.every((o) => o.state === 'done'), writeStarted, rolledBack, next };
}

/**
 * Run (or resume) the journal at `path` in order. Each op is persisted `started` before
 * its handler runs and `done` right after; a failing op is persisted with its error and
 * the run stops (re-run resumes from it).
 */
export async function runJournal(
  path: string,
  handlers: OpHandlers,
  o: { onOp?: (op: JournalOp) => void } = {},
): Promise<Journal> {
  const j = loadJournal(path);
  if (!j) throw new JournalError(`no journal at ${path}`);
  if (journalStatus(j).rolledBack) throw new JournalError('journal was rolled back; plan a new one');
  for (const op of j.ops) {
    if (op.state === 'done') continue;
    const h = handlers[op.kind];
    if (!h) throw new JournalError(`no handler for op kind ${op.kind}`);
    if (h.isDone && (await h.isDone(op))) {
      op.state = 'done';
      delete op.error;
      persist(path, j);
      o.onOp?.(op);
      continue;
    }
    op.state = 'started';
    persist(path, j);
    try {
      const result = await h.apply(op);
      if (result !== undefined) op.result = result;
      op.state = 'done';
      delete op.error;
    } catch (err) {
      op.error = (err as Error).message ?? String(err);
      persist(path, j);
      throw err;
    }
    persist(path, j);
    o.onOp?.(op);
  }
  return j;
}

/**
 * Undo this journal's own started/done ops, newest first, then ARCHIVE the journal
 * (`<direction>-journal.rolledback-<ts>.json`, kept forever) so a retried go/return can
 * {@link createJournal} a fresh one at the same path. A re-run after a crash mid-roll-back
 * resumes from the persisted `undone` states.
 */
export async function rollbackJournal(path: string, handlers: OpHandlers): Promise<Journal> {
  const j = loadJournal(path);
  if (!j) {
    // A crash after the archive rename: the roll back already finished.
    const archived = rolledBackJournals(path);
    const last = archived.length ? loadJournal(archived[archived.length - 1]) : null;
    if (last && journalStatus(last).rolledBack) return last;
    throw new JournalError(`no journal at ${path}`);
  }
  for (const op of [...j.ops].reverse()) {
    if (op.state !== 'started' && op.state !== 'done') continue;
    const h = handlers[op.kind];
    if (op.writes) {
      if (!h?.undo) throw new JournalError(`op ${op.id} (${op.kind}) wrote but has no undo`);
      const r = await h.undo(op);
      if (r !== undefined) op.undoResult = r;
    }
    op.state = 'undone';
    persist(path, j);
  }
  renameSync(path, rolledBackPath(path));
  fsyncDir(dirname(path));
  return j;
}

/** Where a rolled-back journal is archived (never overwrites an earlier archive). */
export function rolledBackPath(path: string): string {
  return path.replace(/\.json$/, '') + `.rolledback-${Date.now()}-${randomBytes(3).toString('hex')}.json`;
}

/** Archived (rolled-back) journals for `path`, oldest first. */
export function rolledBackJournals(path: string): string[] {
  const base = basename(path).replace(/\.json$/, '') + '.rolledback-';
  try {
    return readdirSync(dirname(path)).filter((n) => n.startsWith(base) && n.endsWith('.json')).sort().map((n) => join(dirname(path), n));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- per-trip run lock

export interface RunLock { path: string; release(): void }

/**
 * Single-flight go/return for one trip across processes (dashboard + CLI). A holder that
 * died is reclaimed (pid probe); a live holder, however old, is never stolen from.
 * Returns null when another live process holds it.
 */
export function acquireTripRunLock(dir: string, nowMs: number = Date.now()): RunLock | null {
  const path = join(dir, 'run.lock');
  // staleMs 1 s: past that, liveness of the recorded pid alone decides.
  if (!acquireFileLock(path, nowMs, 1000, { verifyPidLiveness: true })) return null;
  return { path, release: () => releaseFileLock(path) };
}
