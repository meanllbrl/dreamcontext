/**
 * Every live chat in this server, with a status the assistant can read — the "watch
 * sessions" half of the dreamcontext Assistant.
 *
 * FED FROM ONE PLACE. `agent-chat.ts` already parses every NDJSON line a chat's `claude`
 * child writes (the single parse point over `child.stdout`); the bridge calls
 * {@link ChatHandle.observe} there with each frame, {@link ChatHandle.userSent} when it writes
 * a user frame, {@link ChatHandle.answered} when it relays an answer, and
 * {@link ChatHandle.exited} from its teardown. Nothing here spawns, reads a transcript or
 * polls — status is DERIVED from the frames the bridge already has:
 *
 *   starting → (user frame written) → working
 *   working  → (control_request can_use_tool) → asking → (answer relayed) → working
 *   working  → (top-level `result`) → idle
 *   idle / starting → (top-level `assistant` / `stream_event` frame) → working
 *   any      → (child exit) → gone, deleted GONE_TTL_MS later
 *
 * STATUS IS WHAT THE FRAMES SAID LAST; ACTIVITY IS WHAT IS TRUE NOW. `status` is kept as the
 * stable state machine `watch` and `sessions --status` key on. A glance (the notch pill, the
 * rollup) reads {@link activityOf} instead, which adds the clock:
 *   • `starting` older than STARTING_GRACE_MS is `idle`. The app respawns a `claude --resume`
 *     child for every tab it restores, and that child sits at an empty composer until the owner
 *     types. On 2026-09-26 the owner's server had 7 of those listed as `starting` next to 1 real
 *     turn, and the pill said "10 working" where the tab strip said "1 working, 4 idle".
 *   • `working` with no stdout frame for STALE_MS (or TOOL_STALE_MS while a tool call is open)
 *     is `stale`: the registry believes a turn is running, but the child has shown no sign of
 *     life for longer than a live turn ever stays silent.
 *   • `asking` stays `asking`: a chat blocked on the owner is silent by design, not stale.
 *
 * EVERY KEY HAS A DEATH (`pattern-every-store-key-needs-a-death`): a `gone` entry is kept for
 * ten minutes so a `watch` that arrives just after the end can still read how it ended, then
 * a timer deletes it. The timer is unref'd so it never holds the process open.
 *
 * The assistant's OWN session is never registered — it would be watching itself.
 */

import { outwardAction } from '../super/owed.js';
import { closeCardsById, noteAssistantCards } from '../cards/records.js';
import { answeredBy, isOwnerCardKind, MAX_OWNER_WAITS, ownerCardsIn, refusalWait, refusalWaitId, takeSuperSend, type OwnerCardKind, type OwnerWait, type OwnerWaitKind } from '../super/owner-wait.js';
import { imagesInPreviews, stripReplyMark, type PreviewImage, type RefusalFact } from '../super/types.js';
import { canonicalInput } from '../grants/canonical.js';
import type { OpenRequest, RequestResponse } from '../super/request-answer.js';
import {
  parseTelegramPrefix, telegramSideSource, TG_PENDING_REF_TTL_MS,
  type ChatInjector, type InjectedSource, type PendingTelegramRef, type PendingTelegramRefStore, type TelegramRefDropped,
} from '../telegram/contract.js';

export const CHAT_STATUSES = ['starting', 'working', 'asking', 'idle', 'gone'] as const;
export type ChatStatus = typeof CHAT_STATUSES[number];

/** What a glance reports: `status` read against the clock (see the header). */
export const CHAT_ACTIVITIES = ['starting', 'working', 'stale', 'asking', 'idle', 'gone'] as const;
export type ChatActivity = typeof CHAT_ACTIVITIES[number];

/** How long a `gone` entry stays readable before it is deleted. */
export const GONE_TTL_MS = 10 * 60_000;
/** A child that got no message within this long is an open tab waiting for the owner, not a
 *  chat on its way to work. Spawn-to-first-prompt is milliseconds when a prompt is given. */
export const STARTING_GRACE_MS = 30_000;
/** A working turn with no stdout frame this long is stale. Chats run with
 *  `--include-partial-messages`, so a model that is thinking or writing streams a frame every
 *  second or so; three minutes of silence with no tool running is not a live turn. */
export const STALE_MS = 3 * 60_000;
/** The same, while a top-level tool call is open. A Bash call may run up to its 10-minute
 *  maximum timeout without a single frame, so the bar is that plus a minute. */
export const TOOL_STALE_MS = 11 * 60_000;
/** Ring size of the last assistant texts kept per chat. */
export const TEXT_RING = 20;
/** Per-text cap — a registry entry is a glance, not a transcript. */
const TEXT_CAP = 2000;

export interface PendingQuestion {
  requestId: string;
  /** `AskUserQuestion` for a question card, otherwise the tool asking for permission. */
  toolName: string;
  /** True when this is a TOOL-PERMISSION prompt rather than a question to the owner —
   *  answering one of those always needs the owner's approval under `auto`. */
  isPermission: boolean;
  /** The question text / the command being asked about, capped. */
  text: string;
  options: string[];
  /** An AskUserQuestion's option pictures (`<img src>` in its previews, every question), raw:
   *  the super route checks each against the project (ask-show). Absent: none. */
  images?: PreviewImage[];
  /** An AskUserQuestion's whole question list, VERBATIM (an answer is keyed by these exact
   *  texts and labels), so a surface without the chat's socket (the hands-free phone, for a
   *  child question the Super Agent escalated) can draw the same card. Absent on a permission,
   *  and when the input is over {@link MAX_QUESTION_BYTES}: never cut, since a cut text would
   *  key an answer the CLI cannot match. */
  questions?: RegistryQuestion[];
  /** An AskUserQuestion's card title (`input.title`), capped. Absent on a permission. */
  title?: string;
  /** The tool call this request is about (`request.tool_use_id`). A tool_result for it means
   *  the CLI is no longer waiting on the request (it was rejected on a closed stream, say), so
   *  the request settles like a `control_cancel_request`. Absent on an older CLI. */
  toolUseId?: string;
  /** A permission's own one-line description (`request.description`, the agent's words). */
  description?: string;
  /** Why the CLI asks (`decision_reason`, its own words) and the kind (`decision_reason_type`):
   *  `safetyCheck` asks even in Bypass and takes no "always allow". */
  reason?: string;
  reasonType?: string;
  /** A permission's WHOLE command (or path), only when `text` had to be cut: `text` is the short
   *  line a card or a phone shows, this is what a decider (the Super Agent) reads. Bounded by
   *  {@link PERMISSION_FULL_CAP}; past that it is cut too and ends in `…`. */
  fullText?: string;
}

/** The most of a permission's command a decider is handed (a command longer than this is no
 *  ordinary work and goes to the owner). */
export const PERMISSION_FULL_CAP = 16_000;

export interface RegistryQuestionOption { label: string; description?: string; preview?: string }
export interface RegistryQuestion {
  question: string;
  header?: string;
  /** The question's own "why" line (the card's description), shown under it. */
  description?: string;
  multiSelect?: boolean;
  options: RegistryQuestionOption[];
}
/** The most a pending question's list may weigh (previews included) to be kept whole. */
export const MAX_QUESTION_BYTES = 64 * 1024;

export interface ChatEntry {
  sessionId: string;
  conversationId: string | null;
  vault: string;
  mode: string;
  title: string;
  status: ChatStatus;
  lastAssistantText: string[];
  pendingQuestion: PendingQuestion | null;
  /** Requests raised before `pendingQuestion` and still unanswered, oldest first: a chat can hold
   *  several (the CLI raises parallel tool calls together, and the window keeps every one). Without
   *  them a second question overwrote the first, whose queue item closed with its card while the
   *  child still waited on it (owner 2026-10-30). Absent = none. */
  earlierPending?: PendingQuestion[];
  updatedAt: string;
  /** The last sign of life: a stdout frame, a user frame written, an answer relayed. */
  lastFrameAt: string;
  /** Top-level tool calls asked for and not yet answered by a tool_result. */
  toolsInFlight: number;
  /** Background work the CLI still runs for this chat (`system:background_tasks_changed`: a
   *  `run_in_background` shell, a Monitor, a background agent), and when that roster last
   *  changed. A turn can end while it runs: the turn is over, the job is not. Absent until the
   *  first roster frame. */
  backgroundTasks?: number;
  backgroundAt?: string;
  /** Of that roster, the entries that read as a JOB with an end (a script, a test run, a
   *  background agent), not a server or a watch left running (`persistentBackground`). A job
   *  holds a child's row as working for as long as the CLI says it runs. Absent = 0. */
  backgroundJobs?: number;
  /** When that roster last SHRANK since the latest turn began: background work ended, and its
   *  CLI owes a turn for its notification. That turn is invisible here until its first output:
   *  the CLI runs the prompt hooks and waits for the first token first (field 2026-11-08: 14-21 s
   *  on a cold cache), so the child reads idle with an empty roster. Cleared when a turn starts. */
  wakeOwedAt?: string;
  /** What the child left for the OWNER to do and he has not done yet: an unrun `run` card, an
   *  unsubmitted `secret` or `checklist` (super/owner-wait.ts).
   *  Read from its own stream as it arrives; cleared by his answer written back into the chat. */
  ownerWaits?: OwnerWait[];
  /** Waits this process saw ANSWERED (`kind:id`): his receipt or his own message, or the Super
   *  closing it (`dropOwnerWait`). Only these close an owner item; a wait the registry merely
   *  does not hold (a respawn, a restart) is re-adopted from the record, never inferred answered. */
  ownerAnswered?: string[];
  /** Set when the Assistant started this chat (a delegation). Rides the entry's own lifetime:
   *  a respawn of the same conversation inherits it via {@link isDelegatedConversation}. */
  origin?: 'assistant';
  /** Present (true) only while the process runs `--permission-mode bypassPermissions`: its
   *  residual permission requests go to its Super Agent first (super/inbox.ts
   *  `permissionGoesToSuper`). Fail closed: once cleared (an init frame reporting another mode,
   *  or {@link ChatHandle.notBypass}) it never comes back for this process. */
  bypass?: true;
  /** A Super-crew process (main, a member Super, their children), told by the server at
   *  registration, never read from the stream: only a crew chat turns a refused call into an
   *  owner wait (K2). A plain chat keeps its card, tab dot and chime as they are. */
  crew?: true;
  /** The permission mode the server spawned it with or switched it to (`setChatPermissionMode`).
   *  A refusal by mode in `plan` or `dontAsk` is the envelope the owner chose, never his item. */
  permissionMode?: string;
  /** How the last top-level turn ended, stamped BEFORE the move to `idle` is emitted: when, and
   *  whether the owner interrupted it. `resultSeq` is unique across the process (a respawned
   *  chat gets a fresh entry and must never repeat an earlier number). */
  lastTurn?: {
    endedAt: string; interrupted: boolean; resultSeq: number;
    /** The CLI's `result` said `is_error` (plan r4 D6: a child that may be stuck). */
    isError?: boolean;
    /** The API refused the turn on a usage limit and the bridge moved it to another account:
     *  never a stuck child (plan r4 D6, r2-C1). */
    limited?: boolean;
  };
}

