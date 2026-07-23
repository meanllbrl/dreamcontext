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
import { parseChatLine, buildQuestionAnswer, type QuestionSpec } from '../../dashboard/src/lib/chatProtocol.js';

// ─── Fixture lines (realistic claude 2.1.218 stream-json frames) ──────────────────

const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const PERMISSION_REQUEST_ID = '22222222-3333-4444-5555-666666666666';
const QUESTION_REQUEST_ID = '33333333-4444-5555-6666-777777777777';
const TOOL_USE_ID = 'toolu_01ABCDEF';

const SYSTEM_INIT = JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: SESSION_ID,
  model: 'claude-sonnet-5',
  permissionMode: 'acceptEdits',
  capabilities: ['interrupt_receipt_v1', 'partial_messages_v1'],
  claude_code_version: '2.1.218',
});

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
      permissionMode: 'acceptEdits',
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
