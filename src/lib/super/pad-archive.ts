/**
 * The agenda's days are data (task ajanda-gunluk C4). A finished line that leaves the record
 * (an earlier day's roll-off, `note drop`, `note clear`, a full pad's eviction) is kept whole in
 * the file of the day it finished: `<days dir>/<YYYY-MM-DD>.json` (store.ts
 * `superAgendaDaysDir`, machine-local like the record).
 *
 * Every read and write is `lstat` + `realpath`-contained under the vault, a link refused (soul).
 * The append is idempotent (by `id` + `at`) and atomic (a temp file, then a rename); it runs
 * inside the record's own lock (store.ts `withSuperState`), so two writes never race one day.
 *
 * `agendaDoneOn` is the ONE definition of "Done on day D": the live pad's Done lines finished on
 * D plus D's file, one copy per id (the live pad wins for any id it holds; between file copies the
 * newest `at`). Roll-off is lazy and a failed archive puts lines back, so this rule shows every
 * line under its own day whatever state the archive is in.
 */
import { promises as fsp } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, relative, sep } from 'node:path';
import { type SuperId, type SuperPadItem } from './types.js';
import { readSuperState, sanitizePad, superAgendaDaysDir, superRecordPath } from './store.js';

/** A day's file never grows past this many lines (a day of 40-line pads, many times over). */
export const MAX_DAY_LINES = 2000;
const MAX_DAY_BYTES = 2 * 1024 * 1024;
export const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** `ms`'s local day, `YYYY-MM-DD` (the owner's day, on his machine). */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `D` as a real calendar day (strict `YYYY-MM-DD`, no Feb 30), or false. */
export function okDay(day: unknown): day is string {
  if (typeof day !== 'string' || !DAY_RE.test(day)) return false;
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(y, m - 1, d);
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d;
}

/** Refused: the days folder or a file in it is a link, or resolves outside the vault. */
export class DayArchiveRefused extends Error {
  constructor(message: string) { super(message); this.name = 'DayArchiveRefused'; }
}

/** The vault's real root and the days folder, checked: every folder from `state/` down is a plain
 *  folder resolving where it stands. `create` makes the last one (0700); only when the record it
 *  belongs to is on disk, so an archive racing a member's move to trash makes no orphan folder. */
async function containedDir(contextRoot: string, id: SuperId, create: boolean): Promise<string | null> {
  const dir = superAgendaDaysDir(contextRoot, id);
  let realRoot: string;
  try { realRoot = await fsp.realpath(contextRoot); } catch { throw new DayArchiveRefused('the vault cannot be resolved'); }
  const rel = relative(contextRoot, dir);
  const parts = rel.split(sep);
  let cur = contextRoot;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]);
    const last = i === parts.length - 1;
    let st: Awaited<ReturnType<typeof fsp.lstat>>;
    try { st = await fsp.lstat(cur); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      if (!create) return null;
      if (last) {
        try { await fsp.lstat(superRecordPath(contextRoot, id)); } catch { throw new DayArchiveRefused('the record is gone; no days folder is made for it'); }
      }
      await fsp.mkdir(cur, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
      st = await fsp.lstat(cur);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new DayArchiveRefused(`${join(...parts.slice(0, i + 1))} is not a plain folder; refusing it`);
    const real = await fsp.realpath(cur);
    if (real !== join(realRoot, ...parts.slice(0, i + 1))) throw new DayArchiveRefused(`${join(...parts.slice(0, i + 1))} resolves outside the vault`);
  }
  return dir;
}

/** A day file's lines, or [] when it is absent. A link is refused; a file that does not parse
 *  is thrown as corrupt (the writer sets it aside, a reader shows nothing for it). */
