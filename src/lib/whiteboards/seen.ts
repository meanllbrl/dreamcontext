import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { liveElements } from './ops.js';
import { whiteboardsDir } from './store.js';
import { elementTag, type WhiteboardElement } from './widgets.js';

/**
 * What a session saw at its last `whiteboard show`, so the next `show` can say "this board
 * changed since you last looked, and not by you". Without it an agent that read a board,
 * drew elsewhere for a while and came back has no way to know another session filled the
 * empty space in between.
 *
 * One record per (board, session): `whiteboards/.locks/seen/<slug>/<session>.json`. It sits
 * under `.locks/`, which every board folder's own `.gitignore` already keeps out of git, so
 * it is machine-local and never synced. The session is `CLAUDE_CODE_SESSION_ID` (one Claude
 * session), else `terminal`.
 *
 * The session's own writes are folded in as they happen ({@link foldOwnWrite}), so what the
 * next `show` reports is only what someone else did: another session, the dashboard, a sync.
 * Every failure here is swallowed: a missing note must never fail a read or a write.
 */

interface SeenRecord {
  v: 1;
  /** The board's rev when this session last saw it (or last wrote it, with nothing else in between). */
  rev: string;
  /** When the session last ran `show`. */
  at: string;
  /** Every live element then: id → [version, tag]. */
  els: Record<string, [number, string | null]>;
}

/** One side of a change since the last `show`. */
export interface SeenChange {
  id: string;
  tag: string | null;
}

export interface SinceLastShow {
  /** When this session last ran `show` on the board. */
  at: string;
  added: SeenChange[];
  changed: SeenChange[];
  removed: SeenChange[];
}

/** Records older than this are removed whenever one is written. */
const SEEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function sessionKey(): string {
  const raw = process.env.CLAUDE_CODE_SESSION_ID?.trim();
  if (!raw) return 'terminal';
  return /^[A-Za-z0-9_-]{1,80}$/.test(raw) ? raw : createHash('sha1').update(raw).digest('hex');
}

function seenDir(root: string, slug: string): string {
  return join(whiteboardsDir(root), '.locks', 'seen', slug);
}

function snapshot(elements: readonly WhiteboardElement[]): SeenRecord['els'] {
  const els: SeenRecord['els'] = {};
  for (const el of liveElements(elements)) {
    els[el.id] = [typeof el.version === 'number' ? el.version : 0, elementTag(el) ?? null];
  }
  return els;
}

function readRecord(root: string, slug: string): SeenRecord | null {
  try {
    const file = join(seenDir(root, slug), `${sessionKey()}.json`);
    if (!lstatSync(file).isFile()) return null;
    const rec = JSON.parse(readFileSync(file, 'utf-8')) as SeenRecord;
    return rec && rec.v === 1 && typeof rec.rev === 'string' && rec.els && typeof rec.els === 'object' ? rec : null;
  } catch {
    return null;
  }
}

function writeRecord(root: string, slug: string, rec: SeenRecord): void {
  try {
    // Never through a link: every level is made one at a time and must be a real folder.
    const levels = [whiteboardsDir(root), join(whiteboardsDir(root), '.locks'), join(whiteboardsDir(root), '.locks', 'seen'), seenDir(root, slug)];
    for (const level of levels) {
      try {
        lstatSync(level);
      } catch {
        mkdirSync(level);
      }
      if (!lstatSync(level).isDirectory()) return;
    }
    const dir = seenDir(root, slug);
    const file = join(dir, `${sessionKey()}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec), 'utf-8');
    renameSync(tmp, file);
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        if (now - statSync(p).mtimeMs > SEEN_TTL_MS) rmSync(p, { force: true });
      } catch {
        /* raced with another prune */
      }
    }
  } catch {
    /* a note we could not keep is a note the next show will not have */
  }
}

/**
 * Called by `show`: what changed on the board since this session's last `show` (null on the
 * first look, or when nothing did), then remembers the board as it is now.
 */
export function noteShow(root: string, slug: string, rev: string, elements: readonly WhiteboardElement[]): { since: SinceLastShow | null; first: boolean } {
  const prev = readRecord(root, slug);
  const now = snapshot(elements);
  writeRecord(root, slug, { v: 1, rev, at: new Date().toISOString(), els: now });
  if (!prev) return { since: null, first: true };
  if (prev.rev === rev) return { since: null, first: false };
  const added: SeenChange[] = [];
  const changed: SeenChange[] = [];
  const removed: SeenChange[] = [];
  for (const [id, [version, tag]] of Object.entries(now)) {
    const before = prev.els[id];
    if (!before) added.push({ id, tag });
    else if (before[0] !== version) changed.push({ id, tag });
  }
  for (const [id, [, tag]] of Object.entries(prev.els)) if (!(id in now)) removed.push({ id, tag });
  if (added.length + changed.length + removed.length === 0) return { since: null, first: false };
  return { since: { at: prev.at, added, changed, removed }, first: false };
}

/**
 * Called after this session's own successful write. When nothing else wrote since the
 * session last looked, the record simply moves to the new rev. When something did, only the
 * elements this write touched are folded in, so the next `show` still reports the rest.
 */
export function foldOwnWrite(
  root: string,
  slug: string,
  write: { before: string; rev: string; elements: readonly WhiteboardElement[] },
  touched: readonly string[],
): void {
  const rec = readRecord(root, slug);
  if (!rec) return;
  const now = snapshot(write.elements);
  if (rec.rev === write.before) {
    writeRecord(root, slug, { ...rec, rev: write.rev, els: now });
    return;
  }
  for (const id of touched) {
    if (now[id]) rec.els[id] = now[id];
    else delete rec.els[id];
  }
  writeRecord(root, slug, rec);
}
