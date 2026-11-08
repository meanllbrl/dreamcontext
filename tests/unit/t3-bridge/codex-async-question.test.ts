/**
 * Codex's async question (`request_user_input_async`, owner 2026-11-03 "codex bana soru
 * soramıyor"): Codex ends its turn right after asking and reads the answer as the next message.
 * The chat must wait on it as on Claude's AskUserQuestion: the card stays open past the turn's
 * end, the turn's `result` is held (so the chat stays "asking" and a Super child's question stays
 * in the queue), and the owner's pick goes to Codex as the next message.
 */
import { describe, expect, it } from 'vitest';
import { ToWire, asyncAnswerText, type WireFrame } from '../../../src/lib/t3-bridge/to-wire.js';
import { BridgeSession } from '../../../src/lib/t3-bridge/session.js';

const ev = (w: ToWire, e: Record<string, unknown>): WireFrame[] => w.translate(e as never, 1000);
const running = { type: 'provider_turn.updated', providerTurn: { status: 'running' } };
const end = (status = 'completed') => ({
  type: 'turn.terminal', driver: 'codex', providerThreadId: 'pt-1', providerTurnId: 'turn-1',
  runOrdinal: 1, status, failure: null, threadDisposition: 'reusable',
});
const QUESTION = 'Bu akşam hangisini seçersin?';
const asyncQuestion = (requestId = 'r-async', responseMode: 'message' | null = 'message') => ({
  type: 'turn_item.updated',
  turnItem: {
    id: `q-${requestId}`, threadId: 'pt-1', nativeItemRef: null, title: null, type: 'user_input_request', status: 'waiting', requestId,
    ...(responseMode ? { responseMode } : {}),
    questions: [{ id: '0', header: 'Question', question: QUESTION, options: [{ label: 'Evde dinlenmek', description: '' }, { label: 'Dışarı çıkmak', description: '' }] }],
  },
});
const pick = (label: string) => ({ behavior: 'allow', updatedInput: { answers: { [QUESTION]: label } } });

