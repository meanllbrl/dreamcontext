/**
 * The Assistant hears back from the sessions it delegated.
 *
 * On 2026-09-27 Spidey delegated two plan-mode sessions, both asked the owner a question, and
 * Spidey never heard: `watch` was the only way to learn a status and nothing PUSHED a change.
 * This module is the push. A session the Assistant started (`chat`) or sent/answered into is
 * RECORDED here; every registry change for it (`onChatChange`) that the owner needs to know
 * about becomes a `[delegated-session event]` user message delivered to the live Assistant
 * chat through its INBOX (agent-chat.ts attaches it, riding the owner-message switch chain and
 * tainting the Assistant).
 *
 *   asking → an event at once (a new question while still asking is a new event)
 *   idle   → an event after IDLE_DEBOUNCE_MS, cancelled if the session resumes — a background
 *            agent's hand-back can restart a turn seconds after its `result`
 *   gone   → one event after GONE_DEBOUNCE_MS, and the record is deleted — unless the id is
 *            live again by then. A chat RESPAWNED under the same session id (account switch,
 *            auth change, permission-mode fallback) tears its old child down, and that old
 *            child's `exited()` reports `gone` for the id whether the new child registered
 *            before or after it. A `gone` while the registry already holds a live entry for
 *            the id is ignored outright.
 *   working→ nothing; it only forgets the last event, so the next idle is news again
 *
 * THE EVENT IS A FENCE, NOT A MESSAGE. Line 1 is server-authored from allow-listed values
 * only (a UUID, a sanitized vault name, enums, a request id that matches a strict token).
 * Every project-derived string sits inside `wrapUntrusted`. The last line is fixed text. A
 * question written to look like a header, or to close the fence, stays inside it.
 *
 * OFFLINE: with no inbox (the Assistant's chat is not running) events wait in memory — one per
 * session, latest wins, at most QUEUE_CAP — and the notch gets a FIXED-TEXT notify. The queue
 * flushes when the Assistant's chat next attaches. Lost on a server restart (accepted).
 *
 * EVERY KEY HAS A DEATH: a record ends at `gone`, and a record for a session the registry never
 * registered is swept after GONE_TTL_MS. Timers are unref'd.
 */

import { UUID_RE } from '../agent-session-map.js';
import { listVaults } from '../vaults.js';
import { wrapUntrusted } from './autonomy.js';
import { relayCommand } from './relay.js';
import { getAssistantSurface } from './session-state.js';
import { GONE_TTL_MS, activityOf, getChat, onChatChange, type ChatActivity, type ChatChange, type ChatEntry } from './chat-registry.js';

export interface AssistantInbox {
  id: string;
  /** Resolves true when the text was written to the CLI as a user turn; false when it was not. */
  deliver(text: string): Promise<boolean>;
}

/** A session that stops for a turn must stay stopped this long before the Assistant is woken. */
export const IDLE_DEBOUNCE_MS = 2_000;
/** A `gone` must stand this long, with no live entry for the id, before it is believed. */
export const GONE_DEBOUNCE_MS = 3_000;
/** Events held while no Assistant chat runs. */
export const QUEUE_CAP = 20;
/** Cap on the last assistant text carried in an event. */
const LAST_TEXT_CAP = 1500;
/** What the notch keeps of a delegation once its chat closed: the last few, for an hour. */
export const ENDED_CAP = 10;
export const ENDED_TTL_MS = 60 * 60_000;
/** The brief (what the Assistant asked the project to do), capped: a notch line, not a prompt. */
const BRIEF_CAP = 400;
/** A request id reaches the header only when it is this plain. */
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

type EventStatus = 'asking' | 'idle' | 'gone';

const LAST_LINE: Record<EventStatus, string> = {
  asking: 'Relay this question and its options to the owner in the notch; answer only with their choice.',
  idle: 'Report what it found in two or three sentences. It may wake again on its own.',
  gone: 'The chat closed.',
};