async function readDayFile(path: string): Promise<SuperPadItem[]> {
  let st: Awaited<ReturnType<typeof fsp.lstat>>;
  try { st = await fsp.lstat(path); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new DayArchiveRefused(`${basename(path)} is not a plain file; refusing it`);
  if (st.size > MAX_DAY_BYTES) throw new CorruptDay(`${basename(path)} is too large`);
  const text = await fsp.readFile(path, 'utf-8');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new CorruptDay(`${basename(path)} does not parse`); }
  const lines = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { lines?: unknown }).lines : undefined;
  if (!Array.isArray(lines)) throw new CorruptDay(`${basename(path)} has no lines`);
  return sanitizeDayLines(lines);
}

class CorruptDay extends Error {}

/** Day-file lines: the pad's own rules, ids may repeat (one line finished twice, reopened between). */
function sanitizeDayLines(raw: unknown[]): SuperPadItem[] {
  const out: SuperPadItem[] = [];
  for (const one of raw.slice(-MAX_DAY_LINES)) out.push(...sanitizePad([one], 1));
  return out;
}

/** Append `lines` (Done lines leaving the record) to the files of the days they finished. Throws
 *  on any failure (a refused link included): the caller (store.ts) keeps them on the record. */
export async function archiveDoneLines(contextRoot: string, id: SuperId, lines: readonly SuperPadItem[]): Promise<void> {
  if (!lines.length) return;
  const dir = await containedDir(contextRoot, id, true);
  if (!dir) throw new DayArchiveRefused('no days folder');
  const byDay = new Map<string, SuperPadItem[]>();
  for (const p of lines) {
    const day = localDay(p.at);
    byDay.set(day, [...(byDay.get(day) ?? []), p]);
  }
  for (const [day, add] of byDay) {
    const path = join(dir, `${day}.json`);
    let have: SuperPadItem[];
    try { have = await readDayFile(path); } catch (err) {
      if (!(err instanceof CorruptDay)) throw err;
      // A corrupt day would fail every archive into it: set it aside and start the day fresh.
      await fsp.rename(path, `${path}.corrupt-${Date.now()}`);
      have = [];
    }
    const seen = new Set(have.map((p) => `${p.id}\u0000${p.at}`));
    const fresh = add.filter((p) => !seen.has(`${p.id}\u0000${p.at}`));
    if (!fresh.length) continue;
    const next = [...have, ...fresh].slice(-MAX_DAY_LINES);
    const tmp = join(dirname(path), `.${day}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      await fsp.writeFile(tmp, `${JSON.stringify({ v: 1, day, lines: next })}\n`, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
      await fsp.rename(tmp, path);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }
}

/** One copy per id: `live` wins for any id it holds (any section); between file copies the newest `at`. */
export function mergeDayDone(live: readonly SuperPadItem[], fileLines: readonly SuperPadItem[], day: string): SuperPadItem[] {
  const liveIds = new Set(live.map((p) => p.id));
  const out = new Map<string, SuperPadItem>();
  for (const p of live) if (p.section === 'done' && localDay(p.at) === day) out.set(p.id, p);
  for (const p of fileLines) {
    if (liveIds.has(p.id)) continue;
    const was = out.get(p.id);
    if (!was || p.at > was.at) out.set(p.id, p);
  }
  return [...out.values()].sort((a, b) => b.at - a.at);
}

/** Day `day`'s Done lines (see the header). A day file that cannot be read gives the live lines. */
export async function agendaDoneOn(contextRoot: string, id: SuperId, day: string, livePad?: readonly SuperPadItem[]): Promise<SuperPadItem[]> {
  const live = livePad ?? (await readSuperState(contextRoot, id)).pad ?? [];
  let fileLines: SuperPadItem[] = [];
  try {
    const dir = await containedDir(contextRoot, id, false);
    if (dir) fileLines = await readDayFile(join(dir, `${day}.json`));
  } catch (err) {
    console.warn(`[super] ${superAgendaDaysDir(contextRoot, id)}: day ${day} could not be read: ${(err as Error).message}`);
  }
  return mergeDayDone(live, fileLines, day);
}
