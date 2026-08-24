/**
 * Unit tests for chatProtocol.ts — the pure NDJSON → typed-event parser behind the
 * Agent Chat view (beta), task_nQb0y85X (AC11). Every fixture line below is a
 * realistic raw stream-json frame from the empirically-verified `claude` CLI 2.1.218
 * protocol (spike results recorded in the task); this file asserts `parseChatLine`
 * maps each one to the exact typed `ChatEvent` the module documents, that noise
 * frames degrade to `{kind:'ignored'}` rather than throwing, that malformed/partial
 * lines return `null`, and that `buildQuestionAnswer` builds the load-bearing
 * AskUserQuestion reply shape.
 *
 * A `tool_result` content block is echoed back to the model on a top-level
 * `type: 'user'` frame (the Anthropic Messages API's turn convention — confirmed
 * against this repo's own transcript parser, `src/server/routes/agent-terminal.ts:591`).
 * `toChatEvent` routes `'user'` through the same content-block extraction as
 * `'assistant'` (`fromAssistant`), so a real tool_result frame surfaces as a
 * `tool-result` event — see the dedicated describe block below.
 */
import { describe, it, expect } from 'vitest';
import {
  parseChatLine, buildQuestionAnswer, isUrgentChatEvent,
  type QuestionSpec, type ChatEvent,
} from '../../dashboard/src/lib/chatProtocol.js';

// ─── Fixture lines (realistic claude 2.1.218 stream-json frames) ──────────────────

const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const PERMISSION_REQUEST_ID = '22222222-3333-4444-5555-666666666666';
const QUESTION_REQUEST_ID = '33333333-4444-5555-6666-777777777777';
const PLAN_REQUEST_ID = '44444444-5555-6666-7777-888888888888';
const TOOL_USE_ID = 'toolu_01ABCDEF';

const SYSTEM_INIT = JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: SESSION_ID,
  model: 'claude-sonnet-5',
  permissionMode: 'auto',
  capabilities: ['interrupt_receipt_v1', 'partial_messages_v1'],
  claude_code_version: '2.1.218',
});

const TASK_ID = 'task_01abc';
const AGENT_TOOL_USE_ID = 'toolu_01AGENT';

// Sub-agent lifecycle fixtures (state 9) — realistic shapes from the round-3 Task-tool
// spike (task_nQb0y85X): the spawning tool streams as name "Agent" on CLI 2.1.218.
const SYSTEM_TASK_STARTED = JSON.stringify({
  type: 'system',
  subtype: 'task_started',
  task_id: TASK_ID,
  tool_use_id: AGENT_TOOL_USE_ID,
  description: 'Investigate the flaky recall-eval test',
  subagent_type: 'general-purpose',
  task_type: 'investigation',
  prompt: 'Find out why tests/unit/recall-eval.test.ts flakes on CI.',
  uuid: 'bbbbbbbb-1111-2222-3333-444444444444',
  session_id: SESSION_ID,
});
const SYSTEM_TASK_UPDATED = JSON.stringify({
  type: 'system',
  subtype: 'task_updated',
  task_id: TASK_ID,
  patch: { status: 'completed', end_time: 1732400000000 },
});
const SYSTEM_TASK_NOTIFICATION = JSON.stringify({
  type: 'system',
  subtype: 'task_notification',
  task_id: TASK_ID,
  tool_use_id: AGENT_TOOL_USE_ID,
  status: 'completed',
  output_file: '/Users/x/.claude/projects/-Users-x-proj/session-uuid/subagents/agent-task_01abc.jsonl',
  summary: 'Root cause: a shared temp dir race between two parallel test files.',
  usage: { total_tokens: 48213, tool_uses: 9, duration_ms: 41230 },
});
const SYSTEM_TASK_STARTED_NO_ID = JSON.stringify({ type: 'system', subtype: 'task_started', description: 'no id' });
const SYSTEM_UNKNOWN_SUBTYPE = JSON.stringify({ type: 'system', subtype: 'some_future_subtype', foo: 'bar' });

const SYSTEM_HOOK_STARTED = JSON.stringify({ type: 'system', subtype: 'hook_started', hook_event_name: 'UserPromptSubmit' });
const SYSTEM_HOOK_RESPONSE = JSON.stringify({ type: 'system', subtype: 'hook_response', hook_event_name: 'UserPromptSubmit', output: '' });
const SYSTEM_STATUS = JSON.stringify({ type: 'system', subtype: 'status', message: 'Compacting…' });
const SYSTEM_THINKING_TOKENS = JSON.stringify({ type: 'system', subtype: 'thinking_tokens', tokens: 1024 });
const RATE_LIMIT_EVENT = JSON.stringify({ type: 'rate_limit_event', status: 'ok' });

const STREAM_MESSAGE_START = JSON.stringify({
  type: 'stream_event',
  event: { type: 'message_start', message: { id: 'msg_01', role: 'assistant', model: 'claude-sonnet-5' } },
});
const STREAM_BLOCK_START_TEXT = JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
});
const STREAM_BLOCK_START_THINKING = JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } },
});
const STREAM_BLOCK_START_TOOL_USE = JSON.stringify({
  type: 'stream_event',
  event: {
    type: 'content_block_start',
    index: 2,
    content_block: { type: 'tool_use', id: TOOL_USE_ID, name: 'Write', input: {}, parent_tool_use_id: null },
  },
});
const STREAM_TEXT_DELTA = JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
});
const STREAM_THINKING_DELTA = JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'Let me think' } },
});
const STREAM_SIGNATURE_DELTA = JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'abc123' } },
});
const STREAM_BLOCK_STOP = JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_stop', index: 0 },
});
const STREAM_MESSAGE_DELTA = JSON.stringify({
  type: 'stream_event',
  event: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
});
const STREAM_MESSAGE_STOP = JSON.stringify({ type: 'stream_event', event: { type: 'message_stop' } });

