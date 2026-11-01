/**
 * The app chat record (plan r9, D4): one file per conversation,
 * `~/.dreamcontext/apps/chats/<id>.json`, 0600, temp+rename. It is what makes a conversation an
 * app chat: membership = the file exists, whichever pane or route names the id.
 *
 * Files are NEVER deleted. A listing caps at 50 and older rows just stop listing, while the file
 * keeps refusing what it refused (a tombstone). A damaged file reads as `damaged`, which every
 * caller treats as a refusal, so a write cut short can never turn an app chat into a plain one.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { UUID_RE } from '../agent-session-map.js';
import { appChatsDir } from './registry.js';

export interface AppChatRecord {
  id: string;
  hash: string;
  slug: string;
  projectRoot: string;
  /** The AI Team member bound at creation; null = the app's own assistant. */
  member: string | null;
  title: string;
  createdAt: string;
  /** Closed from the strip: gone from the open row, still in the history. */
  closedAt: string | null;
  /** The app was removed: reads, never spawns. */
  removedAt: string | null;
  /** The conversation this one rotated from (`/clear`, a compaction, a handoff). */
  via: string | null;
}

export type AppChatLookup =
  | { kind: 'none' }
  | { kind: 'record'; record: AppChatRecord }
  | { kind: 'damaged' };

export const APP_CHAT_LIST_MAX = 50;
const TITLE_MAX = 120;

function recordPath(id: string, home: string): string {
  if (!UUID_RE.test(id)) throw new Error('bad app chat id');
  return join(appChatsDir(home), `${id}.json`);
}

function parseRecord(text: string, id: string): AppChatRecord | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.id !== id) return null;
  for (const k of ['hash', 'slug', 'projectRoot', 'createdAt']) if (typeof r[k] !== 'string' || !r[k]) return null;
  const opt = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  return {
    id, hash: r.hash as string, slug: r.slug as string, projectRoot: r.projectRoot as string,
    member: opt(r.member), title: typeof r.title === 'string' ? r.title : '', createdAt: r.createdAt as string,
    closedAt: opt(r.closedAt), removedAt: opt(r.removedAt), via: opt(r.via),
  };
}

/** The record of a conversation. An id that is no UUID has none: it can name no file. */
export function lookupAppChat(id: string, home: string = homedir()): AppChatLookup {
  if (!id || !UUID_RE.test(id)) return { kind: 'none' };
  const file = recordPath(id, home);
  let st;
  try { st = lstatSync(file); } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'none' } : { kind: 'damaged' };
  }
  if (!st.isFile()) return { kind: 'damaged' };
  let text: string;
  try { text = readFileSync(file, 'utf-8'); } catch { return { kind: 'damaged' }; }
  const record = parseRecord(text, id);
  return record ? { kind: 'record', record } : { kind: 'damaged' };
}

/** The first of these ids that is an app chat, or a damaged one. */
export function lookupAppChatOf(ids: ReadonlyArray<string | null | undefined>, home: string = homedir()): AppChatLookup {
  for (const id of ids) {
    if (!id) continue;
    const hit = lookupAppChat(id, home);
    if (hit.kind !== 'none') return hit;
  }
  return { kind: 'none' };
}

/**
 * Every path that resumes a conversation outside the app gate asks this: a record id runs only
 * under its envelope, which only `startChatSession` applies. The reason, or null for any other id.
 */
export function appChatRefusal(id: string | null | undefined, home: string = homedir()): string | null {
  return lookupAppChat(id ?? '', home).kind === 'none'
    ? null
    : 'This conversation belongs to an app and opens only in Chat.';
}

/** The same, for a path with no one to answer: it throws, and returns the id for an argv. */
export function assertNotAppChat(id: string, home: string = homedir()): string {
  const why = appChatRefusal(id, home);
  if (why) throw new Error(why);
  return id;
}

function write(record: AppChatRecord, home: string): void {
  const dir = appChatsDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = recordPath(record.id, home);
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, file);
}