interface Delegation {
  vault: string;
  /** What the Assistant asked for — the `chat` prompt or the `send`/`answer` text, latest wins. */
  brief: string;
  /** When the Assistant first handed this session work. */
  startedAt: number;
  /** `${status}:${requestId}` of the last event emitted — identical consecutive states are not news. */
  lastEmitted: string | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  goneTimer: ReturnType<typeof setTimeout> | null;
  recordedAt: number;
}

interface Queued { sessionId: string; text: string }

/** A closed delegation, kept for the notch only (never an event, never the inbox). */
interface Ended { sessionId: string; vault: string; brief: string; startedAt: number; endedAt: number; lastText: string }
let ended: Ended[] = [];

function remember(sessionId: string, d: Delegation, e: ChatEntry | null): void {
  ended = ended.filter((x) => x.sessionId !== sessionId);
  ended.unshift({
    sessionId, vault: d.vault, brief: d.brief, startedAt: d.startedAt, endedAt: Date.now(),
    lastText: e?.lastAssistantText[e.lastAssistantText.length - 1] ?? '',
  });
  if (ended.length > ENDED_CAP) ended.length = ENDED_CAP;
}

const delegated = new Map<string, Delegation>();
let queue: Queued[] = [];
let inbox: AssistantInbox | null = null;
let pumping = false;
let unsubscribe: (() => void) | null = null;

const safeVault = (v: string) => v.replace(/[^A-Za-z0-9 _.-]/g, '_');
const keyOf = (e: ChatEntry) => `${e.status}:${e.pendingQuestion?.requestId ?? ''}`;

function clearIdle(d: Delegation): void {
  if (d.idleTimer) clearTimeout(d.idleTimer);
  d.idleTimer = null;
}

function clearGone(d: Delegation): void {
  if (d.goneTimer) clearTimeout(d.goneTimer);
  d.goneTimer = null;
}

const isLive = (e: ChatEntry | null) => !!e && e.status !== 'gone';

/** Drop records for sessions the registry still does not know after GONE_TTL_MS. */
function sweep(now = Date.now()): void {
  for (const [id, d] of delegated) {
    if (now - d.recordedAt > GONE_TTL_MS && !getChat(id)) {
      clearIdle(d);
      clearGone(d);
      delegated.delete(id);
      remember(id, d, null);
    }
  }
  ended = ended.filter((x) => now - x.endedAt <= ENDED_TTL_MS);
}

/** The event text. Line 1 and the last line are the server's; everything between is fenced. */
export function eventText(sessionId: string, vault: string, status: EventStatus, e: ChatEntry | null): string {
  const pq = status === 'asking' ? e?.pendingQuestion ?? null : null;
  let header = `[delegated-session event] session=${sessionId} vault=${safeVault(vault)} status=${status}`;
  if (pq) {
    header += ` kind=${pq.isPermission ? 'permission' : 'question'}`;
    if (REQUEST_ID_RE.test(pq.requestId)) header += ` question=${pq.requestId}`;
  }
  const lines = [header];
  if (pq) {
    if (pq.text) lines.push(wrapUntrusted(vault, `Question: ${pq.text}`));
    if (pq.options.length) lines.push(wrapUntrusted(vault, `Options: ${pq.options.join(' | ')}`));
  }
  const last = e?.lastAssistantText[e.lastAssistantText.length - 1];
  if (last) lines.push(wrapUntrusted(vault, `Last reply: ${last.length > LAST_TEXT_CAP ? `${last.slice(0, LAST_TEXT_CAP)}…` : last}`));
  lines.push(LAST_LINE[status]);
  return lines.join('\n');
}

function emitEvent(sessionId: string, vault: string, status: EventStatus, e: ChatEntry | null): void {
  const item: Queued = { sessionId, text: eventText(sessionId, vault, status, e) };
  const i = queue.findIndex((q) => q.sessionId === sessionId);
  if (i >= 0) queue[i] = item;
  else {
    queue.push(item);
    if (queue.length > QUEUE_CAP) queue.splice(0, queue.length - QUEUE_CAP);
  }
  if (!inbox && getAssistantSurface()) {
    // Fixed text only: nothing the project wrote reaches the notch this way.
    void relayCommand('notify', {
      text: `A delegated session in ${safeVault(vault)} is ${status}`,
      level: status === 'asking' ? 'attention' : 'info',
    }).catch(() => undefined);
  }
  void pump();
}

