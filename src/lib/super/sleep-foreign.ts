/**
 * Another Mac's lines in this Mac's sleep state (edge-case review, 2026-11-07).
 *
 * A brain that tracked `state/.sleep.json` merged every Mac's copy into one file: a teammate who
 * pulled it holds the owner's sessions, with their last replies, and the bookmarks caught from
 * them (the Super's "waiting on you" lines). Untracking the file stops the next push; it does not
 * take the owner's lines off the teammate's disk, where the snapshot and the Sleep page still show
 * them. So, at the one moment the file is still tracked (the sync's stage pass, or update), this
 * keeps what THIS Mac's sessions said and sets the rest aside.
 *
 * A session is this Mac's when its transcript is here (`sessionIsHere`: HOME's Claude projects,
 * every Claude account, Codex); a session id is never shared across machines. A bookmark goes
 * with its session; one with no session id stays. Nothing is deleted: what leaves goes to
 * `state/.sleep.json.foreign-<time>` (ignored, never read), so an old session of this Mac whose
 * transcript Claude has since cleaned up can be put back by hand. The other fields stay.
 *
 * Under the sleep-state lock, like every writer of the file. Never follows a symlink, never reads
 * an oversized file. Never throws.
 */

import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sessionIsHere } from './record-binding.js';
import { withSleepStateLock } from '../sleep-state-lock.js';

const MAX_BYTES = 32 * 1024 * 1024;

interface SleepLines {
  sessions?: unknown;
  bookmarks?: unknown;
  [k: string]: unknown;
}

const idOf = (v: unknown): string | null => {
  const id = (v as { session_id?: unknown } | null)?.session_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
};

/** Split `raw` into what stays and what leaves; null when nothing leaves. Pure but for `isHere`. */
export function splitForeignSleepLines(raw: SleepLines, isHere: (sessionId: string) => boolean): { keep: SleepLines; aside: { sessions: unknown[]; bookmarks: unknown[] } } | null {
  const sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
  const bookmarks = Array.isArray(raw.bookmarks) ? raw.bookmarks : [];
  const verdict = new Map<string, boolean>();
  const here = (id: string): boolean => {
    let v = verdict.get(id);
    if (v === undefined) { v = isHere(id); verdict.set(id, v); }
    return v;
  };
  const leaves = (item: unknown): boolean => { const id = idOf(item); return id !== null && !here(id); };
  const asideSessions = sessions.filter(leaves);
  const asideBookmarks = bookmarks.filter(leaves);
  if (asideSessions.length === 0 && asideBookmarks.length === 0) return null;
  return {
    keep: { ...raw, sessions: sessions.filter((s) => !leaves(s)), bookmarks: bookmarks.filter((b) => !leaves(b)) },
    aside: { sessions: asideSessions, bookmarks: asideBookmarks },
  };
}

/**
 * Keep this Mac's sessions and bookmarks in `state/.sleep.json`, set the rest aside. Returns the
 * set-aside file's path, or null when nothing left (or nothing could be read).
 */
export function setAsideForeignSleepLines(contextRoot: string, home: string = homedir(), now: Date = new Date()): string | null {
  const path = join(contextRoot, 'state', '.sleep.json');
  try {
    const out = withSleepStateLock(contextRoot, () => {
      if (!existsSync(path)) return null;
      const st = lstatSync(path);
      if (!st.isFile() || st.size > MAX_BYTES) return null;
      let raw: unknown;
      try { raw = JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const split = splitForeignSleepLines(raw as SleepLines, (id) => sessionIsHere(id, home));
      if (!split) return null;
      const aside = `${path}.foreign-${now.getTime()}`;
      writeFileSync(aside, `${JSON.stringify({ setAsideAt: now.toISOString(), why: 'sessions whose transcript is not on this Mac', ...split.aside }, null, 2)}\n`, { mode: 0o600 });
      const tmp = `${path}.${process.pid}.${now.getTime()}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(split.keep, null, 2)}\n`);
      renameSync(tmp, path);
      return aside;
    });
    return out.value;
  } catch {
    return null;
  }
}
