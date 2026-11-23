/**
 * The Telegram copies of the owner's open cards, kept on disk (owner 2026-11-19: "sunucu yeniden
 * başlayınca açık kartlar tam haliyle tekrar gidiyor"). asks.ts keeps each open item's copy (its
 * message ids, their text, and what re-binds their buttons) in memory; a server restart lost that,
 * so the next offer sent the whole card again, pictures and all, beside a copy whose buttons had
 * died. Written here on every change, read once per project after a start: an open card's copy is
 * taken back (its buttons bound again on the same message), never sent a second time.
 *
 * `state/.super/telegram-copies.json`: machine-local like the Super's own record (it names this
 * Mac's bot chats and message ids; `state/.super/` is in both local-only lists). A symlinked file
 * or folder is refused; writes land by temp file + rename; a file over {@link MAX_BYTES} is not
 * read (and a write that would pass it is not made: the previous file stays).
 */
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ensureSuperDir } from '../../lib/super/handoff-file.js';
import type { ButtonRecord } from '../../lib/telegram/contract.js';

export const COPIES_REL = join('state', '.super', 'telegram-copies.json');
export const MAX_BYTES = 8 * 1024 * 1024;

type Obj = Record<string, unknown>;

/** What binds a message's buttons again: the rows it showed, its record, its data. */
export interface StoredButtons { rows: string[][]; rec: Omit<ButtonRecord, 'id' | 'botId' | 'chatId' | 'messageId' | 'textHash' | 'options'>; data: Obj }
/** A rich ask's copy (rich-asks.ts): one message per question, re-bound as one ask. */
export interface StoredRich { target: Obj; questions: Obj[] }
export interface StoredMessage { messageId: number; html: string; question?: string; buttons?: StoredButtons }
export interface StoredCopy {
  key: string; botId: number; chatId: number;
  kind?: string; sessionId?: string; requestId?: string; turn?: true; again?: true; sentAt: number;
  rich?: StoredRich;
  messages: StoredMessage[];
}

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const REBINDABLE: ReadonlySet<string> = new Set(['question', 'permission', 'confirm', 'owner-card']);

function message(v: unknown): StoredMessage | null {
  if (!isObj(v) || !isId(v.messageId) || !isStr(v.html)) return null;
  const out: StoredMessage = { messageId: v.messageId, html: v.html, ...(isStr(v.question) ? { question: v.question } : {}) };
  const b = v.buttons;
  if (isObj(b) && Array.isArray(b.rows) && b.rows.every((r) => Array.isArray(r) && r.every(isStr)) && isObj(b.rec) && isStr(b.rec.kind) && REBINDABLE.has(b.rec.kind) && isObj(b.data)) {
    // Only the fields a card's record carries (where a tap counts is the hub's to set, never the file's).
    const r = b.rec;
    const rec = { kind: r.kind as StoredButtons['rec']['kind'], singleUse: r.singleUse === true, ...(isStr(r.requestId) ? { requestId: r.requestId } : {}), ...(isStr(r.sessionId) ? { sessionId: r.sessionId } : {}), ...(isStr(r.cardRef) ? { cardRef: r.cardRef } : {}) };
    out.buttons = { rows: b.rows as string[][], rec, data: b.data };
  }
  return out;
}

/** A rich ask's answer target, only in the three shapes asks.ts writes (anything else is not taken back). */
function richTarget(t: unknown): Obj | null {
  if (!isObj(t)) return null;
  if (t.kind === 'super-ask' && isObj(t.item) && isStr(t.item.id) && isStr(t.item.kind) && isStr(t.item.sessionId)) return { kind: 'super-ask', item: { id: t.item.id, kind: t.item.kind, sessionId: t.item.sessionId } };
  if (t.kind === 'child-question' && isStr(t.item) && isStr(t.requestId)) return { kind: 'child-question', item: t.item, requestId: t.requestId };
  if (t.kind === 'member' && isStr(t.mirror)) return { kind: 'member', mirror: t.mirror };
  return null;
}

/** One entry as written, or null when its shape is not one this code wrote (hand-edited). */
function copyOf(v: unknown): StoredCopy | null {
  if (!isObj(v) || !isStr(v.key) || !isId(v.botId) || typeof v.chatId !== 'number' || !Number.isSafeInteger(v.chatId) || !Array.isArray(v.messages)) return null;
  const messages = v.messages.map(message);
  if (!messages.length || messages.some((m) => !m)) return null;
  const target = isObj(v.rich) ? richTarget(v.rich.target) : null;
  const rich = target && isObj(v.rich) && Array.isArray(v.rich.questions) && v.rich.questions.every(isObj) ? { target, questions: v.rich.questions as Obj[] } : undefined;
  if (isObj(v.rich) && !rich) return null;
  return {
    key: v.key, botId: v.botId, chatId: v.chatId, sentAt: typeof v.sentAt === 'number' ? v.sentAt : 0,
    ...(isStr(v.kind) ? { kind: v.kind } : {}), ...(isStr(v.sessionId) ? { sessionId: v.sessionId } : {}), ...(isStr(v.requestId) ? { requestId: v.requestId } : {}),
    ...(v.turn === true ? { turn: true as const } : {}), ...(v.again === true ? { again: true as const } : {}), ...(rich ? { rich } : {}),
    messages: messages as StoredMessage[],
  };
}

/** Refuses a symlinked `state`, `state/.super` or file: never read or written through a link. */
function linked(contextRoot: string): boolean {
  for (const p of [join(contextRoot, 'state'), join(contextRoot, 'state', '.super'), join(contextRoot, COPIES_REL)]) {
    try { if (lstatSync(p).isSymbolicLink()) return true; } catch { /* absent */ }
  }
  return false;
}

/** The copies kept for this project, by item id ({} when none, unreadable or refused). */
export function readCopies(contextRoot: string): Record<string, StoredCopy> {
  const path = join(contextRoot, COPIES_REL);
  try {
    if (!existsSync(path) || linked(contextRoot)) return {};
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_BYTES) return {};
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    const all = isObj(raw) && isObj(raw.copies) ? raw.copies : {};
    const out: Record<string, StoredCopy> = {};
    for (const [id, v] of Object.entries(all)) { const c = copyOf(v); if (c) out[id] = c; }
    return out;
  } catch { return {}; }
}

/** Writes this project's copies (atomically). False when it was not written. */
export function writeCopies(contextRoot: string, copies: Record<string, StoredCopy>): boolean {
  try {
    if (linked(contextRoot)) return false;
    const path = join(contextRoot, COPIES_REL);
    if (!Object.keys(copies).length) {
      if (existsSync(path)) rmSync(path, { force: true });
      return true;
    }
    const text = `${JSON.stringify({ v: 1, copies })}\n`;
    if (Buffer.byteLength(text, 'utf-8') > MAX_BYTES) return false;
    ensureSuperDir(contextRoot);
    const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, text, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
    try { renameSync(tmp, path); } catch (err) { rmSync(tmp, { force: true }); throw err; }
    return true;
  } catch { return false; }
}
