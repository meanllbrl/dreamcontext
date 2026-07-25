/**
 * Pure NDJSON → typed-event parser for the Agent Chat view (beta). Translates the raw
 * stream-json frames a headless `claude -p --output-format stream-json` process emits
 * into a small typed `ChatEvent` union the chat UI renders from, and builds the reply
 * frames the UI sends back over the control channel.
 *
 * Zero imports, no side effects — every export is a pure function over its arguments, so
 * this module is unit-testable against inline NDJSON fixtures with no server/DOM/WS in
 * the loop. `agent-chat.ts` (the WS relay) and `chatSession.ts` (the client engine) both
 * depend on this as the single source of truth for the frame shapes.
 *
 * Frame vocabulary is the empirically-verified `claude` CLI 2.1.218 stream-json protocol
 * (spike results, task_nQb0y85X): `system:init`, `stream_event` (raw Anthropic SSE deltas),
 * `assistant` (full API message, one content block per frame), `control_request`
 * (`can_use_tool` — permission prompts AND AskUserQuestion, discriminated by
 * `requires_user_interaction`), `result` (final turn summary), plus assorted noise frames
 * (`system:hook_started`/`hook_response`/`status`/`thinking_tokens`, `rate_limit_event`)
 * that MUST be tolerated, never thrown on. `parseChatLine`/`toChatEvent` never throw on any
 * well-formed JSON object — an unrecognized shape degrades to `{kind:'ignored'}` rather than
 * crashing the relay or the UI's event loop.
 */

