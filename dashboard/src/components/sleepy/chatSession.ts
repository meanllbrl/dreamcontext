import { api, getActiveVault } from '../../api/client';
import { playAskChime } from '../../lib/chime';
import {
  parseChatLine, buildQuestionAnswer,
  type ChatEvent, type QuestionSpec, type ClientControl,
} from '../../lib/chatProtocol';
import type { TermStatus } from './agentSession';
import { runStatusFrom, type SubAgentRun } from './chat/chatEntities';

/**
 * The imperative engine behind a Chat session (beta) — the headless stream-json peer of
 * {@link createSession} (agentSession.ts). Where a terminal session bridges a WebSocket to
 * node-pty/xterm (raw bytes, no structure), a chat session bridges a WebSocket to a
 * headless `claude -p --output-format stream-json` process (typed NDJSON events, see
 * `lib/chatProtocol.ts` for the frame vocabulary) and reduces them into a
 * {@link ConversationModel} the chat UI renders from.
 *
 * Framework-free by design, mirroring agentSession.ts: this is a different cognitive layer
 * from the React orchestration in AgentSurface/ChatPane. Like a terminal session, a chat
 * session owns a DETACHED `container` — AgentSurface (wave 3) portals `<ChatPane>` into it
 * the same way it homes a terminal's xterm container, so the session survives becoming
 * minimized, moving between panes, and the overlay collapsing/expanding.
 *
 * ── Two notification channels ──────────────────────────────────────────────────────
 * `subscribe(cb)` fires on every APPLIED event (drives ChatPane's own re-render — including
 * a single streamed token) so the transcript feels live. The constructor's `notify`
 * parameter (`bumpStatus` in AgentSurface) fires only on a COARSE transition — busy, asking,
 * status, or attention flipping — exactly mirroring agentSession.ts's `markActivity`/
 * `onSettle` split, so per-token deltas never thrash the surface-level re-render (tabs, dock
 * chips, roster). Frames that translate to `{kind:'ignored'}` (hook chatter, status pings,
 * rate-limit events) touch neither channel — nothing changed, so nothing fires.
 *
 * ── Reducer notes ──────────────────────────────────────────────────────────────────
 * `content_block_start` for a `tool_use` block typically carries an EMPTY/partial `input`
 * (the real arguments stream via `input_json_delta`, which chatProtocol.ts deliberately
 * drops as noise — the chat UI doesn't need token-by-token JSON). The AUTHORITATIVE source
 * for a tool call's name+input is the `assistant` frame's full-message echo
 * (`assistant-tool-use`), which always carries the complete input. So a tool card opened by
 * `block-start` is a placeholder (status running, name possibly blank) that
 * `assistant-tool-use` upgrades in place — never a second card. `openBlocksByIndex` is keyed
 * by the raw stream index and is scoped to the CURRENT assistant message only: indices
 * restart at 0 for every new message (Claude Code emits `message_start`…`message_stop` per
 * turn-of-generation, and a tool round-trip can produce several messages within one logical
 * turn). Delta/stop events for an index we never saw start (a message boundary we didn't
 * observe) are dropped rather than throwing — same defensive posture as chatProtocol.ts.
 */

// ─── Conversation model ─────────────────────────────────────────────────────────────

export interface ChatUserItem {
  kind: 'user';
  id: string;
  text: string;
  ts: number;
  /** The message's transcript uuid (`~/.claude/projects/<slug>/<uuid>.jsonl` entry) — the
   *  rewind anchor. Present on history-seeded items immediately; backfilled onto live-sent
   *  items from the transcript after each turn (the protocol never echoes them back). */
  uuid?: string;
}
export interface ChatTextItem { kind: 'text'; id: string; index: number; text: string; done: boolean; ts: number }
export interface ChatThinkingItem { kind: 'thinking'; id: string; index: number; text: string; done: boolean; ts: number }
export interface ChatToolItem {
  kind: 'tool';
  id: string;
  toolUseId: string;
  name: string;
  input: unknown;
  parentToolUseId?: string;
  status: 'running' | 'done' | 'error';
  startedAt: number;
  endedAt?: number;
  result?: unknown;
}
/** One ordered item in the transcript: a user message, an assistant text/thinking block
 *  (streamed in place as deltas arrive), or a tool call card (opened by block-start/
 *  assistant-tool-use, closed by tool-result). Rendered top-to-bottom by ChatPane. */
export type ChatItem = ChatUserItem | ChatTextItem | ChatThinkingItem | ChatToolItem;

export interface PendingPermission {
  kind: 'permission';
  requestId: string;
  toolName: string;
  displayName?: string;
  input: unknown;
  description?: string;
  suggestions?: unknown[];
  toolUseId?: string;
}
export interface PendingQuestion {
  kind: 'question';
  requestId: string;
  toolName: string;
  questions: QuestionSpec[];
}
/** A permission prompt or AskUserQuestion card awaiting the user's answer, keyed by the
 *  control channel's `requestId`. `session.asking` is true whenever this array is non-empty. */
export type PendingItem = PendingPermission | PendingQuestion;

export interface ChatResultInfo {
  success: boolean;
  text?: string;
  costUsd?: number;
  usage?: Record<string, unknown>;
  numTurns?: number;
  permissionDenials?: unknown[];
}

/** The full reduced state of one chat conversation — what {@link ChatSession.getModel}
 *  returns and what ChatPane renders from. Immutable: every reducer step produces a NEW
 *  object (new top-level fields, new `items`/`pending` array references where changed) so a
 *  consumer holding a stale reference never sees it mutate out from under it. */
