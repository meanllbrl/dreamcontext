import { getActiveVault } from '../../api/client';
import { playAskChime } from '../../lib/chime';
import {
  parseChatLine, buildQuestionAnswer,
  type ChatEvent, type QuestionSpec, type ClientControl,
} from '../../lib/chatProtocol';
import type { TermStatus } from './agentSession';

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

export interface ChatUserItem { kind: 'user'; id: string; text: string; ts: number }
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
  capabilities: string[];
  model?: string;
  permissionMode?: string;
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
   *  into: this appends to `ConversationModel.draft` and fires the fine-grained subscribers
   *  so the composer's textarea can pick it up. */
  sendText: (data: string) => void;
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

  let conv: ConversationModel = { items: [], pending: [], draft: '', capabilities: [] };

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
    busy: false, asking: false, attention: false, minimized: false,
    capabilities: [],
    model,
    effort,
    ensureOpen: () => { /* no DOM-open step — the AgentSurface portal mount IS "open" */ },
    fitAndResize: () => { /* no terminal grid to refit */ },
    applyZoom,
    sendText,
    focus: () => { focusTarget?.focus(); },
    dispose,
    subscribe,
    getModel: () => conv,
    send,
    answer,
    answerQuestion,
    interrupt,
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
    conv = { ...conv, draft: conv.draft + data };
    fireSubscribers();
  }

  // ── Reducer: one parsed ChatEvent → conversation model + derived-state mutation ────
  function applyEvent(ev: ChatEvent): void {
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
        };
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
        return;
      }
      case 'permission-request': {
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
      case 'meta-exit': {
        session.busy = false;
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

  return session;
}