const ASSISTANT_TOOL_USE = JSON.stringify({
  type: 'assistant',
  session_id: SESSION_ID,
  uuid: 'aaaaaaaa-0000-0000-0000-000000000000',
  message: {
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [{ type: 'tool_use', id: TOOL_USE_ID, name: 'Write', input: { file_path: '/tmp/x.txt', content: 'hi' }, parent_tool_use_id: null }],
  },
});

// Real tool_result frames arrive as type:'user' (see the file header) — toChatEvent
// routes 'user' through the same fromAssistant content-block extraction as 'assistant'.
const USER_TOOL_RESULT_OK = JSON.stringify({
  type: 'user',
  session_id: SESSION_ID,
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: TOOL_USE_ID, content: 'wrote 2 bytes', is_error: false }],
  },
});
const USER_TOOL_RESULT_ERROR = JSON.stringify({
  type: 'user',
  session_id: SESSION_ID,
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: TOOL_USE_ID, content: 'permission denied', is_error: true }],
  },
});

const CONTROL_REQUEST_PERMISSION = JSON.stringify({
  type: 'control_request',
  request_id: PERMISSION_REQUEST_ID,
  request: {
    subtype: 'can_use_tool',
    tool_name: 'Write',
    display_name: 'Write',
    input: { file_path: '/tmp/x.txt', content: 'hi' },
    description: 'Create a new file',
    permission_suggestions: [{ type: 'addRules', rules: ['Write(/tmp/**)'] }],
    tool_use_id: TOOL_USE_ID,
  },
});

const CONTROL_REQUEST_QUESTION = JSON.stringify({
  type: 'control_request',
  request_id: QUESTION_REQUEST_ID,
  request: {
    subtype: 'can_use_tool',
    tool_name: 'AskUserQuestion',
    requires_user_interaction: true,
    input: {
      questions: [
        {
          question: 'Which package manager should I use?',
          header: 'Package manager',
          options: [{ label: 'npm', description: 'Node default' }, { label: 'pnpm', description: 'Faster, strict' }],
          multiSelect: false,
        },
        {
          question: 'Which environments should get this fix?',
          header: 'Environments',
          options: [{ label: 'staging' }, { label: 'production' }, { label: 'dev' }],
          multiSelect: true,
        },
      ],
    },
  },
});

/** ExitPlanMode's approval gate, captured verbatim from CLI 2.1.220: the SAME
 *  `requires_user_interaction` flag AskUserQuestion carries, over a wholly different input. */
const CONTROL_REQUEST_PLAN = JSON.stringify({
  type: 'control_request',
  request_id: PLAN_REQUEST_ID,
  request: {
    subtype: 'can_use_tool',
    tool_name: 'ExitPlanMode',
    display_name: 'ExitPlanMode',
    input: {
      plan: '# Plan: Create hello.js\n\n## Approach\nAdd a single `hello()` function.\n',
      planFilePath: '/Users/x/.claude/plans/tranquil-volcano.md',
    },
    tool_use_id: TOOL_USE_ID,
    requires_user_interaction: true,
  },
});

/** The third shape: flagged interactive, but neither a plan nor a parseable question. */
const CONTROL_REQUEST_INTERACTIVE_UNKNOWN = JSON.stringify({
  type: 'control_request',
  request_id: PLAN_REQUEST_ID,
  request: {
    subtype: 'can_use_tool',
    tool_name: 'SomeFutureAskingTool',
    input: { somethingElse: true },
    requires_user_interaction: true,
  },
});

const RESULT_SUCCESS = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Done — created the file.',
  session_id: SESSION_ID,
  total_cost_usd: 0.0234,
  usage: { input_tokens: 120, output_tokens: 340, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  num_turns: 3,
  permission_denials: [],
});
const RESULT_ERROR = JSON.stringify({
  type: 'result',
  subtype: 'error',
  is_error: true,
  result: 'The model returned an error.',
  session_id: SESSION_ID,
});

const META_EXIT = JSON.stringify({ type: '_meta', subtype: 'exit', code: 0 });
const META_EXIT_NULL_CODE = JSON.stringify({ type: '_meta', subtype: 'exit' });
const META_ERROR = JSON.stringify({ type: '_meta', subtype: 'error', message: "Couldn't start claude: spawn ENOENT" });

const NON_JSON = 'not json at all';
const PARTIAL_JSON = '{"type":"system"'; // a mid-stream truncated chunk
const EMPTY_LINE = '';
const WHITESPACE_LINE = '   \n';