export interface ConversationModel {
  items: ChatItem[];
  /** Items replayed from the on-disk transcript when this session RESUMED an existing
   *  conversation (`--resume` never re-emits past frames, so without this a resumed chat
   *  opens blank). Kept SEPARATE from `items` so the async fetch can land at any time
   *  without shifting the positions `openBlocksByIndex`/`toolCardPos` recorded for live
   *  items. Rendered above `items` behind an "earlier conversation" divider. */
  history: ChatItem[];
  pending: PendingItem[];
  lastResult?: ChatResultInfo;
  /** Set by a `_meta/error` relay frame (e.g. the child failed to spawn). Not cleared
   *  automatically — a fresh `send()` naturally supersedes it once real output arrives. */
  lastError?: string;
  /** Composer draft text — `sendText` appends to it (skill-chip / file-path inserts); the
   *  composer itself owns clearing it on submit by calling `send()` then setting it back to
   *  '' is the CALLER's job (see `send`'s own draft-clear below) — ChatPane reads this to
   *  seed/restore the textarea when a session is minimized then reopened. */
  draft: string;
  /** Bumped whenever the SESSION (not the composer) replaces `draft` wholesale — today only
   *  a successful rewind, which prefills the rewound message for re-editing. The composer's
   *  textarea state is local (see ChatPane's composer note); it watches this epoch to know
   *  when to adopt `draft` instead of its own text. */
  draftEpoch: number;
  capabilities: string[];
  model?: string;
  permissionMode?: string;
  /** Every user-invocable slash command THIS session offers (no leading slash), as reported
   *  by `system:init` — built-ins, the project's own `.claude/commands/`, and plugin/skill
   *  commands. Feeds the composer's `/` autocomplete. Empty until the handshake lands. */
  slashCommands?: string[];
  /** How full the context window is, reduced from every assistant frame's `message.usage`
   *  (see chatProtocol's {@link TurnUsage}). The server's `/agent/session-stats` cannot
   *  supply this for a LIVE chat — Claude Code ≥2.1.x flushes the transcript only on
   *  exit/rotation — so the stream is the only source, and this is what the composer's
   *  meter reads. Undefined until the first turn reports usage. */
  context?: { used: number; limit: number; pct: number };
  /** Sub-agent runs reduced from the `task-started`/`task-updated`/`task-notification`
   *  ChatEvents (contract C7, state 9) — the ONLY channel that carries sub-agent activity:
   *  a dispatched sub-agent's own text/thinking is never streamed to the parent, and
   *  `parent_tool_use_id` never appears on a text/thinking content block (spike-verified).
   *  Rendered by `SubAgentCard`; the spawning tool's own `ChatToolItem` is suppressed by
   *  the UI via `subAgentToolUseIds` (chatEntities.ts), keyed by `toolUseId` — not by tool
   *  name, since the CLI streams the tool as `Agent` (aliased with `Task`). */
  subAgents: SubAgentRun[];
  /** When the CURRENT turn went in flight (`Date.now()` at the `busy` false→true edge, or
   *  at construction for a server-submitted prompt), cleared when it settles. `busy` alone
   *  says a turn is running; this says for how long — what the working indicator's elapsed
   *  readout reads while the transcript has nothing to show yet (the CLI can take seconds
   *  to spawn + run SessionStart hooks before its first frame). */
  turnStartedAt?: number;
  /** Set by the `meta-exit` relay frame (the child process actually exited) — distinct
   *  from a network drop (`ws.onclose`/`onerror`, which never populate this), so the UI
   *  can show a "Session ended" + Resume banner only for a real process exit. */
  exited?: { code: number | null };
  /** The CLI reported it has no usable credentials, so the turn never reached the API
   *  (chatProtocol's `auth-required`). Carries the CLI's own notice text. Never cleared in
   *  place: signing in happens in ANOTHER session (the interactive TUI — chat cannot run the
   *  OAuth flow), and the recovery path is respawning this conversation, which builds a fresh
   *  model. See ChatPane's SignInBanner. */
  authRequired?: { text: string };
}

// ─── Public session API (contract C4) ──────────────────────────────────────────────

export interface ChatSession {
  id: string;
  bypass: boolean;
  kind: 'chat';
  /** The Claude conversation UUID — mirrors agentSession.ts's Session.claudeId: set at
   *  construction, never re-derived from the server's `init` frame (which may differ only
   *  when a fresh-pin fallback occurred, exactly like the terminal). */
  claudeId: string;
  container: HTMLDivElement;
  status: TermStatus;
  /** True once the `system:init` handshake has been observed (distinct from the terminal's
   *  DOM-mount meaning of `opened` — chat has no DOM-open step; the portal mount IS "open"). */
  opened: boolean;
  busy: boolean;
  asking: boolean;
  attention: boolean;
  minimized: boolean;
  capabilities: string[];
  model: string;
  effort: string;
  ensureOpen: () => void;
  fitAndResize: () => void;
  applyZoom: (zoom: number) => void;
  /** Append text to the composer draft WITHOUT submitting (skill trigger / dropped file
   *  path) — mirrors agentSession.ts's terminal `sendText`, but there is no PTY to write
   *  into: this appends to `ConversationModel.draft` and bumps `draftEpoch` so the
   *  composer's textarea adopts the appended value (see {@link ChatSession.syncDraft}). */
  sendText: (data: string) => void;
  /** Mirror the composer's CURRENT textarea content into `ConversationModel.draft` on
   *  every keystroke. Free typing is composer-local state; without this mirror, an
   *  external `sendText` (file drop, page-level skill insert) would append to a STALE
   *  model draft and the epoch adoption would clobber what the user had typed. */
  syncDraft: (text: string) => void;
  /** Focus the composer's input element, if `setFocusTarget` has registered one (a no-op
   *  before the pane mounts, or after it unmounts — same as focusing a not-yet-open
   *  terminal). See {@link ChatSession.setFocusTarget} for why this is a ref-registration
   *  rather than a DOM CustomEvent on `container`. */
  focus: () => void;
  dispose: () => void;
  /** Fires on EVERY applied event (including a single streamed token) — drives ChatPane's
   *  live re-render. Returns an unsubscribe function. */
  subscribe: (cb: () => void) => () => void;
  /** The current reduced conversation state (a fresh object per mutating event — see
   *  {@link ConversationModel}'s header note). */
  getModel: () => ConversationModel;
  /** Submit a user message: sends the `user` control frame and appends it to the
   *  transcript optimistically (the protocol never echoes the user's own text back). */
  send: (text: string) => void;
  /** Answer a pending permission request (or a plain non-question `can_use_tool` prompt). */
  answer: (requestId: string, opts: { behavior: 'allow' | 'deny'; updatedInput?: unknown; message?: string }) => void;
  /** Answer a pending AskUserQuestion card — builds the load-bearing `{questions, answers}`
   *  updatedInput shape via `buildQuestionAnswer` and allows it. */
  answerQuestion: (requestId: string, questions: QuestionSpec[], picked: Record<string, string>) => void;
  /** Ask the server to interrupt the in-flight turn (Stop button while busy). */
  interrupt: () => void;
  /** Live model switch (`set_model` control request — verified on CLI 2.1.218). Applies to
   *  the NEXT turn; the CLI re-emits `system:init` with the new model, which updates
   *  `session.model`/`conv.model`, and the `control-ack` confirms or surfaces an error. */
  setModel: (model: string) => void;
  /** Live effort switch (a `/effort <level>` user frame — no effort control request exists
   *  on 2.1.218). The CLI answers with a synthetic "Set effort level to <level>" bubble. */
  setEffort: (level: string) => void;
  /** Flip THIS running conversation between Auto (`acceptEdits`) and Bypass
   *  (`bypassPermissions`) without restarting it — a `set_permission_mode` control request
   *  (present on CLI 2.1.220's headless engine; the CLI validates the mode string and acks).
   *
   *  `onFail` fires when the switch demonstrably did NOT land: the socket is closed, or the
   *  CLI rejected the request (an older CLI that never registered the handler answers
   *  "set_permission_mode is not supported in this context"). The caller's fallback is to
   *  respawn this SAME conversation id with `--resume` under the new mode — see
   *  AgentSurface's `changeChatPermissionMode`. It is never called on success, so a caller
   *  that respawns unconditionally would be throwing away a working live switch. */
  setPermissionMode: (mode: 'auto' | 'bypass', onFail?: () => void) => void;
  /** Stop a background shell (`stop_task` control request — verified on CLI 2.1.220). Costs
   *  no model tokens: the CLI kills the child itself and reports it on the roster/task frames
   *  this session already reduces, so the tray updates from the CLI's own account of what
   *  happened rather than from an optimistic local edit. No completion callback, because the
   *  CLI's ack is not evidence — it answers success even for an unknown task id. */
  stopTask: (taskId: string) => void;
  /** Rewind the conversation to just BEFORE this user item (transcript-uuid anchored;
   *  fetches/refreshes the uuid mapping first if the item hasn't one yet). On success the
   *  transcript truncates locally and the rewound message prefills the composer draft —
   *  UNLESS `asRetry` is true (contract C7; see {@link ChatSession.retry}), in which case
   *  the prefill is resent immediately instead of being left in the composer for the user
   *  to re-edit. CONVERSATION-ONLY: files changed after that point are NOT restored. */
  rewind: (itemId: string, asRetry?: boolean) => Promise<void>;
  /** Retry an assistant turn (state 11's hover ⟳ Retry): rewinds to just before the
   *  message's immediately preceding user item and immediately resends its text — a
   *  rewind-and-resend, not a plain rewind. Internally `rewind(userItemId, true)`
   *  (contract C7); a no-op if no preceding user item exists (e.g. the very first turn,
   *  or the assistant item id is unknown). */
  retry: (assistantItemId: string) => Promise<void>;
  /** Session-scoped "Always allow this session" (state 6's permission card checkbox):
   *  every future permission request for this EXACT tool name auto-allows without ever
   *  pushing a card. Client-side only — no protocol change. Never applies to an
   *  AskUserQuestion `question` event, which is parsed as a wholly distinct `ChatEvent`
   *  kind and never reaches the `permission-request` gate this consults. */
  alwaysAllow: (toolName: string) => void;
  clearAttention: () => void;
  /** Register (or clear, with `null`) the composer's focusable element so `focus()` has a
   *  target. Chosen over dispatching a CustomEvent on `container`: `container` isn't
   *  guaranteed to be attached to the document when `focus()` is called (a minimized chat's
   *  container lives in the garage), and a DOM event needs a listener wired on mount anyway
   *  — a plain ref-registration hook is simpler, type-safe, and needs no event bus. */
  setFocusTarget: (el: HTMLElement | null) => void;
}

