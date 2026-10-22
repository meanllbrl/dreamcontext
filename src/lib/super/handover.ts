import { randomUUID } from 'node:crypto';
import { chatTopic, getChat } from '../assistant/chat-registry.js';
import { isReservedId, peekSuperNote, superIndex } from './store.js';
import { clearFresh } from './fresh-session.js';
import { MAX_BRIEF, SESSION_ID_RE, type SuperChild, type SuperState } from './types.js';
import {
  clearOwnerLease, ensureAgendaCard, ensureChatContainer, newQueueId, pumpSuper, reconcileRows, resolveAnswered, stopSweep, superVaultName, writeSuper,
} from './inbox.js';

/**
 * Hand over and take back (plan-r7 D17, decisions 9 and 10).
 *
 * HAND OVER (`POST /api/super/enable`, body `{adopt, titles}`): the window sends the pin ids of
 * the project's open chat tabs. Kept: chats this server has REGISTERED, in THIS vault, live;
 * dropped: the recorded super session itself, any `super`/`assistant` chat and any Assistant
 * delegation. Each kept chat becomes a child with a `chat` container and the `handover` note
 * its next owner message carries; the session is minted on the first hand-over and resumed
 * after; one `[super handover]` turn is queued so the super agent's first turn writes the briefs.
 *
 * TAKE BACK (`POST /api/super/disable`): handed over no more; every child gets the `takeback`
 * note, EXCEPT a child whose `handover` note was never delivered — read from MEMORY, the only
 * place the per-message path consumes notes — whose note is simply cleared (it never heard the
 * mode began). The queue is kept for the next hand-over, except the super agent's own open
 * `ask` (nobody will answer it); the stale sweep stops; the super session is parked by the window.
 *
 * Rows (plan r4 D15, D16): a hand-over closes the open items of children it does not keep (an
 * escalation about a chat that left never blocks the single-question rule) and reconciles the
 * kept children's rows from the registry.
 */

const MAX_ADOPT = 50;

function cleanIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === 'string' && SESSION_ID_RE.test(v) && !isReservedId(v) && !out.includes(v)) out.push(v);
    if (out.length >= MAX_ADOPT) break;
  }
  return out;
}

/** The chats of `vault` the hand-over may adopt (registered, live, not another mode's). */
export function adoptableChats(ids: readonly string[], vault: string): string[] {
  return ids.filter((sid) => {
    const c = getChat(sid);
    return !!c && c.status !== 'gone' && c.vault === vault
      && c.mode !== 'super' && c.mode !== 'assistant' && c.origin !== 'assistant';
  });
}

function titleFor(sid: string, titles: Record<string, unknown>): string {
  const t = Object.prototype.hasOwnProperty.call(titles, sid) ? titles[sid] : undefined;
  if (typeof t === 'string' && t.trim()) return t.trim().replace(/\s+/g, ' ').slice(0, MAX_BRIEF);
  const c = getChat(sid);
  return (c ? chatTopic(c, MAX_BRIEF) : '') || 'chat';
}

export async function enableSuper(contextRoot: string, body: Record<string, unknown>): Promise<{ session: string; state: SuperState }> {
  const vault = superVaultName(contextRoot);
  const titles = body.titles && typeof body.titles === 'object' && !Array.isArray(body.titles) ? body.titles as Record<string, unknown> : {};
  const candidates = adoptableChats(cleanIds(body.adopt), vault);
  const now = Date.now();
  const state = await writeSuper(contextRoot, (s) => {
    if (!s.session) s.session = randomUUID();
    const session = s.session;
    const adopt = candidates.filter((sid) => sid !== session);
    // A child kept from an earlier hand-over: still open, still running, or holding a worktree
    // the super agent may still merge.
    const kept: Record<string, SuperChild> = {};
    for (const [sid, c] of Object.entries(s.children)) {
      const live = getChat(sid);
      if (adopt.includes(sid) || (live && live.status !== 'gone') || c.worktree) kept[sid] = c;
    }
    for (const sid of adopt) {
      if (!Object.prototype.hasOwnProperty.call(kept, sid)) kept[sid] = { sessionId: sid, brief: titleFor(sid, titles), adopted: true, startedAt: now };
    }
    s.children = kept;
    // Items about a child that is not kept are old news.
    for (const q of s.queue) if (q.sessionId !== session && !Object.prototype.hasOwnProperty.call(kept, q.sessionId)) q.state = 'done';
    s.containers = s.containers.filter((c) => c.kind !== 'chat' || !!kept[c.ref]);
    for (const sid of Object.keys(kept)) ensureChatContainer(s, sid, kept[sid].brief.slice(0, 120));
    // The agenda opens with every hand-over (closed last time, it is back; in Others, it stays).
    ensureAgendaCard(s, { first: true });
    for (const sid of adopt) s.notes[sid] = 'handover';
    s.enabled = true;
    s.away = { since: null, events: 0 };
    s.queue = s.queue.filter((q) => !(q.kind === 'handover' && q.state === 'pending'));
    s.queue.push({ id: newQueueId(), sessionId: session, kind: 'handover', state: 'pending', createdAt: now });
    for (const sid of adopt) queueWhatItAsks(s, sid, now);
  });
  await reconcileRows(contextRoot);
  void pumpSuper(contextRoot);
  return { session: state.session as string, state };
}