/** Every fixture line, realistic and malformed alike — the "never throws" sweep. */
const LINES: string[] = [
  SYSTEM_INIT, SYSTEM_HOOK_STARTED, SYSTEM_HOOK_RESPONSE, SYSTEM_STATUS, SYSTEM_THINKING_TOKENS, RATE_LIMIT_EVENT,
  SYSTEM_TASK_STARTED, SYSTEM_TASK_UPDATED, SYSTEM_TASK_NOTIFICATION, SYSTEM_TASK_STARTED_NO_ID, SYSTEM_UNKNOWN_SUBTYPE,
  STREAM_MESSAGE_START, STREAM_BLOCK_START_TEXT, STREAM_BLOCK_START_THINKING, STREAM_BLOCK_START_TOOL_USE,
  STREAM_TEXT_DELTA, STREAM_THINKING_DELTA, STREAM_SIGNATURE_DELTA, STREAM_BLOCK_STOP, STREAM_MESSAGE_DELTA, STREAM_MESSAGE_STOP,
  ASSISTANT_TOOL_USE, USER_TOOL_RESULT_OK, USER_TOOL_RESULT_ERROR,
  CONTROL_REQUEST_PERMISSION, CONTROL_REQUEST_QUESTION,
  RESULT_SUCCESS, RESULT_ERROR,
  META_EXIT, META_EXIT_NULL_CODE, META_ERROR,
  NON_JSON, PARTIAL_JSON, EMPTY_LINE, WHITESPACE_LINE,
];

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe('parseChatLine — system frames', () => {
  it('system:init → a typed init event with capabilities/model/version', () => {
    expect(parseChatLine(SYSTEM_INIT)).toEqual({
      kind: 'init',
      sessionId: SESSION_ID,
      model: 'claude-sonnet-5',
      permissionMode: 'auto',
      capabilities: ['interrupt_receipt_v1', 'partial_messages_v1'],
      version: '2.1.218',
    });
  });

  it('system hook/status/thinking-tokens noise → ignored, never thrown', () => {
    expect(parseChatLine(SYSTEM_HOOK_STARTED)).toEqual({ kind: 'ignored', rawType: 'system:hook_started' });
    expect(parseChatLine(SYSTEM_HOOK_RESPONSE)).toEqual({ kind: 'ignored', rawType: 'system:hook_response' });
    expect(parseChatLine(SYSTEM_STATUS)).toEqual({ kind: 'ignored', rawType: 'system:status' });
    expect(parseChatLine(SYSTEM_THINKING_TOKENS)).toEqual({ kind: 'ignored', rawType: 'system:thinking_tokens' });
  });

  it('rate_limit_event (top-level, not a system subtype) → ignored', () => {
    expect(parseChatLine(RATE_LIMIT_EVENT)).toEqual({ kind: 'ignored', rawType: 'rate_limit_event' });
  });
});

describe('parseChatLine — system:task_* (sub-agent lifecycle, state 9)', () => {
  it('task_started → a typed task-started event with the spawning tool_use_id + full description/subagent_type/task_type/prompt', () => {
    expect(parseChatLine(SYSTEM_TASK_STARTED)).toEqual({
      kind: 'task-started',
      taskId: TASK_ID,
      toolUseId: AGENT_TOOL_USE_ID,
      description: 'Investigate the flaky recall-eval test',
      subagentType: 'general-purpose',
      taskType: 'investigation',
      prompt: 'Find out why tests/unit/recall-eval.test.ts flakes on CI.',
    });
  });

  it('task_updated → a task-updated event carrying the patch.status/end_time', () => {
    expect(parseChatLine(SYSTEM_TASK_UPDATED)).toEqual({
      kind: 'task-updated',
      taskId: TASK_ID,
      status: 'completed',
      endTime: 1732400000000,
    });
  });

  it('task_notification → a task-notification event with status/summary/usage (usage keys mapped from snake_case)', () => {
    expect(parseChatLine(SYSTEM_TASK_NOTIFICATION)).toEqual({
      kind: 'task-notification',
      taskId: TASK_ID,
      toolUseId: AGENT_TOOL_USE_ID,
      status: 'completed',
      outputFile: '/Users/x/.claude/projects/-Users-x-proj/session-uuid/subagents/agent-task_01abc.jsonl',
      summary: 'Root cause: a shared temp dir race between two parallel test files.',
      usage: { totalTokens: 48213, toolUses: 9, durationMs: 41230 },
    });
  });

  it('a task_started missing task_id/description degrades to ignored, not a half-formed event', () => {
    expect(parseChatLine(SYSTEM_TASK_STARTED_NO_ID)).toEqual({ kind: 'ignored', rawType: 'system:task_started' });
  });

  // ── Sub-agent tool attribution. The frames below are the ACTUAL shapes captured from a
  //    real Agent dispatch on CLI 2.1.220 (one sub-agent, one Bash inside it). The load-
  //    bearing detail: `parent_tool_use_id` is on the FRAME, and `content[0]` has NONE. The
  //    parser used to read only the block, so the extraction always came back undefined and
  //    every sub-agent tool call rendered in the PARENT transcript as if the main agent had
  //    run it — with 3 sub-agents going, the user saw a stream of Reads and Bashes nothing in
  //    the UI attributed to anyone.
  it("a sub-agent's tool_use is attributed from the FRAME's parent_tool_use_id, not the content block (which never carries it)", () => {
    const frame = JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: AGENT_TOOL_USE_ID,
      message: {
        role: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        content: [{ type: 'tool_use', id: 'toolu_01SUBBASH', name: 'Bash', input: { command: 'ls' } }],
      },
    });
    expect(parseChatLine(frame)).toMatchObject({
      kind: 'assistant-tool-use',
      toolUseId: 'toolu_01SUBBASH',
      name: 'Bash',
      parentToolUseId: AGENT_TOOL_USE_ID,
    });
  });

  it("a sub-agent's tool_result carries the same frame-level attribution, so the reducer can refuse to card it", () => {
    const frame = JSON.stringify({
      type: 'user',
      parent_tool_use_id: AGENT_TOOL_USE_ID,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_01SUBBASH', content: 'a.ts\nb.ts' }],
      },
    });
    expect(parseChatLine(frame)).toMatchObject({
      kind: 'tool-result',
      toolUseId: 'toolu_01SUBBASH',
      parentToolUseId: AGENT_TOOL_USE_ID,
    });
  });

  it("the PARENT's own Agent-call result carries NO parent_tool_use_id — so gating on it never suppresses the main agent's own cards", () => {
    const frame = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: AGENT_TOOL_USE_ID, content: 'done' }] },
    });
    const ev = parseChatLine(frame);
    expect(ev).toMatchObject({ kind: 'tool-result', toolUseId: AGENT_TOOL_USE_ID });
    expect((ev as { parentToolUseId?: string }).parentToolUseId).toBeUndefined();
  });

  it("a sidechain stream_event is dropped WHOLE — its block `index` is per-message and would splice a sub-agent's deltas into the parent's own text block", () => {
    const frame = JSON.stringify({
      type: 'stream_event',
      parent_tool_use_id: AGENT_TOOL_USE_ID,
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    });
    expect(parseChatLine(frame)).toEqual({ kind: 'ignored', rawType: 'stream_event:subagent' });
  });

  it('a wholly unrecognized system subtype still degrades to ignored (task_* are additions, not a rewrite of the noise-tolerance contract)', () => {
    expect(parseChatLine(SYSTEM_UNKNOWN_SUBTYPE)).toEqual({ kind: 'ignored', rawType: 'system:some_future_subtype' });
  });
});

