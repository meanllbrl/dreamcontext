import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateId } from './id.js';
import { ensureGitignoreEntries } from './gitignore.js';
import { safeResolveInside } from './safe-resolve.js';
import { withTaskFileLock } from './task-file-lock.js';

/**
 * The task audit: every owner override and verdict the task system records
 * (approve, send back, accept, apply, --force, an eval exemption) and every
 * parent a sync held open, with WHO did it and THROUGH WHAT (`via`).
 *
 * It is a detective control, not a security boundary (plan r3 amendment E9):
 * the CLI's owner checks and the verdict routes guard against accidents, and
 * this list is how the owner sees, on the Inbox, anything that went past them.
 * `via: 'no-origin'` marks a write that reached the server without a browser
 * Origin, the shape a scripted call has.
 *
 * Machine-local by design. The file never syncs: `ensureLocalStateIgnored` puts
 * it (and C7's two state files) in both governing `.gitignore` files BEFORE the
 * first write, and its atomic-write temp lives under `_dream_context/tmp/`
 * (already ignored), never beside it in `state/`.
 */

/** The audit file, relative to the context root. Referenced only in this module. */
const TASK_AUDIT_REL = 'state/.task-audit.json';

/** One lock key for the whole file: every write is a read-modify-write. */
const AUDIT_LOCK_KEY = '.task-audit';

/** Oldest entries go first past this: the Inbox shows the last 30 days anyway. */
export const MAX_AUDIT_ENTRIES = 500;

/**
 * The machine-local task-system state files, relative to the context root. Each
 * is created by the module that owns it, and every one of those modules calls
 * {@link ensureLocalStateIgnored} before its first write.
 */
export const LOCAL_STATE_FILES = [
  'state/.owner-corrections.json',
  'state/.learned-patterns.json',
  'state/.task-audit.json',
] as const;

const LOCAL_STATE_IGNORE_COMMENT =
  'dreamcontext local state — owner quotes, learned-pattern history and the task audit never sync';

/**
 * Put {@link LOCAL_STATE_FILES} in both governing `.gitignore` files: the
 * brain's own (`_dream_context/.gitignore`) and the project root's (with the
 * `_dream_context/` prefix). Same shape as `ensureAgentsGitignore`.
 *
 * Throws when a `.gitignore` is not a regular file or cannot be written, and
 * that is on purpose: a caller that cannot have the ignore entry must not write
 * the file (a write without its ignore entry could be committed and pushed).
 * Returns the entries it actually added; empty means already covered.
 */
export function ensureLocalStateIgnored(contextRoot: string): string[] {
  const inner = ensureGitignoreEntries(contextRoot, [...LOCAL_STATE_FILES], { comment: LOCAL_STATE_IGNORE_COMMENT });
  const outer = ensureGitignoreEntries(
    dirname(contextRoot),
    LOCAL_STATE_FILES.map((p) => `_dream_context/${p}`),
    { comment: LOCAL_STATE_IGNORE_COMMENT },
  );
  return [...inner, ...outer];
}

/**
 * Atomic JSON write for the local state files: the temp goes under the
 * already-ignored `_dream_context/tmp/`, never next to the target in `state/`,
 * so even an interrupted write leaves nothing a `git add` could pick up.
 */