// ─── Typed events ────────────────────────────────────────────────────────────────

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionSpec {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

/**
 * One assistant turn's token footprint, straight off the `assistant` frame's
 * `message.usage`. `total` is the sum the CONTEXT WINDOW actually holds — fresh input +
 * both cache buckets + the output just produced — which is the same arithmetic the server
 * does over a flushed transcript (agent-terminal.ts's `computeSessionStats`).
 *
 * Why the client needs its own copy: Claude Code ≥2.1.x flushes a live session's transcript
 * only on exit/rotation, so `GET /api/agent/session-stats` reports nulls for the entire life
 * of a chat — the stream is the ONLY live source of these numbers.
 */
export interface TurnUsage {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
  /** input + cacheCreation + cacheRead + output — how full the window is after this turn. */
  total: number;
  /** The model that ran the turn, for picking the 200K vs 1M window. */
  model?: string;
}

export type ChatEvent =
  | { kind: 'init'; sessionId: string; model?: string; permissionMode?: string; capabilities?: string[]; version?: string; slashCommands?: string[] }
  /** A `Task`/`Agent`-tool sub-agent was dispatched. Empirically verified on CLI
   *  2.1.218 (a real Task-tool spike, task_nQb0y85X round 3): the sub-agent's own
   *  assistant text/thinking is NEVER streamed to the parent, and `parent_tool_use_id`
   *  never appears on a text/thinking content block — so sub-agent activity can ONLY
   *  be reconstructed from this frame + `task-updated`/`task-notification` below, not
   *  from block-level attribution. */
  | { kind: 'task-started'; taskId: string; toolUseId?: string; description: string; subagentType?: string; taskType?: string; prompt?: string }
  /** A lifecycle status patch for an already-started task (e.g. `status:'completed'`). */
  | { kind: 'task-updated'; taskId: string; status?: string; endTime?: number }
  /** The sub-agent's own run finished (or reported progress): final status, a short
   *  summary, and usage totals. `outputFile` (the sub-agent's own transcript path) is
   *  carried through but is NOT trusted/used client-side — the drill-in transcript is
   *  fetched via the server-derived `?subagent=` history route instead (see
   *  agent-chat.ts), never from this client-visible path. */
  | { kind: 'task-notification'; taskId: string; toolUseId?: string; status?: string; outputFile?: string; summary?: string; usage?: { totalTokens?: number; toolUses?: number; durationMs?: number } }
  | { kind: 'block-start'; index: number; blockType: 'text' | 'thinking' | 'tool_use'; toolName?: string; toolUseId?: string; toolInput?: unknown; parentToolUseId?: string }
  | { kind: 'text-delta'; index: number; text: string }
  | { kind: 'thinking-delta'; index: number; text: string }
  | { kind: 'block-stop'; index: number }
  | { kind: 'assistant-tool-use'; toolUseId: string; name: string; input: unknown; parentToolUseId?: string; turnUsage?: TurnUsage }
  /** The full-message echo of a text/thinking content block on an `assistant` frame. LOAD-
   *  BEARING for short replies: the CLI often emits NO `text_delta` at all for a brief text
   *  block (observed empirically — "pong" arrived only in the assistant frame), so the echo
   *  is the AUTHORITATIVE full text that upgrades (or, for synthetic local-command replies
   *  like "Set effort level to low", creates) the transcript item. */
  | { kind: 'assistant-text'; text: string; synthetic: boolean; turnUsage?: TurnUsage }
  | { kind: 'assistant-thinking'; text: string; turnUsage?: TurnUsage }
  | { kind: 'tool-result'; toolUseId: string; content: unknown; isError: boolean }
  /** A `control_response` ack for a control request WE sent (set_model / rewind_conversation).
   *  `payload` is the CLI's nested `response` object when present (e.g. rewind's
   *  `{rewound, prefillText, precedingAssistantUuid, error?}`). */
  | { kind: 'control-ack'; requestId: string; ok: boolean; payload?: Record<string, unknown>; error?: string }
  | { kind: 'permission-request'; requestId: string; toolName: string; displayName?: string; input: unknown; description?: string; suggestions?: unknown[]; toolUseId?: string }
  | { kind: 'question'; requestId: string; toolName: string; questions: QuestionSpec[] }
  | { kind: 'result'; success: boolean; text?: string; costUsd?: number; usage?: Record<string, unknown>; numTurns?: number; permissionDenials?: unknown[] }
  /** The server's cached slash-command list for this project, sent at connect. Carries the
   *  same payload `init.slashCommands` does; whichever arrives later wins. */
  | { kind: 'slash-commands'; commands: string[] }
  | { kind: 'meta-exit'; code: number | null }
  | { kind: 'meta-error'; message: string }
  | { kind: 'ignored'; rawType: string };

// ─── Client → server control frames ───────────────────────────────────────────────

export type ClientControl =
  | { type: 'user'; text: string }
  | { type: 'answer'; requestId: string; behavior: 'allow' | 'deny'; updatedInput?: unknown; message?: string }
  | { type: 'interrupt' }
  /** Live model switch — the server translates this into a `set_model` control_request
   *  (verified on CLI 2.1.218: accepts aliases AND full ids, re-emits `system:init` with
   *  the new model). `requestId` is CLIENT-generated so the `control-ack` can be matched. */
  | { type: 'setModel'; requestId: string; model: string }
  /** Live effort switch — the server translates this into a `/effort <level>` user frame
   *  (no `set_reasoning_effort` control exists on 2.1.218; the slash command works headlessly
   *  and yields a synthetic assistant "Set effort level to <level>" echo). */
  | { type: 'setEffort'; effort: string }
  /** Live permission-mode switch — the server translates this into a `set_permission_mode`
   *  control_request (`mode: 'acceptEdits' | 'bypassPermissions'`). Present on CLI 2.1.220's
   *  headless engine; the ack (matched by this CLIENT-generated `requestId`) is what tells
   *  the caller whether the switch actually landed, so a rejection can fall back to
   *  respawning the same conversation in the new mode. */
  | { type: 'setPermissionMode'; requestId: string; mode: 'auto' | 'bypass' }
  /** Rewind the conversation to just BEFORE the user message with this transcript uuid —
   *  translated into a `rewind_conversation` control_request (`interrupt_if_running: true`).
   *  Conversation-only: the CLI does NOT restore files through this channel. */
  | { type: 'rewind'; requestId: string; targetUuid: string };

// ─── Small object-shape helpers (kept local — this module takes no dependencies) ───

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function bool(v: unknown): boolean {
  return v === true;
}

function ignored(rawType: string): ChatEvent {
  return { kind: 'ignored', rawType };
}

// ─── system:init ─────────────────────────────────────────────────────────────────

function fromSystemInit(obj: Record<string, unknown>): ChatEvent {
  const sessionId = str(obj.session_id) ?? '';
  const capabilities = Array.isArray(obj.capabilities)
    ? obj.capabilities.filter((c): c is string => typeof c === 'string')
    : undefined;
  // The CLI's own list of user-invocable commands, WITHOUT the leading slash — built-ins,
  // project commands and plugin/skill commands alike, exactly what its TUI menu offers. It
  // is per-session (a project's `.claude/commands/` differs from the next one's), so it can
  // only come from this frame; there is no static list to hardcode against.
  const slashCommands = Array.isArray(obj.slash_commands)
    ? obj.slash_commands.filter((c): c is string => typeof c === 'string' && !!c)
    : undefined;
  return {
    kind: 'init',
    sessionId,
    slashCommands,
    model: str(obj.model),
    permissionMode: str(obj.permissionMode),
    capabilities,
    version: str(obj.claude_code_version),
  };
}

// ─── system:task_* (sub-agent lifecycle — state 9) ─────────────────────────────────
//
// Empirically verified on CLI 2.1.218 (a real Task-tool spike, task_nQb0y85X round 3):
// a dispatched sub-agent's stream carries `system:task_started` → a top-level `user`
// frame (parent_tool_use_id + prompt echo, intentionally NOT surfaced as its own event
// — the delegated prompt is already carried on `task-started.prompt`) →
// `system:task_updated` → `system:task_notification` → a final `user` tool_result
// (already handled by `fromUserFrame`/`fromAssistant` as an ordinary `tool-result`,
// correlated client-side by `toolUseId`). A missing `task_id` (or, for task_started,
// a missing `description`) degrades to `ignored` rather than emitting a half-formed
// event nothing downstream can key by.

function fromTaskStarted(obj: Record<string, unknown>): ChatEvent {
  const taskId = str(obj.task_id);
  const description = str(obj.description);
  if (!taskId || !description) return ignored('system:task_started');
  return {
    kind: 'task-started',
    taskId,
    toolUseId: str(obj.tool_use_id),
    description,
    subagentType: str(obj.subagent_type),
    taskType: str(obj.task_type),
    prompt: str(obj.prompt),
  };
}

function fromTaskUpdated(obj: Record<string, unknown>): ChatEvent {
  const taskId = str(obj.task_id);
  if (!taskId) return ignored('system:task_updated');
  const patch = isRecord(obj.patch) ? obj.patch : {};
  return {
    kind: 'task-updated',
    taskId,
    status: str(patch.status),
    endTime: typeof patch.end_time === 'number' ? patch.end_time : undefined,
  };
}

function fromTaskNotification(obj: Record<string, unknown>): ChatEvent {
  const taskId = str(obj.task_id);
  if (!taskId) return ignored('system:task_notification');
  const usageRaw = isRecord(obj.usage) ? obj.usage : undefined;
  const usage = usageRaw
    ? {
      totalTokens: typeof usageRaw.total_tokens === 'number' ? usageRaw.total_tokens : undefined,
      toolUses: typeof usageRaw.tool_uses === 'number' ? usageRaw.tool_uses : undefined,
      durationMs: typeof usageRaw.duration_ms === 'number' ? usageRaw.duration_ms : undefined,
    }
    : undefined;
  return {
    kind: 'task-notification',
    taskId,
    toolUseId: str(obj.tool_use_id),
    status: str(obj.status),
    outputFile: str(obj.output_file),
    summary: str(obj.summary),
    usage,
  };
}

// ─── stream_event (raw Anthropic SSE event) ────────────────────────────────────────

/**
 * `content_block_start` carries the block's TYPE and, for a tool_use block, its name/id/
 * input/parent — everything the UI needs to open a tool card the moment the block begins
 * (before any delta arrives). Non-text/thinking/tool_use block types (there are none in the
 * documented set today, but a future addition must degrade safely) fall through to `ignored`.
 */
function fromContentBlockStart(event: Record<string, unknown>): ChatEvent {
  const index = typeof event.index === 'number' ? event.index : 0;
  const block = isRecord(event.content_block) ? event.content_block : {};
  const blockType = str(block.type);
  if (blockType === 'text') return { kind: 'block-start', index, blockType: 'text' };
  if (blockType === 'thinking') return { kind: 'block-start', index, blockType: 'thinking' };
  if (blockType === 'tool_use') {
    return {
      kind: 'block-start',
      index,
      blockType: 'tool_use',
      toolName: str(block.name),
      toolUseId: str(block.id),
      toolInput: 'input' in block ? block.input : undefined,
      parentToolUseId: str(block.parent_tool_use_id),
    };
  }
  return ignored('stream_event:content_block_start:' + (blockType ?? 'unknown'));
}

function fromContentBlockDelta(event: Record<string, unknown>): ChatEvent {
  const index = typeof event.index === 'number' ? event.index : 0;
  const delta = isRecord(event.delta) ? event.delta : {};
  const deltaType = str(delta.type);
  if (deltaType === 'text_delta' && typeof delta.text === 'string') {
    return { kind: 'text-delta', index, text: delta.text };
  }
  if (deltaType === 'thinking_delta' && typeof delta.thinking === 'string') {
    return { kind: 'thinking-delta', index, text: delta.thinking };
  }
  // signature_delta, input_json_delta (tool-arg streaming), and any future delta kind —
  // the chat UI does not render these; tolerate and drop.
  return ignored('stream_event:content_block_delta:' + (deltaType ?? 'unknown'));
}

function fromStreamEvent(obj: Record<string, unknown>): ChatEvent {
  const event = isRecord(obj.event) ? obj.event : null;
  if (!event) return ignored('stream_event:missing_event');
  const type = str(event.type) ?? '';
  switch (type) {
    case 'content_block_start':
      return fromContentBlockStart(event);
    case 'content_block_delta':
      return fromContentBlockDelta(event);
    case 'content_block_stop': {
      const index = typeof event.index === 'number' ? event.index : 0;
      return { kind: 'block-stop', index };
    }
    // message_start / message_delta / message_stop carry only outer-message bookkeeping
    // (stop_reason, usage running totals) that duplicates what `result` already reports —
    // no UI surface reads them today, so they are tolerated noise.
    case 'message_start':
    case 'message_delta':
    case 'message_stop':
      return ignored('stream_event:' + type);
    default:
      return ignored('stream_event:' + (type || 'unknown'));
  }
}

// ─── assistant (full API message; one content block per frame) ────────────────────

/**
 * An `assistant` frame's `message.content` is normally a single-element array (Claude
 * Code emits one content block per frame). A `tool_use` block surfaces as
 * `assistant-tool-use` — the fallback path for tool calls that don't arrive via
 * `content_block_start` (mirrors sleepy-chat.ts's belt-and-suspenders handling). A
 * `tool_result` block (present on a USER-role frame echoing a tool's output back to the
 * model) surfaces as `tool-result`. A text/thinking block surfaces as
 * `assistant-text`/`assistant-thinking` — the AUTHORITATIVE full-block echo (the CLI can
 * skip `text_delta`s entirely for short replies, so this is not a duplicate: it is the
 * only guaranteed carrier of the block's complete text). Only the FIRST recognized block
 * in the array is translated — Claude Code's one-block-per-frame contract means a second
 * block, if ever present, would need its own frame; translating just the first keeps this
 * a 1:1 mapping and avoids silently dropping a caller that expects one event per line.
 */
function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * `message.usage` off an ASSISTANT frame → {@link TurnUsage}. Returns undefined for
 * anything else, which is what keeps a user frame's tool_result echo (routed through the
 * same block extraction) and a `<synthetic>` local-command reply from being mistaken for a
 * real turn. A frame carrying `parent_tool_use_id` is a SUB-AGENT's turn: its tokens live
 * in that sub-agent's own window, not the conversation's, so it is skipped too — the same
 * distinction the server makes with the transcript's `isSidechain`.
 */