export interface ChatHandle {
  readonly sessionId: string;
  observe(frame: Record<string, unknown>): void;
  /** `source` = who wrote the turn (I4, J1): a Telegram text clears no owner wait and is never
   *  "unheard" (a run or secret card is answered on the Mac or the phone, never by a chat text). */
  /** `ownerReceipt`: the server delivered an owner-proven card result (closes that card by id
   *  only). `closesNothing`: the server's own turn through the crew handle (answers no wait). */
  userSent(text: string, opts?: { source?: InjectedSource; server?: true; ownerReceipt?: OwnerReceiptMark; closesNothing?: true }): void;
  /** `answers` (question → picked labels, AskUserQuestion's own `updatedInput.answers`) when the
   *  window answered a question: what the Telegram copy of that card says it was answered with. */
  answered(requestId?: string, answers?: unknown): void;
  /** The owner interrupted the running turn (the bridge wrote the interrupt request). */
  interrupted(): void;
  /** The running (or just-ended) turn was refused on a usage limit and an account switch is
   *  under way: its end is not an error worth reporting. */
  markLimited(): void;
  /** The bridge moved the process off `bypassPermissions` (it wrote `set_permission_mode`):
   *  {@link ChatEntry.bypass} is cleared for good. */
  notBypass(): void;
  /** Stop settled with NO `result` (agent-chat settleAfterInterrupt): a running turn is stamped
   *  ended and interrupted (every reader of the idle edge sees a stopped turn) and the entry goes
   *  idle; an idle one is left alone. The interrupt flag is cleared either way, never kept. */
  stopSettled(): void;
  exited(): void;
}

type Waiter = { until: WatchUntil; from: ChatStatus; resolve: (r: WatchResult) => void; timer: ReturnType<typeof setTimeout> };
/** `settled` = the chat stopped for the owner: idle OR asking. */
export type WatchUntil = 'settled' | 'idle' | 'asking' | 'any';
export interface WatchResult {
  entry: ChatEntry | null;
  ended?: boolean;
  timedOut?: boolean;
  unknown?: boolean;
}

/**
 * Who hears a chat's OUTWARD action that went through (a push, a publish, a PR, a deploy, an MCP
 * send: owed.ts `outwardAction`), once per tool call: the Super inbox registers it (a registry
 * never imports the Super). Told only on the call's non-error `tool_result`, so a push the owner
 * denied is never told as sent.
 */
let outwardSink: ((sessionId: string, what: string, toolUseId: string) => void) | null = null;
type OutwardSink = (sessionId: string, what: string, toolUseId: string) => void;
/** Set the sink; returns the one it replaced (a test puts it back). */
export function setOutwardSink(fn: OutwardSink | null): OutwardSink | null { const prev = outwardSink; outwardSink = fn; return prev; }
/** Outward calls seen and not resolved yet, per chat (bounded). */
const MAX_OUTWARD_OPEN = 64;
/** Calls already told, per chat (bounded): a frame seen twice counts once. */
const MAX_OUTWARD_TOLD = 256;

