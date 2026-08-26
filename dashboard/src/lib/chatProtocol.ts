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

/** Running totals the CLI reports for a task, on both `task_progress` (live, once per tool
 *  use) and `task_notification` (final). `durationMs` is the CLI's own measure of how long
 *  the task ran — preferred over any wall-clock the client could compute. */
export interface TaskUsage {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

/**
 * The Agent tool's OWN structured result, lifted off the `tool_use_result` sibling that
 * rides alongside `message` on the top-level `user` tool_result frame. This is the only
 * channel that reports which model a sub-agent actually ran on — no `task_*` frame carries
 * it (verified against CLI 2.1.220's own zod schemas and a live spike; see
 * {@link fromToolUseResult}).
 *
 * Two shapes arrive, and both are handled because both are real:
 *   • `async_launched` — the default (agents run in the background), so this lands
 *     IMMEDIATELY after `task_started` and gives the row its model while it is still
 *     running. Carries `resolvedModel` only.
 *   • `completed` — a `run_in_background:false` dispatch, landing at the very end with the
 *     full accounting: `resolvedModel`, `totalDurationMs`, `totalTokens`,
 *     `totalToolUseCount` (and `modelsUsed` when the run swapped models mid-flight).
 */
export interface SubAgentResult {
  /** The CLI's own agent id — identical to `task_id` on the `task_*` frames (verified), so
   *  it correlates a result back to its run even without a `tool_use_id`. */
  agentId?: string;
  /** Full model id the sub-agent actually ran on, e.g. `claude-haiku-4-5-20251001`. */
  resolvedModel?: string;
  /** Ordered distinct models used; length > 1 means the run swapped models mid-flight. */
  modelsUsed?: string[];
  totalDurationMs?: number;
  totalTokens?: number;
  totalToolUseCount?: number;
}

/** One entry of the CLI's live background-shell roster (`system:background_tasks_changed`). */
export interface BackgroundTaskEntry {
  taskId: string;
  /** `local_bash` for a backgrounded shell command. Carried verbatim so a future task type
   *  can be told apart rather than assumed to be a shell. */
  taskType?: string;
  description?: string;
}

export type ChatEvent =
  | { kind: 'init'; sessionId: string; model?: string; permissionMode?: string; capabilities?: string[]; version?: string; slashCommands?: string[] }
  /** The CLI's authoritative roster of tasks STILL RUNNING in the background, pushed on
   *  every change (empirically verified on CLI 2.1.220: fires when a `run_in_background`
   *  Bash starts, and again with `tasks: []` when the last one ends).
   *
   *  Load-bearing for two things the `task_*` frames alone can't do: it is the only frame
   *  that says a shell is still alive RIGHT NOW (so a roster that lost an entry without a
   *  terminal `task_updated` — a shell reaped with the process — can be reconciled), and it
   *  carries entries for shells whose `task_started` we never saw. It deliberately does NOT
   *  carry terminal state: a finished task simply drops out of `tasks`, so completion still
   *  comes from `task-updated`/`task-notification`. */
  | { kind: 'background-tasks'; tasks: BackgroundTaskEntry[] }
  /** A `Task`/`Agent`-tool sub-agent was dispatched. Empirically verified on CLI
   *  2.1.218/2.1.220 (real Agent-tool spikes): the sub-agent's own assistant text/thinking
   *  is NEVER streamed to the parent, so its NARRATIVE can only be reconstructed from this
   *  frame + `task-updated`/`task-progress`/`task-notification` below.
   *
   *  Its TOOL CALLS, however, ARE streamed to the parent — as ordinary `assistant`
   *  tool_use frames (and `user` tool_result frames) carrying a top-level
   *  `parent_tool_use_id`. Those are deliberately dropped from the parent transcript
   *  (see {@link frameParent}) rather than rendered: this card is the sub-agent's
   *  representation here, and its step-by-step belongs in the drill-in. */
  | { kind: 'task-started'; taskId: string; toolUseId?: string; description: string; subagentType?: string; taskType?: string; prompt?: string }
  /** A lifecycle status patch for an already-started task (e.g. `status:'completed'`). */
  | { kind: 'task-updated'; taskId: string; status?: string; endTime?: number }
  /** Live progress for a still-running task, emitted once per tool use (verified on CLI
   *  2.1.220: 7 frames over a ~68s run). The ONLY channel that reports what a sub-agent is
   *  doing right now — `activity` is a fresh description of the current step ("Running List
   *  directory contents of /usr/share"), NOT the task's static name — plus running usage
   *  totals. `usage.durationMs` here is the CLI's own measure of the run so far. */
  | { kind: 'task-progress'; taskId: string; toolUseId?: string; activity?: string; subagentType?: string; lastToolName?: string; summary?: string; usage?: TaskUsage }
  /** The sub-agent's own run finished (or reported progress): final status, a short
   *  summary, and usage totals. `outputFile` (the sub-agent's own transcript path) is
   *  carried through but is NOT trusted/used client-side — the drill-in transcript is
   *  fetched via the server-derived `?subagent=` history route instead (see
   *  agent-chat.ts), never from this client-visible path. */
  | { kind: 'task-notification'; taskId: string; toolUseId?: string; status?: string; outputFile?: string; summary?: string; usage?: TaskUsage }
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
  /** The CLI has no usable credentials, so the turn never reached the API. Empirically
   *  verified against CLI 2.1.220 in an isolated unauthenticated HOME: the frame is an
   *  ordinary `assistant` text block carrying `model:'<synthetic>'`, `is_api_error_message:
   *  true` and `error:'authentication_failed'`, with the text "Not logged in · Please run
   *  /login" (and a matching `result` frame with `terminal_reason:'api_error'`).
   *
   *  Split out from `assistant-text` because the remedy is not in this surface at all: the
   *  headless engine answers `/login` with "/login isn't available in this environment."
   *  (also verified) — the OAuth flow only exists in the interactive TUI. The UI turns this
   *  into a sign-in card that opens a terminal session instead of showing the user a dead end. */
  | { kind: 'auth-required'; text: string }
  /** The machine signed into a DIFFERENT Claude account while this session was open. The
   *  process behind it read its credentials at startup and is still using the old ones, so
   *  it has to be restarted to follow — `restart` is the server's judgement on whether doing
   *  so would actually help (see claude-auth-watch.ts's `isRestartable`: only a confirmed
   *  sign-in qualifies; restarting onto a signed-out or unknown state makes things worse).
   *  `identity` is a display label ("someone@example.com · team"), possibly empty. */
  | { kind: 'auth-changed'; identity: string; restart: boolean; loggedIn: boolean | null }
  /** `parentToolUseId` present ⇒ this is a result for a tool a SUB-AGENT called, not the
   *  main agent (the parent's own final Agent-tool result carries none — spike-verified),
   *  so the parent transcript must not open or close a card for it. */
  | { kind: 'tool-result'; toolUseId: string; content: unknown; isError: boolean; agentResult?: SubAgentResult; parentToolUseId?: string }
  /** A `control_response` ack for a control request WE sent (set_model / rewind_conversation).
   *  `payload` is the CLI's nested `response` object when present (e.g. rewind's
   *  `{rewound, prefillText, precedingAssistantUuid, error?}`). */
  | { kind: 'control-ack'; requestId: string; ok: boolean; payload?: Record<string, unknown>; error?: string }
  /** `requiresInteraction` marks a request the CLI flagged `requires_user_interaction` that
   *  nonetheless carried NEITHER a plan nor a single parseable question — the answerable
   *  fallback (see {@link fromControlRequest}). It is what tells the session never to
   *  auto-allow this one from "always allow this session": the CLI asked for a person. */
  | { kind: 'permission-request'; requestId: string; toolName: string; displayName?: string; input: unknown; description?: string; suggestions?: unknown[]; toolUseId?: string; requiresInteraction?: boolean }
  | { kind: 'question'; requestId: string; toolName: string; questions: QuestionSpec[] }
  /** ExitPlanMode's approval gate — a `can_use_tool` request flagged
   *  `requires_user_interaction` whose input is `{plan, planFilePath}` rather than
   *  `{questions}` (captured on CLI 2.1.220). Answering it `allow` is what actually leaves
   *  plan mode: the very next tool call writes to disk. */
  | { kind: 'plan-review'; requestId: string; toolName: string; plan: string; planFilePath?: string; input: unknown }
  | { kind: 'result'; success: boolean; text?: string; costUsd?: number; usage?: Record<string, unknown>; numTurns?: number; permissionDenials?: unknown[] }
  /** The server's cached slash-command list for this project, sent at connect. Carries the
   *  same payload `init.slashCommands` does; whichever arrives later wins. */
  | { kind: 'slash-commands'; commands: string[] }
  /** The opening prompt the SERVER auto-submitted for us (a sleep / brain-resolve / delegate
   *  spawn), echoed back so the transcript can render it as the first user message — the
   *  client never types it, and with `promptToken` never even sees it. */
  | { kind: 'prompt-echo'; text: string }
  | { kind: 'meta-exit'; code: number | null }
  | { kind: 'meta-error'; message: string }
  /** The server's fresh-session branch guard reporting what it did to the working tree.
   *  `warn` for a refusal, `info` for a move it made. See `fromMeta`. */
  | { kind: 'branch-start'; tone: 'info' | 'warn'; message: string }
  | { kind: 'ignored'; rawType: string };

// ─── Render urgency ───────────────────────────────────────────────────────────────

/**
 * The event kinds a renderer may safely COALESCE into one commit per frame — the
 * high-frequency arms that carry a fraction of a message each. Everything not listed is
 * urgent by construction, which is the load-bearing default: a kind added to `ChatEvent`
 * later must delay nothing until somebody has decided it is safe to delay.
 */
const COALESCABLE_KINDS: ReadonlySet<ChatEvent['kind']> = new Set<ChatEvent['kind']>([
  // One per streamed token.
  'text-delta',
  'thinking-delta',
  // Block framing brackets those deltas — same rate, same nothing-to-act-on.
  'block-start',
  'block-stop',
  // A fan-out of sub-agents emits these continuously for the whole run.
  'task-progress',
  'background-tasks',
  // Noise the reducer discards anyway.
  'ignored',
]);

/**
 * Does this event need to reach the screen THIS tick, or may it ride the next frame?
 *
 * Urgent means "the user is waiting to act on it, or the turn's shape just changed": a
 * permission card, a question, a plan to approve, the result frame, the process exiting, a
 * missing credential. Delaying any of those by even a frame is user-visible latency on an
 * interaction — the exact thing coalescing must never buy performance with.
 *
 * Pure, and deliberately kind-only: the decision must not depend on session state, so the
 * same frame always answers the same way.
 */
export function isUrgentChatEvent(ev: ChatEvent): boolean {
  return !COALESCABLE_KINDS.has(ev.kind);
}

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
   *  control_request (`mode: 'auto' | 'bypassPermissions'`). Present on CLI 2.1.220's
   *  headless engine; the ack (matched by this CLIENT-generated `requestId`) is what tells
   *  the caller whether the switch actually landed, so a rejection can fall back to
   *  respawning the same conversation in the new mode. */
  | { type: 'setPermissionMode'; requestId: string; mode: 'auto' | 'bypass' }
  /** Stop a background shell — the server translates this into a `stop_task`
   *  control_request (`{subtype:'stop_task', task_id}`), which the CLI honours with zero
   *  model tokens (empirically verified on 2.1.220).
   *
   *  No `requestId`: the ack is worthless as confirmation — the CLI answers
   *  `{subtype:'success', response:{}}` even for a task_id that does not exist — so there
   *  is nothing for a client-generated id to usefully match. The REAL confirmation is the
   *  `task-updated`/`background-tasks` frames that follow, which the reducer applies. */
  | { type: 'stopTask'; taskId: string }
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
// Empirically verified on CLI 2.1.218 (task_nQb0y85X round 3) and re-spiked whole on
// 2.1.220: a dispatched sub-agent's stream carries `system:task_started` → a top-level
// `user` frame (parent_tool_use_id + prompt echo, intentionally NOT surfaced as its own
// event — the delegated prompt is already carried on `task-started.prompt`) → the
// sub-agent's OWN tool_use/tool_result frames, each stamped with the same top-level
// `parent_tool_use_id` and dropped from the parent transcript (see {@link frameParent}) →
// `system:task_progress` (one per tool use — the live heartbeat that legitimately reports
// what it is doing) → `system:task_updated` → `system:task_notification` → a final `user`
// tool_result with NO parent_tool_use_id: the parent's own Agent-call result (handled by
// `fromUserFrame`/`fromAssistant` as an ordinary `tool-result`, correlated client-side by
// `toolUseId`). A missing `task_id` (or, for task_started, a missing `description`)
// degrades to `ignored` rather than emitting a half-formed event nothing downstream can
// key by.

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

/** `{total_tokens, tool_uses, duration_ms}` → {@link TaskUsage}. Shared by the progress and
 *  notification frames, which carry the identical shape. */
function taskUsageOf(obj: Record<string, unknown>): TaskUsage | undefined {
  const raw = isRecord(obj.usage) ? obj.usage : undefined;
  if (!raw) return undefined;
  return {
    totalTokens: typeof raw.total_tokens === 'number' ? raw.total_tokens : undefined,
    toolUses: typeof raw.tool_uses === 'number' ? raw.tool_uses : undefined,
    durationMs: typeof raw.duration_ms === 'number' ? raw.duration_ms : undefined,
  };
}

/**
 * `system:task_progress` — the live heartbeat for a running task. Its `description` is the
 * CURRENT step, not the task's name, so it is mapped to `activity` rather than being allowed
 * anywhere near the row's title (overwriting the title with it would make a run rename itself
 * on every tool call).
 */
function fromTaskProgress(obj: Record<string, unknown>): ChatEvent {
  const taskId = str(obj.task_id);
  if (!taskId) return ignored('system:task_progress');
  return {
    kind: 'task-progress',
    taskId,
    toolUseId: str(obj.tool_use_id),
    activity: str(obj.description),
    subagentType: str(obj.subagent_type),
    lastToolName: str(obj.last_tool_name),
    summary: str(obj.summary),
    usage: taskUsageOf(obj),
  };
}

/**
 * `system:background_tasks_changed` → the running roster. An entry without a `task_id` is
 * dropped (nothing downstream could key by it) rather than invalidating the whole frame; an
 * EMPTY roster is a meaningful, load-bearing value (it is how "the last shell just ended"
 * is reported), so unlike the `task_*` mappers this one never degrades to `ignored` for
 * lack of entries.
 */
function fromBackgroundTasksChanged(obj: Record<string, unknown>): ChatEvent {
  const raw = Array.isArray(obj.tasks) ? obj.tasks : [];
  const tasks: BackgroundTaskEntry[] = [];
  for (const t of raw) {
    if (!isRecord(t)) continue;
    const taskId = str(t.task_id);
    if (!taskId) continue;
    tasks.push({ taskId, taskType: str(t.task_type), description: str(t.description) });
  }
  return { kind: 'background-tasks', tasks };
}

function fromTaskNotification(obj: Record<string, unknown>): ChatEvent {
  const taskId = str(obj.task_id);
  if (!taskId) return ignored('system:task_notification');
  const usage = taskUsageOf(obj);
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

// ─── Sub-agent attribution (`parent_tool_use_id`) ─────────────────────────────────
//
// WHERE THE FIELD ACTUALLY LIVES: on the FRAME, never on the content block. Verified on
// CLI 2.1.220 by spiking a real Agent dispatch and dumping every frame — a sub-agent's
// tool call arrives as an ordinary `assistant` frame with top-level
// `parent_tool_use_id: <the Agent call's id>` while its `content[0].parent_tool_use_id` is
// absent. Reading the block was the bug that leaked every sub-agent tool call into the
// parent transcript: the extraction always came back undefined, so nothing downstream
// could tell a sub-agent's Read/Bash from the main agent's own.
//
// The block-level read is kept as a fallback (a future CLI may mirror it there) but the
// frame is authoritative.

/** The spawning `Agent`/`Task` call's `tool_use_id` when this FRAME belongs to a
 *  sub-agent's own turn, else undefined. The single gate for "is this the main agent?". */
function frameParent(frame: Record<string, unknown>): string | undefined {
  return str(frame.parent_tool_use_id);
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
  const parent = frameParent(obj);
  // A SUB-AGENT's partial messages are dropped WHOLE, not attributed. Two reasons, both
  // structural: this surface represents a sub-agent by its `SubAgentCard` (its transcript is
  // read by drilling in), and `index` is scoped to the emitting message — a sidechain's
  // block 0 and the main agent's block 0 are different blocks, so letting them share the
  // reducer's `openBlocksByIndex` map would splice a sub-agent's deltas into the parent's own
  // text bubble. The CLI does not stream sidechain partials today (spike-verified on 2.1.220:
  // only whole `assistant` frames arrive); this keeps that from becoming a corruption bug the
  // day it does.
  if (parent) return ignored('stream_event:subagent');
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
  if (frameParent(frame)) return undefined;
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

/**
 * The `tool_use_result` SIBLING of `message` on a top-level `user` tool_result frame →
 * {@link SubAgentResult}, when it is an Agent-tool result. Empirically verified on CLI
 * 2.1.220 (both dispatch modes spiked):
 *
 *   async  → `{isAsync, status:'async_launched', agentId, description, resolvedModel,
 *             prompt, outputFile, canReadOutputFile}`
 *   sync   → `{status:'completed', agentId, agentType, content, resolvedModel,
 *             totalDurationMs, totalTokens, totalToolUseCount, usage, toolStats}`
 *
 * Gated on `agentId`, which every Agent-tool result carries and no other tool's result does
 * — so a Bash or Read result's own `tool_use_result` (a completely different shape) can
 * never be mistaken for a sub-agent's accounting. Returns undefined for everything else.
 *
 * NOTE: reasoning effort is deliberately absent — it appears on NO channel the CLI exposes
 * (not `task_*`, not here, not the sub-agent's own sidechain transcript, not the
 * SubagentStart hook payload), and the Agent tool has no `effort` parameter. A run's effort
 * is therefore unknowable client-side and is never displayed rather than guessed from the
 * parent session's level.
 */
function fromToolUseResult(obj: Record<string, unknown>): SubAgentResult | undefined {
  const raw = isRecord(obj.tool_use_result) ? obj.tool_use_result : undefined;
  if (!raw) return undefined;
  const agentId = str(raw.agentId);
  if (!agentId) return undefined;
  const modelsUsed = Array.isArray(raw.modelsUsed)
    ? raw.modelsUsed.filter((m): m is string => typeof m === 'string' && !!m)
    : undefined;
  return {
    agentId,
    resolvedModel: str(raw.resolvedModel),
    modelsUsed: modelsUsed?.length ? modelsUsed : undefined,
    totalDurationMs: typeof raw.totalDurationMs === 'number' ? raw.totalDurationMs : undefined,
    totalTokens: typeof raw.totalTokens === 'number' ? raw.totalTokens : undefined,
    totalToolUseCount: typeof raw.totalToolUseCount === 'number' ? raw.totalToolUseCount : undefined,
  };
}

/**
 * Whether an `assistant` frame is the CLI's "no usable credentials" notice rather than a
 * model reply. Exported for the unit fixtures: the shape is the CLI's, not ours, so it is
 * pinned by a test against the real frame captured from an unauthenticated run.
 *
 * `error === 'authentication_failed'` is the CLI's own discriminant and the primary gate.
 * The text probe is the fallback for the same condition worded differently by a later CLI
 * (an expired OAuth token and a rejected API key both land here) — it is deliberately
 * narrow: only an `is_api_error_message` frame that names `/login` as the remedy qualifies,
 * so a model that merely mentions logging in can never be mistaken for one.
 */
export function isAuthFailure(frame: Record<string, unknown>, text: string): boolean {
  if (str(frame.error) === 'authentication_failed') return true;
  return bool(frame.is_api_error_message) && /(^|\s)\/login\b/.test(text);
}

function fromAssistant(obj: Record<string, unknown>): ChatEvent {
  const message = isRecord(obj.message) ? obj.message : {};
  const content = message.content;
  if (!Array.isArray(content) || content.length === 0) return ignored('assistant:no_content');
  const block = content.find((c) => isRecord(c)) as Record<string, unknown> | undefined;
  if (!block) return ignored('assistant:no_content');
  const blockType = str(block.type);
  const turnUsage = usageOf(obj, message);
  // FRAME first, block as fallback — see the `frameParent` note. This is what tells a
  // sub-agent's own Read/Bash from the main agent's; reading only the block (which never
  // carries it) is what leaked every sub-agent tool call into the parent transcript.
  const parentToolUseId = frameParent(obj) ?? str(block.parent_tool_use_id);
  if (blockType === 'tool_use' && typeof block.name === 'string' && typeof block.id === 'string') {
    return {
      kind: 'assistant-tool-use',
      toolUseId: block.id,
      name: block.name,
      input: 'input' in block ? block.input : undefined,
      parentToolUseId,
      turnUsage,
    };
  }
  if (blockType === 'tool_result' && typeof block.tool_use_id === 'string') {
    return {
      kind: 'tool-result',
      toolUseId: block.tool_use_id,
      content: 'content' in block ? block.content : undefined,
      isError: bool(block.is_error),
      agentResult: fromToolUseResult(obj),
      parentToolUseId,
    };
  }
  if (blockType === 'text' && typeof block.text === 'string' && block.text) {
    // Credentials, not content: this text is a local notice about a turn that never ran, and
    // its fix lives in the terminal surface (see the `auth-required` doc comment). The `error`
    // discriminant is the CLI's own; the text probe is the belt-and-braces for a future
    // wording of the same condition that drops the field but still names the command.
    if (isAuthFailure(obj, block.text)) return { kind: 'auth-required', text: block.text };
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
 * The interaction discriminator: `requires_user_interaction === true` on the request payload
 * marks a `can_use_tool` request the CLI wants a PERSON to answer, rather than a plain
 * tool-permission prompt (verified empirically — the field is absent/false on ordinary
 * Write/Bash/etc. prompts). It does NOT mean "AskUserQuestion": ExitPlanMode carries the
 * same flag with a wholly different payload (see {@link parsePlan}), so the flag selects the
 * INTERACTIVE family and the input's shape picks the member.
 *
 * A malformed `questions` array (missing/non-array, or an entry missing `question`/
 * `options`) is dropped from the list rather than throwing.
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

/**
 * ExitPlanMode's payload — `{plan: "<markdown>", planFilePath: "~/.claude/plans/….md"}`,
 * captured verbatim from CLI 2.1.220. Shape-keyed rather than name-keyed, for the same
 * reason the question/permission split is: the flag names the family, the payload names the
 * member, and a future interactive tool that presents a plan gets the right card for free.
 */
function parsePlan(input: unknown): { plan: string; planFilePath?: string } | null {
  if (!isRecord(input)) return null;
  const plan = str(input.plan);
  return plan ? { plan, planFilePath: str(input.planFilePath) } : null;
}

function fromControlRequest(obj: Record<string, unknown>): ChatEvent {
  const requestId = str(obj.request_id) ?? '';
  const request = isRecord(obj.request) ? obj.request : {};
  const subtype = str(request.subtype);
  if (subtype !== 'can_use_tool') return ignored('control_request:' + (subtype ?? 'unknown'));

  const toolName = str(request.tool_name) ?? '';
  const input = request.input;
  const interactive = bool(request.requires_user_interaction);
  if (interactive) {
    const plan = parsePlan(input);
    if (plan) return { kind: 'plan-review', requestId, toolName, plan: plan.plan, planFilePath: plan.planFilePath, input };
    const questions = parseQuestions(input);
    if (questions.length) return { kind: 'question', requestId, toolName, questions };
    // Neither shape. This USED to emit a `question` with an empty list, which rendered a
    // survey card with no question, no options and a dead Submit — the turn could not be
    // answered from Chat at all (owner report 07-26: ExitPlanMode, before it had a card of
    // its own, landed here). Falling through to the permission card instead means the
    // worst case for ANY future interactive tool this parser doesn't know is a card that
    // still shows the raw request and can still answer it, never a card that strands the turn.
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
    requiresInteraction: interactive || undefined,
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
  // The opening prompt the server submitted on our behalf (see agent-chat.ts's echo note).
  if (subtype === 'prompt_echo') {
    const text = str(obj.text);
    return text ? { kind: 'prompt-echo', text } : ignored('_meta:prompt_echo');
  }
  // The user signed into another Claude account (server-detected — claude-auth-watch.ts).
  // `restart` and `loggedIn` are read STRICTLY: anything that is not a literal `true` /
  // boolean is the conservative answer, because the fallback for both is "do nothing to a
  // running session", and a malformed frame must never be the thing that kills one.
  // What the fresh-session branch guard did to the working tree, or declined to do
  // (src/lib/session-start-branch.ts). Only the outcomes that are NEWS are sent, so anything
  // that arrives here is worth putting in front of the user: `switched` mutated their checkout,
  // `blocked-dirty` left them somewhere they were told new sessions would not start.
  if (subtype === 'branch_start') {
    const message = str(obj.message);
    if (!message) return ignored('_meta:branch_start');
    // Read strictly, and default to the non-alarming tone: an unrecognised kind from a newer
    // server must not paint an ordinary message as a refusal.
    const kind = obj.kind === 'blocked-dirty' || obj.kind === 'failed' ? 'warn' : 'info';
    return { kind: 'branch-start', tone: kind, message };
  }
  if (subtype === 'auth_changed') {
    return {
      kind: 'auth-changed',
      identity: str(obj.identity) ?? '',
      restart: obj.restart === true,
      loggedIn: typeof obj.loggedIn === 'boolean' ? obj.loggedIn : null,
    };
  }
  return ignored('_meta:' + (subtype ?? 'unknown'));
}

// ─── system (init, or noise) ────────────────────────────────────────────────────────

function fromSystem(obj: Record<string, unknown>): ChatEvent {
  const subtype = str(obj.subtype);
  if (subtype === 'init') return fromSystemInit(obj);
  if (subtype === 'task_started') return fromTaskStarted(obj);
  if (subtype === 'task_updated') return fromTaskUpdated(obj);
  if (subtype === 'task_progress') return fromTaskProgress(obj);
  if (subtype === 'task_notification') return fromTaskNotification(obj);
  if (subtype === 'background_tasks_changed') return fromBackgroundTasksChanged(obj);
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