describe('parseChatLine — stream_event (raw Anthropic SSE deltas)', () => {
  it('content_block_start text/thinking → block-start with the right blockType', () => {
    expect(parseChatLine(STREAM_BLOCK_START_TEXT)).toEqual({ kind: 'block-start', index: 0, blockType: 'text' });
    expect(parseChatLine(STREAM_BLOCK_START_THINKING)).toEqual({ kind: 'block-start', index: 1, blockType: 'thinking' });
  });

  it('content_block_start tool_use → block-start carrying the tool identity + input up front', () => {
    expect(parseChatLine(STREAM_BLOCK_START_TOOL_USE)).toEqual({
      kind: 'block-start',
      index: 2,
      blockType: 'tool_use',
      toolName: 'Write',
      toolUseId: TOOL_USE_ID,
      toolInput: {},
    });
  });

  it('content_block_delta text_delta / thinking_delta → the matching delta event', () => {
    expect(parseChatLine(STREAM_TEXT_DELTA)).toEqual({ kind: 'text-delta', index: 0, text: 'Hello' });
    expect(parseChatLine(STREAM_THINKING_DELTA)).toEqual({ kind: 'thinking-delta', index: 1, text: 'Let me think' });
  });

  it('content_block_delta signature_delta → ignored (not rendered by the chat UI)', () => {
    expect(parseChatLine(STREAM_SIGNATURE_DELTA)).toEqual({ kind: 'ignored', rawType: 'stream_event:content_block_delta:signature_delta' });
  });

  it('content_block_stop → block-stop', () => {
    expect(parseChatLine(STREAM_BLOCK_STOP)).toEqual({ kind: 'block-stop', index: 0 });
  });

  it('message_start / message_delta / message_stop → tolerated as outer-message bookkeeping noise', () => {
    expect(parseChatLine(STREAM_MESSAGE_START)).toEqual({ kind: 'ignored', rawType: 'stream_event:message_start' });
    expect(parseChatLine(STREAM_MESSAGE_DELTA)).toEqual({ kind: 'ignored', rawType: 'stream_event:message_delta' });
    expect(parseChatLine(STREAM_MESSAGE_STOP)).toEqual({ kind: 'ignored', rawType: 'stream_event:message_stop' });
  });
});

describe('parseChatLine — assistant frame (tool_use fallback path)', () => {
  it('an assistant frame carrying a tool_use content block → assistant-tool-use', () => {
    expect(parseChatLine(ASSISTANT_TOOL_USE)).toEqual({
      kind: 'assistant-tool-use',
      toolUseId: TOOL_USE_ID,
      name: 'Write',
      input: { file_path: '/tmp/x.txt', content: 'hi' },
    });
  });
});

describe('parseChatLine — tool_result frames (type:"user")', () => {
  it('a successful tool_result on a type:"user" frame → tool-result, isError:false', () => {
    expect(parseChatLine(USER_TOOL_RESULT_OK)).toEqual({
      kind: 'tool-result',
      toolUseId: TOOL_USE_ID,
      content: 'wrote 2 bytes',
      isError: false,
    });
  });

  it('a failed tool_result (is_error:true) → tool-result, isError:true', () => {
    expect(parseChatLine(USER_TOOL_RESULT_ERROR)).toEqual({
      kind: 'tool-result',
      toolUseId: TOOL_USE_ID,
      content: 'permission denied',
      isError: true,
    });
  });
});

