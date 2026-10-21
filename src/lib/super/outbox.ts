import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { activityOf, getChat, onChatChange } from '../assistant/chat-registry.js';
import { liveTranscriptPath } from '../transcript-locate.js';
import { sendWindowCommand, tokenOfSession } from '../window-control.js';
import { superIndex, superRootOfChild, superRootOfSession } from './store.js';
import { readTail } from './transcript-tail.js';
import { MAX_READ_BYTES } from './types.js';

/**
 * The super send OUTBOX (field 2026-10-21: messages the window had queued for a busy child were
 * lost when the app was quit and reopened — the window's queue lives in memory).
 *
 * A `super send` the window answers `queued` is also written here, on this machine
 * (`~/.dreamcontext/super-outbox/<vault hash>.json`, never synced). It leaves the outbox when the
 * child's transcript shows it arrived. While the server run that queued it lives, the window owns
 * it; after a relaunch, at the child's first idle (or the super chat's own, once its window is
 * back) it is sent again through the super chat's window, which gives an idle chat a plain new
 * turn. Nothing is sent twice: a message the transcript already holds, written after it was
 * queued, is dropped instead.
 */

/**
 * `boot`: the server run that saw the window queue it. While that run lives, the WINDOW owns the
 * message (its queue drains it, the owner's Stop and delete apply to it): the outbox only watches
 * for it to arrive. Only an item from an EARLIER run (the app was quit, the window's memory is
 * gone) is sent from here (end review: two deliverers raced on the same idle edge).
 */
export interface OutboxItem { id: string; child: string; text: string; at: number; boot?: string }

/** This server run. */
export const OUTBOX_BOOT = randomBytes(6).toString('hex');

/** At most this many waiting messages per vault (the oldest drop first). */
export const MAX_OUTBOX = 50;

const outboxDir = () => join(homedir(), '.dreamcontext', 'super-outbox');

function outboxPath(contextRoot: string): string {
  const key = createHash('sha1').update(resolve(contextRoot)).digest('hex').slice(0, 16);
  return join(outboxDir(), `${key}.json`);
}

/** The file is `{ root, items }`: the root lets a restarted server find what still waits. */
async function readOutboxFile(file: string): Promise<{ root: string | null; items: OutboxItem[] }> {
  try {
    const raw = JSON.parse(await fsp.readFile(file, 'utf-8')) as { root?: unknown; items?: unknown };
    const root = typeof raw?.root === 'string' ? raw.root : null;
    if (!Array.isArray(raw?.items)) return { root, items: [] };
    return { root, items: raw.items.filter((x): x is OutboxItem => !!x && typeof x === 'object'
      && typeof (x as OutboxItem).id === 'string' && typeof (x as OutboxItem).child === 'string'
      && typeof (x as OutboxItem).text === 'string' && typeof (x as OutboxItem).at === 'number') };
  } catch {
    return { root: null, items: [] };
  }
}

export async function readOutbox(contextRoot: string): Promise<OutboxItem[]> {
  return (await readOutboxFile(outboxPath(contextRoot))).items;
}

/** One writer at a time per vault (the route and the pump can race). */
const locks = new Map<string, Promise<unknown>>();

async function updateOutbox(contextRoot: string, fn: (items: OutboxItem[]) => OutboxItem[]): Promise<OutboxItem[]> {
  const key = resolve(contextRoot);
  const run = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const next = fn(await readOutbox(contextRoot)).slice(-MAX_OUTBOX);
    const file = outboxPath(contextRoot);
    await fsp.mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ root: key, items: next }), { mode: 0o600 });
    await fsp.rename(tmp, file);
    return next;
  });
  locks.set(key, run);
  try { return await run; } finally { if (locks.get(key) === run) locks.delete(key); }
}

/** Keep a message the window queued for `child` until it is seen to arrive. */
export async function addToOutbox(contextRoot: string, child: string, text: string, now = Date.now()): Promise<OutboxItem> {
  const item: OutboxItem = { id: `o-${now.toString(36)}-${randomBytes(3).toString('hex')}`, child, text, at: now, boot: OUTBOX_BOOT };
  await updateOutbox(contextRoot, (items) => [...items, item]);
  return item;
}

