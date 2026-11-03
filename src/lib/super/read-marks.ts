import { promises as fsp } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { renameWithRetry } from '../fs-retry.js';
import { superReadMarksPath } from './store.js';
import type { SuperId } from './types.js';

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
 *    chat with a long past does not arrive all unread; raised only by the cap.
 *  - `read`: the messages read since then, each with the message's own time. "Mark all read"
 *    sends every unit too: a cut-off time would swallow what lands after it.
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
/**
 * A MEMBER Super's marks also say which of its own replies he has seen (plan r4 D7): `replies` =
 * the end times of the member session's owner-origin turns (newest {@link MAX_REPLIES}), `seenAt`
 * = the newest time he looked at the member's stage. Unread = replies newer than `seenAt`. Main's
 * file never carries them (its unread is the window's message count).
 */
export interface SuperReadMarks { since: number; read: ReadMark[]; replies?: number[]; seenAt?: number }
export interface ReadPatch { read?: ReadMark[]; seen?: true }
/** Replies a member's marks remember. */
export const MAX_REPLIES = 20;

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
  const out = capReadMarks({ since: o.since, read });
  if (Array.isArray(o.replies)) {
    const replies = cleanReplies(o.replies);
    if (replies.length) out.replies = replies;
  }
  if (okTime(o.seenAt)) out.seenAt = o.seenAt;
  return out;
}

/** Finite, non-negative, sorted, the newest MAX_REPLIES; anything else dropped. */
function cleanReplies(raw: readonly unknown[]): number[] {
  return raw.filter(okTime).sort((a, b) => a - b).slice(-MAX_REPLIES);
}

/** How many of a member's replies he has not seen. */
export function unseenReplies(marks: SuperReadMarks | null): number {
  if (!marks?.replies) return 0;
  const seen = marks.seenAt ?? -1;
  return marks.replies.filter((t) => t > seen).length;
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
 *  One key may hold several marks: the same words at another time are another message. */
export function mergeReadMarks(marks: SuperReadMarks, patch: ReadPatch): SuperReadMarks {
  const byId = new Map([...marks.read, ...(patch.read ?? [])].map((m) => [`${m.key}|${m.ts}`, m]));
  return { ...extras(marks), ...capReadMarks({ since: marks.since, read: [...byId.values()] }) };
}

/** A member's reply fields, carried through a merge or a cap untouched. */
function extras(m: SuperReadMarks): Pick<SuperReadMarks, 'replies' | 'seenAt'> {
  return { ...(m.replies ? { replies: m.replies } : {}), ...(m.seenAt !== undefined ? { seenAt: m.seenAt } : {}) };
}

/** A request body as a patch, or null when it is not one. */
export function parseReadPatch(body: unknown): ReadPatch | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  const patch: ReadPatch = {};
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
  if (o.seen !== undefined) {
    if (o.seen !== true) return null;
    patch.seen = true;
  }
  return patch;
}

/** Main's file (READ_MARKS_REL), or a member Super's beside its record (plan-r10 1). */
const marksPath = (contextRoot: string, id: SuperId = 'main') => (id === 'main' ? join(contextRoot, READ_MARKS_REL) : superReadMarksPath(contextRoot, id));

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
  // A member's marks live one folder down (`state/.super/members/`): its parent is checked too.
  if (basename(dir) === 'members') {
    const up = await fsp.lstat(dirname(dir)).catch(() => null);
    if (up && !up.isDirectory()) throw new Error('state/.super is not a directory');
  }
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
export function readReadMarks(contextRoot: string, id: SuperId = 'main'): Promise<SuperReadMarks | null> {
  const path = marksPath(contextRoot, id);
  return serial(path, () => loadFile(path));
}

/** Any write births the record (an empty patch is how the window does it): `since` = now. */
export function applyReadMarks(contextRoot: string, patch: ReadPatch, now: number = Date.now(), id: SuperId = 'main'): Promise<SuperReadMarks> {
  const path = marksPath(contextRoot, id);
  return serial(path, async () => {
    const merged = mergeReadMarks((await loadFile(path)) ?? { since: now, read: [] }, patch);
    await saveFile(path, merged);
    return merged;
  });
}

/** The record's death: the owner took the Super Agent back. */
export function clearReadMarks(contextRoot: string, id: SuperId = 'main'): Promise<void> {
  const path = marksPath(contextRoot, id);
  return serial(path, async () => {
    await checkDir(dirname(path));
    await fsp.rm(path, { force: true });
  });
}

/**
 * A member Super's turn for the owner ended at `at` (plan r4 D7). `seen`: he was looking at that
 * member's stage as it arrived, so it never counts (`seenAt` is raised with it). Never for main.
 */
export function noteReply(contextRoot: string, id: SuperId, at: number, seen: boolean): Promise<SuperReadMarks | null> {
  if (id === 'main') return Promise.resolve(null);
  const path = marksPath(contextRoot, id);
  return serial(path, async () => {
    const cur = (await loadFile(path)) ?? { since: at, read: [] };
    const next: SuperReadMarks = { ...cur, replies: cleanReplies([...(cur.replies ?? []), at]) };
    if (seen) next.seenAt = Math.max(cur.seenAt ?? 0, at);
    await saveFile(path, next);
    return next;
  });
}

/** He has seen the member's stage up to `now`: `seenAt` only ever rises. Never for main. */
export function markSeen(contextRoot: string, id: SuperId, now: number = Date.now()): Promise<SuperReadMarks | null> {
  if (id === 'main') return Promise.resolve(null);
  const path = marksPath(contextRoot, id);
  return serial(path, async () => {
    const cur = (await loadFile(path)) ?? { since: now, read: [] };
    if (cur.seenAt !== undefined && cur.seenAt >= now) return cur;
    const next: SuperReadMarks = { ...cur, seenAt: now };
    await saveFile(path, next);
    return next;
  });
}