/** Deliver the queue head by head. Single-flight; a head is removed only once delivered, and
 *  only if it is still the same object (a newer event for that session replaced it meanwhile). */
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  let failedOn: AssistantInbox | null = null;
  try {
    for (;;) {
      const inb = inbox;
      const head = queue[0];
      if (!inb || !head) break;
      let ok = false;
      try { ok = await inb.deliver(head.text); } catch { ok = false; }
      if (ok) {
        const i = queue.indexOf(head);
        if (i >= 0) queue.splice(i, 1);
      } else if (inbox === inb) {
        failedOn = inb;
        break;
      }
    }
  } finally {
    pumping = false;
  }
  // An attach that arrived while this pump was failing out returned early; it is owed a pump.
  if (failedOn && queue.length && inbox && inbox !== failedOn) void pump();
}

function armIdle(sessionId: string, d: Delegation): void {
  clearIdle(d);
  const t = setTimeout(() => {
    d.idleTimer = null;
    if (delegated.get(sessionId) !== d) return;
    const now = getChat(sessionId);
    if (!now || now.status !== 'idle') return;
    const key = keyOf(now);
    if (key === d.lastEmitted) return;
    d.lastEmitted = key;
    emitEvent(sessionId, d.vault, 'idle', now);
  }, IDLE_DEBOUNCE_MS);
  t.unref?.();
  d.idleTimer = t;
}

/** Believe a `gone` only if it still stands after GONE_DEBOUNCE_MS: a respawn under the same
 *  id registers a live entry meanwhile, and then the record simply carries on. */
function armGone(sessionId: string, d: Delegation, gone: ChatEntry): void {
  clearIdle(d);
  clearGone(d);
  const t = setTimeout(() => {
    d.goneTimer = null;
    if (delegated.get(sessionId) !== d) return;
    if (isLive(getChat(sessionId))) return;
    delegated.delete(sessionId);
    remember(sessionId, d, gone);
    emitEvent(sessionId, d.vault, 'gone', gone);
  }, GONE_DEBOUNCE_MS);
  t.unref?.();
  d.goneTimer = t;
}

function onChange({ entry }: ChatChange): void {
  sweep();
  const id = entry.sessionId;
  const d = delegated.get(id);
  if (!d) return;
  if (entry.status === 'gone') {
    // An old child's teardown after its replacement already registered under this id.
    if (isLive(getChat(id))) return;
    armGone(id, d, entry);
    return;
  }
  clearGone(d);
  switch (entry.status) {
    case 'starting':
    case 'working':
      clearIdle(d);
      d.lastEmitted = null;
      return;
    case 'asking': {
      clearIdle(d);
      const key = keyOf(entry);
      if (key === d.lastEmitted) return;
      d.lastEmitted = key;
      emitEvent(id, d.vault, 'asking', entry);
      return;
    }
    case 'idle':
      if (keyOf(entry) === d.lastEmitted) { clearIdle(d); return; }
      armIdle(id, d);
  }
}

/**
 * The Assistant started (`chat`) or sent/answered into this session: tell it when the session
 * asks, finishes a turn, or closes. An invalid id or an unregistered vault is ignored.
 */