/**
 * The owner took a queued message back in the window (deleted or edited its row, or pressed
 * Stop, which holds the queue): it must not come back after a relaunch either (end review
 * round 2). `texts` absent = every waiting message for the child.
 */
export async function dropFromOutbox(contextRoot: string, child: string, texts?: readonly string[]): Promise<number> {
  const want = texts ? new Set(texts.map((t) => t.trim())) : null;
  let dropped = 0;
  const has = (await readOutbox(contextRoot)).some((i) => i.child === child);
  if (!has) return 0;
  await updateOutbox(contextRoot, (all) => all.filter((i) => {
    const gone = i.child === child && (!want || want.has(i.text.trim()));
    if (gone) dropped += 1;
    return !gone;
  }));
  return dropped;
}

/** Did `text` reach the child's transcript after `at`? Reads only the bounded tail. */
export async function arrivedInTranscript(path: string | null, text: string, at: number): Promise<boolean> {
  if (!path) return false;
  try {
    const tail = await readTail(path, MAX_READ_BYTES);
    const lines = tail.text.split('\n');
    if (tail.truncated) lines.shift();
    for (const line of lines) {
      if (!line.includes('"user"')) continue;
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (obj.type !== 'user' || obj.isSidechain === true) continue;
      const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
      if (Number.isFinite(ts) && ts < at) continue;
      const content = (obj.message as { content?: unknown } | undefined)?.content;
      const texts = typeof content === 'string' ? [content]
        : Array.isArray(content) ? (content as Array<Record<string, unknown>>).filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text as string) : [];
      // The message itself (a note may ride in its own block), never a longer line that only
      // contains it: a short "devam" must not read as arrived inside the owner's own message.
      if (texts.some((t) => t.trim() === text.trim())) return true;
    }
  } catch { /* unreadable: not seen */ }
  return false;
}

/** What the pump needs; injectable for tests. */
export interface OutboxDeps {
  /** This server run (tests name one). */
  boot?: string;
  isIdle: (sid: string) => boolean;
  /** Still a live (not ended, not succeeded) child of this vault's super agent. */
  isChild: (contextRoot: string, sid: string) => boolean;
  superToken: (contextRoot: string) => string | null;
  transcript: (contextRoot: string, sid: string) => string | null;
  send: (token: string, child: string, text: string) => Promise<string | null>;
}

const defaultDeps: OutboxDeps = {
  // The index holds only children not ended (store.ts); a succeeded child is ended too.
  isChild: (root, sid) => superIndex(root).children.has(sid),
  // A resumed chat sits in `starting` until its first turn: past the grace that reads idle.
  isIdle: (sid) => { const e = getChat(sid); return !!e && activityOf(e) === 'idle'; },
  superToken: (root) => {
    const s = superIndex(root).session;
    return s ? tokenOfSession(s) : null;
  },
  transcript: (root, sid) => liveTranscriptPath(root, sid),
  send: async (token, child, text) => {
    const r = await sendWindowCommand(token, 'send', { tab: child, text });
    const how = r.ok ? (r.result as { delivered?: unknown } | undefined)?.delivered : undefined;
    return typeof how === 'string' ? how : null;
  },
};

const pumping = new Set<string>();

/**
 * Deliver what an EARLIER run left for the idle children of `contextRoot` (or only `child`). A
 * message the transcript already shows, or whose child was ended or replaced, is dropped; one
 * the window takes as a new turn (`sent`) or into a turn (`steered`) leaves; one it queues again
 * becomes this run's window's, watched until it is seen to arrive.
 */