function usageOf(frame: Record<string, unknown>, message: Record<string, unknown>): TurnUsage | undefined {
  if (message.role !== 'assistant' || message.model === '<synthetic>') return undefined;
  if (typeof frame.parent_tool_use_id === 'string' && frame.parent_tool_use_id) return undefined;
  const u = message.usage;
  if (!isRecord(u)) return undefined;
  const input = n(u.input_tokens);
  const cacheCreation = n(u.cache_creation_input_tokens);
  const cacheRead = n(u.cache_read_input_tokens);
  const output = n(u.output_tokens);
  const total = input + cacheCreation + cacheRead + output;
  if (total <= 0) return undefined;
  return { input, cacheCreation, cacheRead, output, total, model: str(message.model) };
}

function fromAssistant(obj: Record<string, unknown>): ChatEvent {
  const message = isRecord(obj.message) ? obj.message : {};
  const content = message.content;
  if (!Array.isArray(content) || content.length === 0) return ignored('assistant:no_content');
  const block = content.find((c) => isRecord(c)) as Record<string, unknown> | undefined;
  if (!block) return ignored('assistant:no_content');
  const blockType = str(block.type);
  const turnUsage = usageOf(obj, message);
  if (blockType === 'tool_use' && typeof block.name === 'string' && typeof block.id === 'string') {
    return {
      kind: 'assistant-tool-use',
      toolUseId: block.id,
      name: block.name,
      input: 'input' in block ? block.input : undefined,
      parentToolUseId: str(block.parent_tool_use_id),
      turnUsage,
    };
  }
  if (blockType === 'tool_result' && typeof block.tool_use_id === 'string') {
    return {
      kind: 'tool-result',
      toolUseId: block.tool_use_id,
      content: 'content' in block ? block.content : undefined,
      isError: bool(block.is_error),
    };
  }
  if (blockType === 'text' && typeof block.text === 'string' && block.text) {
    // `<synthetic>` marks a locally-generated reply (e.g. `/effort`'s "Set effort level to
    // low") — no stream deltas ever accompany it, so the reducer appends it as a done item.
    return { kind: 'assistant-text', text: block.text, synthetic: message.model === '<synthetic>', turnUsage };
  }
  if (blockType === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
    return { kind: 'assistant-thinking', text: block.thinking, turnUsage };
  }
  return ignored('assistant:' + (blockType ?? 'unknown'));
}

