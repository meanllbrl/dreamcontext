import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { acquireFileLock, releaseFileLock } from '../file-lock.js';
import { projectKey } from '../local-store.js';
import { parsePattern, renderPattern, type RecordLessonInput } from '../automations/store.js';
import { globalMemoryDir } from './scope.js';

/**
 * A global agent's memory (AI Team v2 D1): one agent, many projects running it at once, and no
 * write ever lost to another.
 *
 *   memory/memory.md                       the folded pattern (playbook + lessons) and, in its
 *                                          frontmatter, the journal files already folded into it
 *   memory/journal/<ts>-<projectKey>-<run>.md   one file per lesson a run recorded
 *
 * A run never rewrites a shared file: it only ADDS its own journal file (a unique name, written
 * whole through tmp + rename). One consolidator per agent, under a PID lockfile, folds the journal
 * into `memory.md`; the folded names go into that SAME atomic write, and only then are the files
 * deleted. A crash between the write and the deletes leaves files the next read and the next
 * consolidation see as already folded, so nothing is folded twice. A second consolidator waits
 * for the first. A prompt reads `memory.md` plus every journal file not yet folded.
 *
 * Every read is the M2 rule: a regular file only, a link is never followed.
 */

const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 15_000;
const POLL_MS = 25;
/** A journal file's name: compact UTC stamp, the project's M0 key, the run. */
const JOURNAL_NAME = /^\d{8}T\d{9}Z-[0-9a-f]{16}-[A-Za-z0-9_-]{1,64}\.md$/;

export function journalDir(slug: string, home?: string): string {
  return join(globalMemoryDir(slug, home), 'journal');
}

function memoryPath(slug: string, home?: string): string {
  return join(globalMemoryDir(slug, home), 'memory.md');
}

function lockPath(slug: string, home?: string): string {
  return join(globalMemoryDir(slug, home), '.consolidate.lock');
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best effort */ }
}

function readRegular(path: string): string | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  renameSync(tmp, path);
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace('.', '');
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface JournalEntry {
  name: string;
  date: string;
  lesson: string | null;
  playbook: string | null;
}

/**
 * Add one lesson (and/or a playbook) to the agent's journal. Never touches another file, so
 * any number of runs in any number of projects can do this at once. Returns the file name.
 */
export function appendGlobalJournal(
  slug: string,
  projectRoot: string,
  input: RecordLessonInput,
  opts: { home?: string; runId?: string } = {},
): string {
  const lesson = input.lesson?.trim();
  const playbook = input.playbook?.trim();
  if (!lesson && playbook === undefined) throw new Error('Nothing to record — pass a lesson, a playbook, or both.');
  const now = input.now ?? new Date();
  const run = (opts.runId ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || randomBytes(6).toString('hex');
  // The random tail keeps two lessons of one run in one millisecond apart.
  const name = `${stamp(now)}-${projectKey(projectRoot)}-${run}${randomBytes(3).toString('hex')}.md`;
  const dir = journalDir(slug, opts.home);
  ensureDir(dir);
  const data: Record<string, unknown> = { date: localDate(now) };
  if (playbook !== undefined) data.playbook = playbook;
  writeAtomic(join(dir, name), matter.stringify(lesson ? `${lesson}\n` : '', data));
  return name;
}

function readJournal(slug: string, home?: string): JournalEntry[] {
  let names: string[];
  try {
    names = readdirSync(journalDir(slug, home));
  } catch {
    return [];
  }
  const out: JournalEntry[] = [];
  for (const name of names.filter((n) => JOURNAL_NAME.test(n)).sort()) {
    const raw = readRegular(join(journalDir(slug, home), name));
    if (raw === null) continue;
    try {
      const { data, content } = matter(raw);
      out.push({
        name,
        date: typeof data.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.date) ? data.date : name.slice(0, 4) + '-' + name.slice(4, 6) + '-' + name.slice(6, 8),
        lesson: content.trim() || null,
        playbook: typeof data.playbook === 'string' ? data.playbook : null,
      });
    } catch {
      // an unreadable entry is skipped (and never folded): it costs one lesson, never the memory
    }
  }
  return out;
}