export async function pumpOutbox(contextRoot: string, child?: string, deps: OutboxDeps = defaultDeps): Promise<{ delivered: string[]; dropped: string[] }> {
  const key = resolve(contextRoot);
  const out = { delivered: [] as string[], dropped: [] as string[] };
  if (pumping.has(key)) return out;
  pumping.add(key);
  try {
    const items = (await readOutbox(contextRoot)).filter((i) => !child || i.child === child);
    if (!items.length) return out;
    const done = new Set<string>();
    const adopted = new Set<string>();
    const boot = deps.boot ?? OUTBOX_BOOT;
    const token = deps.superToken(contextRoot);
    // One message per child per pump: a new turn makes it busy, the next idle sends the next.
    const sentTo = new Set<string>();
    for (const item of items) {
      // Its child was ended or replaced: the message is for work that has moved on.
      if (!deps.isChild(contextRoot, item.child)) { done.add(item.id); out.dropped.push(item.id); continue; }
      if (await arrivedInTranscript(deps.transcript(contextRoot, item.child), item.text, item.at)) {
        done.add(item.id); out.dropped.push(item.id);
        continue;
      }
      // This run's window still holds it in its queue: never a second deliverer.
      if (item.boot === boot) continue;
      if (!token || sentTo.has(item.child) || !deps.isIdle(item.child)) continue;
      const how = await deps.send(token, item.child, item.text).catch(() => null);
      if (how === 'sent' || how === 'steered') { done.add(item.id); out.delivered.push(item.id); sentTo.add(item.child); }
      // Queued again: this run's window owns it now.
      else if (how === 'queued') { adopted.add(item.id); sentTo.add(item.child); }
    }
    if (done.size || adopted.size) {
      const left = await updateOutbox(contextRoot, (all) => all
        .filter((i) => !done.has(i.id))
        .map((i) => (adopted.has(i.id) ? { ...i, boot } : i)));
      if (!left.some((i) => i.boot !== boot)) waiting.delete(key);
    }
    return out;
  } finally {
    pumping.delete(key);
  }
}

let armed: (() => void) | null = null;
/** Vaults with messages waiting: retried every {@link OUTBOX_RETRY_MS} while any remain (a
 *  chat resumed at relaunch starts no turn, so no turn end would ever come for it). */
const waiting = new Set<string>();
export const OUTBOX_RETRY_MS = 30_000;
let retryTimer: ReturnType<typeof setInterval> | null = null;

function armRetry(): void {
  if (retryTimer || !waiting.size) return;
  retryTimer = setInterval(() => {
    if (!waiting.size) { if (retryTimer) clearInterval(retryTimer); retryTimer = null; return; }
    for (const root of [...waiting]) void pumpOutbox(root).catch(() => undefined);
  }, OUTBOX_RETRY_MS);
  retryTimer.unref?.();
}

/** A restarted server: find the vaults whose messages still wait, and retry them. */
async function recoverWaiting(): Promise<void> {
  let files: string[] = [];
  try { files = (await fsp.readdir(outboxDir())).filter((f) => f.endsWith('.json')); } catch { return; }
  for (const f of files) {
    const { root, items } = await readOutboxFile(join(outboxDir(), f));
    if (root && items.some((i) => i.boot !== OUTBOX_BOOT)) waiting.add(root);
  }
  armRetry();
}

/** Pump on every turn end: a child's first idle sends its waiting message; the super chat's own
 *  idle (its window is back) pumps all of its children. Plus the retry above. Idempotent. */
export function armSuperOutbox(): void {
  if (armed) return;
  void recoverWaiting();
  armed = onChatChange(({ entry, from }) => {
    if (entry.status !== 'idle' || from === 'idle') return;
    const asChild = superRootOfChild(entry.sessionId);
    if (asChild) { void pumpOutbox(asChild, entry.sessionId).catch(() => undefined); return; }
    const asSuper = superRootOfSession(entry.sessionId);
    if (asSuper) void pumpOutbox(asSuper).catch(() => undefined);
  });
}

/** Tests only. */
export function _resetSuperOutbox(): void {
  armed?.();
  armed = null;
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = null;
  waiting.clear();
  pumping.clear();
  locks.clear();
}