describe('parseChatLine — control_request (permission prompts + AskUserQuestion)', () => {
  it('can_use_tool WITHOUT requires_user_interaction → permission-request', () => {
    expect(parseChatLine(CONTROL_REQUEST_PERMISSION)).toEqual({
      kind: 'permission-request',
      requestId: PERMISSION_REQUEST_ID,
      toolName: 'Write',
      displayName: 'Write',
      input: { file_path: '/tmp/x.txt', content: 'hi' },
      description: 'Create a new file',
      suggestions: [{ type: 'addRules', rules: ['Write(/tmp/**)'] }],
      toolUseId: TOOL_USE_ID,
    });
  });

  it('can_use_tool WITH requires_user_interaction:true → question, with options + multiSelect parsed', () => {
    const ev = parseChatLine(CONTROL_REQUEST_QUESTION);
    expect(ev?.kind).toBe('question');
    if (ev?.kind !== 'question') throw new Error('expected a question event');
    expect(ev.requestId).toBe(QUESTION_REQUEST_ID);
    expect(ev.toolName).toBe('AskUserQuestion');
    expect(ev.questions).toEqual([
      {
        question: 'Which package manager should I use?',
        header: 'Package manager',
        options: [{ label: 'npm', description: 'Node default' }, { label: 'pnpm', description: 'Faster, strict' }],
        multiSelect: false,
      },
      {
        question: 'Which environments should get this fix?',
        header: 'Environments',
        options: [{ label: 'staging' }, { label: 'production' }, { label: 'dev' }],
        multiSelect: true,
      },
    ]);
  });

  it('the discriminator is requires_user_interaction, not the tool name', () => {
    // CONTROL_REQUEST_PERMISSION's tool is "Write" (a normal permission prompt) and
    // CONTROL_REQUEST_QUESTION's tool is "AskUserQuestion" WITH the flag — confirming the
    // parser keys off the flag, not off recognizing "AskUserQuestion" as a special name.
    expect(parseChatLine(CONTROL_REQUEST_PERMISSION)?.kind).toBe('permission-request');
    expect(parseChatLine(CONTROL_REQUEST_QUESTION)?.kind).toBe('question');
  });

  it('ExitPlanMode carries the SAME flag over a plan payload → plan-review, not an empty question', () => {
    // The regression this exists for: the flag alone used to route every interactive request
    // to the survey card, so a plan arrived as a `question` with zero questions and rendered
    // a card with nothing in it and a dead Submit.
    const ev = parseChatLine(CONTROL_REQUEST_PLAN);
    expect(ev?.kind).toBe('plan-review');
    if (ev?.kind !== 'plan-review') throw new Error('expected a plan-review event');
    expect(ev.requestId).toBe(PLAN_REQUEST_ID);
    expect(ev.toolName).toBe('ExitPlanMode');
    expect(ev.plan).toContain('# Plan: Create hello.js');
    expect(ev.planFilePath).toBe('/Users/x/.claude/plans/tranquil-volcano.md');
    // The original input, echoed back verbatim on allow — that answer is what leaves plan mode.
    expect(ev.input).toEqual({
      plan: '# Plan: Create hello.js\n\n## Approach\nAdd a single `hello()` function.\n',
      planFilePath: '/Users/x/.claude/plans/tranquil-volcano.md',
    });
  });

  it('an interactive request that is NEITHER a plan nor a question stays answerable (permission card), never a dead survey', () => {
    const ev = parseChatLine(CONTROL_REQUEST_INTERACTIVE_UNKNOWN);
    expect(ev?.kind).toBe('permission-request');
    if (ev?.kind !== 'permission-request') throw new Error('expected a permission-request event');
    expect(ev.toolName).toBe('SomeFutureAskingTool');
    expect(ev.input).toEqual({ somethingElse: true });
    // Marked interactive so "always allow this session" can never answer it for the user.
    expect(ev.requiresInteraction).toBe(true);
  });

  it('an AskUserQuestion whose questions are all malformed degrades to the answerable card too', () => {
    const line = JSON.stringify({
      type: 'control_request',
      request_id: QUESTION_REQUEST_ID,
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        requires_user_interaction: true,
        input: { questions: [{ header: 'no question text' }, 'not an object'] },
      },
    });
    expect(parseChatLine(line)?.kind).toBe('permission-request');
  });

  it('a plain permission request is NOT marked interactive', () => {
    const ev = parseChatLine(CONTROL_REQUEST_PERMISSION);
    if (ev?.kind !== 'permission-request') throw new Error('expected a permission-request event');
    expect(ev.requiresInteraction).toBeUndefined();
  });
});

describe('parseChatLine — result (final turn summary)', () => {
  it('a successful result → success:true with cost/usage/turns/denials', () => {
    expect(parseChatLine(RESULT_SUCCESS)).toEqual({
      kind: 'result',
      success: true,
      text: 'Done — created the file.',
      costUsd: 0.0234,
      usage: { input_tokens: 120, output_tokens: 340, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      numTurns: 3,
      permissionDenials: [],
    });
  });

  it('an error result → success:false', () => {
    const ev = parseChatLine(RESULT_ERROR);
    expect(ev?.kind).toBe('result');
    if (ev?.kind !== 'result') throw new Error('expected a result event');
    expect(ev.success).toBe(false);
    expect(ev.text).toBe('The model returned an error.');
  });
});

describe('parseChatLine — _meta (server-relay lifecycle frames)', () => {
  it('exit with a code → meta-exit', () => {
    expect(parseChatLine(META_EXIT)).toEqual({ kind: 'meta-exit', code: 0 });
  });

  it('exit with no code → meta-exit with code:null (never undefined)', () => {
    expect(parseChatLine(META_EXIT_NULL_CODE)).toEqual({ kind: 'meta-exit', code: null });
  });

  it('error → meta-error with the message', () => {
    expect(parseChatLine(META_ERROR)).toEqual({ kind: 'meta-error', message: "Couldn't start claude: spawn ENOENT" });
  });

  it('prompt_echo → prompt-echo carrying the server-submitted opening prompt (the transcript has no other way to show it)', () => {
    const line = JSON.stringify({ type: '_meta', subtype: 'prompt_echo', text: 'Run a full dreamcontext memory consolidation' });
    expect(parseChatLine(line)).toEqual({ kind: 'prompt-echo', text: 'Run a full dreamcontext memory consolidation' });
  });

  it('prompt_echo with an empty/missing text → ignored (never an empty user bubble)', () => {
    expect(parseChatLine(JSON.stringify({ type: '_meta', subtype: 'prompt_echo', text: '' })))
      .toEqual({ kind: 'ignored', rawType: '_meta:prompt_echo' });
    expect(parseChatLine(JSON.stringify({ type: '_meta', subtype: 'prompt_echo' })))
      .toEqual({ kind: 'ignored', rawType: '_meta:prompt_echo' });
  });

  it('auth_changed → auth-changed carrying the new account and the restart verdict', () => {
    const line = JSON.stringify({
      type: '_meta', subtype: 'auth_changed',
      identity: 'someone@example.com · team', restart: true, loggedIn: true,
    });
    expect(parseChatLine(line)).toEqual({
      kind: 'auth-changed', identity: 'someone@example.com · team', restart: true, loggedIn: true,
    });
  });

  it('auth_changed for a sign-OUT → reported, but restart:false (never kill a live session for it)', () => {
    const line = JSON.stringify({ type: '_meta', subtype: 'auth_changed', identity: '', restart: false, loggedIn: false });
    expect(parseChatLine(line)).toEqual({ kind: 'auth-changed', identity: '', restart: false, loggedIn: false });
  });

  it('auth_changed reads restart/loggedIn STRICTLY — a malformed frame can never kill a session', () => {
    // The fallback for both fields is "do nothing to the running process", so anything that
    // is not a literal boolean has to degrade to the conservative answer rather than to a
    // truthy one. A server bug must not become a restart.
    const line = JSON.stringify({ type: '_meta', subtype: 'auth_changed', restart: 'yes', loggedIn: 'true' });
    expect(parseChatLine(line)).toEqual({ kind: 'auth-changed', identity: '', restart: false, loggedIn: null });
  });
});

describe('parseChatLine — malformed / empty lines', () => {
  it('non-JSON text → null', () => {
    expect(parseChatLine(NON_JSON)).toBeNull();
  });

  it('a partial/truncated JSON chunk → null (not a throw)', () => {
    expect(parseChatLine(PARTIAL_JSON)).toBeNull();
  });

  it('an empty or whitespace-only line → null', () => {
    expect(parseChatLine(EMPTY_LINE)).toBeNull();
    expect(parseChatLine(WHITESPACE_LINE)).toBeNull();
  });
});

describe('parseChatLine — assistant full-message text/thinking echoes', () => {
  it('an assistant frame carrying a text block → assistant-text (the authoritative full text — the CLI can skip text_deltas entirely for short replies)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      session_id: SESSION_ID,
      message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'pong' }] },
    });
    expect(parseChatLine(line)).toEqual({ kind: 'assistant-text', text: 'pong', synthetic: false });
  });

  it('a <synthetic>-model assistant frame (local command echo, e.g. /effort) → assistant-text with synthetic: true', () => {
    const line = JSON.stringify({
      type: 'assistant',
      session_id: SESSION_ID,
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Set effort level to low' }] },
    });
    expect(parseChatLine(line)).toEqual({ kind: 'assistant-text', text: 'Set effort level to low', synthetic: true });
  });

  it('an assistant frame carrying a thinking block → assistant-thinking', () => {
    const line = JSON.stringify({
      type: 'assistant',
      session_id: SESSION_ID,
      message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'thinking', thinking: 'hmm', signature: 'sig' }] },
    });
    expect(parseChatLine(line)).toEqual({ kind: 'assistant-thinking', text: 'hmm' });
  });

  it('an EMPTY text block stays ignored (nothing to render, nothing to upgrade)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      session_id: SESSION_ID,
      message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: '' }] },
    });
    expect(parseChatLine(line)).toEqual({ kind: 'ignored', rawType: 'assistant:text' });
  });

  it("a USER frame's text block must NOT surface as assistant-text (synthetic nudges / local-command stdout are not assistant bubbles)", () => {
    const syntheticNudge = JSON.stringify({
      type: 'user',
      session_id: SESSION_ID,
      isSynthetic: true,
      message: { role: 'user', content: [{ type: 'text', text: '[Your previous response had no visible output.]' }] },
    });
    expect(parseChatLine(syntheticNudge)).toEqual({ kind: 'ignored', rawType: 'user:non_tool_result' });
    const commandStdout = JSON.stringify({
      type: 'user',
      session_id: SESSION_ID,
      message: { role: 'user', content: '<local-command-stdout>Set model to sonnet</local-command-stdout>' },
    });
    expect(parseChatLine(commandStdout)).toEqual({ kind: 'ignored', rawType: 'user:non_tool_result' });
  });
});

