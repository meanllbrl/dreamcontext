/**
 * Deletes of shared app data (app-veri-ortak plan r6, K6). Absence is never a delete: a tracked
 * shared file missing from disk stays in git. A real delete comes only from the app itself
 * (`dc.data.remove`), which leaves a TOMBSTONE here, `~/.dreamcontext/apps/deletes/<hash>.json`
 * = `{paths: [{path, at, approved?, sentAt?, blocked?}]}`. The exchange layer (data-exchange.ts)
 * stages `git rm --cached` only for a tombstoned path, and clears the stone once the delete
 * commit reached the remote.
 *
 * A sync with more than {@link PER_SYNC_DELETE_CAP} unapproved deletes sends none of them and asks
 * the owner (a broken app must not wipe the team's data at once). THE set the owner is shown, the
 * set an approval marks and the count a sync calls waiting are one function,
 * {@link waitingDeletes}: live, not approved, not `blocked` (the last sync found it cannot be sent
 * from here: the path is untracked, back on disk, or not shared from this Mac). The owner's answer
 * {@link approveDeletes} names the COUNT they saw and approves only when that set still has
 * exactly that many; a grown set is refused, nothing approved. A stone waiting for that answer
 * never expires: the {@link TOMBSTONE_TTL_MS} counts from the first sync that SENT it.
 *
 * Every writer (the server's `addTombstone`, the sync's `markSent`/`clearTombstones`/
 * `setBlocked`, the CLI's `approveDeletes`) re-reads and writes under one per-app PID lock, so a
 * stone added by another process between a read and a write is never lost.
 */

import { acquireFileLock, releaseFileLock } from '../file-lock.js';
import { appStateFile, readJsonStrict, writeJsonAtomic } from './data-consent.js';
import { pathNameRefusal } from './data-share.js';

export const PER_SYNC_DELETE_CAP = 20;
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A runaway app cannot grow the file without bound. */
const MAX_STONES = 1000;
/** How long a writer waits for another process's write (each one is a read and a rename). */
export const STONES_LOCK_WAIT_MS = 2000;
const STONES_LOCK_STALE_MS = 30_000;

export interface Tombstone {
  path: string;
  at: string;
  /** The owner approved this delete past the per-sync cap ({@link approveDeletes}). */
  approved?: boolean;
  /** When a sync first sent it (staged the delete); the expiry counts from here. */
  sentAt?: string;
  /** The last sync found it cannot be sent from this Mac ({@link setBlocked}): not waiting. */
  blocked?: boolean;
}

export function tombstonesPath(home: string, hash: string): string {
  return appStateFile(home, 'deletes', hash);
}

function readAll(home: string, hash: string): Tombstone[] {
  let raw: unknown;
  try { raw = readJsonStrict(tombstonesPath(home, hash)); } catch { return []; }
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { paths?: unknown }).paths)) return [];
  const out: Tombstone[] = [];
  for (const t of (raw as { paths: unknown[] }).paths) {
    if (!t || typeof t !== 'object') continue;
    const { path, at, approved, sentAt, blocked } = t as Record<string, unknown>;
    if (typeof path !== 'string' || pathNameRefusal(path) || typeof at !== 'string' || Number.isNaN(Date.parse(at))) continue;
    if (out.some((x) => x.path === path)) continue;
    const stone: Tombstone = { path, at };
    if (approved === true) stone.approved = true;
    if (typeof sentAt === 'string' && !Number.isNaN(Date.parse(sentAt))) stone.sentAt = sentAt;
    if (blocked === true) stone.blocked = true;
    out.push(stone);
  }
  return out;
}

/** A stone not yet sent waits for its sync (or the owner) and never expires. */
const live = (t: Tombstone, nowMs: number) => !t.sentAt || nowMs - Date.parse(t.sentAt) < TOMBSTONE_TTL_MS;

const sleepMs = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/**
 * Read, change and write this app's stones under its lock (re-read inside it). `fn` returns the
 * new list, or null for "no change". Throws when the lock cannot be had in
 * {@link STONES_LOCK_WAIT_MS} (never writes over another process's change).
 */
function withStones<T>(home: string, hash: string, fn: (all: Tombstone[]) => { next: Tombstone[] | null; out: T }): T {
  const file = tombstonesPath(home, hash);
  const lock = `${file}.lock`;
  const end = Date.now() + STONES_LOCK_WAIT_MS;
  while (!acquireFileLock(lock, Date.now(), STONES_LOCK_STALE_MS, { verifyPidLiveness: true })) {
    if (Date.now() >= end) throw new Error('the tombstones of this app are being written by another process; try again');
    sleepMs(10);
  }
  try {
    const r = fn(readAll(home, hash));
    if (r.next) writeJsonAtomic(file, { paths: r.next.slice(-MAX_STONES) });
    return r.out;
  } finally {
    releaseFileLock(lock);
  }
}

/**
 * Record that the app deleted `relPath` (relative to its data folder). Deleting a path again keeps
 * the owner's approval of it (the owner already said yes to that path), and starts it unsent and
 * unjudged. Throws on a bad path, or when the lock cannot be had.
 */
