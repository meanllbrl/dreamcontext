import { randomUUID } from 'node:crypto';
import { chatTopic, getChat } from '../assistant/chat-registry.js';
import { isReservedId, peekSuperNote } from './store.js';
import { MAX_BRIEF, SESSION_ID_RE, type SuperChild, type SuperState } from './types.js';
import {
  clearOwnerLease, ensureChatContainer, newQueueId, pumpSuper, resolveAnswered, superVaultName, writeSuper,
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
 * mode began). The queue is kept for the next hand-over; the super session is parked by the
 * window.
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
    s.containers = s.containers.filter((c) => c.kind !== 'chat' || !!kept[c.ref]);
    for (const sid of Object.keys(kept)) ensureChatContainer(s, sid, kept[sid].brief.slice(0, 120));
    for (const sid of adopt) s.notes[sid] = 'handover';
    s.enabled = true;
    s.away = { since: null, events: 0 };
    s.queue = s.queue.filter((q) => !(q.kind === 'handover' && q.state === 'pending'));
    s.queue.push({ id: newQueueId(), sessionId: session, kind: 'handover', state: 'pending', createdAt: now });
    // A child that is ALREADY asking gets the item the status-change path would have made (M3):
    // a permission is at the owner's queue head at once, a question goes pending under D7.
    // The same child + request is never queued twice (that path checks the same way).
    // First, what the child is no longer asking goes: while the mode was off the registry path
    // ignored it, so an item answered in its own tab would still lead the strip (w5 Minor 5).
    for (const sid of adopt) {
      const pq = getChat(sid)?.status === 'asking' ? getChat(sid)?.pendingQuestion : null;
      resolveAnswered(s, sid, pq?.requestId ?? null);
      if (!pq) continue;
      if (s.queue.some((q) => q.sessionId === sid && q.requestId === pq.requestId && q.state !== 'done')) continue;
      s.queue.push({
        id: newQueueId(), sessionId: sid, kind: pq.isPermission ? 'permission' : 'question',
        requestId: pq.requestId, state: 'pending', createdAt: now,
      });
    }
  });
  void pumpSuper(contextRoot);
  return { session: state.session as string, state };
}

export async function disableSuper(contextRoot: string): Promise<SuperState> {
  clearOwnerLease(contextRoot);
  return writeSuper(contextRoot, (s) => {
    s.enabled = false;
    for (const sid of Object.keys(s.children)) {
      // In memory, never from disk: a note being delivered right now is already gone from
      // memory, and its persist deletes only the value it delivered (store.ts clearSuperNote).
      if (peekSuperNote(sid) === 'handover') delete s.notes[sid];
      else s.notes[sid] = 'takeback';
    }
  });
}
