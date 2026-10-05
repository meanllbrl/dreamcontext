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
}

export interface ChatEntry {
  sessionId: string;
  conversationId: string | null;
  vault: string;
  mode: string;
  title: string;
  status: ChatStatus;
  lastAssistantText: string[];
  pendingQuestion: PendingQuestion | null;
  updatedAt: string;
  /** The last sign of life: a stdout frame, a user frame written, an answer relayed. */
  lastFrameAt: string;
  /** Top-level tool calls asked for and not yet answered by a tool_result. */
  toolsInFlight: number;
  /** Set when the Assistant started this chat (a delegation). Rides the entry's own lifetime:
   *  a respawn of the same conversation inherits it via {@link isDelegatedConversation}. */
  origin?: 'assistant';
}

export interface ChatHandle {
  readonly sessionId: string;
  observe(frame: Record<string, unknown>): void;
  userSent(text: string): void;
  answered(requestId?: string): void;
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

const entries = new Map<string, ChatEntry>();
const waiters = new Map<string, Set<Waiter>>();
const deathTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** One change to a chat: a new status, or a new question replacing the pending one while
 *  the status stays `asking` (then `from` is `asking` too). */
export interface ChatChange { entry: ChatEntry; from: ChatStatus }
const listeners = new Set<(c: ChatChange) => void>();

/** Be told of every {@link ChatChange}. Returns the unsubscribe. A listener that throws is
 *  isolated — it never stops the registry or the other listeners. */
export function onChatChange(fn: (c: ChatChange) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function emit(e: ChatEntry, from: ChatStatus): void {
  for (const fn of [...listeners]) {
    try { fn({ entry: clone(e), from }); } catch { /* a listener's failure is its own */ }
  }
}

const cap = (s: string, n = TEXT_CAP) => (s.length > n ? `${s.slice(0, n)}…` : s);
const clone = (e: ChatEntry): ChatEntry => ({ ...e, lastAssistantText: [...e.lastAssistantText], pendingQuestion: e.pendingQuestion ? { ...e.pendingQuestion, options: [...e.pendingQuestion.options] } : null });

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
function assistantText(frame: Record<string, unknown>): string {
  const msg = frame.message as { content?: unknown } | undefined;
  if (!msg || !Array.isArray(msg.content)) return '';
  return msg.content
    .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
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

/** Read a `control_request{can_use_tool}` into a pending question. Unrecognised shapes
 *  return null (`pattern-unrecognized-shape-returns-null`). */
export function readPendingQuestion(frame: Record<string, unknown>): PendingQuestion | null {
  if (frame.type !== 'control_request') return null;
  const req = frame.request as Record<string, unknown> | undefined;
  if (!req || req.subtype !== 'can_use_tool' || typeof frame.request_id !== 'string') return null;
  const toolName = typeof req.tool_name === 'string' ? req.tool_name : 'tool';
  const input = (req.input && typeof req.input === 'object' ? req.input : {}) as Record<string, unknown>;
  if (toolName === 'AskUserQuestion') {
    const qs = Array.isArray(input.questions) ? input.questions as Array<Record<string, unknown>> : [];
    const first = qs[0] ?? {};
    const options = Array.isArray(first.options)
      ? (first.options as Array<Record<string, unknown>>).map((o) => (typeof o?.label === 'string' ? o.label : '')).filter(Boolean)
      : [];
    const text = qs.map((q) => (typeof q.question === 'string' ? q.question : '')).filter(Boolean).join('\n');
    return { requestId: frame.request_id, toolName, isPermission: false, text: cap(text, 600), options };
  }
  const described = typeof input.command === 'string' ? input.command
    : typeof input.file_path === 'string' ? input.file_path
      : typeof input.description === 'string' ? input.description : '';
  return { requestId: frame.request_id, toolName, isPermission: true, text: cap(described, 600), options: ['allow', 'deny'] };
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
export function registerChat(init: { sessionId: string; conversationId: string | null; vault: string; mode: string; origin?: 'assistant'; seed?: { title?: string; lastAssistantText?: string[] } }): ChatHandle {
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
  };
  entries.set(init.sessionId, e);
  let dead = false;
  const openTools = new Set<string>();
  const alive = () => { e.lastFrameAt = new Date().toISOString(); };
  const syncTools = () => { e.toolsInFlight = openTools.size; };

  return {
    sessionId: init.sessionId,
    observe(frame) {
      if (dead) return;
      alive();
      if (frame.type === 'system' && frame.subtype === 'init' && typeof frame.session_id === 'string') {
        e.conversationId = frame.session_id;
      }
      const q = readPendingQuestion(frame);
      if (q) {
        const prevRequestId = e.pendingQuestion?.requestId;
        const wasAsking = e.status === 'asking';
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
          e.lastAssistantText.push(cap(text));
          if (e.lastAssistantText.length > TEXT_RING) e.lastAssistantText.splice(0, e.lastAssistantText.length - TEXT_RING);
          e.updatedAt = new Date().toISOString();
        }
        return;
      }
      if (frame.type === 'result' && topLevel) {
        e.pendingQuestion = null;
        openTools.clear();
        syncTools();
        setStatus(e, 'idle');
      }
    },
    userSent(text) {
      if (dead) return;
      alive();
      if (!e.title && text.trim()) e.title = cap(text.trim().replace(/\s+/g, ' '), 80);
      setStatus(e, 'working');
    },
    answered(requestId) {
      if (dead) return;
      alive();
      if (!requestId || e.pendingQuestion?.requestId === requestId) e.pendingQuestion = null;
      if (e.status === 'asking') setStatus(e, 'working');
    },
    exited() {
      if (dead) return;
      dead = true;
      e.pendingQuestion = null;
      setStatus(e, 'gone');
      const t = setTimeout(() => {
        deathTimers.delete(init.sessionId);
        if (entries.get(init.sessionId) === e) entries.delete(init.sessionId);
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
  waiters.clear();
  deathTimers.clear();
  listeners.clear();
}