export function createAppChat(
  input: Pick<AppChatRecord, 'id' | 'hash' | 'slug' | 'projectRoot' | 'member'> & { title?: string; via?: string | null },
  home: string = homedir(),
): AppChatRecord {
  const record: AppChatRecord = {
    id: input.id, hash: input.hash, slug: input.slug, projectRoot: input.projectRoot, member: input.member,
    title: input.title ?? '', createdAt: new Date().toISOString(), closedAt: null, removedAt: null, via: input.via ?? null,
  };
  write(record, home);
  return record;
}

function patch(id: string, change: Partial<Pick<AppChatRecord, 'title' | 'closedAt' | 'removedAt'>>, home: string): AppChatRecord | null {
  const hit = lookupAppChat(id, home);
  if (hit.kind !== 'record') return null;
  const next = { ...hit.record, ...change };
  write(next, home);
  return next;
}

export function closeAppChat(id: string, home: string = homedir()): AppChatRecord | null {
  return patch(id, { closedAt: new Date().toISOString() }, home);
}

/** Picked from the history: back on the open row. */
export function reopenAppChat(id: string, home: string = homedir()): AppChatRecord | null {
  return patch(id, { closedAt: null }, home);
}

export function titleAppChat(id: string, title: string, home: string = homedir()): AppChatRecord | null {
  return patch(id, { title: Array.from(title.trim()).slice(0, TITLE_MAX).join('') }, home);
}

/**
 * A conversation rotated: the successor gets its own file, written from the stream's `session_id`
 * so the envelope holds with hooks off, and the predecessor is stamped closed. Idempotent, and
 * safe to call on every frame.
 */
export function rotateAppChat(from: AppChatRecord, to: string, home: string = homedir()): AppChatRecord | null {
  if (to === from.id || !UUID_RE.test(to) || lookupAppChat(to, home).kind !== 'none') return null;
  const next = createAppChat({ ...from, id: to, title: from.title, via: from.id }, home);
  patch(from.id, { closedAt: new Date().toISOString() }, home);
  return next;
}

function allRecords(home: string): AppChatRecord[] {
  const dir = appChatsDir(home);
  if (!existsSync(dir)) return [];
  const out: AppChatRecord[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -'.json'.length);
    if (!UUID_RE.test(id)) continue;
    const hit = lookupAppChat(id, home);
    if (hit.kind === 'record') out.push(hit.record);
  }
  return out;
}

/** An app's conversations, newest first, a rotated one collapsed into its successor. */
export function listAppChats(hash: string, projectRoot: string, home: string = homedir()): AppChatRecord[] {
  const own = allRecords(home).filter((r) => r.hash === hash && r.projectRoot === projectRoot);
  const rotated = new Set(own.map((r) => r.via).filter(Boolean));
  return own
    .filter((r) => !rotated.has(r.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, APP_CHAT_LIST_MAX);
}

/** Every id of this app, rotated ones included: what the history and the file route filter on. */
export function appChatIds(hash: string, projectRoot: string, home: string = homedir()): Set<string> {
  return new Set(allRecords(home).filter((r) => r.hash === hash && r.projectRoot === projectRoot).map((r) => r.id));
}

/** The app is gone: its conversations read, and spawn nothing. Returns their ids. */
export function stampAppRemoved(hash: string, home: string = homedir()): string[] {
  const at = new Date().toISOString();
  const ids: string[] = [];
  for (const r of allRecords(home)) {
    if (r.hash !== hash) continue;
    ids.push(r.id);
    if (!r.removedAt) patch(r.id, { removedAt: at }, home);
  }
  return ids;
}

/** The per-chat gate file: its list of what runs bare, under the `chats/**` write deny. */
export function gateFilePath(id: string, home: string = homedir()): string {
  if (!UUID_RE.test(id)) throw new Error('bad app chat id');
  return join(appChatsDir(home), `${id}.gate.json`);
}