export function addTombstone(home: string, hash: string, relPath: string, nowMs: number = Date.now()): Tombstone {
  if (pathNameRefusal(relPath)) throw new Error(`bad path: ${relPath.slice(0, 80)}`);
  return withStones<Tombstone>(home, hash, (all) => {
    const was = all.find((t) => t.path === relPath);
    const stone: Tombstone = { path: relPath, at: new Date(nowMs).toISOString(), ...(was?.approved ? { approved: true } : {}) };
    return { next: [...all.filter((t) => live(t, nowMs) && t.path !== relPath), stone], out: stone };
  });
}

/** The live tombstones (expired ones left out). Never throws. */
export function listTombstones(home: string, hash: string, nowMs: number = Date.now()): Tombstone[] {
  try { return readAll(home, hash).filter((t) => live(t, nowMs)); } catch { return []; }
}

/** Is this stone waiting for the owner? (The one predicate behind {@link waitingDeletes}.) */
const isWaiting = (t: Tombstone): boolean => !t.approved && !t.blocked;

/**
 * THE deletes waiting for the owner: live, not approved, not blocked. The CLI lists exactly these,
 * {@link approveDeletes} approves exactly these, and a sync's `capStones(...).waiting` counts
 * exactly these. Never throws.
 */
export function waitingDeletes(home: string, hash: string, nowMs: number = Date.now()): Tombstone[] {
  return listTombstones(home, hash, nowMs).filter(isWaiting);
}

/** Drop the stones whose delete reached the remote, and the expired ones. */
export function clearTombstones(home: string, hash: string, delivered: string[], nowMs: number = Date.now()): void {
  withStones<void>(home, hash, (all) => {
    const keep = all.filter((t) => live(t, nowMs) && !delivered.includes(t.path));
    return { next: keep.length === all.length ? null : keep, out: undefined };
  });
}

/**
 * The owner's answer to "N deletes are waiting" (`apps data deletes <slug>` lists them and prints
 * the exact `apps data deletes <slug> --approve <N> --confirm` line):
 * approves the {@link waitingDeletes} set ONLY when it still has exactly `expect` stones, the
 * number the owner was shown. Otherwise nothing changes and the current count comes back
 * (`changed`), so a list that grew after the owner looked (a broken app still deleting) is shown
 * again, never approved unseen. Throws on a bad hash or when the lock cannot be had.
 */
export type ApproveDeletesResult = { ok: true; approved: number } | { ok: false; reason: 'changed'; waiting: number };

export function approveDeletes(home: string, hash: string, expect: number, nowMs: number = Date.now()): ApproveDeletesResult {
  return withStones<ApproveDeletesResult>(home, hash, (all) => {
    const waiting = all.filter((t) => live(t, nowMs) && isWaiting(t));
    if (waiting.length !== expect) return { next: null, out: { ok: false, reason: 'changed', waiting: waiting.length } };
    if (!waiting.length) return { next: null, out: { ok: true, approved: 0 } };
    const marked = new Set(waiting.map((t) => t.path));
    return { next: all.map((t) => (marked.has(t.path) ? { ...t, approved: true } : t)), out: { ok: true, approved: waiting.length } };
  });
}

/** A sync staged these deletes: the expiry starts (once; a resend keeps the first time). */
export function markSent(home: string, hash: string, paths: string[], nowMs: number = Date.now()): void {
  withStones<void>(home, hash, (all) => {
    let changed = false;
    const next = all.map((t) => {
      if (t.sentAt || !paths.includes(t.path)) return t;
      changed = true;
      return { ...t, sentAt: new Date(nowMs).toISOString() };
    });
    return { next: changed ? next : null, out: undefined };
  });
}

/**
 * The sync's verdict on every stone of this app: `blockedPaths` cannot be sent from this Mac now
 * (untracked, back on disk, not shared from here); every other stone is unblocked. A blocked stone
 * is neither waiting nor approvable until a later sync finds it sendable again.
 */
export function setBlocked(home: string, hash: string, blockedPaths: string[], nowMs: number = Date.now()): void {
  withStones<void>(home, hash, (all) => {
    let changed = false;
    const next = all.map((t) => {
      if (!live(t, nowMs)) return t;
      const want = blockedPaths.includes(t.path);
      if (!!t.blocked === want) return t;
      changed = true;
      const { blocked: _b, ...rest } = t;
      return want ? { ...rest, blocked: true } : rest;
    });
    return { next: changed ? next : null, out: undefined };
  });
}

/**
 * One sync's deletes, from the stones it can send. Approved ones always go; the waiting ones
 * ({@link isWaiting}, the same predicate as {@link waitingDeletes}) all go, or none and the owner
 * is asked when there are more than the cap. `waiting` = how many are waiting, ask or not.
 */
export function capStones(stones: Tombstone[]): { send: string[]; ask: boolean; waiting: number } {
  const approved = stones.filter((t) => t.approved && !t.blocked).map((t) => t.path);
  const rest = stones.filter(isWaiting).map((t) => t.path);
  const cap = capDeletes(rest);
  return { send: [...approved, ...cap.send], ask: cap.ask, waiting: rest.length };
}

/** One sync's deletes: all of them, or none and ask, when there are more than the cap. */
export function capDeletes(paths: string[]): { send: string[]; ask: boolean } {
  return paths.length > PER_SYNC_DELETE_CAP ? { send: [], ask: true } : { send: paths, ask: false };
}
