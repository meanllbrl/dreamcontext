import { promises as fsp } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { renameWithRetry } from '../fs-retry.js';

/**
 * What the owner has read in the Super Agent's chat — `state/.super/read-marks.json`, one per
 * vault, LOCAL-ONLY (the whole `state/.super/` directory is, git-sync/brain-repo.ts).
 *
 * A file rather than the window's storage, because the mark has to outlive what the window does
 * not: an app restart, a Super session rotated by a handoff, and the phone's mirror of the same
 * chat, which is another origin. Keys are derived from a message's WORDS by the window, never
 * from a session id, so a handoff changes nothing here.
 *
 *  - `since`: everything older than this counts as read. Born at the window's first POST, so a
 *    chat with a long past does not arrive all unread; raised by "mark all read" and by the cap.
 *  - `read`: the messages read one by one since then, each with the message's own time.
 *
 * Bounded by {@link MAX_READ}: the oldest marks fold into `since`. Dies with the hand-over
 * (`clearReadMarks`, called from the take-back): the next hand-over starts a new record.
 */

export const READ_MARKS_REL = join('state', '.super', 'read-marks.json');
export const MAX_READ = 2000;
/** Marks one POST may carry. */
export const MAX_READ_PATCH = 200;
export const READ_KEY_RE = /^[A-Za-z0-9:_.-]{1,96}$/;

export interface ReadMark { key: string; ts: number }
export interface SuperReadMarks { since: number; read: ReadMark[] }
export interface ReadPatch { read?: ReadMark[]; allBefore?: number }

const okTime = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** A record off disk, or null when it is not one (a broken file is a new record, never a crash). */
export function sanitizeReadMarks(raw: unknown): SuperReadMarks | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!okTime(o.since) || !Array.isArray(o.read)) return null;
  const read = o.read.flatMap((x): ReadMark[] => {
    const m = x as Partial<ReadMark> | null;
    return m && typeof m.key === 'string' && READ_KEY_RE.test(m.key) && okTime(m.ts) ? [{ key: m.key, ts: m.ts }] : [];
  });
  return capReadMarks({ since: o.since, read });
}

/** Oldest marks past the cap fold into `since`; a mark `since` already covers is dropped. */
export function capReadMarks(marks: SuperReadMarks): SuperReadMarks {
  let since = marks.since;
  let read = [...marks.read].sort((a, b) => a.ts - b.ts);
  if (read.length > MAX_READ) {
    since = Math.max(since, read[read.length - MAX_READ - 1].ts);
    read = read.slice(-MAX_READ);
  }
  return { since, read: read.filter((m) => m.ts > since) };
}

/** Marks only ever add: two surfaces reading at once can both be right, never undo each other.
 *  `now` caps `allBefore`, so a wrong clock cannot swallow messages yet to come. */
export function mergeReadMarks(marks: SuperReadMarks, patch: ReadPatch, now: number): SuperReadMarks {
  const byKey = new Map(marks.read.map((m) => [m.key, m]));
  for (const m of patch.read ?? []) {
    const held = byKey.get(m.key);
    if (!held || held.ts < m.ts) byKey.set(m.key, m);
  }
  const since = Math.max(marks.since, Math.min(patch.allBefore ?? 0, now));
  return capReadMarks({ since, read: [...byKey.values()] });
}

/** A request body as a patch, or null when it is not one. */
export function parseReadPatch(body: unknown): ReadPatch | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  const patch: ReadPatch = {};
  if (o.allBefore !== undefined) {
    if (!okTime(o.allBefore)) return null;
    patch.allBefore = o.allBefore;
  }
  if (o.read !== undefined) {
    if (!Array.isArray(o.read) || o.read.length > MAX_READ_PATCH) return null;
    const read: ReadMark[] = [];
    for (const x of o.read as unknown[]) {
      const m = x as Partial<ReadMark> | null;
      if (!m || typeof m.key !== 'string' || !READ_KEY_RE.test(m.key) || !okTime(m.ts)) return null;
      read.push({ key: m.key, ts: m.ts });
    }
    patch.read = read;
  }
  return patch;
}

const marksPath = (contextRoot: string) => join(contextRoot, READ_MARKS_REL);

async function loadFile(path: string): Promise<SuperReadMarks | null> {
  try {
    if ((await fsp.lstat(path)).isSymbolicLink()) throw new Error('the read marks file is a symlink');
    return sanitizeReadMarks(JSON.parse(await fsp.readFile(path, 'utf8')));
  } catch (err) {
    if ((err as Error).message === 'the read marks file is a symlink') throw err;
    return null;
  }
}

/** A committed symlink at `state/.super` must not carry a write out of the vault. */
async function checkDir(dir: string): Promise<void> {
  const st = await fsp.lstat(dir).catch(() => null);
  if (st && !st.isDirectory()) throw new Error('state/.super is not a directory');
}

async function saveFile(path: string, marks: SuperReadMarks): Promise<void> {
  await checkDir(dirname(path));
  await fsp.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(marks), { mode: 0o600 });
    await renameWithRetry(tmp, path);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** One writer at a time per vault; dropped when the queue drains, so no entry outlives its work. */
const queues = new Map<string, Promise<unknown>>();
function serial<T>(path: string, run: () => Promise<T>): Promise<T> {
  const next = (queues.get(path) ?? Promise.resolve()).catch(() => {}).then(run);
  queues.set(path, next);
  void next.catch(() => {}).finally(() => { if (queues.get(path) === next) queues.delete(path); });
  return next;
}

/** The vault's record, or null before its birth. Never writes (the phone's GET rule). */
export function readReadMarks(contextRoot: string): Promise<SuperReadMarks | null> {
  const path = marksPath(contextRoot);
  return serial(path, () => loadFile(path));
}

/** Any write births the record (an empty patch is how the window does it): `since` = now. */
export function applyReadMarks(contextRoot: string, patch: ReadPatch, now: number = Date.now()): Promise<SuperReadMarks> {
  const path = marksPath(contextRoot);
  return serial(path, async () => {
    const merged = mergeReadMarks((await loadFile(path)) ?? { since: now, read: [] }, patch, now);
    await saveFile(path, merged);
    return merged;
  });
}

/** The record's death: the owner took the Super Agent back. */
export function clearReadMarks(contextRoot: string): Promise<void> {
  const path = marksPath(contextRoot);
  return serial(path, async () => {
    await checkDir(dirname(path));
    await fsp.rm(path, { force: true });
  });
}