/**
 * A top-level `user` frame carries either a tool_result echo (rendered — routed through
 * the same block extraction as `assistant`), or local-command/synthetic chatter
 * (`<local-command-stdout>…` strings, `isSynthetic` continuation nudges) that the UI does
 * not render. Critically, a user frame's TEXT block must NOT surface as `assistant-text` —
 * so this wrapper only lets tool_result extractions through.
 */
function fromUserFrame(obj: Record<string, unknown>): ChatEvent {
  const ev = fromAssistant(obj);
  return ev.kind === 'tool-result' ? ev : ignored('user:non_tool_result');
}

// ─── control_request (permission prompts + AskUserQuestion) ───────────────────────

/**
 * The question/permission discriminator: `requires_user_interaction === true` on the
 * request payload is what marks a `can_use_tool` request as AskUserQuestion rather than
 * a plain tool-permission prompt (verified empirically — the field is absent/false on
 * ordinary Write/Bash/etc. prompts). A malformed `questions` array (missing/non-array,
 * or an entry missing `question`/`options`) is dropped from the list rather than
 * throwing; an empty resulting list still surfaces as a `question` event so the UI can
 * show the degrade path (AC5) instead of silently losing the turn.
 */
function parseQuestions(input: unknown): QuestionSpec[] {
  if (!isRecord(input) || !Array.isArray(input.questions)) return [];
  const out: QuestionSpec[] = [];
  for (const q of input.questions) {
    if (!isRecord(q)) continue;
    const question = str(q.question);
    if (!question) continue;
    const rawOptions = Array.isArray(q.options) ? q.options : [];
    const options: QuestionOption[] = rawOptions
      .filter((o): o is Record<string, unknown> => isRecord(o) && typeof o.label === 'string')
      .map((o) => ({ label: o.label as string, description: str(o.description) }));
    out.push({ question, header: str(q.header), options, multiSelect: bool(q.multiSelect) });
  }
  return out;
}

