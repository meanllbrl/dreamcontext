/**
 * Regression lock for the owner report of 2026-08-24 (Slack C0B8ZH7N7LN, Berdan): stopping a
 * chat AT THE MOMENT Claude asks a question left the card on screen for the rest of the
 * session — "chat bubble'ı hiç gitmiyor". Pending cards render after the transcript, so a
 * card that outlives its own request sits pinned below every later message, `asking` never
 * comes back down (no steering, and the project chip keeps its asking bubble), and its
 * buttons answer a `can_use_tool` request the CLI already abandoned.
 *
 * Three edges end that request with no answer of ours and are pinned here: the interrupt,
 * the CLI process exiting, and the socket going away.
 *
 * Drives the REAL `createChatSession` — the bug lives in the reducer's edges, not in a pure
 * helper that could be tested in isolation. The browser surface it needs is small and stubbed
 * below (no jsdom in this suite): a container element, `location`, and a fake WebSocket that
 * hands frames to `ws.onmessage` exactly as the server's relay does.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── browser stubs ────────────────────────────────────────────────────────────────────

/** Every frame this client wrote, in order — the assertions read `type` off these. */
let sent: string[] = [];
let lastSocket: FakeWebSocket | null = null;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { lastSocket = this; }
  send(data: string): void { sent.push(data); }
  close(): void { this.readyState = FakeWebSocket.CLOSED; this.onclose?.(); }
  /** Deliver one NDJSON line the way `agent-chat.ts` relays the CLI's stdout. */
  deliver(frame: unknown): void { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

/** The detached `container` div the session owns. Only `className`/`style` are ever touched. */
function stubElement(): unknown {
  return {
    className: '',
    style: { setProperty: () => {}, removeProperty: () => {} },
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    appendChild: () => {},
    removeChild: () => {},
    remove: () => {},
  };
}

const g = globalThis as unknown as Record<string, unknown>;
const GLOBALS = ['document', 'location', 'window', 'WebSocket'] as const;
const saved: Record<string, unknown> = {};

beforeEach(() => {
  sent = [];
  lastSocket = null;
  for (const k of GLOBALS) saved[k] = g[k];
  // A visible, focused document short-circuits `raiseAskAttention` (the ask alarm) before it
  // reaches the Dock/notification transports — those read `window.__TAURI_INTERNALS__`
  // unguarded, which is safe in a real webview and a ReferenceError in a node test run.
  g.document = { createElement: () => stubElement(), visibilityState: 'visible', hasFocus: () => true };
  g.location = { protocol: 'http:', host: '127.0.0.1:4319' };
  g.window = {};
  g.WebSocket = FakeWebSocket;
});

afterEach(() => {
  for (const k of GLOBALS) {
    if (saved[k] === undefined) delete g[k];
    else g[k] = saved[k];
  }
  vi.restoreAllMocks();
});

// ─── wire frames (shapes captured from CLI 2.1.220, same as chatProtocol's own tests) ──

/** An `AskUserQuestion` ask: `can_use_tool` + `requires_user_interaction` + a `questions`
 *  array is what `fromControlRequest` discriminates into a `question` event. */
const QUESTION_FRAME = {
  type: 'control_request',
  request_id: 'req-ask-1',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'AskUserQuestion',
    requires_user_interaction: true,
    input: {
      questions: [{
        question: 'Which library should we use for date formatting?',
        header: 'Library',
        options: [{ label: 'date-fns' }, { label: 'dayjs' }],
      }],
    },
  },
};

/** An ordinary permission prompt — the same `pending` channel, a different card. */
const PERMISSION_FRAME = {
  type: 'control_request',
  request_id: 'req-perm-1',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'Bash',
    input: { command: 'rm -rf /tmp/nothing' },
    description: 'Delete a scratch path',
  },
};

/** The CLI's own answer to an interrupt, as `agent-chat.ts` documents it: the tool it was
 *  blocked on is rejected and the turn ends `aborted_tools`. Note what is NOT here — any
 *  frame naming `req-ask-1`. Nothing retires the card but the client itself. */
const ABORT_RESULT_FRAME = {
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  result: 'ABORTED',
  num_turns: 1,
  terminal_reason: 'aborted_tools',
  session_id: 'test-session',
};