// The one assistant frame that is NOT content: the CLI has no usable credentials and the turn
// never reached the API. Split out because the remedy isn't on this surface — the headless
// engine answers `/login` with "isn't available in this environment", so the UI has to route
// the user to the interactive terminal instead of echoing advice that doesn't work here.
//
// Every fixture below is the REAL frame shape, captured by running
// `claude -p --input-format stream-json --output-format stream-json --verbose` under an
// isolated unauthenticated HOME on CLI 2.1.220.
describe('parseChatLine — auth-required (not signed in)', () => {
  it('the captured unauthenticated frame → auth-required, NOT an assistant bubble', () => {
    const line = JSON.stringify({
      type: 'assistant',
      session_id: SESSION_ID,
      error: 'authentication_failed',
      is_api_error_message: true,
      message: {
        role: 'assistant',
        model: '<synthetic>',
        content: [{ type: 'text', text: 'Not logged in · Please run /login' }],
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
    expect(parseChatLine(line)).toEqual({ kind: 'auth-required', text: 'Not logged in · Please run /login' });
  });

  it('an is_api_error_message frame that names /login as the remedy also qualifies (a later CLI may drop the `error` field or reword it — an expired token and a rejected key both land here)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      session_id: SESSION_ID,
      is_api_error_message: true,
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Invalid API key · Please run /login' }] },
    });
    expect(parseChatLine(line)).toEqual({ kind: 'auth-required', text: 'Invalid API key · Please run /login' });
  });

  it('a MODEL answer that merely mentions /login is still an ordinary assistant bubble (no error flag → not an auth failure)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      session_id: SESSION_ID,
      message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Run /login to authenticate the CLI.' }] },
    });
    expect(parseChatLine(line)).toEqual({
      kind: 'assistant-text', text: 'Run /login to authenticate the CLI.', synthetic: false,
    });
  });

  it('an api-error frame that does NOT name /login stays an ordinary bubble (overload/rate-limit notices are not sign-in problems)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      session_id: SESSION_ID,
      is_api_error_message: true,
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: Overloaded' }] },
    });
    expect(parseChatLine(line)).toEqual({ kind: 'assistant-text', text: 'API Error: Overloaded', synthetic: true });
  });
});

