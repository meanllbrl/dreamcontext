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

export type ChatEvent =
  | { kind: 'init'; sessionId: string; model?: string; permissionMode?: string; capabilities?: string[]; version?: string }
  | { kind: 'block-start'; index: number; blockType: 'text' | 'thinking' | 'tool_use'; toolName?: string; toolUseId?: string; toolInput?: unknown; parentToolUseId?: string }
  | { kind: 'text-delta'; index: number; text: string }
  | { kind: 'thinking-delta'; index: number; text: string }
  | { kind: 'block-stop'; index: number }
  | { kind: 'assistant-tool-use'; toolUseId: string; name: string; input: unknown; parentToolUseId?: string }
  | { kind: 'tool-result'; toolUseId: string; content: unknown; isError: boolean }
  | { kind: 'permission-request'; requestId: string; toolName: string; displayName?: string; input: unknown; description?: string; suggestions?: unknown[]; toolUseId?: string }
  | { kind: 'question'; requestId: string; toolName: string; questions: QuestionSpec[] }
  | { kind: 'result'; success: boolean; text?: string; costUsd?: number; usage?: Record<string, unknown>; numTurns?: number; permissionDenials?: unknown[] }
  | { kind: 'meta-exit'; code: number | null }
  | { kind: 'meta-error'; message: string }
  | { kind: 'ignored'; rawType: string };

// ─── Client → server control frames ───────────────────────────────────────────────

export type ClientControl =
  | { type: 'user'; text: string }
  | { type: 'answer'; requestId: string; behavior: 'allow' | 'deny'; updatedInput?: unknown; message?: string }
  | { type: 'interrupt' };

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
  return {
    kind: 'init',
    sessionId,
    model: str(obj.model),
    permissionMode: str(obj.permissionMode),
    capabilities,
    version: str(obj.claude_code_version),
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
 * model) surfaces as `tool-result`. Only the FIRST recognized block in the array is
 * translated — Claude Code's one-block-per-frame contract means a second block, if ever
 * present, would need its own frame; translating just the first keeps this a 1:1 mapping
 * and avoids silently dropping a caller that expects one event per line.
 */
function fromAssistant(obj: Record<string, unknown>): ChatEvent {
  const message = isRecord(obj.message) ? obj.message : {};
  const content = message.content;
  if (!Array.isArray(content) || content.length === 0) return ignored('assistant:no_content');
  const block = content.find((c) => isRecord(c)) as Record<string, unknown> | undefined;
  if (!block) return ignored('assistant:no_content');
  const blockType = str(block.type);
  if (blockType === 'tool_use' && typeof block.name === 'string' && typeof block.id === 'string') {
    return {
      kind: 'assistant-tool-use',
      toolUseId: block.id,
      name: block.name,
      input: 'input' in block ? block.input : undefined,
      parentToolUseId: str(block.parent_tool_use_id),
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
  // A plain text/thinking block on an `assistant` frame duplicates the stream_event
  // deltas already rendering it — nothing new for the UI here.
  return ignored('assistant:' + (blockType ?? 'unknown'));
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
  return ignored('_meta:' + (subtype ?? 'unknown'));
}

// ─── system (init, or noise) ────────────────────────────────────────────────────────

function fromSystem(obj: Record<string, unknown>): ChatEvent {
  const subtype = str(obj.subtype);
  if (subtype === 'init') return fromSystemInit(obj);
  // hook_started / hook_response / status / thinking_tokens — observed noise the
  // parser must tolerate (global hooks + status pings fire during a headless run).
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
    // own transcript parser at agent-terminal.ts:591). `fromAssistant` already
    // extracts tool_result blocks from `message.content`; route user frames through
    // the same path so those results actually reach the tool card.
    case 'user':
      return fromAssistant(obj);
    case 'control_request':
      return fromControlRequest(obj);
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