export function recordDelegation(sessionId: unknown, vault: unknown, brief?: unknown): void {
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) return;
  if (typeof vault !== 'string' || !listVaults().some((v) => v.name === vault)) return;
  if (!unsubscribe) unsubscribe = onChatChange(onChange);
  sweep();
  const prev = delegated.get(sessionId);
  if (prev) { clearIdle(prev); clearGone(prev); }
  const chat = getChat(sessionId);
  const d: Delegation = prev ?? { vault, brief: '', startedAt: Date.now(), lastEmitted: null, idleTimer: null, goneTimer: null, recordedAt: Date.now() };
  d.vault = vault;
  if (typeof brief === 'string' && brief.trim()) d.brief = brief.trim().slice(0, BRIEF_CAP);
  ended = ended.filter((x) => x.sessionId !== sessionId);
  d.recordedAt = Date.now();
  delegated.set(sessionId, d);
  if (chat?.status === 'gone') {
    // Held only for the gone debounce (it may be mid-respawn); then one event, and deleted.
    armGone(sessionId, d, chat);
  } else if (chat?.status === 'asking') {
    const key = keyOf(chat);
    if (key !== d.lastEmitted) {
      d.lastEmitted = key;
      emitEvent(sessionId, vault, 'asking', chat);
    }
  } else if (chat?.status === 'idle') {
    armIdle(sessionId, d);
  }
}

/** Attach the live Assistant chat's inbox and flush what waited. The disposer clears it only
 *  while it is still the current one (last attach wins; one Assistant chat exists). */
export function attachAssistantInbox(next: AssistantInbox): () => void {
  inbox = next;
  void pump();
  return () => { if (inbox?.id === next.id) inbox = null; };
}

/** One delegation as the notch draws it. `lastText` and `pending` are PROJECT text (callers wrap). */
export interface DelegationView {
  sessionId: string;
  vault: string;
  brief: string;
  startedAt: number;
  endedAt: number | null;
  activity: ChatActivity;
  lastText: string;
  pending: { id: string; kind: 'permission' | 'question'; tool: string; text: string } | null;
}

/** Every delegation the notch should show: the live ones, then the recently closed. */
export function listDelegations(now = Date.now()): DelegationView[] {
  sweep(now);
  const live = [...delegated].map(([sessionId, d]): DelegationView => {
    const c = getChat(sessionId);
    return {
      sessionId, vault: d.vault, brief: d.brief, startedAt: d.startedAt, endedAt: null,
      activity: c ? activityOf(c, now) : 'gone',
      lastText: c?.lastAssistantText[c.lastAssistantText.length - 1] ?? '',
      pending: c?.pendingQuestion
        ? { id: c.pendingQuestion.requestId, kind: c.pendingQuestion.isPermission ? 'permission' : 'question', tool: c.pendingQuestion.toolName, text: c.pendingQuestion.text }
        : null,
    };
  }).sort((a, b) => b.startedAt - a.startedAt);
  const closed: DelegationView[] = ended.map((x) => ({
    sessionId: x.sessionId, vault: x.vault, brief: x.brief, startedAt: x.startedAt, endedAt: x.endedAt,
    activity: 'gone', lastText: x.lastText, pending: null,
  }));
  return [...live, ...closed];
}

/** The owner cleared a closed delegation from the notch. A live one is not dismissable. */
export function dismissDelegation(sessionId: string): boolean {
  const before = ended.length;
  ended = ended.filter((x) => x.sessionId !== sessionId);
  return ended.length < before;
}

/** Is this session one the Assistant handed work to? Its turn ends reach the owner through the
 *  hand-off rows, so the notch inbox does not announce them a second time. */
export function isDelegatedSession(sessionId: string): boolean {
  return delegated.has(sessionId);
}

/** Test seam. */
export function _currentAssistantInbox(): AssistantInbox | null {
  return inbox;
}

/** Test seam: the recorded session ids and the queued texts. */
export function _delegationState(): { delegated: string[]; queued: Queued[] } {
  return { delegated: [...delegated.keys()], queued: queue.map((q) => ({ ...q })) };
}

/** Test-only reset. */
export function _resetDelegations(): void {
  for (const d of delegated.values()) { clearIdle(d); clearGone(d); }
  delegated.clear();
  queue = [];
  ended = [];
  inbox = null;
  pumping = false;
  unsubscribe?.();
  unsubscribe = null;
}
