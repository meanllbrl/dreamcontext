/**
 * What an app learned, waiting for sleep (plan-tasima r12 K4, kept by plan-veri r3 K4).
 *
 * A queue OUTSIDE every repo: `~/.dreamcontext/apps/learn/<hash>.jsonl` (folder 0700, file 0600),
 * apart from the data folder a backend can write. Two sources: the app's own assistant
 * (`dreamcontext apps learn <slug> "…"`) and the backend (`dc.learn(text)` → gateway
 * `POST /__dc/learn`, Bearer only). The main session's agent is a trusted source with its own
 * ways in and never writes here.
 *
 * Only a COUNT reaches the snapshot and `sleep start`; the text is read by `sleep-product` alone,
 * fenced as untrusted (`apps learn-list`), and distilled into `knowledge/apps/<slug>.md`. The
 * queue empties only through `apps learn-done --through <id>`, for the records sleep processed.
 */

import { randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { acquireFileLock, releaseFileLock } from '../file-lock.js';
import { appsHome } from './registry.js';
import { makeRedactor } from './redact.js';

export const FINDING_MAX_CHARS = 600;
export const FINDINGS_MAX_PENDING = 20;

export interface Finding { id: string; at: string; source: string; text: string }

const HASH_RE = /^[A-Za-z0-9_-]{1,80}$/;
const ID_RE = /^f-[0-9a-z]{6,12}-[0-9a-f]{6}$/;
const LOCK_STALE_MS = 15_000;
const LOCK_WAIT_MS = 3_000;

export function learnDir(home: string): string {
  return join(appsHome(home), 'learn');
}

export function learnFile(home: string, hash: string): string {
  if (!HASH_RE.test(hash)) throw new Error('bad app hash');
  return join(learnDir(home), `${hash}.jsonl`);
}

/** Control characters out (a newline becomes a space), the generic secret shapes redacted, capped. */
export function cleanFinding(text: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  return makeRedactor([])(flat).slice(0, FINDING_MAX_CHARS);
}

function ensureDir(home: string): string {
  const dir = learnDir(home);
  mkdirSync(appsHome(home), { recursive: true, mode: 0o700 });
  try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('the findings folder is a symlink or not a folder');
  return dir;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock<T>(home: string, hash: string, fn: () => T): T {
  const lock = join(ensureDir(home), `.${hash}.lock`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = acquireFileLock(lock, Date.now(), LOCK_STALE_MS, { verifyPidLiveness: true });
  while (!held && Date.now() < deadline) {
    sleepSync(20);
    held = acquireFileLock(lock, Date.now(), LOCK_STALE_MS, { verifyPidLiveness: true });
  }
  if (!held) throw new Error('the findings queue is busy; retry');
  try { return fn(); } finally { releaseFileLock(lock); }
}

function parseLines(text: string): Finding[] {
  const out: Finding[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      if (typeof r.id !== 'string' || !ID_RE.test(r.id) || typeof r.at !== 'string' || typeof r.text !== 'string') continue;
      out.push({ id: r.id, at: r.at, source: typeof r.source === 'string' ? r.source : 'app', text: r.text });
    } catch { /* a torn line */ }
  }
  return out;
}

/** The file's records, a symlink refused (as empty). */
function readRecords(home: string, hash: string): Finding[] {
  const p = learnFile(home, hash);
  try {
    if (lstatSync(p).isSymbolicLink()) return [];
    return parseLines(readFileSync(p, 'utf-8'));
  } catch { return []; }
}

export function appendFinding(home: string, hash: string, input: { source: 'assistant' | 'backend'; text: string }): { ok: true; id: string } | { ok: false; code: 'learn_full' | 'learn_bad' } {
  if (typeof input.text !== 'string') return { ok: false, code: 'learn_bad' };
  const text = cleanFinding(input.text);
  if (!text) return { ok: false, code: 'learn_bad' };
  return withLock(home, hash, () => {
    if (readRecords(home, hash).length >= FINDINGS_MAX_PENDING) return { ok: false as const, code: 'learn_full' as const };
    const id = `f-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
    const line = JSON.stringify({ id, at: new Date().toISOString(), source: input.source, text }) + '\n';
    const fd = openSync(learnFile(home, hash), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, line); fsyncSync(fd); } finally { closeSync(fd); }
    return { ok: true as const, id };
  });
}

/** Oldest first. */
export function listFindings(home: string, hash: string): Finding[] {
  try { return readRecords(home, hash); } catch { return []; }
}

/** Never throws: the snapshot must not fall over a broken queue. */
export function countFindings(home: string, hash: string): number {
  try { return existsSync(learnFile(home, hash)) ? readRecords(home, hash).length : 0; } catch { return 0; }
}

/** Remove every record up to and including `id`. An unknown id removes nothing. */
export function doneThrough(home: string, hash: string, id: string): { removed: number } {
  return withLock(home, hash, () => {
    const all = readRecords(home, hash);
    const i = all.findIndex((f) => f.id === id);
    if (i < 0) return { removed: 0 };
    const keep = all.slice(i + 1);
    const p = learnFile(home, hash);
    if (!keep.length) {
      try { unlinkSync(p); } catch { /* gone */ }
      return { removed: i + 1 };
    }
    const tmp = `${p}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, keep.map((f) => JSON.stringify(f)).join('\n') + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, p);
    return { removed: i + 1 };
  });
}