export function writeLocalStateJson(contextRoot: string, rel: string, value: unknown): void {
  const target = safeResolveInside(contextRoot, rel);
  const tmpDir = safeResolveInside(contextRoot, 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(dirname(target), { recursive: true });
  const tmp = join(tmpDir, `${rel.replace(/[^A-Za-z0-9_.-]/g, '_')}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf-8');
  renameSync(tmp, target);
}

// ─── The audit ───────────────────────────────────────────────────────────────

export type AuditVia = 'cli' | 'dashboard' | 'phone' | 'no-origin';
export const AUDIT_VIAS: readonly AuditVia[] = ['cli', 'dashboard', 'phone', 'no-origin'];

export type AuditKind = 'approval' | 'send_back' | 'accept' | 'apply' | 'force' | 'held_open' | 'exempt';
export const AUDIT_KINDS: readonly AuditKind[] = ['approval', 'send_back', 'accept', 'apply', 'force', 'held_open', 'exempt'];

export interface AuditSeen {
  at: string;
  actor: string;
  via: AuditVia;
}

export interface AuditEntry {
  /** `ta_<nanoid8>` */
  id: string;
  at: string;
  kind: AuditKind;
  slug: string;
  actor: string;
  via: AuditVia;
  note: string | null;
  journalId: string | null;
  seen?: AuditSeen;
}

export type NewAuditEntry = Omit<AuditEntry, 'id' | 'at' | 'seen'>;

export class AuditError extends Error {}

function isEntry(e: unknown): e is AuditEntry {
  if (!e || typeof e !== 'object') return false;
  const x = e as Record<string, unknown>;
  return typeof x.id === 'string'
    && typeof x.at === 'string'
    && typeof x.slug === 'string'
    && typeof x.actor === 'string'
    && AUDIT_KINDS.includes(x.kind as AuditKind)
    && AUDIT_VIAS.includes(x.via as AuditVia);
}

/** Newest first. A missing or unreadable file reads as empty: the audit never blocks a read. */
function readAll(contextRoot: string): AuditEntry[] {
  let p: string;
  try {
    p = safeResolveInside(contextRoot, TASK_AUDIT_REL);
  } catch {
    return [];
  }
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as { entries?: unknown };
    return Array.isArray(parsed?.entries) ? parsed.entries.filter(isEntry) : [];
  } catch {
    return [];
  }
}

function writeAll(contextRoot: string, entries: AuditEntry[]): void {
  writeLocalStateJson(contextRoot, TASK_AUDIT_REL, { version: 1, entries: entries.slice(0, MAX_AUDIT_ENTRIES) });
}

/**
 * Record one entry (newest first). The ignore entries are ensured before
 * anything is read or written; a failure there throws and nothing is written.
 */
export function recordAudit(contextRoot: string, e: NewAuditEntry, now: Date = new Date()): AuditEntry {
  ensureLocalStateIgnored(contextRoot);
  if (!AUDIT_KINDS.includes(e.kind)) throw new AuditError(`Unknown audit kind: ${String(e.kind)}`);
  if (!AUDIT_VIAS.includes(e.via)) throw new AuditError(`Unknown audit via: ${String(e.via)}`);
  const entry: AuditEntry = {
    id: generateId('ta'),
    at: now.toISOString(),
    kind: e.kind,
    slug: e.slug,
    actor: e.actor,
    via: e.via,
    note: e.note ?? null,
    journalId: e.journalId ?? null,
  };
  withTaskFileLock(contextRoot, AUDIT_LOCK_KEY, () => {
    writeAll(contextRoot, [entry, ...readAll(contextRoot)]);
  });
  return entry;
}

export interface ListAuditOptions {
  kinds?: readonly AuditKind[];
  /** Only entries newer than this many days. */
  sinceDays?: number;
  /** Only entries not yet marked seen. */
  unseenOnly?: boolean;
  now?: Date;
}

/** Entries, newest first. */
export function listAudit(contextRoot: string, opts: ListAuditOptions = {}): AuditEntry[] {
  const now = (opts.now ?? new Date()).getTime();
  const cutoff = opts.sinceDays !== undefined ? now - opts.sinceDays * 86_400_000 : null;
  return readAll(contextRoot).filter((e) => {
    if (opts.kinds && !opts.kinds.includes(e.kind)) return false;
    if (opts.unseenOnly && e.seen) return false;
    if (cutoff !== null && Date.parse(e.at) < cutoff) return false;
    return true;
  });
}

/** Mark one entry seen, recording who cleared it and through what. */
export function markAuditSeen(contextRoot: string, id: string, actor: string, via: AuditVia, now: Date = new Date()): AuditEntry {
  ensureLocalStateIgnored(contextRoot);
  if (!AUDIT_VIAS.includes(via)) throw new AuditError(`Unknown audit via: ${String(via)}`);
  return withTaskFileLock(contextRoot, AUDIT_LOCK_KEY, () => {
    const all = readAll(contextRoot);
    const hit = all.find((e) => e.id === id);
    if (!hit) throw new AuditError(`No audit entry ${id}.`);
    hit.seen = { at: now.toISOString(), actor, via };
    writeAll(contextRoot, all);
    return hit;
  });
}

/**
 * A sync held a parent open (a remote close while its sub-tasks are open, r2 B6): flag
 * it on the Inbox once. A flag already waiting for that parent is not repeated on every
 * pull. The sync is never aborted for the audit: when the record cannot be written
 * (its ignore entries cannot be ensured, the file is busy), nothing is written and
 * `warn` says so.
 */
export function recordHeldOpen(contextRoot: string, slug: string, open: number, warn: (message: string) => void): void {
  try {
    if (listAudit(contextRoot, { kinds: ['held_open'], unseenOnly: true }).some((e) => e.slug === slug)) return;
    recordAudit(contextRoot, {
      kind: 'held_open',
      slug,
      actor: 'sync',
      via: 'cli',
      note: `closed on the remote while ${open} sub-task(s) are open; kept open here`,
      journalId: null,
    });
  } catch (err) {
    warn(`${slug}: the held-open parent is not on the Inbox (the task audit cannot be written: ${err instanceof Error ? err.message : String(err)}).`);
  }
}