// The composer's context meter is fed from THIS, not from the server's transcript reader:
// Claude Code ≥2.1.x flushes a live session's transcript only on exit/rotation, so
// `/agent/session-stats` reports nulls for a chat's entire life. `message.usage` on the
// assistant frame is the only live source of how full the window is.
describe('parseChatLine — turnUsage (live context-window footprint)', () => {
  const withUsage = (over: Record<string, unknown> = {}, frame: Record<string, unknown> = {}) => JSON.stringify({
    type: 'assistant',
    session_id: SESSION_ID,
    ...frame,
    message: {
      role: 'assistant',
      model: 'claude-opus-4-5-20251101',
      content: [{ type: 'text', text: 'pong' }],
      usage: {
        input_tokens: 4,
        cache_creation_input_tokens: 12_000,
        cache_read_input_tokens: 30_000,
        output_tokens: 200,
        ...over,
      },
    },
  });

  it('sums input + both cache buckets + output — the window footprint, not just fresh input', () => {
    const ev = parseChatLine(withUsage());
    expect(ev).toMatchObject({ kind: 'assistant-text', text: 'pong' });
    expect(ev && 'turnUsage' in ev ? ev.turnUsage : undefined).toEqual({
      input: 4, cacheCreation: 12_000, cacheRead: 30_000, output: 200,
      total: 42_204, model: 'claude-opus-4-5-20251101',
    });
  });

  it('rides on a tool_use frame too — a turn that ends in a tool call still moved the window', () => {
    const line = JSON.stringify({
      type: 'assistant',
      session_id: SESSION_ID,
      message: {
        role: 'assistant',
        model: 'claude-opus-4-5-20251101',
        content: [{ type: 'tool_use', id: TOOL_USE_ID, name: 'Read', input: { file_path: '/tmp/a' } }],
        usage: { input_tokens: 1, cache_read_input_tokens: 99, output_tokens: 0 },
      },
    });
    const ev = parseChatLine(line);
    expect(ev).toMatchObject({ kind: 'assistant-tool-use', toolUseId: TOOL_USE_ID });
    expect(ev && 'turnUsage' in ev ? ev.turnUsage?.total : undefined).toBe(100);
  });

  it('a SUB-AGENT frame (parent_tool_use_id) carries no turnUsage — its tokens live in its own window', () => {
    const ev = parseChatLine(withUsage({}, { parent_tool_use_id: AGENT_TOOL_USE_ID }));
    expect(ev && 'turnUsage' in ev ? ev.turnUsage : undefined).toBeUndefined();
  });

  it('a <synthetic> local-command echo carries no turnUsage — no model call happened', () => {
    const line = JSON.stringify({
      type: 'assistant',
      session_id: SESSION_ID,
      message: {
        role: 'assistant', model: '<synthetic>',
        content: [{ type: 'text', text: 'Set effort level to low' }],
        usage: { input_tokens: 5, output_tokens: 5 },
      },
    });
    const ev = parseChatLine(line);
    expect(ev && 'turnUsage' in ev ? ev.turnUsage : undefined).toBeUndefined();
  });

  it('an all-zero (or absent) usage block stays undefined rather than reporting a 0-token window', () => {
    expect(parseChatLine(withUsage({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 })))
      .toEqual({ kind: 'assistant-text', text: 'pong', synthetic: false });
    const noUsage = JSON.stringify({
      type: 'assistant',
      session_id: SESSION_ID,
      message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'pong' }] },
    });
    const ev = parseChatLine(noUsage);
    expect(ev && 'turnUsage' in ev ? ev.turnUsage : undefined).toBeUndefined();
  });
});

describe('parseChatLine — control_response acks (set_model / rewind_conversation)', () => {
  it('a plain success ack (set_model) → control-ack with ok: true and no payload', () => {
    const line = JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'sm-chat-1-1' },
    });
    expect(parseChatLine(line)).toEqual({
      kind: 'control-ack', requestId: 'sm-chat-1-1', ok: true, payload: undefined, error: undefined,
    });
  });

  it("a payloaded success ack (rewind_conversation) → control-ack carrying the CLI's nested response", () => {
    const payload = {
      rewound: true,
      targetMessageUuid: '13b74217-a64f-4902-a275-2a4c3dd2d67d',
      prefillText: 'Now remember a second codeword: KIWI. Reply OK.',
      precedingAssistantUuid: '245d4e7d-f5c0-42ab-9271-0e6707e12566',
    };
    const line = JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'rw-chat-1-2', response: payload },
    });
    expect(parseChatLine(line)).toEqual({
      kind: 'control-ack', requestId: 'rw-chat-1-2', ok: true, payload, error: undefined,
    });
  });

  it('an error ack → control-ack with ok: false and the error string', () => {
    const line = JSON.stringify({
      type: 'control_response',
      response: { subtype: 'error', request_id: 'rw-chat-1-3', error: 'target not found' },
    });
    expect(parseChatLine(line)).toEqual({
      kind: 'control-ack', requestId: 'rw-chat-1-3', ok: false, payload: undefined, error: 'target not found',
    });
  });

  it('a control_response without a request_id degrades to ignored (nothing to match)', () => {
    const line = JSON.stringify({ type: 'control_response', response: { subtype: 'success' } });
    expect(parseChatLine(line)).toEqual({ kind: 'ignored', rawType: 'control_response:no_request_id' });
  });
});

describe('parseChatLine — never throws, across every fixture line', () => {
  it('every realistic and malformed line in LINES parses without throwing', () => {
    for (const line of LINES) {
      expect(() => parseChatLine(line)).not.toThrow();
    }
  });

  it('a well-formed but wholly unrecognized frame type degrades to ignored, not a throw', () => {
    expect(parseChatLine(JSON.stringify({ type: 'some_future_frame_type', foo: 'bar' })))
      .toEqual({ kind: 'ignored', rawType: 'some_future_frame_type' });
  });

  it('a JSON array (not an object) → null, since a frame must be a record', () => {
    expect(parseChatLine(JSON.stringify([1, 2, 3]))).toBeNull();
  });
});

// ─── buildQuestionAnswer ────────────────────────────────────────────────────────