async function openSession() {
  const { createChatSession } = await import('../../dashboard/src/components/sleepy/chatSession.js');
  const session = createChatSession('proj', true, () => {}, 'conv-uuid-1');
  const ws = lastSocket!;
  ws.onopen?.();
  return { session, ws };
}

// ─── the lock ─────────────────────────────────────────────────────────────────────────

describe('a card never outlives the request behind it', () => {
  it('Stop clears an open question card and lowers `asking`', async () => {
    const { session, ws } = await openSession();

    ws.deliver(QUESTION_FRAME);
    expect(session.getModel().pending).toHaveLength(1);
    expect(session.getModel().pending[0].kind).toBe('question');
    expect(session.asking).toBe(true);

    session.interrupt();

    // The interrupt still goes out — clearing the card is IN ADDITION to stopping the turn.
    expect(sent.map((s) => JSON.parse(s).type)).toContain('interrupt');
    expect(session.getModel().pending).toEqual([]);
    expect(session.asking).toBe(false);
  });

  it('the card stays gone once the aborted turn reports back', async () => {
    const { session, ws } = await openSession();
    ws.deliver(QUESTION_FRAME);
    session.interrupt();

    // The exact frames a real abort follows with. None of them names the request, which is
    // why the client had to retire the card itself.
    ws.deliver({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
    ws.deliver(ABORT_RESULT_FRAME);

    expect(session.getModel().pending).toEqual([]);
    expect(session.asking).toBe(false);
    expect(session.busy).toBe(false);
  });

  it('the next message is an ordinary turn — no card, and steering works again', async () => {
    const { session, ws } = await openSession();
    ws.deliver(QUESTION_FRAME);
    session.interrupt();
    ws.deliver(ABORT_RESULT_FRAME);

    session.send('carry on without asking');
    expect(session.getModel().pending).toEqual([]);
    // `canSteer` is false while a card is open; that it is true here is the second half of
    // the report — the composer was left unable to cut into the next turn.
    expect(session.busy).toBe(true);
    expect(session.canSteer()).toBe(true);
  });

  it('Stop clears a permission card too — same channel, same dead request', async () => {
    const { session, ws } = await openSession();
    ws.deliver(PERMISSION_FRAME);
    expect(session.getModel().pending).toHaveLength(1);
    expect(session.getModel().pending[0].kind).toBe('permission');

    session.interrupt();
    expect(session.getModel().pending).toEqual([]);
    expect(session.asking).toBe(false);
  });

  it('Stop on a closed socket changes nothing (the frame never left)', async () => {
    const { session, ws } = await openSession();
    ws.deliver(QUESTION_FRAME);
    ws.readyState = FakeWebSocket.CLOSING;
    sent = [];

    session.interrupt();
    expect(sent).toEqual([]);
    expect(session.getModel().pending).toHaveLength(1);
  });

  it('a card does not outlive the CLI process', async () => {
    const { session, ws } = await openSession();
    ws.deliver(QUESTION_FRAME);
    expect(session.asking).toBe(true);

    // `_meta` is the server relay's own lifecycle envelope, not a claude-native frame.
    ws.deliver({ type: '_meta', subtype: 'exit', code: 0 });

    expect(session.getModel().pending).toEqual([]);
    expect(session.asking).toBe(false);
    expect(session.getModel().exited).toEqual({ code: 0 });
  });

  it('a card does not outlive the socket', async () => {
    const { session, ws } = await openSession();
    ws.deliver(QUESTION_FRAME);

    ws.close();

    expect(session.getModel().pending).toEqual([]);
    expect(session.asking).toBe(false);
    expect(session.status).toBe('closed');
  });

  it('Stop with nothing open is untouched — no card, and the queue pause still lands', async () => {
    const { session, ws } = await openSession();
    ws.deliver({ type: 'system', subtype: 'init', session_id: 'test-session', model: 'claude-opus-5' });
    session.send('do the thing');
    session.enqueue('and then this one');
    expect(session.getModel().queued).toHaveLength(1);

    session.interrupt();

    expect(session.getModel().pending).toEqual([]);
    // The pause `interrupt` has always taken is unchanged by the card clearing beside it.
    expect(session.getModel().queuePaused).toBe(true);
    expect(session.getModel().queued).toHaveLength(1);
  });
});