function fromControlRequest(obj: Record<string, unknown>): ChatEvent {
  const requestId = str(obj.request_id) ?? '';
  const request = isRecord(obj.request) ? obj.request : {};
  const subtype = str(request.subtype);
  if (subtype !== 'can_use_tool') return ignored('control_request:' + (subtype ?? 'unknown'));

  const toolName = str(request.tool_name) ?? '';
  const input = request.input;
  if (bool(request.requires_user_interaction)) {
    return { kind: 'question', requestId, toolName, questions: parseQuestions(input) };
  }
  return {
    kind: 'permission-request',
    requestId,
    toolName,
    displayName: str(request.display_name),
    input,
    description: str(request.description),
    suggestions: Array.isArray(request.permission_suggestions) ? request.permission_suggestions : undefined,
    toolUseId: str(request.tool_use_id),
  };
}

// ─── control_response (ack for a control request WE sent) ──────────────────────────

/**
 * `{"type":"control_response","response":{"subtype":"success"|"error","request_id":…,
 *  "response":{…}?, "error":…?}}` — the CLI's ack envelope for `set_model` /
 * `rewind_conversation` / `interrupt` control requests (verified on 2.1.218). Surfaced so
 * chatSession can match its own client-generated request ids; acks for requests we don't
 * track (e.g. the server's interrupt) are simply never matched and fall through harmlessly.
 */