/**
 * A child that is ALREADY asking gets the item the status-change path would have made (M3): a
 * permission is at the owner's queue head at once, a question goes pending under D7. The same
 * child + request is never queued twice (that path checks the same way). First, what the child
 * is no longer asking goes: while it was no child the registry path ignored it, so an item
 * answered in its own tab would still lead the strip (w5 Minor 5).
 */
function queueWhatItAsks(s: SuperState, sid: string, now: number): void {
  const pq = getChat(sid)?.status === 'asking' ? getChat(sid)?.pendingQuestion : null;
  resolveAnswered(s, sid, pq?.requestId ?? null);
  if (!pq) return;
  if (s.queue.some((q) => q.sessionId === sid && q.requestId === pq.requestId && q.state !== 'done')) return;
  s.queue.push({
    id: newQueueId(), sessionId: sid, kind: pq.isPermission ? 'permission' : 'question',
    requestId: pq.requestId, state: 'pending', createdAt: now,
  });
}

/**
 * `super adopt` (on the owner's word): ONE open chat of the vault becomes a child mid-hand-over,
 * the way the hand-over adopts each of his chats: recorded `adopted`, its card, the `handover`
 * note its next owner message carries, and the queue item for what it already asks. A recorded
 * child that was ended and runs again (the owner reopened it) is a child again, and his.
 * Returns its card id (null: no room).
 * The caller has checked {@link adoptableChats} and that it is not the super session.
 */
export function adoptChat(s: SuperState, sid: string, brief: string, now: number = Date.now()): string | null {
  const have = Object.prototype.hasOwnProperty.call(s.children, sid) ? s.children[sid] : undefined;
  // An ended child running again was reopened by the owner: his, like any chat adopted here.
  if (have) { delete have.endedAt; have.adopted = true; }
  else s.children[sid] = { sessionId: sid, brief: brief || titleFor(sid, {}), adopted: true, startedAt: now };
  const card = ensureChatContainer(s, sid, s.children[sid].brief.slice(0, 120));
  s.notes[sid] = 'handover';
  queueWhatItAsks(s, sid, now);
  return card;
}

export async function disableSuper(contextRoot: string): Promise<SuperState> {
  clearOwnerLease(contextRoot);
  stopSweep(contextRoot);
  // A "New session" turn already running when the owner takes the screen back must not rotate
  // the pane afterwards through the fallback (fresh-session.ts): nobody wants a fresh super now.
  const recorded = superIndex(contextRoot).session;
  if (recorded) clearFresh(recorded);
  return writeSuper(contextRoot, (s) => {
    s.enabled = false;
    // The super's own question and a "New session" not yet delivered go with the hand-over: the
    // next hand-over must not rotate a session nobody asked to rotate.
    for (const q of s.queue) if (q.kind === 'ask' || (q.kind === 'fresh' && q.state === 'pending')) q.state = 'done';
    for (const sid of Object.keys(s.children)) {
      // In memory, never from disk: a note being delivered right now is already gone from
      // memory, and its persist deletes only the value it delivered (store.ts clearSuperNote).
      if (peekSuperNote(sid) === 'handover') delete s.notes[sid];
      else s.notes[sid] = 'takeback';
    }
  });
}