describe('buildQuestionAnswer', () => {
  const singleSelect: QuestionSpec = {
    question: 'Which package manager should I use?',
    header: 'Package manager',
    options: [{ label: 'npm' }, { label: 'pnpm' }],
    multiSelect: false,
  };
  const multiSelect: QuestionSpec = {
    question: 'Which environments should get this fix?',
    options: [{ label: 'staging' }, { label: 'production' }, { label: 'dev' }],
    multiSelect: true,
  };

  it('single-select: echoes the questions + maps question text to the chosen label', () => {
    const result = buildQuestionAnswer([singleSelect], { [singleSelect.question]: 'npm' });
    expect(result).toEqual({
      questions: [singleSelect],
      answers: { [singleSelect.question]: 'npm' },
    });
  });

  it('multiSelect: the picked value is a comma-joined string of chosen labels (caller pre-joins)', () => {
    const result = buildQuestionAnswer([multiSelect], { [multiSelect.question]: 'staging, production' });
    expect(result).toEqual({
      questions: [multiSelect],
      answers: { [multiSelect.question]: 'staging, production' },
    });
  });

  it('an unanswered question is simply absent from answers (not an empty-string entry)', () => {
    const result = buildQuestionAnswer([singleSelect, multiSelect], { [singleSelect.question]: 'pnpm' }) as {
      questions: QuestionSpec[]; answers: Record<string, string>;
    };
    expect(result.answers).toEqual({ [singleSelect.question]: 'pnpm' });
    expect(Object.keys(result.answers)).not.toContain(multiSelect.question);
  });

  it('multiple questions answered together → both keyed by their own question text', () => {
    const result = buildQuestionAnswer([singleSelect, multiSelect], {
      [singleSelect.question]: 'npm',
      [multiSelect.question]: 'staging, dev',
    });
    expect(result).toEqual({
      questions: [singleSelect, multiSelect],
      answers: {
        [singleSelect.question]: 'npm',
        [multiSelect.question]: 'staging, dev',
      },
    });
  });
});

// ─── isUrgentChatEvent (render coalescing) ───────────────────────────────────────
//
// The urgency table decides which frames may be batched into one React commit per
// animation frame (see notifyCoalescer.ts). It is enumerated exhaustively here on purpose:
// the safe default is URGENT, so the way this can regress is a NEW high-frequency kind
// silently joining the coalescable set — or, worse, an interactive one being added to it.

describe('isUrgentChatEvent', () => {
  const urgent: ChatEvent[] = [
    { kind: 'init', sessionId: 'a1b2' },
    { kind: 'permission-request', requestId: 'r1', toolName: 'Bash', input: {} },
    { kind: 'question', requestId: 'r2', toolName: 'AskUserQuestion', questions: [] },
    { kind: 'plan-review', requestId: 'r3', toolName: 'ExitPlanMode', plan: '# Plan', input: {} },
    { kind: 'result', success: true },
    { kind: 'meta-exit', code: 0 },
    { kind: 'meta-error', message: 'relay died' },
    { kind: 'auth-required', text: 'Please run /login' },
    // Urgent because it is the trigger for a session RESTART — a frame delayed here is a
    // session left running on the wrong account for another beat.
    { kind: 'auth-changed', identity: 'a@b.c · max', restart: true, loggedIn: true },
    { kind: 'prompt-echo', text: 'hello' },
    { kind: 'control-ack', requestId: 'r4', ok: true },
    { kind: 'assistant-text', text: 'pong', synthetic: false },
    { kind: 'assistant-thinking', text: 'hmm' },
    { kind: 'assistant-tool-use', toolUseId: 't1', name: 'Read', input: {} },
    { kind: 'tool-result', toolUseId: 't1', content: 'ok', isError: false },
    { kind: 'task-started', taskId: 'k1', description: 'scan' },
    { kind: 'task-updated', taskId: 'k1', status: 'completed' },
    { kind: 'task-notification', taskId: 'k1', status: 'completed' },
    { kind: 'slash-commands', commands: ['/login'] },
  ];
  const coalescable: ChatEvent[] = [
    { kind: 'text-delta', index: 0, text: 'to' },
    { kind: 'thinking-delta', index: 0, text: 'ken' },
    { kind: 'block-start', index: 0, blockType: 'text' },
    { kind: 'block-stop', index: 0 },
    { kind: 'task-progress', taskId: 'k1', activity: 'reading' },
    { kind: 'background-tasks', tasks: [] },
    { kind: 'ignored', rawType: 'system:status' },
  ];

  it.each(urgent.map((ev) => [ev.kind, ev] as const))(
    '%s is urgent — the user is waiting to act on it, or the turn just changed shape',
    (_kind, ev) => { expect(isUrgentChatEvent(ev)).toBe(true); },
  );

  it.each(coalescable.map((ev) => [ev.kind, ev] as const))(
    '%s may be coalesced — high-frequency, nothing to act on',
    (_kind, ev) => { expect(isUrgentChatEvent(ev)).toBe(false); },
  );

  it('covers every kind in the ChatEvent union (no arm left unclassified)', () => {
    const covered = new Set([...urgent, ...coalescable].map((ev) => ev.kind));
    // Every `kind` string literal in chatProtocol.ts's exported union, transcribed. A new
    // arm added there without a decision here fails this test rather than defaulting in
    // silence.
    const allKinds: Array<ChatEvent['kind']> = [
      'init', 'background-tasks', 'task-started', 'task-updated', 'task-progress',
      'task-notification', 'block-start', 'text-delta', 'thinking-delta', 'block-stop',
      'assistant-tool-use', 'assistant-text', 'assistant-thinking', 'auth-required', 'auth-changed',
      'tool-result', 'control-ack', 'permission-request', 'question', 'plan-review',
      'result', 'slash-commands', 'prompt-echo', 'meta-exit', 'meta-error', 'ignored',
    ];
    expect([...allKinds].sort()).toEqual([...covered].sort());
  });

  it('an unknown/future kind defaults to URGENT — coalescing is opt-in, never inferred', () => {
    expect(isUrgentChatEvent({ kind: 'something-new' } as unknown as ChatEvent)).toBe(true);
  });
});