// ─── Session factory ────────────────────────────────────────────────────────────────

let chatSessionSeq = 0;

/**
 * `promptToken`/`initialPrompt`/`deferPrompt` mirror agentSession.ts's `createSession`
 * exactly (AC3 parity — a chat session can be delegated to with a large prompt the same way
 * a terminal agent can): `promptToken` wins over an inline `initialPrompt` when both are
 * set, and `deferPrompt` only matters when a prompt exists at all. Chat has no PTY readline,
 * so unlike the terminal's client-side "type without submit" fallback, an initial prompt is
 * ALWAYS delivered server-side (submitted as the first user frame, or parked for the
 * UserPromptSubmit hook when deferred) — there is no client-side injection path here.
 */
export function createChatSession(
  bypass: boolean,
  notify: () => void,
  claudeId: string,
  resume = false,
  model = '',
  effort = '',
  initialPrompt = '',
  promptToken = '',
  deferPrompt = false,
): ChatSession {
  const id = `chat-${++chatSessionSeq}`;
  const container = document.createElement('div');
  container.className = 'agent-pane-chat';

  // ── WS URL (contract C2) — same param conventions as agentSession.ts:268-305, plus
  //    `effort` (chat sets it at spawn via `--effort`; the terminal only ever switches it
  //    live via `/effort`, so it never appears in the terminal's own URL builder). ──
  const vault = getActiveVault();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const idParam = resume ? `&resume=${encodeURIComponent(claudeId)}` : `&sessionId=${encodeURIComponent(claudeId)}`;
  const modelParam = model ? `&model=${encodeURIComponent(model)}` : '';
  const effortParam = effort ? `&effort=${encodeURIComponent(effort)}` : '';
  const bypassParam = bypass ? '1' : '0';
  const serverSubmitsPrompt = !!initialPrompt || !!promptToken;
  const promptParam = !serverSubmitsPrompt
    ? ''
    : promptToken
      ? `&promptToken=${encodeURIComponent(promptToken)}`
      : `&prompt=${encodeURIComponent(initialPrompt)}`;
  const deferParam = serverSubmitsPrompt && deferPrompt ? '&deferPrompt=1' : '';
  const url = `${proto}://${location.host}/api/agent/chat?vault=${encodeURIComponent(vault ?? '')}`
    + `&bypass=${bypassParam}${idParam}${modelParam}${effortParam}${promptParam}${deferParam}`;
  const ws = new WebSocket(url);

  let itemSeq = 0;
  const nextItemId = () => `item-${++itemSeq}`;
  // Position in `conv.items` of the block currently streaming at a given raw stream index.
  // Cleared on block-stop — index numbering restarts at 0 for every new assistant message,
  // so a stale entry must never survive into the next message's block-start.
  const openBlocksByIndex = new Map<number, number>();
  // toolUseId -> position in `conv.items`, so tool-result / assistant-tool-use (which key by
  // toolUseId, not stream index) can find and update the card in O(1) regardless of which
  // frame created it first.
  const toolCardPos = new Map<string, number>();

  // Control requests THIS client sent and is awaiting a control-ack for, keyed by the
  // client-generated request id (contract: the server echoes it into the CLI frame).
  let ctrlSeq = 0;
  const pendingRewinds = new Map<string, string>(); // requestId -> user item id
  const pendingModels = new Map<string, string>();  // requestId -> requested model
  // requestId -> the requested permission mode + the caller's respawn fallback, run only if
  // the CLI rejects the switch (see ChatSession.setPermissionMode).
  const pendingModes = new Map<string, { mode: 'auto' | 'bypass'; onFail?: () => void }>();
  // requestIds from `rewind(itemId, true)` (i.e. called by `retry`) — a matching ack must
  // truncate-then-resend instead of leaving the prefill sitting in the composer (C7).
  const pendingRetries = new Set<string>();
  // "Always allow this session" (state 6) — tool names the user has session-scoped
  // auto-allowed; consulted ONLY by the `permission-request` reducer arm.
  const sessionAllow = new Set<string>();

  let conv: ConversationModel = {
    items: [], history: [], pending: [], draft: '', draftEpoch: 0, capabilities: [], subAgents: [],
    // A server-submitted prompt (delegation, promptToken, sleep/brain spawns) means a turn is
    // ALREADY in flight before this client sends anything — see `busy` below.
    turnStartedAt: serverSubmitsPrompt ? Date.now() : undefined,
  };

  const subscribers = new Set<() => void>();
  const fireSubscribers = () => {
    subscribers.forEach((cb) => { try { cb(); } catch { /* a broken subscriber must not kill the session */ } });
  };

  let focusTarget: HTMLElement | null = null;
  let disposed = false;

  const session: ChatSession = {
    id, bypass, kind: 'chat', claudeId, container,
    status: 'connecting',
    opened: false,
    // Busy from the first instant when the SERVER submits the opening prompt: the turn is
    // running before any frame arrives, so the working indicator, the dock chip and the
    // "don't inject into a busy session" guards must all see it (a spawn with no prompt
    // stays idle — it is genuinely waiting for the user).
    busy: serverSubmitsPrompt, asking: false, attention: false, minimized: false,
    capabilities: [],
    model,
    effort,
    ensureOpen: () => { /* no DOM-open step — the AgentSurface portal mount IS "open" */ },
    fitAndResize: () => { /* no terminal grid to refit */ },
    applyZoom,
    sendText,
    syncDraft,
    focus: () => { focusTarget?.focus(); },
    dispose,
    subscribe,
    getModel: () => conv,
    send,
    answer,
    answerQuestion,
    interrupt,
    setModel,
    setEffort,
    setPermissionMode,
    stopTask,
    rewind,
    retry,
    alwaysAllow,
    clearAttention,
    setFocusTarget: (el) => { focusTarget = el; },
  };

  // ── Coarse-transition notification (see file header) ──────────────────────────────
  function snapshot() {
    return { busy: session.busy, asking: session.asking, status: session.status, attention: session.attention };
  }
  function applyAndNotify(mutate: () => void): void {
    const before = snapshot();
    mutate();
    // The turn clock starts on the busy edge and stops when the turn settles. Derived here
    // rather than in each reducer arm so EVERY path that flips busy (send, block-start, an
    // assistant frame with no deltas, result, exit, error, socket close) gets it for free.
    if (before.busy !== session.busy) {
      conv = { ...conv, turnStartedAt: session.busy ? Date.now() : undefined };
    }
    fireSubscribers();
    const after = snapshot();
    if (before.busy !== after.busy || before.asking !== after.asking
      || before.status !== after.status || before.attention !== after.attention) {
      notify();
    }
  }

  function subscribe(cb: () => void): () => void {
    subscribers.add(cb);
    return () => { subscribers.delete(cb); };
  }

  function applyZoom(zoom: number): void {
    try { container.style.setProperty('--chat-zoom', String(zoom > 0 ? zoom : 1)); } catch { /* detached */ }
  }

  function sendText(data: string): void {
    if (!data) return;
    // Bumping draftEpoch makes the composer ADOPT the appended draft — an external insert
    // (file drop, page-level skill chip) reaches the visible textarea, not just the model.
    // Safe because `syncDraft` keeps the model mirroring the textarea on every keystroke,
    // so append-then-adopt can never lose free-typed text.
    conv = { ...conv, draft: conv.draft + data, draftEpoch: conv.draftEpoch + 1 };
    fireSubscribers();
  }

  function syncDraft(text: string): void {
    // Mirror only — no subscriber fire (a per-keystroke transcript re-render buys nothing)
    // and no epoch bump (the textarea already shows this text; adoption would be a no-op).
    conv = { ...conv, draft: text };
  }

  /** Which context window the running model has. Mirrors the server's rule
   *  (agent-terminal.ts's `computeSessionStats`): 200K unless the model id carries the `1m`
   *  marker, and promoted to 1M the moment the observed footprint outgrows 200K — a session
   *  cannot be at 130% of its window, so exceeding it IS the evidence of the larger one. */
  function contextLimitFor(usedTokens: number, modelId: string | undefined): number {
    return /1m/i.test(modelId ?? '') || usedTokens > 200_000 ? 1_000_000 : 200_000;
  }

  // ── Reducer: one parsed ChatEvent → conversation model + derived-state mutation ────
  function applyEvent(ev: ChatEvent): void {
    // Every assistant frame restates the whole turn's token footprint, so the LAST one to
    // arrive is how full the window is right now — reduced here, before the per-kind arms,
    // so all three assistant event kinds feed the meter without repeating themselves.
    const usage = 'turnUsage' in ev ? ev.turnUsage : undefined;
    if (usage) {
      const limit = contextLimitFor(usage.total, usage.model ?? session.model);
      conv = { ...conv, context: { used: usage.total, limit, pct: Math.min(100, Math.round((usage.total / limit) * 100)) } };
    }
    switch (ev.kind) {
      case 'init': {
        session.opened = true;
        if (ev.capabilities) session.capabilities = ev.capabilities;
        if (ev.model) session.model = ev.model;
        conv = {
          ...conv,
          capabilities: ev.capabilities ?? conv.capabilities,
          model: ev.model ?? conv.model,
          permissionMode: ev.permissionMode ?? conv.permissionMode,
          // Kept from the PREVIOUS init if this one omits it: the CLI re-emits `system:init`
          // after a live `set_model`, and dropping the command list on that re-emit would
          // silently kill the composer's `/` menu mid-conversation.
          slashCommands: ev.slashCommands ?? conv.slashCommands,
        };
        return;
      }
      case 'slash-commands': {
        // The server's cached list, replayed at connect. A real `init` later in this stream
        // carries the same field and overwrites it — same source either way.
        conv = { ...conv, slashCommands: ev.commands };
        return;
      }
      case 'block-start': {
        session.busy = true;
        if (ev.blockType === 'text') {
          const item: ChatTextItem = { kind: 'text', id: nextItemId(), index: ev.index, text: '', done: false, ts: Date.now() };
          openBlocksByIndex.set(ev.index, conv.items.length);
          conv = { ...conv, items: [...conv.items, item] };
        } else if (ev.blockType === 'thinking') {
          const item: ChatThinkingItem = { kind: 'thinking', id: nextItemId(), index: ev.index, text: '', done: false, ts: Date.now() };
          openBlocksByIndex.set(ev.index, conv.items.length);
          conv = { ...conv, items: [...conv.items, item] };
        } else if (ev.blockType === 'tool_use') {
          // Authoritative name/input arrives via `assistant-tool-use` (see file header) —
          // this only opens a running placeholder if one doesn't already exist.
          const toolUseId = ev.toolUseId ?? nextItemId();
          const existingPos = toolCardPos.get(toolUseId);
          if (existingPos === undefined) {
            const item: ChatToolItem = {
              kind: 'tool', id: nextItemId(), toolUseId, name: ev.toolName ?? '', input: ev.toolInput,
              parentToolUseId: ev.parentToolUseId, status: 'running', startedAt: Date.now(),
            };
            openBlocksByIndex.set(ev.index, conv.items.length);
            toolCardPos.set(toolUseId, conv.items.length);
            conv = { ...conv, items: [...conv.items, item] };
          } else {
            openBlocksByIndex.set(ev.index, existingPos);
          }
        }
        return;
      }
      case 'text-delta':
      case 'thinking-delta': {
        const pos = openBlocksByIndex.get(ev.index);
        if (pos === undefined) return; // delta for a block we never saw start — drop safely
        const items = conv.items.slice();
        const cur = items[pos];
        if (cur && (cur.kind === 'text' || cur.kind === 'thinking')) {
          items[pos] = { ...cur, text: cur.text + ev.text };
          conv = { ...conv, items };
        }
        return;
      }
      case 'block-stop': {
        const pos = openBlocksByIndex.get(ev.index);
        openBlocksByIndex.delete(ev.index);
        if (pos === undefined) return;
        const items = conv.items.slice();
        const cur = items[pos];
        if (cur && (cur.kind === 'text' || cur.kind === 'thinking')) {
          items[pos] = { ...cur, done: true };
          conv = { ...conv, items };
        }
        return;
      }
      case 'assistant-tool-use': {
        session.busy = true;
        const existingPos = toolCardPos.get(ev.toolUseId);
        if (existingPos !== undefined) {
          const items = conv.items.slice();
          const cur = items[existingPos];
          if (cur && cur.kind === 'tool') {
            items[existingPos] = { ...cur, name: ev.name, input: ev.input, parentToolUseId: ev.parentToolUseId ?? cur.parentToolUseId };
            conv = { ...conv, items };
          }
        } else {
          const item: ChatToolItem = {
            kind: 'tool', id: nextItemId(), toolUseId: ev.toolUseId, name: ev.name, input: ev.input,
            parentToolUseId: ev.parentToolUseId, status: 'running', startedAt: Date.now(),
          };
          toolCardPos.set(ev.toolUseId, conv.items.length);
          conv = { ...conv, items: [...conv.items, item] };
        }
        return;
      }
      case 'assistant-text':
      case 'assistant-thinking': {
        // The authoritative full-block echo (see chatProtocol.ts's fromAssistant note): the
        // CLI can emit NO deltas at all for a short block, so the still-streaming item is
        // upgraded to the complete text here. If no item of this kind is open (a synthetic
        // local-command reply, or a spawn without partial messages), append a finished one —
        // unless the last finished item of this kind already carries this exact text (the
        // echo raced AFTER block-stop; appending would duplicate the streamed bubble).
        const kind = ev.kind === 'assistant-text' ? 'text' : 'thinking';
        if (!(ev.kind === 'assistant-text' && ev.synthetic)) session.busy = true;
        let pos = -1;
        for (let i = conv.items.length - 1; i >= 0; i--) {
          const it = conv.items[i];
          if (it.kind === kind) { pos = it.done ? -1 : i; break; }
        }
        if (pos >= 0) {
          const items = conv.items.slice();
          const cur = items[pos] as ChatTextItem | ChatThinkingItem;
          items[pos] = { ...cur, text: ev.text };
          conv = { ...conv, items };
        } else {
          const last = [...conv.items].reverse().find((it) => it.kind === kind);
          if (last && (last as ChatTextItem | ChatThinkingItem).text === ev.text) return;
          const item: ChatTextItem | ChatThinkingItem = {
            kind, id: nextItemId(), index: -1, text: ev.text, done: true, ts: Date.now(),
          };
          conv = { ...conv, items: [...conv.items, item] };
        }
        return;
      }
      case 'auth-required': {
        // The turn is OVER — it never reached the API. The CLI does send a `result` frame
        // after this one, but clearing busy here too keeps the working indicator from
        // outliving a turn that already failed if that frame is ever dropped. The notice text
        // itself is NOT appended as an assistant bubble: it names a command this surface can't
        // run, so it would read as advice that doesn't work. The banner says what to do
        // instead.
        session.busy = false;
        conv = { ...conv, authRequired: { text: ev.text } };
        return;
      }
      case 'control-ack': {
        applyControlAck(ev);
        return;
      }
      case 'task-started': {
        // A dispatched sub-agent (state 9) — the ONLY frame that carries its start (its
        // own text/thinking is never streamed to the parent; see the file header note).
        session.busy = true;
        const run: SubAgentRun = {
          taskId: ev.taskId,
          toolUseId: ev.toolUseId,
          name: ev.description,
          subagentType: ev.subagentType,
          taskType: ev.taskType,
          prompt: ev.prompt,
          status: 'running',
          startedAt: Date.now(),
        };
        conv = { ...conv, subAgents: [...conv.subAgents, run] };
        return;
      }
      case 'task-updated': {
        const idx = conv.subAgents.findIndex((r) => r.taskId === ev.taskId);
        if (idx === -1) return; // a status patch for a task we never saw start — drop safely
        const runs = conv.subAgents.slice();
        const cur = runs[idx];
        const status = runStatusFrom(ev.status, cur.status);
        runs[idx] = {
          ...cur,
          status,
          // A run that just reached a terminal state needs an end time even when the frame
          // omitted one, or its duration would keep ticking after it stopped.
          endedAt: ev.endTime ?? cur.endedAt ?? (status !== 'running' ? Date.now() : undefined),
        };
        conv = { ...conv, subAgents: runs };
        return;
      }
      case 'task-progress': {
        // The live heartbeat: what the run is doing now + running usage totals. Its
        // `activity` NEVER touches `name` — the row's title is what the task was dispatched
        // as, not the step it happens to be on.
        const idx = conv.subAgents.findIndex((r) => r.taskId === ev.taskId);
        if (idx === -1) return; // progress for a task we never saw start — drop safely
        const runs = conv.subAgents.slice();
        const cur = runs[idx];
        runs[idx] = {
          ...cur,
          toolUseId: cur.toolUseId ?? ev.toolUseId,
          subagentType: cur.subagentType ?? ev.subagentType,
          activity: ev.activity ?? cur.activity,
          lastToolName: ev.lastToolName ?? cur.lastToolName,
          summary: ev.summary ?? cur.summary,
          usage: ev.usage ?? cur.usage,
        };
        conv = { ...conv, subAgents: runs };
        return;
      }
      case 'task-notification': {
        // Final (or progress) report for a sub-agent run: status, summary, usage.
        // `outputFile` is deliberately NOT consumed here (contract C7) — the drill-in
        // transcript is fetched via the server-derived `?subagent=` history route, never
        // from this client-visible path.
        const idx = conv.subAgents.findIndex((r) => r.taskId === ev.taskId);
        if (idx === -1) return;
        const runs = conv.subAgents.slice();
        const cur = runs[idx];
        runs[idx] = {
          ...cur,
          toolUseId: cur.toolUseId ?? ev.toolUseId,
          status: runStatusFrom(ev.status, cur.status),
          summary: ev.summary ?? cur.summary,
          usage: ev.usage ?? cur.usage,
          endedAt: cur.endedAt ?? Date.now(),
        };
        conv = { ...conv, subAgents: runs };
        return;
      }
      case 'background-tasks': {
        // The CLI's authoritative roster of shells STILL RUNNING. Two jobs, and neither is
        // "replace the list" — the roster carries no terminal state and drops a task the
        // moment it ends, so treating it as the source of truth would delete every finished
        // shell (and its still-readable output) from the tray.
        //
        //   1. Adopt a shell we never saw start (its `task_started` was missed, or the
        //      conversation was resumed into a live roster).
        //   2. Reconcile a shell that VANISHED from the roster without ever sending a
        //      terminal frame — reaped with the process, say. Left alone it would spin as
        //      "running" forever, which is the same class of bug as the killed-status
        //      fall-through this arm's `runStatusFrom` fixed.
        const live = new Set(ev.tasks.map((t) => t.taskId));
        const known = new Set(conv.subAgents.map((r) => r.taskId));
        const adopted: SubAgentRun[] = ev.tasks
          .filter((t) => !known.has(t.taskId))
          .map((t) => ({
            taskId: t.taskId,
            name: t.description ?? 'Background shell',
            taskType: t.taskType ?? 'local_bash',
            status: 'running' as const,
            startedAt: Date.now(),
          }));
        const reconciled = conv.subAgents.map((r) => (
          // Only ever a SHELL, and only one this roster could have spoken for: an agent run
          // is not tracked here at all, so its absence says nothing.
          r.status === 'running' && r.taskType === 'local_bash' && !live.has(r.taskId)
            ? { ...r, status: 'stopped' as const, endedAt: r.endedAt ?? Date.now() }
            : r
        ));
        if (adopted.length === 0 && reconciled.every((r, i) => r === conv.subAgents[i])) return;
        conv = { ...conv, subAgents: [...reconciled, ...adopted] };
        return;
      }
      case 'tool-result': {
        const pos = toolCardPos.get(ev.toolUseId);
        const cur = pos !== undefined ? conv.items[pos] : undefined;
        if (cur && cur.kind === 'tool') {
          const items = conv.items.slice();
          items[pos!] = { ...cur, status: ev.isError ? 'error' : 'done', result: ev.content, endedAt: Date.now() };
          conv = { ...conv, items };
        } else {
          // A result with no known card (shouldn't happen per the spike's observed frame
          // ordering, but never silently drop a result) — surface a minimal closed card.
          const item: ChatToolItem = {
            kind: 'tool', id: nextItemId(), toolUseId: ev.toolUseId, name: '', input: undefined,
            status: ev.isError ? 'error' : 'done', startedAt: Date.now(), endedAt: Date.now(), result: ev.content,
          };
          toolCardPos.set(ev.toolUseId, conv.items.length);
          conv = { ...conv, items: [...conv.items, item] };
        }
        // Sub-agent correlation (state 9): the spawning tool's own final tool-result is
        // keyed by `toolUseId`, same as any other tool — stamp it onto the matching run
        // too, best-effort (the notification's `summary` already carries the human-facing
        // outcome; this is the raw content for the drill-in's degrade path).
        //
        // The frame's `tool_use_result` sibling rides along here as `agentResult`, and it is
        // the ONLY carrier of the run's model. It arrives on BOTH dispatch modes: for a
        // backgrounded agent (the default) it lands right after `task_started`, so the row
        // gets its model while the run is still going; for a synchronous one it lands at the
        // end with the full accounting. `agentId` is the same value as `task_id`, which is
        // what lets a result find its run even when the tool_use_id didn't match.
        const agentId = ev.agentResult?.agentId;
        const subIdx = conv.subAgents.findIndex((r) => (
          (!!ev.toolUseId && r.toolUseId === ev.toolUseId) || (!!agentId && r.taskId === agentId)
        ));
        if (subIdx !== -1) {
          const runs = conv.subAgents.slice();
          const cur = runs[subIdx];
          const res = ev.agentResult;
          runs[subIdx] = {
            ...cur,
            resultContent: ev.content,
            model: res?.resolvedModel ?? cur.model,
            modelsUsed: res?.modelsUsed ?? cur.modelsUsed,
            // Only the `completed` shape carries totals, and a live `task-progress` frame may
            // already have reported further — so each field defers to whatever is already
            // known rather than overwriting it with an absent value.
            usage: res && (res.totalTokens != null || res.totalToolUseCount != null || res.totalDurationMs != null)
              ? {
                totalTokens: res.totalTokens ?? cur.usage?.totalTokens,
                toolUses: res.totalToolUseCount ?? cur.usage?.toolUses,
                durationMs: res.totalDurationMs ?? cur.usage?.durationMs,
              }
              : cur.usage,
          };
          conv = { ...conv, subAgents: runs };
        }
        return;
      }
      case 'permission-request': {
        if (sessionAllow.has(ev.toolName)) {
          // "Always allow this session" (state 6) — auto-answer, no card ever pushed.
          // This gate lives ONLY on this arm: a `question` event is a structurally
          // distinct ChatEvent kind (its own case below) and never reaches here.
          answer(ev.requestId, { behavior: 'allow', updatedInput: ev.input });
          return;
        }
        const pending = conv.pending.filter((p) => p.requestId !== ev.requestId);
        const entry: PendingPermission = {
          kind: 'permission', requestId: ev.requestId, toolName: ev.toolName, displayName: ev.displayName,
          input: ev.input, description: ev.description, suggestions: ev.suggestions, toolUseId: ev.toolUseId,
        };
        conv = { ...conv, pending: [...pending, entry] };
        session.asking = conv.pending.length > 0;
        return;
      }
      case 'question': {
        // Attention/chime fire only on a FRESH question edge (0 pending questions -> 1+) —
        // deliberately narrower than `asking` (which any pending permission also sets): a
        // permission prompt is common in acceptEdits mode and would make the chime noisy;
        // AskUserQuestion is the "the strongest 'needs you' there is" signal (AC5).
        const hadQuestionBefore = conv.pending.some((p) => p.kind === 'question');
        const pending = conv.pending.filter((p) => p.requestId !== ev.requestId);
        const entry: PendingQuestion = { kind: 'question', requestId: ev.requestId, toolName: ev.toolName, questions: ev.questions };
        conv = { ...conv, pending: [...pending, entry] };
        session.asking = conv.pending.length > 0;
        if (!hadQuestionBefore) {
          session.attention = true;
          playAskChime();
        }
        return;
      }
      case 'result': {
        conv = {
          ...conv,
          lastResult: { success: ev.success, text: ev.text, costUsd: ev.costUsd, usage: ev.usage, numTurns: ev.numTurns, permissionDenials: ev.permissionDenials },
        };
        session.busy = false;
        // Finished while minimized (not looking at it) -> flag the dock's attention badge,
        // mirroring agentSession.ts's onSettle (no chime here — only a fresh question chimes).
        if (session.minimized && !session.attention) session.attention = true;
        return;
      }
      case 'prompt-echo': {
        // The server auto-submitted an opening prompt for us (sleep / brain-resolve /
        // delegate). Render it as the first user message so the transcript shows what the
        // agent was actually asked — chat has no visible readline the way the terminal does,
        // so without this the run looks like it started from nothing. Idempotent: a repeat
        // echo (reconnect) that matches the item we already hold is dropped rather than
        // stacking a duplicate bubble.
        const last = conv.items[conv.items.length - 1];
        if (last?.kind === 'user' && last.text === ev.text) return;
        const echoed: ChatUserItem = { kind: 'user', id: nextItemId(), text: ev.text, ts: Date.now() };
        conv = { ...conv, items: [...conv.items, echoed] };
        // The turn is already in flight server-side — keep the working indicator honest even
        // if the CLI's first frame is still seconds away (hooks, spawn).
        session.busy = true;
        return;
      }
      case 'meta-exit': {
        session.busy = false;
        // Distinguishes a real process exit from a network drop (ws.onclose/onerror never
        // set this) so the Session-ended banner shows only for the former.
        conv = { ...conv, exited: { code: ev.code } };
        return;
      }
      case 'meta-error': {
        // Also clears busy (beyond the literal "result/meta-exit" wording) — leaving busy
        // stuck true on a spawn/relay error would strand the composer disabled forever.
        session.busy = false;
        conv = { ...conv, lastError: ev.message };
        return;
      }
      case 'ignored':
      default:
        return;
    }
  }

  ws.onopen = () => { applyAndNotify(() => { session.status = 'open'; }); };
  ws.onmessage = (e) => {
    const raw = typeof e.data === 'string' ? e.data : '';
    if (!raw) return;
    const ev = parseChatLine(raw);
    // Noise (hook chatter, status pings, rate-limit events) and unparseable lines touch
    // neither notification channel — nothing changed, so nothing re-renders.
    if (!ev || ev.kind === 'ignored') return;
    applyAndNotify(() => applyEvent(ev));
    // The turn just flushed to the transcript — backfill rewind-anchor uuids while idle.
    if (ev.kind === 'result') void syncTranscriptUuids();
  };
  const stopOnClose = () => {
    applyAndNotify(() => { session.busy = false; session.asking = false; session.status = 'closed'; });
  };
  ws.onclose = stopOnClose;
  ws.onerror = stopOnClose;

  function send(text: string): void {
    const clean = text.trim();
    if (!clean || ws.readyState !== WebSocket.OPEN) return;
    const frame: ClientControl = { type: 'user', text: clean };
    try { ws.send(JSON.stringify(frame)); } catch { return; }
    applyAndNotify(() => {
      const item: ChatUserItem = { kind: 'user', id: nextItemId(), text: clean, ts: Date.now() };
      conv = { ...conv, items: [...conv.items, item], draft: '' };
      session.busy = true;
    });
  }

  function answer(requestId: string, opts: { behavior: 'allow' | 'deny'; updatedInput?: unknown; message?: string }): void {
    if (ws.readyState === WebSocket.OPEN) {
      const frame: ClientControl = { type: 'answer', requestId, behavior: opts.behavior, updatedInput: opts.updatedInput, message: opts.message };
      try { ws.send(JSON.stringify(frame)); } catch { /* best-effort — the request stays pending server-side */ }
    }
    // Optimistic local removal: the protocol has no explicit "answer accepted" ack frame.
    applyAndNotify(() => {
      conv = { ...conv, pending: conv.pending.filter((p) => p.requestId !== requestId) };
      session.asking = conv.pending.length > 0;
    });
  }

  function answerQuestion(requestId: string, questions: QuestionSpec[], picked: Record<string, string>): void {
    answer(requestId, { behavior: 'allow', updatedInput: buildQuestionAnswer(questions, picked) });
  }

  function interrupt(): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify({ type: 'interrupt' } as ClientControl)); } catch { /* best-effort */ }
  }

  // ── Live model / effort switches ────────────────────────────────────────────────────
  function sendControl(frame: ClientControl): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    try { ws.send(JSON.stringify(frame)); return true; } catch { return false; }
  }

  function setModel(model: string): void {
    if (!model) return;
    const requestId = `sm-${id}-${++ctrlSeq}`;
    // Registered before the send, for the same reason as `setPermissionMode` above.
    pendingModels.set(requestId, model);
    if (!sendControl({ type: 'setModel', requestId, model })) pendingModels.delete(requestId);
  }

  /** Stop a background shell. Fire-and-forget by design: the CLI acks `success` even for a
   *  task id that never existed, so there is nothing to match an ack against — the truthful
   *  update arrives as `background_tasks_changed` + `task_updated{status:'killed'}`, which the
   *  reducer applies. Nothing is marked stopped locally on the strength of having asked. */
  function stopTask(taskId: string): void {
    if (!taskId) return;
    sendControl({ type: 'stopTask', taskId });
  }

  function setPermissionMode(mode: 'auto' | 'bypass', onFail?: () => void): void {
    const requestId = `pm-${id}-${++ctrlSeq}`;
    // Register BEFORE sending. An ack can only be matched against an entry that already
    // exists, and registering afterwards leaves a window in which a same-tick delivery finds
    // an empty map and silently drops the response.
    pendingModes.set(requestId, { mode, onFail });
    if (!sendControl({ type: 'setPermissionMode', requestId, mode })) {
      pendingModes.delete(requestId);
      onFail?.();
    }
  }

  function setEffort(level: string): void {
    if (!level || !sendControl({ type: 'setEffort', effort: level })) return;
    // No queryable effort state exists (unlike model, which the re-emitted init reports) —
    // reflect the choice optimistically; the CLI's synthetic "Set effort level to <level>"
    // bubble is the visible confirmation.
    session.effort = level;
  }

  // ── Rewind (conversation-only, transcript-uuid anchored) ──────────────────────────
  function applyControlAck(ev: { requestId: string; ok: boolean; payload?: Record<string, unknown>; error?: string }): void {
    const modeReq = pendingModes.get(ev.requestId);
    if (modeReq !== undefined) {
      pendingModes.delete(ev.requestId);
      if (ev.ok) {
        // The live switch landed: this conversation is now genuinely running under the new
        // mode, so the session's own flag must agree — a later resume/"continue in terminal"
        // reads `bypass` from here, and a stale value would silently downgrade the mode.
        session.bypass = modeReq.mode === 'bypass';
        conv = { ...conv, permissionMode: modeReq.mode === 'bypass' ? 'bypassPermissions' : 'acceptEdits' };
        return;
      }
      // Rejected (an older CLI with no `set_permission_mode` handler). Say nothing in the
      // transcript — the caller's fallback respawns this conversation under the new mode,
      // and an error banner for something the app immediately fixes is just noise.
      modeReq.onFail?.();
      return;
    }
    const modelReq = pendingModels.get(ev.requestId);
    if (modelReq !== undefined) {
      pendingModels.delete(ev.requestId);
      if (ev.ok) session.model = modelReq; // the re-emitted system:init confirms/normalizes it
      else conv = { ...conv, lastError: `Model switch failed: ${ev.error ?? 'rejected by the CLI'}` };
      return;
    }
    const itemId = pendingRewinds.get(ev.requestId);
    if (itemId === undefined) return; // an ack we don't track (e.g. the server's interrupt)
    pendingRewinds.delete(ev.requestId);
    // Set.delete returns whether the id was present — one step to both check AND clear.
    const isRetry = pendingRetries.delete(ev.requestId);
    const rewound = ev.ok && ev.payload?.rewound === true;
    if (!rewound) {
      const reason = ev.error
        ?? (typeof ev.payload?.error === 'string' ? ev.payload.error : 'the CLI rejected it');
      conv = { ...conv, lastError: `Rewind failed: ${reason}` };
      return;
    }
    const prefillRaw = ev.payload?.prefillText;
    // The rewound user message (and everything after it) leaves the transcript; its text
    // prefills the composer for re-editing — exactly the TUI rewind's behavior (or, for a
    // retry, is resent immediately instead — see below).
    const inItems = conv.items.findIndex((it) => it.id === itemId);
    const target = inItems >= 0
      ? conv.items[inItems]
      : conv.history.find((it) => it.id === itemId);
    const prefill = typeof prefillRaw === 'string' && prefillRaw
      ? prefillRaw
      : (target?.kind === 'user' ? target.text : '');
    if (inItems >= 0) {
      conv = { ...conv, items: conv.items.slice(0, inItems) };
    } else {
      const inHist = conv.history.findIndex((it) => it.id === itemId);
      if (inHist >= 0) conv = { ...conv, history: conv.history.slice(0, inHist), items: [] };
    }
    openBlocksByIndex.clear();
    toolCardPos.clear(); // positions may now be stale — future results fall back to fresh cards
    session.busy = false;
    session.asking = false;
    if (isRetry) {
      // Retry (contract C7): truncate exactly like any rewind, but write NEITHER `draft`
      // NOR bump `draftEpoch` — the composer's local textarea (which only adopts a new
      // `draft` on an epoch bump) must never show this prefill. `send()` resends it
      // immediately instead, which sets `draft` back to '' itself (a no-op, since we never
      // wrote it here) and appends the fresh user item — so the composer stays empty.
      conv = { ...conv, pending: [], lastResult: undefined, lastError: undefined };
      send(prefill);
      return;
    }
    conv = { ...conv, pending: [], lastResult: undefined, lastError: undefined, draft: prefill, draftEpoch: conv.draftEpoch + 1 };
  }

  /**
   * @param asRetry When true (only `retry()` passes this), a successful ack truncates and
   *   then immediately RESENDS the prefill instead of leaving it in the composer — see
   *   `applyControlAck`'s `isRetry` branch. Internal-facing; ordinary callers (the hover
   *   "Rewind" affordance) omit it.
   */
  async function rewind(itemId: string, asRetry = false): Promise<void> {
    const find = (): ChatUserItem | undefined => {
      const it = conv.items.find((x) => x.id === itemId) ?? conv.history.find((x) => x.id === itemId);
      return it?.kind === 'user' ? it : undefined;
    };
    let target = find();
    if (!target) return;
    if (!target.uuid) {
      await syncTranscriptUuids();
      target = find();
    }
    if (!target?.uuid) {
      applyAndNotify(() => {
        conv = { ...conv, lastError: 'Rewind unavailable: this message has not reached the transcript yet — try again in a moment.' };
      });
      return;
    }
    const requestId = `rw-${id}-${++ctrlSeq}`;
    if (sendControl({ type: 'rewind', requestId, targetUuid: target.uuid })) {
      pendingRewinds.set(requestId, itemId);
      if (asRetry) pendingRetries.add(requestId);
    }
  }

  /** Retry (state 11): rewind to just before the nearest preceding user item, then resend
   *  it — see `rewind`'s `asRetry` param and `applyControlAck`'s `isRetry` branch for the
   *  no-stale-prefill mechanics (contract C7). Searches `history` then `items` in that
   *  order (chronological — history is always the earlier segment) so it works whether
   *  the assistant turn being retried is from a resumed session's replay or a live one. */
  async function retry(assistantItemId: string): Promise<void> {
    const all: ChatItem[] = [...conv.history, ...conv.items];
    const idx = all.findIndex((it) => it.id === assistantItemId);
    if (idx < 0) return;
    let userItem: ChatUserItem | undefined;
    for (let i = idx - 1; i >= 0; i--) {
      const it = all[i];
      if (it.kind === 'user') { userItem = it; break; }
    }
    if (!userItem) return; // no preceding user message (e.g. the very first turn) — no-op
    await rewind(userItem.id, true);
  }

  /** "Always allow this session" (state 6) — session-scoped, client-side only. */
  function alwaysAllow(toolName: string): void {
    if (toolName) sessionAllow.add(toolName);
  }

  // ── Transcript history (resume replay + rewind-anchor uuids) ───────────────────────

  interface HistoryEntry {
    kind: 'user' | 'text' | 'thinking' | 'tool';
    uuid?: string;
    text?: string;
    toolUseId?: string;
    name?: string;
    input?: unknown;
    status?: 'done' | 'error';
    result?: unknown;
  }

  async function fetchTranscriptHistory(): Promise<HistoryEntry[]> {
    try {
      const r = await api.get<{ items: HistoryEntry[] }>(`/agent/chat-history?claudeId=${encodeURIComponent(claudeId)}`);
      return Array.isArray(r?.items) ? r.items : [];
    } catch { return []; }
  }

  function toChatItem(h: HistoryEntry): ChatItem | null {
    const idStr = `hist-${++itemSeq}`;
    if (h.kind === 'user' && typeof h.text === 'string') {
      return { kind: 'user', id: idStr, text: h.text, ts: 0, uuid: h.uuid };
    }
    if (h.kind === 'text' && typeof h.text === 'string') {
      return { kind: 'text', id: idStr, index: -1, text: h.text, done: true, ts: 0 };
    }
    if (h.kind === 'thinking' && typeof h.text === 'string') {
      return { kind: 'thinking', id: idStr, index: -1, text: h.text, done: true, ts: 0 };
    }
    if (h.kind === 'tool' && typeof h.toolUseId === 'string') {
      return {
        kind: 'tool', id: idStr, toolUseId: h.toolUseId, name: h.name ?? '', input: h.input,
        status: h.status === 'error' ? 'error' : 'done', startedAt: 0, endedAt: 0, result: h.result,
      };
    }
    return null;
  }

  /** Resume replay: `--resume` never re-emits past frames, so a resumed chat would open
   *  blank without this. Lands in `conv.history` (never `items`) so the async arrival can't
   *  shift positions the live reducer bookkeeping recorded. */
  async function seedHistory(): Promise<void> {
    const entries = await fetchTranscriptHistory();
    if (disposed || !entries.length) return;
    const items = entries.map(toChatItem).filter((x): x is ChatItem => !!x);
    if (!items.length) return;
    applyAndNotify(() => { conv = { ...conv, history: items }; });
  }

  /** Backfill transcript uuids onto live-sent user items (the protocol never echoes them),
   *  matching text from the END of both sequences — the live items are always the
   *  transcript's tail. Called lazily after each turn and before an anchor-less rewind. */
  let uuidSyncInFlight: Promise<void> | null = null;
  function syncTranscriptUuids(): Promise<void> {
    if (uuidSyncInFlight) return uuidSyncInFlight;
    uuidSyncInFlight = (async () => {
      try {
        const entries = (await fetchTranscriptHistory()).filter((h) => h.kind === 'user' && h.uuid);
        if (disposed || !entries.length) return;
        const items = conv.items.slice();
        let changed = false;
        let e = entries.length - 1;
        for (let i = items.length - 1; i >= 0 && e >= 0; i--) {
          const it = items[i];
          if (it.kind !== 'user') continue;
          while (e >= 0 && entries[e].text !== it.text) e--;
          if (e < 0) break;
          if (!it.uuid) { items[i] = { ...it, uuid: entries[e].uuid }; changed = true; }
          e--;
        }
        if (changed) applyAndNotify(() => { conv = { ...conv, items }; });
      } finally {
        uuidSyncInFlight = null;
      }
    })();
    return uuidSyncInFlight;
  }

  function clearAttention(): void {
    if (!session.attention) return;
    applyAndNotify(() => { session.attention = false; });
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    try { ws.close(); } catch { /* already closing */ }
    try { container.remove(); } catch { /* already detached */ }
  }

  // A resumed conversation replays its transcript into `conv.history` (fire-and-forget —
  // an empty/missing transcript just leaves history empty, exactly like a fresh session).
  if (resume) void seedHistory();

  return session;
}