const entries = new Map<string, ChatEntry>();
/** Process-wide turn counter for {@link ChatEntry.lastTurn}. */
let resultSeq = 0;
const waiters = new Map<string, Set<Waiter>>();
const deathTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Entries a newer registration of the same id displaced while their process still ran: a
 *  second process for one pin (a respawn, a phone or reload open). When the newer one exits, the
 *  newest of these that is still running is the chat again, never a `gone` id whose process
 *  still answers the owner (field 2026-11-07: the Super's own pane went missing for nine hours). */
const displaced = new Map<string, ChatEntry[]>();

/** One change to a chat: a new status, or a new question replacing the pending one while
 *  the status stays `asking` (then `from` is `asking` too). */
export interface ChatChange { entry: ChatEntry; from: ChatStatus }
const listeners = new Set<(c: ChatChange) => void>();
/** Owner waits moved (a card appeared, his answer cleared one): its own channel, so a status
 *  listener never mistakes it for a status change. */
const ownerListeners = new Set<(e: ChatEntry) => void>();

/** Be told when a chat's {@link ChatEntry.ownerWaits} change. Returns the unsubscribe. */
export function onOwnerWaitChange(fn: (e: ChatEntry) => void): () => void {
  ownerListeners.add(fn);
  return () => { ownerListeners.delete(fn); };
}

function emitOwner(e: ChatEntry): void {
  for (const fn of [...ownerListeners]) {
    try { fn(clone(e)); } catch { /* a listener's failure is its own */ }
  }
}

/** Replace the chat's owner waits; tell the owner listeners only when they changed. Over the cap,
 *  an open CARD wait already held is never the one evicted (sahip-karti-yerinde K2: it may have a
 *  running action or an owed receipt): the newcomer beyond the cap is the one not tracked, and
 *  the child is told the owner already has that many open cards. Other kinds keep the newest. */
function setOwnerWaits(e: ChatEntry, next: OwnerWait[]): void {
  const cur = e.ownerWaits ?? [];
  const key = (ws: OwnerWait[]) => ws.map((w) => `${w.kind}:${w.id}:${w.line}`).join('\n');
  if (key(cur) === key(next)) return;
  let kept = next;
  if (next.length > MAX_OWNER_WAITS) {
    const held = new Set(cur.filter((w) => isOwnerCardKind(w.kind)).map(waitKey));
    const pinned = next.filter((w) => held.has(waitKey(w)));
    const rest = next.filter((w) => !held.has(waitKey(w)));
    const room = Math.max(0, MAX_OWNER_WAITS - pinned.length);
    // New cards take the free seats in posting order (one past the cap is not tracked); other
    // kinds (a refusal) keep the newest in what is left.
    const others = rest.filter((w) => !isOwnerCardKind(w.kind));
    const newCards = rest.filter((w) => isOwnerCardKind(w.kind));
    const keepCards = newCards.slice(0, room);
    const left = room - keepCards.length;
    const fill = [...keepCards, ...(left > 0 ? others.slice(-left) : [])];
    const dropped = newCards.filter((w) => !keepCards.includes(w));
    kept = next.filter((w) => pinned.includes(w) || fill.includes(w));
    for (const w of dropped) tellCardOverflow(e.sessionId, w);
  }
  if (kept.length) e.ownerWaits = kept.slice(-MAX_OWNER_WAITS); else delete e.ownerWaits;
  pruneOrigins(e);
  if (key(cur) === key(e.ownerWaits ?? [])) return;
  emitOwner(e);
}

/** What the child is told when its card is past the cap (K2): the owner already has that many. */
export const CARD_OVERFLOW_TEXT = (w: Pick<OwnerWait, 'kind' | 'id'>): string =>
  `[server] Your ${w.kind} card "${w.id}" is not tracked: the owner already has ${MAX_OWNER_WAITS} open cards from you. Wait until one of them is done, then post it again.`;

/** Tell a crew child its card past the cap is not tracked (after the frame that posted it). */
function tellCardOverflow(sessionId: string, w: OwnerWait): void {
  const t = setTimeout(() => {
    try { crewHandles.get(sessionId)?.sendServerTurn(CARD_OVERFLOW_TEXT(w)); } catch { /* a closed chat hears nothing */ }
  }, 0);
  t.unref?.();
}

// ─── Where an owner card came from (sahip-karti-yerinde K1) ───────────────────

/** The frame a card wait was read from: what the inbox builds the item's card handle with. */
export interface OwnerWaitOrigin { messageUuid: string; conversationId: string; text: string }
/** By `<session>\n<kind>:<id>`; bounded per chat by the waits it holds (dropped with them). */
const waitOrigins = new Map<string, OwnerWaitOrigin>();
const originKey = (sid: string, w: { kind: string; id: string }): string => `${sid}\n${waitKey(w)}`;

/** The frame the chat's open card wait `kind:id` was posted in, or null (an adopted wait, a
 *  restart: the item already carries its handle). Server-internal. */
export function ownerWaitOrigin(sessionId: string, kind: string, id: string): OwnerWaitOrigin | null {
  return waitOrigins.get(originKey(sessionId, { kind, id })) ?? null;
}
function pruneOrigins(e: ChatEntry): void {
  const live = new Set((e.ownerWaits ?? []).map((w) => originKey(e.sessionId, w)));
  for (const k of [...waitOrigins.keys()]) if (k.startsWith(`${e.sessionId}\n`) && !live.has(k)) waitOrigins.delete(k);
}

/** A receipt the SERVER delivered for an owner-proven card action (K4, K6): it closes the wait
 *  with this card id, and nothing else does on its behalf. */
export interface OwnerReceiptMark { kind: OwnerCardKind; id: string }

/**
 * A background roster entry that reads as a server or a watch left running (a dev server, a
 * Monitor, a tail, a tunnel): it has no end the child waits for, so it does not hold the row
 * past the quiet bar. Everything else (a script, a test run, a background agent) is a job.
 */
export function persistentBackground(t: { task_type?: unknown; description?: unknown }): boolean {
  const type = typeof t.task_type === 'string' ? t.task_type : '';
  const desc = typeof t.description === 'string' ? t.description : '';
  if (/monitor|watch/i.test(type)) return true;
  return /\b(?:dev[- ]?server|server|serve|serving|watch(?:er|ing)?|monitor(?:ing)?|tail|preview|listen(?:er|ing)?|daemon|tunnel|localhost|port \d+|npm (?:run )?(?:dev|start)|vite|next dev|keep[- ]alive)\b/i.test(desc);
}

/** Be told of every {@link ChatChange}. Returns the unsubscribe. A listener that throws is
 *  isolated — it never stops the registry or the other listeners. */
export function onChatChange(fn: (c: ChatChange) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** A question or permission of a chat was answered through its window (the Mac card, the
 *  Super's `answer`, a phone or Telegram tap that goes through the window). */
export interface RequestAnswered { sessionId: string; requestId: string; answers: Record<string, string> | null }
const answerListeners = new Set<(a: RequestAnswered) => void>();
export function onRequestAnswered(fn: (a: RequestAnswered) => void): () => void {
  answerListeners.add(fn);
  return () => { answerListeners.delete(fn); };
}
/** Question → answer text (strings only, at most 8 questions, each cut to 300). */
function answerMap(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [q, a] of Object.entries(raw as Record<string, unknown>).slice(0, 8)) {
    const v = Array.isArray(a) ? a.filter((x) => typeof x === 'string').join(', ') : typeof a === 'string' ? a : '';
    if (v) out[q.slice(0, 300)] = v.slice(0, 300);
  }
  return Object.keys(out).length ? out : null;
}

function emit(e: ChatEntry, from: ChatStatus): void {
  for (const fn of [...listeners]) {
    try { fn({ entry: clone(e), from }); } catch { /* a listener's failure is its own */ }
  }
}

const cap = (s: string, n = TEXT_CAP) => (s.length > n ? `${s.slice(0, n)}…` : s);
const clonePending = (p: PendingQuestion): PendingQuestion => ({
  ...p, options: [...p.options],
  ...(p.images ? { images: p.images.map((i) => ({ ...i })) } : {}),
  ...(p.questions ? { questions: p.questions.map((q) => ({ ...q, options: q.options.map((o) => ({ ...o })) })) } : {}),
});
const clone = (e: ChatEntry): ChatEntry => ({
  ...e, lastAssistantText: [...e.lastAssistantText],
  pendingQuestion: e.pendingQuestion ? clonePending(e.pendingQuestion) : null,
  ...(e.earlierPending ? { earlierPending: e.earlierPending.map(clonePending) } : {}),
  ...(e.ownerWaits ? { ownerWaits: e.ownerWaits.map(cloneWait) } : {}),
  ...(e.ownerAnswered ? { ownerAnswered: [...e.ownerAnswered] } : {}),
});

const cloneWait = (w: OwnerWait): OwnerWait => ({ ...w, ...(w.refusal ? { refusal: { ...w.refusal } } : {}) });
const waitKey = (w: { kind: string; id: string }) => `${w.kind}:${w.id}`;
const MAX_ANSWERED = 16;

/** Mark waits answered (they leave `ownerWaits`), and tell the owner listeners. */
function answerWaits(e: ChatEntry, done: readonly OwnerWait[]): void {
  if (!done.length) return;
  const keys = new Set(done.map(waitKey));
  e.ownerAnswered = [...(e.ownerAnswered ?? []).filter((k) => !keys.has(k)), ...keys].slice(-MAX_ANSWERED);
  setOwnerWaits(e, (e.ownerWaits ?? []).filter((w) => !keys.has(waitKey(w))));
  // setOwnerWaits emits only on a change of waits; an answer always is one.
}

/** Is this wait one the process saw answered? */
export function ownerWaitAnswered(sessionId: string, kind: string, id: string): boolean {
  return !!entries.get(sessionId)?.ownerAnswered?.includes(`${kind}:${id}`);
}

/** His messages to a chat that arrived while it held no wait (head of each, when, newest last). */
const unheard = new Map<string, Array<{ text: string; at: number }>>();
const UNHEARD_MAX = 4;
const UNHEARD_CHARS = 1000;

/**
 * The record still holds open waits this process does not (a respawn, a server restart): hold
 * them again, so his receipt still finds them. Unless he ALREADY answered one in this process
 * (his run report can be a respawned child's very first frame, before the record is read): those
 * come back as answered and the caller closes their items. The waits are matched as ONE set, as
 * the live path does (with two run cards open, only the one whose command ran is answered), each
 * only by his words from after it was asked (`since`); a text that answered is used up. Quiet (no
 * emit): the record already says it.
 */
export function adoptOwnerWaits(sessionId: string, waits: ReadonlyArray<{ wait: OwnerWait; since: number }>): Set<string> {
  const answered = new Set<string>();
  const e = entries.get(sessionId);
  if (!e || e.status === 'gone') return answered;
  const fresh = waits.filter(({ wait }) => {
    const k = waitKey(wait);
    if (e.ownerAnswered?.includes(k)) { answered.add(k); return false; }
    return !(e.ownerWaits ?? []).some((x) => waitKey(x) === k);
  });
  const texts = unheard.get(sessionId) ?? [];
  const used = new Set<number>();
  texts.forEach((t, i) => {
    const open = fresh.filter(({ wait, since }) => since <= t.at && !answered.has(waitKey(wait))).map(({ wait }) => wait);
    const hit = answeredBy(t.text, open);
    if (hit.length) used.add(i);
    for (const w of hit) answered.add(waitKey(w));
  });
  if (used.size) unheard.set(sessionId, texts.filter((_, i) => !used.has(i)));
  const newly = fresh.filter(({ wait }) => answered.has(waitKey(wait))).map(({ wait }) => waitKey(wait));
  if (newly.length) e.ownerAnswered = [...(e.ownerAnswered ?? []), ...newly].slice(-MAX_ANSWERED);
  const held = fresh.filter(({ wait }) => !answered.has(waitKey(wait))).map(({ wait }) => cloneWait(wait));
  if (held.length) e.ownerWaits = [...(e.ownerWaits ?? []), ...held].slice(-MAX_OWNER_WAITS);
  return answered;
}

/** The Super Agent closed an owner item (`super queue done`: he did it another way): the wait
 *  is answered, so it never comes back from the registry. */
export function dropOwnerWait(sessionId: string, kind: OwnerWaitKind, id: string, opts: { postingSession?: string } = {}): void {
  // Its card records close with it, EVERY card kind (run, secret, checklist, mcp: H1,
  // sahip-karti-yerinde K1): no button, phone, Telegram tap or slot acts on it after. Closed
  // whether or not a live entry holds the wait (a parked, gone or restarted child's record too),
  // and under the session that POSTED the card (a succeeded card's item names its successor).
  if (isOwnerCardKind(kind)) {
    closeCardsById(sessionId, kind, id);
    if (opts.postingSession && opts.postingSession !== sessionId) closeCardsById(opts.postingSession, kind, id);
  }
  const e = entries.get(sessionId);
  if (!e) return;
  const k = `${kind}:${id}`;
  const held = (e.ownerWaits ?? []).filter((w) => waitKey(w) === k);
  if (held.length) { answerWaits(e, held); return; }
  if (!e.ownerAnswered?.includes(k)) e.ownerAnswered = [...(e.ownerAnswered ?? []), k].slice(-MAX_ANSWERED);
}

function satisfies(until: WatchUntil, from: ChatStatus, now: ChatStatus): boolean {
  if (until === 'any') return now !== from;
  if (until === 'settled') return now === 'idle' || now === 'asking';
  return now === until;
}

function setStatus(e: ChatEntry, status: ChatStatus): void {
  const from = e.status;
  e.status = status;
  e.updatedAt = new Date().toISOString();
  if (from === status) return;
  // A turn began: it is the one any ended background work was owed (a roster that shrinks while
  // it runs owes again, see `wakeOwedAt`).
  if (status === 'working' && from !== 'asking') delete e.wakeOwedAt;
  const set = waiters.get(e.sessionId);
  for (const w of set ? [...set] : []) {
    if (status === 'gone') settle(e.sessionId, w, { entry: clone(e), ended: true });
    else if (satisfies(w.until, w.from, status)) settle(e.sessionId, w, { entry: clone(e) });
  }
  emit(e, from);
}

function settle(sessionId: string, w: Waiter, r: WatchResult): void {
  clearTimeout(w.timer);
  waiters.get(sessionId)?.delete(w);
  if (waiters.get(sessionId)?.size === 0) waiters.delete(sessionId);
  w.resolve(r);
}

/** Pull the plain text out of an `assistant` frame's content blocks. */
export function assistantText(frame: Record<string, unknown>): string {
  const msg = frame.message as { content?: unknown } | undefined;
  if (!msg || !Array.isArray(msg.content)) return '';
  return msg.content
    .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * A frame of a LOCAL slash command (`/effort`, `/model`…): the CLI answers it itself, with a
 * synthetic `assistant` frame (`local_command_run`) and a `result` (`local_command`), and no
 * model ran (measured on the CLI, 2026-11-08). It is a setting, never the chat's work: its echo
 * is no reply and its `result` ends no turn of the owner's. An older CLI without the markers
 * reads as before.
 */
export function isLocalCommandFrame(frame: Record<string, unknown>): boolean {
  if (frame.type === 'assistant') return (frame.local_command_run != null && typeof frame.local_command_run === 'object') || typeof frame.local_command_source === 'string';
  if (frame.type === 'result') return typeof frame.local_command === 'string' && frame.local_command !== '';
  return false;
}

/** Ids of the content blocks of one `type` in a frame's message (tool_use ids, or the
 *  tool_use_id a tool_result answers). */
function blockIds(frame: Record<string, unknown>, type: 'tool_use' | 'tool_result'): string[] {
  const msg = frame.message as { content?: unknown } | undefined;
  if (!msg || !Array.isArray(msg.content)) return [];
  const key = type === 'tool_use' ? 'id' : 'tool_use_id';
  return msg.content
    .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object' && (b as { type?: unknown }).type === type)
    .map((b) => b[key])
    .filter((id): id is string => typeof id === 'string');
}

/** What a glance should say about a chat right now — see the header for the rules. */
export function activityOf(e: Pick<ChatEntry, 'status' | 'lastFrameAt' | 'toolsInFlight'>, now = Date.now()): ChatActivity {
  const silentFor = now - Date.parse(e.lastFrameAt);
  if (e.status === 'starting') return silentFor > STARTING_GRACE_MS ? 'idle' : 'starting';
  if (e.status === 'working') return silentFor > (e.toolsInFlight > 0 ? TOOL_STALE_MS : STALE_MS) ? 'stale' : 'working';
  return e.status;
}

/** An AskUserQuestion's `questions`, verbatim, or undefined when a shape is unrecognised or the
 *  whole is over {@link MAX_QUESTION_BYTES}. */
export function registryQuestions(raw: readonly unknown[]): RegistryQuestion[] | undefined {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const out: RegistryQuestion[] = [];
  for (const rq of raw) {
    if (!rq || typeof rq !== 'object' || Array.isArray(rq)) return undefined;
    const q = rq as Record<string, unknown>;
    const question = str(q.question);
    if (!question) return undefined;
    const rawOpts = Array.isArray(q.options) ? q.options as unknown[] : [];
    const options: RegistryQuestionOption[] = [];
    for (const ro of rawOpts) {
      const o = (ro && typeof ro === 'object' ? ro : {}) as Record<string, unknown>;
      const label = str(o.label);
      if (!label) return undefined;
      const description = str(o.description);
      const preview = str(o.preview);
      options.push({ label, ...(description ? { description } : {}), ...(preview ? { preview } : {}) });
    }
    const header = str(q.header);
    const qDescription = str(q.description);
    out.push({ question, ...(header ? { header } : {}), ...(qDescription ? { description: qDescription } : {}), ...(q.multiSelect === true ? { multiSelect: true } : {}), options });
  }
  if (!out.length || Buffer.byteLength(JSON.stringify(out), 'utf-8') > MAX_QUESTION_BYTES) return undefined;
  return out;
}

/** At most this many earlier requests a chat keeps (a batch of parallel tool calls). */
const MAX_EARLIER_PENDING = 16;

/** The request ids a chat is waiting on: the newest and the ones raised before it. */
export function pendingRequestIds(e: Pick<ChatEntry, 'pendingQuestion' | 'earlierPending'> | null | undefined): string[] {
  if (!e) return [];
  return [...(e.earlierPending ?? []), ...(e.pendingQuestion ? [e.pendingQuestion] : [])].map((p) => p.requestId);
}

/** One waiting request of a chat by its id, wherever it stands. */
export function pendingRequest(e: Pick<ChatEntry, 'pendingQuestion' | 'earlierPending'> | null | undefined, requestId: string | undefined): PendingQuestion | null {
  if (!e || !requestId) return null;
  if (e.pendingQuestion?.requestId === requestId) return e.pendingQuestion;
  return e.earlierPending?.find((p) => p.requestId === requestId) ?? null;
}

/** Read a `control_request{can_use_tool}` into a pending question. Unrecognised shapes
 *  return null (`pattern-unrecognized-shape-returns-null`). */
export function readPendingQuestion(frame: Record<string, unknown>): PendingQuestion | null {
  if (frame.type !== 'control_request') return null;
  const req = frame.request as Record<string, unknown> | undefined;
  if (!req || req.subtype !== 'can_use_tool' || typeof frame.request_id !== 'string') return null;
  const toolName = typeof req.tool_name === 'string' ? req.tool_name : 'tool';
  const input = (req.input && typeof req.input === 'object' ? req.input : {}) as Record<string, unknown>;
  const toolUse = typeof req.tool_use_id === 'string' && req.tool_use_id ? { toolUseId: req.tool_use_id } : {};
  if (toolName === 'AskUserQuestion') {
    const qs = Array.isArray(input.questions) ? input.questions as Array<Record<string, unknown>> : [];
    const first = qs[0] ?? {};
    const options = Array.isArray(first.options)
      ? (first.options as Array<Record<string, unknown>>).map((o) => (typeof o?.label === 'string' ? o.label : '')).filter(Boolean)
      : [];
    const text = qs.map((q) => (typeof q.question === 'string' ? q.question : '')).filter(Boolean).join('\n');
    const images = imagesInPreviews(qs.map((q) => ({ options: Array.isArray(q.options) ? q.options as Array<{ label?: unknown; preview?: unknown }> : [] })));
    const questions = registryQuestions(qs);
    const title = typeof input.title === 'string' && input.title.trim() ? { title: cap(input.title.trim(), 200) } : {};
    return { requestId: frame.request_id, toolName, isPermission: false, text: cap(text, 600), options, ...title, ...(images.length ? { images } : {}), ...(questions ? { questions } : {}), ...toolUse };
  }
  const described = typeof input.command === 'string' ? input.command
    : typeof input.file_path === 'string' ? input.file_path
      : typeof input.description === 'string' ? input.description : '';
  const why = {
    ...(typeof req.description === 'string' && req.description.trim() ? { description: cap(req.description.trim(), 200) } : {}),
    ...(typeof req.decision_reason === 'string' && req.decision_reason.trim() ? { reason: cap(req.decision_reason.trim(), 300) } : {}),
    ...(typeof req.decision_reason_type === 'string' && /^[A-Za-z]{1,40}$/.test(req.decision_reason_type) ? { reasonType: req.decision_reason_type } : {}),
  };
  const text = cap(described, 600);
  const full = text === described ? {} : { fullText: cap(described, PERMISSION_FULL_CAP) };
  return { requestId: frame.request_id, toolName, isPermission: true, text, options: ['allow', 'deny'], ...toolUse, ...why, ...full };
}

/** Does its Super Agent decide this request first? Only a TOOL permission (never a question or a
 *  plan approval) of a process that runs `bypassPermissions` right now (`ChatEntry.bypass`): the
 *  residual asks Claude Code still raises in Bypass. Anything else is the owner's alone. */
export function superDecidesPermission(entry: Pick<ChatEntry, 'bypass'> | null | undefined, q: Pick<PendingQuestion, 'isPermission' | 'toolName'> | null | undefined): boolean {
  return entry?.bypass === true && !!q && q.isPermission && q.toolName !== 'ExitPlanMode' && q.toolName !== 'AskUserQuestion';
}

/** What a chat is about, in one line: its title, else the first line of its newest assistant
 *  text, else ''. Whitespace collapsed, clipped to `max` with a trailing `…`. */
export function chatTopic(e: Pick<ChatEntry, 'title' | 'lastAssistantText'>, max = 100): string {
  const newest = e.lastAssistantText[e.lastAssistantText.length - 1] ?? '';
  const raw = e.title.trim() || newest.split('\n').find((l) => l.trim()) || '';
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Register a live chat. Returns the handle the bridge feeds. `seed` carries what an existing
 *  conversation is already about (a `--resume` respawn replays no history, chat-seed.ts reads it
 *  from disk); it sets title and texts only — never status or updatedAt. */
export function registerChat(init: {
  sessionId: string; conversationId: string | null; vault: string; mode: string; origin?: 'assistant'; bypass?: boolean;
  seed?: { title?: string; lastAssistantText?: string[] };
  /** Told by the server (W4 field): the process's permission mode, and whether it is Super crew. */
  permissionMode?: string; crew?: boolean;
}): ChatHandle {
  const existingDeath = deathTimers.get(init.sessionId);
  if (existingDeath) { clearTimeout(existingDeath); deathTimers.delete(init.sessionId); }
  const e: ChatEntry = {
    sessionId: init.sessionId,
    conversationId: init.conversationId,
    vault: init.vault,
    mode: init.mode,
    title: init.seed?.title?.trim() ? cap(init.seed.title.trim().replace(/\s+/g, ' '), 80) : '',
    status: 'starting',
    lastAssistantText: (init.seed?.lastAssistantText ?? []).filter((t) => typeof t === 'string' && t).map((t) => cap(t)).slice(-TEXT_RING),
    pendingQuestion: null,
    updatedAt: new Date().toISOString(),
    lastFrameAt: new Date().toISOString(),
    toolsInFlight: 0,
    ...(init.origin === 'assistant' ? { origin: 'assistant' as const } : {}),
    ...(init.bypass === true ? { bypass: true as const } : {}),
    ...(init.crew === true ? { crew: true as const } : {}),
    ...(typeof init.permissionMode === 'string' && init.permissionMode ? { permissionMode: init.permissionMode } : {}),
  };
  const before = entries.get(init.sessionId);
  if (before && before.status !== 'gone') displaced.set(init.sessionId, [...(displaced.get(init.sessionId) ?? []).filter((x) => x !== before), before]);
  entries.set(init.sessionId, e);
  unheard.delete(init.sessionId);
  let dead = false;
  let interruptAsked = false;
  let limitAsked = false;
  /** Messages (not slash commands) written since the last model `result`. A local command's
   *  `result` answers only itself: while one of these is still owed, it must not read as the
   *  turn's end (field 2026-11-08: `super update --effort` then `super send` gave a false `done`
   *  whose last reply was the effort echo, while the child had just started on the message). */
  let messagesOwed = 0;
  const openTools = new Set<string>();
  const outwardOpen = new Map<string, string>();
  const outwardTold = new Set<string>();
  /** Every assistant frame (top level and a sub-agent's): an outward call is remembered; every
   *  user frame: its non-error result tells it, once. */
  const noteOutward = (frame: Record<string, unknown>): void => {
    const content = (frame.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      const blk = b as Record<string, unknown>;
      if (frame.type === 'assistant' && blk.type === 'tool_use' && typeof blk.id === 'string') {
        if (outwardTold.has(blk.id) || outwardOpen.has(blk.id)) continue;
        const what = outwardAction(blk.name, blk.input);
        if (!what) continue;
        outwardOpen.set(blk.id, what);
        if (outwardOpen.size > MAX_OUTWARD_OPEN) outwardOpen.delete(outwardOpen.keys().next().value as string);
      } else if (frame.type === 'user' && blk.type === 'tool_result' && typeof blk.tool_use_id === 'string') {
        const what = outwardOpen.get(blk.tool_use_id);
        if (what === undefined) continue;
        outwardOpen.delete(blk.tool_use_id);
        if (blk.is_error === true) continue;
        outwardTold.add(blk.tool_use_id);
        if (outwardTold.size > MAX_OUTWARD_TOLD) outwardTold.delete(outwardTold.values().next().value as string);
        try { outwardSink?.(e.sessionId, what, blk.tool_use_id); } catch { /* a sink never breaks the stream */ }
      }
    }
  };
  const alive = () => { e.lastFrameAt = new Date().toISOString(); };
  const syncTools = () => { e.toolsInFlight = openTools.size; };
  const refusals = newTurnRefusals();

  /** A request left (answered or cancelled). Others still waiting: the chat keeps asking and the
   *  listeners close only this one. An id it is not waiting on (a card that outlived its turn)
   *  closes nothing: it would take every waiting request down with it. */
  const settlePending = (requestId?: string | null): void => {
    if (requestId && pendingRequestIds(e).length && !pendingRequest(e, requestId)) return;
    const earlier = e.earlierPending ?? [];
    if (requestId && earlier.length) {
      const rest = earlier.filter((p) => p.requestId !== requestId);
      if (rest.length === earlier.length) e.pendingQuestion = rest.pop() ?? null;
      if (rest.length) e.earlierPending = rest; else delete e.earlierPending;
      if (e.status === 'asking') emit(e, 'asking');
      return;
    }
    if (!requestId || e.pendingQuestion?.requestId === requestId) { e.pendingQuestion = null; delete e.earlierPending; }
    if (e.status === 'asking') setStatus(e, 'working');
  };
  return {
    sessionId: init.sessionId,
    observe(frame) {
      if (dead) return;
      alive();
      if (frame.type === 'system' && frame.subtype === 'init' && typeof frame.session_id === 'string') {
        e.conversationId = frame.session_id;
      }
      // The process says what it runs: anything but bypass clears the flag for good (fail closed).
      if (frame.type === 'system' && frame.subtype === 'init' && typeof frame.permissionMode === 'string' && frame.permissionMode !== 'bypassPermissions') {
        delete e.bypass;
      }
      // K2: what this turn refused, and what it ran after all (a crew chat only).
      if (e.crew) noteRefusalFacts(e, refusals, frame);
      if (frame.type === 'system' && frame.subtype === 'background_tasks_changed') {
        const tasks = Array.isArray(frame.tasks) ? frame.tasks as unknown[] : [];
        const n = tasks.length;
        const jobs = tasks.filter((t) => !t || typeof t !== 'object' || !persistentBackground(t as Record<string, unknown>)).length;
        if (n !== (e.backgroundTasks ?? 0) || e.backgroundAt === undefined) {
          const at = new Date().toISOString();
          if (n < (e.backgroundTasks ?? 0)) e.wakeOwedAt = at;
          e.backgroundTasks = n;
          e.backgroundAt = at;
        }
        if (jobs > 0) e.backgroundJobs = jobs; else delete e.backgroundJobs;
        return;
      }
      // The CLI took a request back itself: it waits on it no more, whoever still shows it.
      if (frame.type === 'control_cancel_request' && typeof frame.request_id === 'string') {
        if (pendingRequest(e, frame.request_id)) settlePending(frame.request_id);
        return;
      }
      if (frame.type === 'assistant' || frame.type === 'user') noteOutward(frame);
      const q = readPendingQuestion(frame);
      if (q) {
        const prevRequestId = e.pendingQuestion?.requestId;
        const wasAsking = e.status === 'asking';
        // A different request: the one before it still waits for its answer.
        if (e.pendingQuestion && prevRequestId !== q.requestId) {
          e.earlierPending = [...(e.earlierPending ?? []).filter((p) => p.requestId !== q.requestId), e.pendingQuestion].slice(-MAX_EARLIER_PENDING);
        }
        e.pendingQuestion = q;
        setStatus(e, 'asking');
        // Still asking, but about something new: the owner has a different question to see.
        if (wasAsking && prevRequestId !== q.requestId) emit(e, 'asking');
        return;
      }
      // The main agent is producing output, so a turn IS running, whoever opened it (a queued
      // second message after the first one's result, or a turn the bridge wrote itself).
      // `null` and absent both mean top level: real CLI frames carry `parent_tool_use_id: null`
      // on `assistant` and omit it on `result`.
      const topLevel = frame.parent_tool_use_id == null;
      // A local slash command's echo and `result` (isLocalCommandFrame): no work started, so its
      // echo opens no turn and is no reply. Its `result` ends a turn only when it was the owner's
      // own slash command and no message is still owed; a setting the bridge wrote while the chat
      // rested (`super update`, a picker) leaves the chat as it was.
      if (topLevel && isLocalCommandFrame(frame)) {
        if (frame.type === 'assistant' || messagesOwed > 0 || (e.status !== 'working' && e.status !== 'asking')) return;
      }
      // A tool_result for a request's tool call (top level or inside a sub-agent): the CLI is done
      // with that call, so it waits on the request no more (a stream that closed under it, say).
      if (frame.type === 'user' && pendingRequestIds(e).length) {
        for (const id of blockIds(frame, 'tool_result')) {
          const closed = [...(e.earlierPending ?? []), ...(e.pendingQuestion ? [e.pendingQuestion] : [])].find((p) => p.toolUseId === id);
          if (closed) settlePending(closed.requestId);
        }
      }
      if (topLevel && (frame.type === 'assistant' || frame.type === 'stream_event') && (e.status === 'idle' || e.status === 'starting')) {
        setStatus(e, 'working');
      }
      if (topLevel && frame.type === 'user') {
        for (const id of blockIds(frame, 'tool_result')) openTools.delete(id);
        syncTools();
      }
      if (frame.type === 'assistant' && topLevel) {
        for (const id of blockIds(frame, 'tool_use')) openTools.add(id);
        syncTools();
        const text = assistantText(frame);
        if (text) {
          // The server's own run/secret card records (plan H1): keyed by this message's uuid.
          const uuid = typeof frame.uuid === 'string' ? frame.uuid : typeof (frame.message as { id?: unknown } | undefined)?.id === 'string' ? (frame.message as { id: string }).id : '';
          if (uuid) noteAssistantCards(e.sessionId, e.vault, uuid, text);
          // Read the whole text, before the cap: a card at the end of a long reply still counts.
          const cards = ownerCardsIn(text);
          if (cards.length) {
            const keep = (e.ownerWaits ?? []).filter((w) => !cards.some((c) => c.kind === w.kind && c.id === w.id));
            // A card posted again is a new ask, even under an id he answered before.
            if (e.ownerAnswered) e.ownerAnswered = e.ownerAnswered.filter((k) => !cards.some((c) => waitKey(c) === k));
            // The frame each card came from (K1): the inbox makes the item's card handle from it.
            if (uuid) for (const c of cards) waitOrigins.set(originKey(e.sessionId, c), { messageUuid: uuid, conversationId: e.conversationId ?? '', text });
            setOwnerWaits(e, [...keep, ...cards]);
          }
          // The whole text, marks included, to whoever routes answers (the Telegram hub, W2).
          emitAssistantText(e.sessionId, text);
          // The Super's reply mark (`<!-- re:<ref> -->`) is for the window, never a last line.
          e.lastAssistantText.push(cap(stripReplyMark(text)));
          if (e.lastAssistantText.length > TEXT_RING) e.lastAssistantText.splice(0, e.lastAssistantText.length - TEXT_RING);
          e.updatedAt = new Date().toISOString();
        }
        return;
      }
      if (frame.type === 'result' && topLevel) {
        // The turn's refusals become owner waits once the whole turn is in: a call refused and
        // then run after all was never his to settle.
        if (e.crew && !isLocalCommandFrame(frame)) settleTurnRefusals(e, refusals, frame);
        e.pendingQuestion = null;
        delete e.earlierPending;
        openTools.clear();
        syncTools();
        e.lastTurn = {
          endedAt: new Date().toISOString(), interrupted: interruptAsked, resultSeq: ++resultSeq,
          ...(frame.is_error === true ? { isError: true } : {}),
          ...(limitAsked ? { limited: true } : {}),
        };
        interruptAsked = false;
        limitAsked = false;
        // A model's `result` answers every frame written before it (the CLI folds them).
        if (!isLocalCommandFrame(frame)) messagesOwed = 0;
        setStatus(e, 'idle');
      }
    },
    userSent(text, opts) {
      if (dead) return;
      alive();
      // A new turn: an interrupt asked for while nothing ran belongs to no turn.
      if (e.status !== 'working' && e.status !== 'asking') { interruptAsked = false; limitAsked = false; }
      if (!e.title && text.trim()) e.title = cap(text.trim().replace(/\s+/g, ' '), 80);
      if (text.trim() && !text.trimStart().startsWith('/')) messagesOwed += 1;
      // A send the server noted for an agent (`super send`, an agent's `window send` into the
      // Super) is never his words: it answers no wait and ends no Telegram presence.
      const steered = !telegramSideSource(opts?.source) && takeSuperSend(e.sessionId, text);
      const receipt = opts?.ownerReceipt;
      emitUserSent(e.sessionId, text, opts?.source, opts?.server === true || steered || !!receipt);
      // A receipt the SERVER delivered for an owner-proven action (sahip-karti-yerinde K4, K6)
      // closes its own card BY ID, nothing else; one whose wait is already closed (a rerun, a
      // second checklist submit) closes nothing and is still delivered.
      if (receipt) {
        const hit = (e.ownerWaits ?? []).filter((w) => w.kind === receipt.kind && w.id === receipt.id);
        if (hit.length) answerWaits(e, hit);
        else if (!e.ownerAnswered?.includes(`${receipt.kind}:${receipt.id}`)) {
          // Not held here yet (a woken child's wait still lives only in the record): answered.
          e.ownerAnswered = [...(e.ownerAnswered ?? []), `${receipt.kind}:${receipt.id}`].slice(-MAX_ANSWERED);
          emitOwner(e);
        }
      }
      // HIS answer (his own words to the child, or a receipt the window wrote for his press)
      // clears what it answers; the Super Agent steering the child (a send the server noted for
      // it) clears nothing. A Telegram text clears nothing either (H1, J1). A turn the server wrote
      // through the crew handle (an Allow-once note, a cut-off card notice) closes NOTHING, even
      // when it LOOKS like a receipt (K4 attribution): a crew card closes by its id above.
      else if (!telegramSideSource(opts?.source) && !steered && opts?.closesNothing !== true) {
        // A server-looking turn the window wrote (a run report) closes only its card, never a
        // refusal or a stall: those close when their grant is used or the server says so.
        if (e.ownerWaits?.length && opts?.server === true) answerWaits(e, answeredBy(text, e.ownerWaits).filter((w) => w.kind !== 'refusal' && w.kind !== 'stalled'));
        else if (e.ownerWaits?.length) answerWaits(e, answeredBy(text, e.ownerWaits));
        // His words with no wait held here yet: a respawned child's wait still lives only in the
        // record, and his run report may be the very first frame (adoptOwnerWait reads these).
        else if (text.trim() && opts?.server !== true) unheard.set(e.sessionId, [...(unheard.get(e.sessionId) ?? []), { text: text.slice(0, UNHEARD_CHARS), at: Date.now() }].slice(-UNHEARD_MAX));
      }
      setStatus(e, 'working');
    },
    interrupted() {
      if (dead) return;
      interruptAsked = true;
    },
    markLimited() {
      if (dead) return;
      // The refusal can arrive on the turn's own `result`, after it was stamped: mark that turn.
      if (e.status === 'idle' && e.lastTurn) { e.lastTurn = { ...e.lastTurn, limited: true }; return; }
      limitAsked = true;
    },
    notBypass() {
      delete e.bypass;
    },
    stopSettled() {
      if (dead) return;
      // A turn stopped with no `result`: its refusals belong to no turn the owner can act on.
      resetTurnRefusals(refusals);
      interruptAsked = false;
      messagesOwed = 0;
      if (e.status !== 'working' && e.status !== 'asking') return;
      e.pendingQuestion = null;
      delete e.earlierPending;
      openTools.clear();
      syncTools();
      e.lastTurn = { endedAt: new Date().toISOString(), interrupted: true, resultSeq: ++resultSeq };
      limitAsked = false;
      setStatus(e, 'idle');
    },
    answered(requestId, answers) {
      if (dead) return;
      alive();
      settlePending(requestId);
      if (!requestId) return;
      const a: RequestAnswered = { sessionId: init.sessionId, requestId, answers: answerMap(answers) };
      for (const fn of [...answerListeners]) { try { fn(a); } catch { /* a listener's failure is its own */ } }
    },
    exited() {
      if (dead) return;
      dead = true;
      e.pendingQuestion = null;
      delete e.earlierPending;
      setStatus(e, 'gone');
      // The child that wrote its Telegram refs is gone: their 30-minute clock starts again (F6).
      restartWrittenRefClocks(init.sessionId);
      const rest = (displaced.get(init.sessionId) ?? []).filter((x) => x !== e && x.status !== 'gone');
      if (rest.length) displaced.set(init.sessionId, rest); else displaced.delete(init.sessionId);
      // A process this one displaced still runs under the same id: it is the chat again.
      if (entries.get(init.sessionId) === e && rest.length) {
        const back = rest[rest.length - 1];
        displaced.set(init.sessionId, rest.slice(0, -1));
        if (!displaced.get(init.sessionId)?.length) displaced.delete(init.sessionId);
        entries.set(init.sessionId, back);
        emit(back, 'gone');
        return;
      }
      const t = setTimeout(() => {
        deathTimers.delete(init.sessionId);
        // Only THIS entry's death drops its refs: an old child exiting after its successor
        // registered under the same id never deletes the successor's (F5).
        if (entries.get(init.sessionId) === e) {
          entries.delete(init.sessionId); unheard.delete(init.sessionId); dropAllRefs(init.sessionId);
          for (const k of [...waitOrigins.keys()]) if (k.startsWith(`${init.sessionId}\n`)) waitOrigins.delete(k);
        }
      }, GONE_TTL_MS);
      t.unref?.();
      deathTimers.set(init.sessionId, t);
    },
  };
}

export function listChats(filter: { vault?: string; status?: ChatStatus } = {}): ChatEntry[] {
  return [...entries.values()]
    .filter((e) => (!filter.vault || e.vault === filter.vault) && (!filter.status || e.status === filter.status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(clone);
}

/**
 * Did the Assistant start the conversation `conversationId`? True while an entry for it with
 * `origin: 'assistant'` is still in the registry — live, or `gone` and not yet deleted
 * (GONE_TTL_MS). That is how a respawn-in-place (Resume, account or mode switch — each a new
 * spawn of the same conversation) keeps the delegation marker without a store of its own:
 * the old entry is still here when the new spawn registers, and the new entry carries it on.
 */
export function isDelegatedConversation(conversationId: string): boolean {
  if (!conversationId) return false;
  for (const e of entries.values()) {
    if (e.origin === 'assistant' && e.conversationId === conversationId) return true;
  }
  return false;
}

export function getChat(sessionId: string): ChatEntry | null {
  const e = entries.get(sessionId);
  return e ? clone(e) : null;
}

/**
 * Long-poll one chat. Resolves:
 *  • at once with `ended:true` when it is already gone (or goes while waiting);
 *  • at once when it is ALREADY in the requested status (`idle`/`asking`, or either for
 *    `settled`) — "wait until it is done" on a chat that is done is an answer, not a wait;
 *  • on the next change for `any`;
 *  • with `timedOut:true` after `timeoutMs`;
 *  • with `unknown:true` for a session this server has never seen.
 */
export function watchChat(sessionId: string, until: WatchUntil, timeoutMs: number): Promise<WatchResult> {
  const e = entries.get(sessionId);
  if (!e) return Promise.resolve({ entry: null, unknown: true });
  if (e.status === 'gone') return Promise.resolve({ entry: clone(e), ended: true });
  if (until !== 'any' && satisfies(until, e.status, e.status)) return Promise.resolve({ entry: clone(e) });
  return new Promise((resolve) => {
    const w: Waiter = {
      until,
      from: e.status,
      resolve,
      timer: setTimeout(() => settle(sessionId, w, { entry: getChat(sessionId), timedOut: true }), Math.max(0, timeoutMs)),
    };
    const set = waiters.get(sessionId) ?? new Set<Waiter>();
    set.add(w);
    waiters.set(sessionId, set);
  });
}

/** Test-only: drop every entry, waiter and timer. */
export function _resetChatRegistry(): void {
  for (const t of deathTimers.values()) clearTimeout(t);
  for (const set of waiters.values()) for (const w of set) clearTimeout(w.timer);
  entries.clear();
  displaced.clear();
  waiters.clear();
  deathTimers.clear();
  listeners.clear();
  ownerListeners.clear();
  unheard.clear();
  waitOrigins.clear();
  assistantListeners.clear();
  userSentListeners.clear();
  injectors.clear();
  injectorListeners.clear();
  crewHandles.clear();
  tgRefs.clear();
  tgDropListeners.clear();
  tgWrittenListeners.clear();
  if (tgSweepTimer) { clearInterval(tgSweepTimer); tgSweepTimer = null; }
  tgNow = Date.now;
}

// ─── Assistant text, for whoever routes answers (W2) ────────────────────────

const assistantListeners = new Set<(sessionId: string, text: string) => void>();

/** Be told every top-level assistant text of every chat, whole (reply marks included). */
export function onChatAssistantText(fn: (sessionId: string, text: string) => void): () => void {
  assistantListeners.add(fn);
  return () => { assistantListeners.delete(fn); };
}

function emitAssistantText(sessionId: string, text: string): void {
  for (const fn of [...assistantListeners]) {
    try { fn(sessionId, text); } catch { /* a listener's failure is its own */ }
  }
}

type UserSentListener = (sessionId: string, text: string, source: InjectedSource | undefined, server: boolean) => void;
const userSentListeners = new Set<UserSentListener>();

/** Be told every owner turn a chat wrote, with who wrote it (a Telegram text or not). `server` =
 *  the server's own text riding the owner path (a usage-reset or account-move continue): never his. */
export function onChatUserSent(fn: UserSentListener): () => void {
  userSentListeners.add(fn);
  return () => { userSentListeners.delete(fn); };
}

function emitUserSent(sessionId: string, text: string, source: InjectedSource | undefined, server: boolean): void {
  for (const fn of [...userSentListeners]) {
    try { fn(sessionId, text, source, server); } catch { /* a listener's failure is its own */ }
  }
}

// ─── Refusal capture (uye-bildirim K2) ──────────────────────────────────────
//
// A refused tool call ends its turn `success`, byte-identical to an allowed one for every reader
// that keeps only `is_error`: the agent says "I could not" in prose and the owner never hears.
// The stream does say it (Claude Code 2.1.322, measured): the `user` frame's
// `tool_result_meta[].permission_decision`, a `system/permission_denied` event with the reason,
// and `result.permission_denials`. Read here, at the resource, so no caller has to remember.

/** What one turn refused and ran, kept until its `result` (bounded: a runaway turn cannot grow it). */
interface TurnRefusals {
  seq: number;
  /** tool_use id → the call (every level: a sub-agent's refused call stops the work too). */
  calls: Map<string, { tool: string; input: unknown }>;
  /** tool_use id (or a synthetic key for an event that names none) → its `permission_denied`. */
  denied: Map<string, { seq: number; frame: Record<string, unknown> }>;
  /** tool_use id → its rejecting meta and the tool_result's own text. */
  rejected: Map<string, { seq: number; meta: Record<string, unknown>; text?: string }>;
  /** Refusal-wait ids of calls that RAN this turn, and when. */
  ran: Array<{ id: string; seq: number }>;
}
const MAX_TURN_FACTS = 256;

function newTurnRefusals(): TurnRefusals {
  return { seq: 0, calls: new Map(), denied: new Map(), rejected: new Map(), ran: [] };
}
function resetTurnRefusals(t: TurnRefusals): void {
  t.seq = 0; t.calls.clear(); t.denied.clear(); t.rejected.clear(); t.ran.length = 0;
}
function boundedSet<V>(m: Map<string, V>, k: string, v: V): void {
  m.delete(k);
  m.set(k, v);
  if (m.size > MAX_TURN_FACTS) m.delete(m.keys().next().value as string);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const TOOL_NAME_RE = /^[A-Za-z0-9_.:/-]{1,120}$/;

/**
 * Who refused a call, as the owner must hear it, or null when it is not his to settle. TOTAL:
 * a shape nobody wrote a row for is a refusal (`unknown`), never read as allowed.
 *  - an accept is no refusal;
 *  - `source: hook` is dreamcontext's own guidance (most recorded refusals): never;
 *  - a refusal by mode while the process runs `plan` or `dontAsk` is the envelope he chose: never;
 *  - the decider's own no (a `user*` source, `user_reject`, an interrupted call): never;
 *  - a classifier block, a settings deny or ask rule, the bridge's unattended deny: a refusal.
 * A headless ask-rule reject reads `non_execution_kind: user-rejected` with `source: config`
 * (premise step 2), so the decider is told by its SOURCE, never by that kind alone.
 */
export function refusalSource(
  meta: Record<string, unknown> | null | undefined,
  deniedEvent: Record<string, unknown> | null | undefined,
  mode: string | null | undefined,
): RefusalFact['source'] | null {
  const pd = isObj(meta?.permission_decision) ? meta!.permission_decision as Record<string, unknown> : null;
  if (pd && (pd.decision === 'accept' || pd.decision === 'allow')) return null;
  if (!pd && !deniedEvent) return null;
  const source = str(pd?.source);
  const reasonType = str(pd?.reason_type) || str(deniedEvent?.decision_reason_type);
  const kind = str(meta?.non_execution_kind);
  if (source === 'hook' || (!source && reasonType === 'hook')) return null;
  if (reasonType === 'mode' && (mode === 'plan' || mode === 'dontAsk')) return null;
  if (/^user/.test(source) || reasonType === 'user_reject' || kind === 'interrupted') return null;
  if (reasonType === 'classifier' || kind === 'automode-blocked') return 'classifier';
  if (reasonType === 'bridge' || source === 'bridge') return 'bridge';
  if (reasonType === 'rule' || (source === 'config' && !reasonType)) return 'rule';
  if (reasonType === 'mode') return 'mode';
  return 'unknown';
}

/** The refusal frame the t3 bridge writes for a call it denied unattended (Codex, Antigravity):
 *  the same `permission_denied` event Claude Code emits, with the call itself in it (the bridge
 *  has no `tool_result_meta`). */
export interface BridgeRefusalFrame {
  type: 'system';
  subtype: 'permission_denied';
  decision_reason_type: 'bridge';
  tool_name: string;
  tool_use_id?: string;
  tool_input: unknown;
  message: string;
}
export function bridgeRefusalFrame(tool: string, input: unknown, message: string, toolUseId?: string): BridgeRefusalFrame {
  return {
    type: 'system', subtype: 'permission_denied', decision_reason_type: 'bridge',
    tool_name: tool, ...(toolUseId ? { tool_use_id: toolUseId } : {}), tool_input: input, message,
  };
}

/** The canonical input of a call (grants `canonicalInput`), '' when there is none to read. */
function canonOf(tool: string, input: unknown): string {
  if (input === undefined || input === null) return '';
  try { return canonicalInput(tool, input); } catch { return ''; }
}

/** The text of a tool_result block (its string, or its text parts). */
function resultText(b: Record<string, unknown>): string {
  if (typeof b.content === 'string') return b.content;
  if (Array.isArray(b.content)) return b.content.filter(isObj).map((x) => str(x.text)).join('\n');
  return '';
}

/** One frame of a crew chat: remember calls, refusals and what ran. A call that ran closes an
 *  open refusal of the same call at once, in this turn or any later one. */
function noteRefusalFacts(e: ChatEntry, t: TurnRefusals, frame: Record<string, unknown>): void {
  if (frame.type === 'assistant') {
    const content = (frame.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (isObj(b) && b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') boundedSet(t.calls, b.id, { tool: b.name, input: b.input });
    }
    return;
  }
  if (frame.type === 'system' && frame.subtype === 'permission_denied') {
    const id = typeof frame.tool_use_id === 'string' && frame.tool_use_id ? frame.tool_use_id : `ev-${t.seq + 1}`;
    boundedSet(t.denied, id, { seq: ++t.seq, frame });
    return;
  }
  if (frame.type !== 'user') return;
  const metas = new Map<string, Record<string, unknown>>();
  if (Array.isArray(frame.tool_result_meta)) {
    for (const m of frame.tool_result_meta) if (isObj(m) && typeof m.id === 'string') metas.set(m.id, m);
  }
  const blocks = new Map<string, Record<string, unknown>>();
  const content = (frame.message as { content?: unknown } | undefined)?.content;
  if (Array.isArray(content)) {
    for (const b of content) if (isObj(b) && b.type === 'tool_result' && typeof b.tool_use_id === 'string') blocks.set(b.tool_use_id, b);
  }
  for (const id of new Set([...blocks.keys(), ...metas.keys()])) {
    const meta = metas.get(id);
    const block = blocks.get(id);
    const pd = isObj(meta?.permission_decision) ? meta!.permission_decision as Record<string, unknown> : null;
    const accepted = pd ? pd.decision === 'accept' || pd.decision === 'allow' : !!block && block.is_error !== true && !t.denied.has(id);
    if (pd && !accepted) {
      const text = block ? resultText(block) : '';
      boundedSet(t.rejected, id, { seq: ++t.seq, meta: meta!, ...(text ? { text } : {}) });
      continue;
    }
    if (!accepted) continue;
    const call = t.calls.get(id);
    if (!call) continue;
    const wid = refusalWaitId(call.tool, canonOf(call.tool, call.input));
    t.ran.push({ id: wid, seq: ++t.seq });
    if (t.ran.length > MAX_TURN_FACTS) t.ran.shift();
    const held = (e.ownerWaits ?? []).filter((w) => w.kind === 'refusal' && w.id === wid);
    if (held.length) answerWaits(e, held);
  }
}

/** The turn's `result`: every refusal the owner must settle, and not run later in the turn,
 *  becomes an owner wait (deduped by call, newest kept up to MAX_OWNER_WAITS). */
function settleTurnRefusals(e: ChatEntry, t: TurnRefusals, result: Record<string, unknown>): void {
  try {
    const backstop = new Map<string, { tool: string; input: unknown }>();
    if (Array.isArray(result.permission_denials)) {
      for (const d of result.permission_denials) {
        if (isObj(d) && typeof d.tool_use_id === 'string' && typeof d.tool_name === 'string') backstop.set(d.tool_use_id, { tool: d.tool_name, input: d.tool_input });
      }
    }
    const ids = [...new Set([...t.rejected.keys(), ...t.denied.keys()])];
    const seqOf = (id: string) => Math.min(t.rejected.get(id)?.seq ?? Infinity, t.denied.get(id)?.seq ?? Infinity);
    ids.sort((a, b) => seqOf(a) - seqOf(b));
    const fresh: OwnerWait[] = [];
    for (const id of ids) {
      const rej = t.rejected.get(id);
      const ev = t.denied.get(id)?.frame ?? null;
      const source = refusalSource(rej?.meta ?? null, ev, e.permissionMode);
      if (!source) continue;
      const fromEvent = ev && typeof ev.tool_name === 'string' ? { tool: ev.tool_name, input: ev.tool_input } : null;
      const call = t.calls.get(id) ?? fromEvent ?? backstop.get(id) ?? null;
      // The input from the call itself; an event or the result's list only when the call frame
      // never came (a bridge refusal, an older CLI).
      const input = call?.input !== undefined ? call.input : fromEvent?.input !== undefined ? fromEvent.input : backstop.get(id)?.input;
      const tool = call && TOOL_NAME_RE.test(call.tool) ? call.tool : 'unknown';
      const canon = canonOf(tool, input);
      const wid = refusalWaitId(tool, canon);
      if (t.ran.some((r) => r.id === wid && r.seq > seqOf(id))) continue;
      if (fresh.some((w) => w.id === wid)) continue;
      const pd = isObj(rej?.meta.permission_decision) ? rej!.meta.permission_decision as Record<string, unknown> : null;
      const category = str(pd?.classifier_category) || str(ev?.classifier_category);
      const reason = str(ev?.message) || rej?.text || '';
      fresh.push(refusalWait(tool, canon, PERMISSION_FULL_CAP, { source, ...(category ? { category } : {}), ...(reason ? { reason } : {}) }));
    }
    if (!fresh.length) return;
    const ids2 = new Set(fresh.map(waitKey));
    // Refused again: a new ask, even when he settled the same call before.
    if (e.ownerAnswered) e.ownerAnswered = e.ownerAnswered.filter((k) => !ids2.has(k));
    const keep = (e.ownerWaits ?? []).filter((w) => !ids2.has(waitKey(w)));
    setOwnerWaits(e, [...keep, ...fresh]);
  } finally {
    resetTurnRefusals(t);
  }
}

/** The server tells a live chat its permission mode changed (a level change, a live switch). */
export function setChatPermissionMode(sessionId: string, mode: string): void {
  const e = entries.get(sessionId);
  if (!e || e.status === 'gone') return;
  if (mode) e.permissionMode = mode; else delete e.permissionMode;
}

// ─── Crew handles (uye-bildirim K3 "Allow once") ────────────────────────────
//
// How the server writes ITS OWN turn into a live crew process that may have no window (a member
// Super, a child): the injector's mechanism for every crew session. Registered by agent-chat.ts at
// spawn, unregistered at exit, so every key has its death.

export interface CrewHandle {
  sendServerTurn(text: string): boolean;
  /** Write an owner-proven card result into the process as a user frame on the `ownerReceipt`
   *  channel (sahip-karti-yerinde K6): resolves true once the registry has seen that frame (the
   *  wait closed by its card id), false when it could not go in. Only the server calls it. */
  sendOwnerReceipt?(text: string, mark: OwnerReceiptMark): Promise<boolean>;
  /** Answer a request the process holds open right now, the way the window's card does:
   *  `respond` builds the answer from the request (request-answer.ts) or refuses it (null).
   *  False when that request is not open here or `respond` refused. For `super allow` and
   *  `super answer` when the window does not answer (field 2026-11-13: an app in the background
   *  held a Bypass child's permission for minutes). Only the server. */
  answerRequest?(requestId: string, respond: (req: OpenRequest) => RequestResponse | null): boolean;
  /** The PATH the process really runs with (its login shell's, read once at spawn), or null while
   *  unknown: a grant resolves its interpreter with it, the way the session's hook will. */
  sessionPath?(): string | null;
}
const crewHandles = new Map<string, CrewHandle>();

/** Returns the unregister, which removes only this handle (a successor's stays). */
export function registerCrewHandle(sessionId: string, handle: CrewHandle): () => void {
  crewHandles.set(sessionId, handle);
  return () => { if (crewHandles.get(sessionId) === handle) crewHandles.delete(sessionId); };
}

/** The crew handle of the chat with pin id `sessionId`, or null. Server-internal. */
export function crewHandle(sessionId: string): CrewHandle | null {
  return crewHandles.get(sessionId) ?? null;
}

// ─── Chat injectors (plan "Injector", B1, D1) ───────────────────────────────

const injectors = new Map<string, ChatInjector>();
const injectorListeners = new Set<(sessionId: string) => void>();

/** A live Super chat registers how the hub writes into it (beside the mirror wiring). Returns
 *  the unregister, which removes only this injector (a successor's stays). */
export function registerChatInjector(sessionId: string, injector: ChatInjector): () => void {
  injectors.set(sessionId, injector);
  for (const fn of [...injectorListeners]) {
    try { fn(sessionId); } catch { /* a listener's failure is its own */ }
  }
  return () => { if (injectors.get(sessionId) === injector) injectors.delete(sessionId); };
}

/** The injector of the chat with pin id `sessionId`, or null. Server-internal: no route reads it. */
export function chatInjector(sessionId: string): ChatInjector | null {
  return injectors.get(sessionId) ?? null;
}

/** Be told when an injector registers (the hub waits for a reopened Super, A3). */
export function onChatInjector(fn: (sessionId: string) => void): () => void {
  injectorListeners.add(fn);
  return () => { injectorListeners.delete(fn); };
}

// ─── The pending Telegram ref store (D1, E1, F2, F5, F6; contract.ts) ──────
//
// Keyed by chatRegistryId (the pin id, which survives the --resume restart). Written ONLY by
// the hub and the run registry; no HTTP route reads or writes it. Every key has a death: an
// unwritten ref after TG_PENDING_REF_TTL_MS, a written ref on its turn's clean result, after
// the TTL once its child is gone (the clock restarts at the exit, F6), and with the registry
// entry's own death.

interface RefSlot extends PendingTelegramRef { clockAt: number }
const tgRefs = new Map<string, Map<string, RefSlot>>();
const tgDropListeners = new Set<TelegramRefDropped>();
const tgWrittenListeners = new Set<(chatRegistryId: string, ref: string) => void>();
let tgSweepTimer: ReturnType<typeof setInterval> | null = null;
let tgNow: () => number = Date.now;

function dropRef(chatRegistryId: string, ref: string): void {
  const map = tgRefs.get(chatRegistryId);
  const slot = map?.get(ref);
  if (!map || !slot) return;
  map.delete(ref);
  if (!map.size) tgRefs.delete(chatRegistryId);
  for (const fn of [...tgDropListeners]) {
    try { fn(chatRegistryId, ref, slot.written); } catch { /* a listener's failure is its own */ }
  }
}

function dropAllRefs(chatRegistryId: string): void {
  for (const ref of [...(tgRefs.get(chatRegistryId)?.keys() ?? [])]) dropRef(chatRegistryId, ref);
}

function restartWrittenRefClocks(chatRegistryId: string): void {
  const now = tgNow();
  for (const slot of tgRefs.get(chatRegistryId)?.values() ?? []) if (slot.written) slot.clockAt = now;
}

/** The TTL: a written ref is exempt while the child that wrote it lives (F5, F6). */
export function sweepTelegramRefs(): void {
  const now = tgNow();
  for (const [id, map] of [...tgRefs]) {
    const e = entries.get(id);
    const childLives = !!e && e.status !== 'gone';
    for (const [ref, slot] of [...map]) {
      if (slot.written && childLives) continue;
      if (now - slot.clockAt > TG_PENDING_REF_TTL_MS) dropRef(id, ref);
    }
  }
  if (!tgRefs.size && tgSweepTimer) { clearInterval(tgSweepTimer); tgSweepTimer = null; }
}

function armSweep(): void {
  if (tgSweepTimer) return;
  tgSweepTimer = setInterval(sweepTelegramRefs, 60_000);
  tgSweepTimer.unref?.();
}

export const telegramRefs: PendingTelegramRefStore & {
  has(chatRegistryId: string, ref: string): boolean;
  get(chatRegistryId: string, ref: string): PendingTelegramRef | null;
  /** Fires once when `writeOwnerTurn` first honours a ref (the turn reached a live child). */
  onTelegramRefWritten(listener: (chatRegistryId: string, ref: string) => void): () => void;
  /** The hub gives up an UNWRITTEN ref (the injection never happened): no drop notice. */
  forget(chatRegistryId: string, ref: string): void;
  /** Test seam: the clock the TTL reads. */
  _setNow(now: () => number): void;
} = {
  put(chatRegistryId, ref, entry) {
    const map = tgRefs.get(chatRegistryId) ?? new Map<string, RefSlot>();
    map.set(ref, { ...entry, clockAt: tgNow() });
    tgRefs.set(chatRegistryId, map);
    armSweep();
  },
  take(chatRegistryId, text) {
    const { ref, body } = parseTelegramPrefix(text);
    if (!ref) return { ref: null, entry: null, body };
    sweepTelegramRefs();
    const slot = tgRefs.get(chatRegistryId)?.get(ref);
    if (!slot) return { ref: null, entry: null, body };
    const first = !slot.written;
    slot.written = true;
    // The hub's journal follows (F5): a crash after this point yields "yazıldı ama tamamlanamadı".
    if (first) for (const fn of [...tgWrittenListeners]) { try { fn(chatRegistryId, ref); } catch { /* its own */ } }
    slot.clockAt = tgNow();
    const { clockAt: _c, ...entry } = slot;
    return { ref, entry: { ...entry }, body };
  },
  settle(chatRegistryId, ref) {
    if (tgRefs.get(chatRegistryId)?.get(ref)?.written) dropRef(chatRegistryId, ref);
  },
  onTelegramRefDropped(listener) {
    tgDropListeners.add(listener);
    return () => { tgDropListeners.delete(listener); };
  },
  onTelegramRefWritten(listener) {
    tgWrittenListeners.add(listener);
    return () => { tgWrittenListeners.delete(listener); };
  },
  has(chatRegistryId, ref) {
    return !!tgRefs.get(chatRegistryId)?.has(ref);
  },
  get(chatRegistryId, ref) {
    const slot = tgRefs.get(chatRegistryId)?.get(ref);
    if (!slot) return null;
    const { clockAt: _c, ...entry } = slot;
    return { ...entry };
  },
  forget(chatRegistryId, ref) {
    const map = tgRefs.get(chatRegistryId);
    if (!map?.get(ref) || map.get(ref)!.written) return;
    map.delete(ref);
    if (!map.size) tgRefs.delete(chatRegistryId);
  },
  _setNow(now) { tgNow = now; },
};