function fromControlResponse(obj: Record<string, unknown>): ChatEvent {
  const resp = isRecord(obj.response) ? obj.response : {};
  const requestId = str(resp.request_id) ?? '';
  if (!requestId) return ignored('control_response:no_request_id');
  return {
    kind: 'control-ack',
    requestId,
    ok: str(resp.subtype) === 'success',
    payload: isRecord(resp.response) ? resp.response : undefined,
    error: str(resp.error),
  };
}

// ─── result (final turn summary) ───────────────────────────────────────────────────

function fromResult(obj: Record<string, unknown>): ChatEvent {
  const success = !bool(obj.is_error);
  return {
    kind: 'result',
    success,
    text: str(obj.result),
    costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined,
    usage: isRecord(obj.usage) ? (obj.usage as Record<string, unknown>) : undefined,
    numTurns: typeof obj.num_turns === 'number' ? obj.num_turns : undefined,
    permissionDenials: Array.isArray(obj.permission_denials) ? obj.permission_denials : undefined,
  };
}

// ─── _meta (server-relay lifecycle frames — not a claude-native frame type) ────────

function fromMeta(obj: Record<string, unknown>): ChatEvent {
  const subtype = str(obj.subtype);
  if (subtype === 'exit') {
    return { kind: 'meta-exit', code: typeof obj.code === 'number' ? obj.code : null };
  }
  if (subtype === 'error') {
    return { kind: 'meta-error', message: str(obj.message) ?? 'Unknown error' };
  }
  // The server replaying this project's LAST known command list at connect time, because
  // the CLI withholds `system:init` until a turn starts — without it, `/` would do nothing
  // on the first message of every session. See agent-chat.ts's slash-cache note.
  if (subtype === 'slash_commands') {
    const commands = Array.isArray(obj.commands)
      ? obj.commands.filter((c): c is string => typeof c === 'string' && !!c)
      : [];
    return commands.length ? { kind: 'slash-commands', commands } : ignored('_meta:slash_commands');
  }
  return ignored('_meta:' + (subtype ?? 'unknown'));
}

