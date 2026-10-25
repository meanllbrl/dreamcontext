import { randomBytes } from 'node:crypto';
import { readLocalJson, updateLocalJson } from './local-store.js';

/**
 * M1, the owner inbox: `<localDir>/owner-inbox.json`. Owner-waiting rows that need NO Super
 * session (a held secret, a hand-edited assignment, a renamed agent, a synced pattern to adopt).
 * Machine-local like every M0 record: a synced row would raise a teammate's buttons here. Task
 * jobs raise theirs from the CLI host as well as the server (C1).
 *
 * Every row has a death. Writers dedupe on `dedupeKey` (re-raising a row that is already open
 * keeps the first and refreshes its words), a writer that owns a kind closes the rows whose
 * subject is gone (`closeInboxRows`), and info rows (no action but Dismiss) die after 24 hours.
 */

export type InboxKind =
  | 'secret-held'
  | 'assigned-outside'
  | 'assigned-elsewhere'
  | 'renamed'
  | 'parked'
  | 'replaced-by-sync'
  | 'adopt-pattern'
  | 'unowned'
  // Task jobs (C1): each dies when its task moves on (agents/task-starter.ts reconcileTaskRows).
  | 'task-start-missed'
  | 'task-orphaned'
  | 'task-stopped'
  | 'task-blocked'
  | 'task-plan'
  | 'task-question'
  | 'task-stalled'
  | 'task-review'
  | 'task-stuck';

export type InboxAction =
  | 'start' | 'ignore' | 'adopt' | 'dismiss' | 'start-all' | 'review'
  | 'start-now' | 'reschedule' | 'stop' | 'let-finish' | 'continue' | 'take-over'
  | 'approve-plan' | 'change-plan' | 'one-more-round' | 'cancel' | 'open-task' | 'complete' | 'send-back';

export interface InboxRow {
  id: string;
  kind: InboxKind;
  /** What the row is about: a task slug, a brain-relative path, an agent slug. */
  ref: string;
  agent: string | null;
  title: string;
  detail?: string;
  actions: InboxAction[];
  createdAt: string;
  dedupeKey: string;
}

export type NewInboxRow = Omit<InboxRow, 'id' | 'createdAt'>;

const FILE = 'owner-inbox.json';
const INFO_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ROWS = 200;

interface InboxFile {
  rows: InboxRow[];
}

function isRow(v: unknown): v is InboxRow {
  const r = v as Partial<InboxRow> | null;
  return !!r && typeof r.id === 'string' && typeof r.kind === 'string' && typeof r.ref === 'string'
    && typeof r.title === 'string' && Array.isArray(r.actions) && typeof r.createdAt === 'string'
    && typeof r.dedupeKey === 'string';
}

function rowsOf(file: InboxFile): InboxRow[] {
  return Array.isArray(file.rows) ? file.rows.filter(isRow) : [];
}

/** An info row: nothing to do but read it, so it dies after a day. */
function isInfo(row: InboxRow): boolean {
  return row.actions.every((a) => a === 'dismiss');
}

function alive(row: InboxRow, nowMs: number): boolean {
  if (!isInfo(row)) return true;
  const at = Date.parse(row.createdAt);
  return Number.isFinite(at) && nowMs - at < INFO_TTL_MS;
}

/** Open a row, or refresh the open row with the same `dedupeKey`. Returns the row kept. */
export function raiseInboxRow(projectRoot: string, row: NewInboxRow, home?: string, now: Date = new Date()): InboxRow {
  let kept: InboxRow | null = null;
  updateLocalJson<InboxFile>(projectRoot, FILE, { rows: [] }, (cur) => {
    const rows = rowsOf(cur).filter((r) => alive(r, now.getTime()));
    const existing = rows.find((r) => r.dedupeKey === row.dedupeKey);
    if (existing) {
      existing.title = row.title;
      existing.detail = row.detail;
      existing.actions = row.actions;
      kept = existing;
      return { rows };
    }
    const fresh: InboxRow = { ...row, id: `inb_${randomBytes(6).toString('hex')}`, createdAt: now.toISOString() };
    kept = fresh;
    return { rows: [...rows, fresh].slice(-MAX_ROWS) };
  }, home);
  return kept as unknown as InboxRow;
}

/** Every open row, oldest first. Never throws. */
export function listInboxRows(projectRoot: string, home?: string, now: Date = new Date()): InboxRow[] {
  return rowsOf(readLocalJson<InboxFile>(projectRoot, FILE, { rows: [] }, home)).filter((r) => alive(r, now.getTime()));
}

/** Close rows matching `match`. Returns how many went. Never throws. */
export function closeInboxRows(projectRoot: string, match: (row: InboxRow) => boolean, home?: string): number {
  let closed = 0;
  try {
    if (!rowsOf(readLocalJson<InboxFile>(projectRoot, FILE, { rows: [] }, home)).some(match)) return 0;
    updateLocalJson<InboxFile>(projectRoot, FILE, { rows: [] }, (cur) => {
      const rows = rowsOf(cur);
      const next = rows.filter((r) => !match(r));
      closed = rows.length - next.length;
      return { rows: next };
    }, home);
  } catch {
    // a row that outlives its subject is closed by the next writer of its kind
  }
  return closed;
}

/** Close one row by id (the owner pressed an action). Returns the row, or null. */
export function resolveInboxRow(projectRoot: string, id: string, home?: string): InboxRow | null {
  const row = listInboxRows(projectRoot, home).find((r) => r.id === id) ?? null;
  if (row) closeInboxRows(projectRoot, (r) => r.id === id, home);
  return row;
}