function asked(w: ToWire): string {
  ev(w, running);
  const out = ev(w, asyncQuestion());
  const card = out.find((f) => f.type === 'control_request')!;
  expect(card).toMatchObject({ request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion' } });
  return String(card.request_id);
}

describe('a Codex async question on the wire', () => {
  it('keeps its card open past the turn and holds the result', () => {
    const w = new ToWire({ tool: 'codex', model: 'm', cwd: '/p', permissionMode: 'auto' });
    const id = asked(w);
    const atEnd = ev(w, end());
    expect(atEnd.filter((f) => f.type === 'control_cancel_request')).toEqual([]);
    expect(atEnd.filter((f) => f.type === 'result')).toEqual([]);
    expect(w.holding).toBe(true);
    expect(w.busy).toBe(true);
    expect(w.isAsyncAsk(id)).toBe(true);
  });

  it("turns the owner's pick into the next message, and the next run's end is the turn's one result", () => {
    const w = new ToWire({ tool: 'codex', model: 'm', cwd: '/p', permissionMode: 'auto' });
    const id = asked(w);
    ev(w, end());
    const settled = w.settleAsyncAsk(id, pick('Dışarı çıkmak'));
    expect(settled.frames).toEqual([]);
    expect(settled.send).toContain(QUESTION);
    expect(settled.send).toContain('Dışarı çıkmak');
    // The run that carries the answer opens no second turn on the wire, and its end closes it.
    expect(w.dropAsyncAsks()).toEqual([]);
    expect(ev(w, running)).toEqual([]);
    const closing = ev(w, end());
    expect(closing.filter((f) => f.type === 'result')).toHaveLength(1);
    expect(w.holding).toBe(false);
    expect(w.busy).toBe(false);
  });

  it('a closed card with no answer ends the held turn with its result', () => {
    const w = new ToWire({ tool: 'codex', model: 'm', cwd: '/p', permissionMode: 'auto' });
    const id = asked(w);
    ev(w, end());
    const settled = w.settleAsyncAsk(id, { behavior: 'deny' });
    expect(settled.send).toBeNull();
    expect(settled.frames.map((f) => f.type)).toEqual(['result']);
    expect(w.busy).toBe(false);
  });

  it("the server's plain dismissal (its default 'Denied') sends nothing and ends the turn", () => {
    const w = new ToWire({ tool: 'codex', model: 'm', cwd: '/p', permissionMode: 'auto' });
    const id = asked(w);
    ev(w, end());
    const settled = w.settleAsyncAsk(id, { behavior: 'deny', message: 'Denied' });
    expect(settled.send).toBeNull();
    expect(settled.frames.map((f) => f.type)).toEqual(['result']);
  });

  it('a card closed with words sends the words', () => {
    const w = new ToWire({ tool: 'codex', model: 'm', cwd: '/p', permissionMode: 'auto' });
    const id = asked(w);
    ev(w, end());
    expect(w.settleAsyncAsk(id, { behavior: 'deny', message: 'Daha açık sor.' }).send).toContain('Daha açık sor.');
  });

  it('a Stop on the held turn closes the card and draws the result', () => {
    const w = new ToWire({ tool: 'codex', model: 'm', cwd: '/p', permissionMode: 'auto' });
    const id = asked(w);
    ev(w, end());
    const out = w.endHeld();
    expect(out.map((f) => f.type)).toEqual(['control_cancel_request', 'result']);
    expect(out[0]).toMatchObject({ request_id: id });
    expect(w.isAsyncAsk(id)).toBe(false);
  });

  it('a turn that failed cancels the async card as before', () => {
    const w = new ToWire({ tool: 'codex', model: 'm', cwd: '/p', permissionMode: 'auto' });
    asked(w);
    const out = ev(w, end('failed'));
    expect(out.map((f) => f.type)).toEqual(['control_cancel_request', 'result']);
    expect(w.holding).toBe(false);
  });

  it('a live (in-turn) question still closes at the turn end', () => {
    const w = new ToWire({ tool: 'codex', model: 'm', cwd: '/p', permissionMode: 'auto' });
    ev(w, running);
    const card = ev(w, asyncQuestion('r-live', null)).find((f) => f.type === 'control_request')!;
    expect(w.isAsyncAsk(String(card.request_id))).toBe(false);
    expect(ev(w, end()).map((f) => f.type)).toEqual(['control_cancel_request', 'result']);
  });

  it('writes the note the owner typed with his pick', () => {
    const text = asyncAnswerText([{ id: '0', question: QUESTION }], { answers: { [QUESTION]: 'Evde dinlenmek' }, annotations: { [QUESTION]: { notes: 'yorgunum' } } });
    expect(text).toBe(`${QUESTION}\nMy answer: Evde dinlenmek\nMy note: yorgunum`);
  });
});

type Inner = {
  providerThread: { id: string };
  session: unknown;
  wire: ToWire;
  onEvent(event: unknown): void;
  answer(requestId: string, response: Record<string, unknown>): Promise<void>;
  interrupt(): Promise<void>;
  send(text: string): Promise<void>;
};

function bridge(frames: WireFrame[], sent: string[]): Inner {
  const Make = BridgeSession as unknown as new (opts: unknown) => Inner;
  const s = new Make({ tool: 'codex', cwd: '/tmp/x', model: '', mode: 'auto', paneId: 'pane-1', emit: (f: WireFrame) => { frames.push(f); } });
  s.providerThread = { id: 'pt-1' };
  s.session = {};
  s.send = async (text: string) => { sent.push(text); };
  return s;
}

describe('a Codex async question in the bridge session', () => {
  it("sends the owner's pick to Codex as the next message, never as a runtime response", async () => {
    const frames: WireFrame[] = [];
    const sent: string[] = [];
    const s = bridge(frames, sent);
    s.onEvent(running);
    s.onEvent(asyncQuestion());
    s.onEvent(end());
    const card = frames.find((f) => f.type === 'control_request')!;
    expect(frames.some((f) => f.type === 'result')).toBe(false);
    await s.answer(String(card.request_id), pick('Evde dinlenmek'));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Evde dinlenmek');
  });

  it('a Stop while it waits ends the held turn', async () => {
    const frames: WireFrame[] = [];
    const s = bridge(frames, []);
    s.onEvent(running);
    s.onEvent(asyncQuestion());
    s.onEvent(end());
    await s.interrupt();
    expect(frames.filter((f) => f.type === 'result')).toHaveLength(1);
    expect(frames.some((f) => f.type === 'control_cancel_request')).toBe(true);
  });
});

describe('the card of a bare-label option', () => {
  it('draws no description that only repeats the label', () => {
    const w = new ToWire({ tool: 'codex', model: 'm', cwd: '/p', permissionMode: 'auto' });
    ev(w, running);
    const item = asyncQuestion();
    (item.turnItem.questions[0]!.options as Array<{ label: string; description: string }>) = [{ label: 'Red', description: 'Red' }, { label: 'Blue', description: 'the sea' }];
    const card = ev(w, item).find((f) => f.type === 'control_request')!;
    const options = ((card.request as { input: { questions: Array<{ options: unknown[] }> } }).input.questions[0]!.options);
    expect(options).toEqual([{ label: 'Red' }, { label: 'Blue', description: 'the sea' }]);
  });
});

// Plan 1.7 (task plan-modu-once-anlar-…): the owner approves a UI drawing on a question card.
// A provider that sends an option `preview` must reach the card with it; the bridge used to
// drop it, so the owner was asked to approve a screen he never saw.
describe('a question option preview on the wire', () => {
  const withPreview = {
    type: 'turn_item.updated',
    turnItem: {
      id: 'q-prev', threadId: 'pt-1', nativeItemRef: null, title: null, type: 'user_input_request', status: 'waiting', requestId: 'r-prev',
      questions: [{ id: '0', header: 'Draft', question: 'Approve this draft screen?', options: [
        { label: 'Approve the draft', description: 'Go on with this layout', preview: '<div class="dc-card">draft, not the final version</div>' },
        { label: 'Change it', description: 'Change it' },
      ] }],
    },
  };

  it('carries a preview through and adds none where the provider sent none', () => {
    const w = new ToWire({ tool: 'claude', model: 'm', cwd: '/p', permissionMode: 'auto' });
    ev(w, running);
    const card = ev(w, withPreview).find((f) => f.type === 'control_request') as any;
    const options = card.request.input.questions[0].options;
    expect(options[0]).toEqual({ label: 'Approve the draft', description: 'Go on with this layout', preview: '<div class="dc-card">draft, not the final version</div>' });
    expect(options[1]).toEqual({ label: 'Change it' });
  });
});