// ─── system (init, or noise) ────────────────────────────────────────────────────────

function fromSystem(obj: Record<string, unknown>): ChatEvent {
  const subtype = str(obj.subtype);
  if (subtype === 'init') return fromSystemInit(obj);
  if (subtype === 'task_started') return fromTaskStarted(obj);
  if (subtype === 'task_updated') return fromTaskUpdated(obj);
  if (subtype === 'task_notification') return fromTaskNotification(obj);
  // hook_started / hook_response / status / thinking_tokens / any other subtype —
  // observed or future noise the parser must tolerate (global hooks + status pings
  // fire during a headless run).
  return ignored('system:' + (subtype ?? 'unknown'));
}

// ─── Top-level dispatch ─────────────────────────────────────────────────────────────

/**
 * Translate one parsed stream-json line into a typed `ChatEvent`. Never throws on a
 * well-formed JSON object — any frame type/shape this module doesn't recognize (including
 * `rate_limit_event`, and any future frame type the CLI adds) degrades to `{kind:'ignored',
 * rawType}` rather than crashing the relay or the UI's event loop.
 */
export function toChatEvent(obj: Record<string, unknown>): ChatEvent {
  const type = str(obj.type) ?? '';
  switch (type) {
    case 'system':
      return fromSystem(obj);
    case 'stream_event':
      return fromStreamEvent(obj);
    case 'assistant':
      return fromAssistant(obj);
    // A `tool_result` content block is echoed back to the model on a top-level
    // `type:'user'` frame (Messages API convention — confirmed against this repo's
    // own transcript parser at agent-terminal.ts:591). `fromUserFrame` routes user
    // frames through the same block extraction but lets ONLY tool_result through —
    // a user frame's text (synthetic nudges, `<local-command-stdout>`) must never
    // render as an assistant bubble.
    case 'user':
      return fromUserFrame(obj);
    case 'control_request':
      return fromControlRequest(obj);
    case 'control_response':
      return fromControlResponse(obj);
    case 'result':
      return fromResult(obj);
    case '_meta':
      return fromMeta(obj);
    default:
      return ignored(type || 'unknown');
  }
}

/**
 * Parse one raw NDJSON line into a typed event. Returns `null` for an empty/whitespace
 * line or a line that isn't valid JSON (a partial line mid-stream, or transport noise) —
 * the caller (chatSession's line buffer) should simply skip a `null` result, exactly like
 * the terminal/sleepy-chat NDJSON parsers already do.
 */
export function parseChatLine(line: string): ChatEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(obj)) return null;
  return toChatEvent(obj);
}

// ─── AskUserQuestion answer builder ─────────────────────────────────────────────────

/**
 * Build the `updatedInput` payload for an AskUserQuestion `allow` response: the ORIGINAL
 * questions input echoed back, plus an `answers` record mapping each question's text to
 * the chosen label(s). Per the spike findings, the shape is load-bearing — a plain allow
 * echo or a per-question `answer` field both yield "The user did not answer the questions"
 * (the turn ends gracefully but the answer is lost), so this must stay exactly
 * `{questions: [...], answers: {<question text>: <label|comma-joined labels>}}`.
 * A multiSelect question's picked value is treated as an already comma-joined string (the
 * caller is responsible for joining multiple chosen labels before calling this).
 */
export function buildQuestionAnswer(questions: QuestionSpec[], picked: Record<string, string>): unknown {
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const answer = picked[q.question];
    if (typeof answer === 'string' && answer.length > 0) answers[q.question] = answer;
  }
  return { questions, answers };
}