/**
 * The folded memory, `{pattern: '', folded: []}` when there is none yet, or `'unreadable'` when a
 * file is there but cannot be read or parsed (a hand edit broke its frontmatter, an I/O error, a
 * link). Unreadable is never "empty": folding over it would erase every lesson folded before.
 */
function readMemoryFile(slug: string, home?: string): { pattern: string; folded: string[] } | 'unreadable' {
  const path = memoryPath(slug, home);
  let raw: string;
  try {
    if (!lstatSync(path).isFile()) return 'unreadable';
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { pattern: '', folded: [] } : 'unreadable';
  }
  try {
    const { data, content } = matter(raw);
    if (data.folded !== undefined && !Array.isArray(data.folded)) return 'unreadable';
    const folded = Array.isArray(data.folded) ? (data.folded as unknown[]).filter((n): n is string => typeof n === 'string') : [];
    return { pattern: content.trim(), folded };
  } catch {
    return 'unreadable';
  }
}

/** Entries applied in journal order (oldest first): each lesson lands newest-first, a playbook replaces. */
function apply(pattern: string, entries: readonly JournalEntry[]): string {
  if (entries.length === 0) return pattern;
  const p = parsePattern(pattern);
  for (const e of entries) {
    if (e.playbook !== null) p.playbook = e.playbook;
    if (e.lesson) p.lessons.unshift({ date: e.date, text: e.lesson });
  }
  return renderPattern(p);
}

/** What a prompt reads: the folded memory plus every journal entry not yet folded. Never throws. */
export function readGlobalPattern(slug: string, home?: string): string {
  try {
    const read = readMemoryFile(slug, home);
    // An unreadable memory still lends its journal: nothing folded is lost, nothing new is hidden.
    const mem = read === 'unreadable' ? { pattern: '', folded: [] } : read;
    const folded = new Set(mem.folded);
    return apply(mem.pattern, readJournal(slug, home).filter((e) => !folded.has(e.name)));
  } catch {
    return '';
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface ConsolidateResult {
  /** Journal files folded by this pass. */
  folded: number;
  /** True when another consolidator held the lock for the whole wait. */
  busy: boolean;
}

/**
 * Fold the journal into `memory.md`. One at a time per agent: a second caller waits (up to
 * `waitMs`) for the first. `crashAfterWrite` is for tests only: stop after the write, before the
 * deletes, as a crash there would.
 */
export function consolidateGlobalMemory(
  slug: string,
  opts: { home?: string; waitMs?: number; crashAfterWrite?: boolean } = {},
): ConsolidateResult {
  const lock = lockPath(slug, opts.home);
  ensureDir(globalMemoryDir(slug, opts.home));
  const deadline = Date.now() + (opts.waitMs ?? LOCK_WAIT_MS);
  let held = acquireFileLock(lock, Date.now(), LOCK_STALE_MS, { verifyPidLiveness: true });
  while (!held && Date.now() < deadline) {
    sleepSync(POLL_MS);
    held = acquireFileLock(lock, Date.now(), LOCK_STALE_MS, { verifyPidLiveness: true });
  }
  if (!held) return { folded: 0, busy: true };
  try {
    const mem = readMemoryFile(slug, opts.home);
    // Never fold over a memory that cannot be read: the journal keeps every lesson until it can.
    if (mem === 'unreadable') return { folded: 0, busy: false };
    const already = new Set(mem.folded);
    const journal = readJournal(slug, opts.home);
    const onDisk = new Set(journal.map((e) => e.name));
    const pending = journal.filter((e) => !already.has(e.name));
    // Names whose files are gone are dropped from the list; leftovers of a crash stay listed.
    const folded = [...mem.folded.filter((n) => onDisk.has(n)), ...pending.map((e) => e.name)];
    if (pending.length > 0 || folded.length !== mem.folded.length) {
      writeAtomic(memoryPath(slug, opts.home), matter.stringify(`${apply(mem.pattern, pending)}\n`, { folded }));
    }
    if (opts.crashAfterWrite) return { folded: pending.length, busy: false };
    for (const name of folded) {
      try { rmSync(join(journalDir(slug, opts.home), name), { force: true }); } catch { /* the next pass drops it */ }
    }
    return { folded: pending.length, busy: false };
  } finally {
    releaseFileLock(lock);
  }
}
