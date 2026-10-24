/**
 * The Super's reply mark in the window's chat session (owner 2026-10-23): in a Super view the
 * item holds the body and `replyTo` the refs, the head draws nothing while it streams, a
 * replayed block loses its mark too; the phone's mirror (`superMirror`, an ordinary mode)
 * behaves like the Super's own window; any other chat never parses a mark.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static all: FakeWebSocket[] = [];
  readonly OPEN = 1;
  readyState = 0;
  url: string;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(url: string) { this.url = url; FakeWebSocket.all.push(this); }
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
}

let history: unknown[] = [];

beforeEach(() => {
  FakeWebSocket.all = [];
  history = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:4173', assign: vi.fn() });
  vi.stubGlobal('document', {
    createElement: () => ({ className: '', remove() {}, style: {}, appendChild() {} }),
    addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', querySelector: () => null,
  });
  vi.stubGlobal('fetch', vi.fn(async (u: string) => new Response(
    JSON.stringify(String(u).includes('chat-history') ? { items: history } : { messages: [], items: [] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )));
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
});

afterEach(() => { vi.unstubAllGlobals(); });

async function open(mode: 'super' | 'basic' | 'assistant', superMirror = false, resume = false) {
  const { createChatSession } = await import('../../dashboard/src/components/sleepy/chatSession');
  const s = createChatSession('demo', false, () => {}, '6f1c2e9a-a001-4a5b-8c9d-0123456789ab', resume, '', '', '', '', false, mode, '', '', null, '', null, superMirror);
  const ws = FakeWebSocket.all.at(-1)!;
  ws.open();
  return { s, ws };
}
const frame = (ws: FakeWebSocket, f: Record<string, unknown>) => ws.onmessage?.({ data: `${JSON.stringify(f)}\n` });
const start = (ws: FakeWebSocket) => frame(ws, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } });
const delta = (ws: FakeWebSocket, text: string) => frame(ws, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const echo = (ws: FakeWebSocket, text: string) => frame(ws, { type: 'assistant', message: { role: 'assistant', model: 'claude-opus', content: [{ type: 'text', text }] } });
const texts = (s: { getModel: () => { items: Array<{ kind: string; text?: string; replyTo?: string[] }> } }) => s.getModel().items.filter((it) => it.kind === 'text');

describe('the reply mark in a Super view', () => {
  it('a mark split across three deltas: nothing drawn until the head resolves, then the body and its ref', async () => {
    const { s, ws } = await open('super');
    start(ws);
    const seen: string[] = [];
    for (const d of ['<!-- r', 'e:k3f9', 'q0 -->\nHello']) {
      delta(ws, d);
      seen.push(texts(s)[0].text ?? '');
    }
    expect(seen).toEqual(['', '', 'Hello']);
    expect(texts(s)[0].replyTo).toEqual(['k3f9q0']);
    // The authoritative echo keeps the same body and ref, never the mark.
    echo(ws, '<!-- re:k3f9q0 -->\nHello there.');
    expect(texts(s)).toHaveLength(1);
    expect(texts(s)[0]).toMatchObject({ text: 'Hello there.', replyTo: ['k3f9q0'] });
  });

  it('a no-delta answer (the echo alone) and an unmarked one', async () => {
    const { s, ws } = await open('super');
    echo(ws, '<!-- re:k3f9q0 a1b2c3 -->\nBoth done.');
    expect(texts(s)[0]).toMatchObject({ text: 'Both done.', replyTo: ['k3f9q0', 'a1b2c3'] });
    echo(ws, 'Plain.');
    expect(texts(s)[1].text).toBe('Plain.');
    expect(texts(s)[1].replyTo).toBeUndefined();
  });

  it('the phone\'s mirror (superMirror, an ordinary mode) parses it like the Super\'s own window', async () => {
    const { s, ws } = await open('basic', true);
    expect(s.superMirror).toBe(true);
    echo(ws, '<!-- re:k3f9q0 -->\nOn the phone.');
    expect(texts(s)[0]).toMatchObject({ text: 'On the phone.', replyTo: ['k3f9q0'] });
  });

  it('any other chat never parses a mark', async () => {
    for (const mode of ['basic', 'assistant'] as const) {
      const { s, ws } = await open(mode);
      expect(s.superMirror).toBe(false);
      echo(ws, '<!-- re:k3f9q0 -->\nUntouched.');
      expect(texts(s)[0].text).toBe('<!-- re:k3f9q0 -->\nUntouched.');
      expect(texts(s)[0].replyTo).toBeUndefined();
    }
  });

  it('a replayed Super block keeps its words and refs, never the mark', async () => {
    history = [
      { kind: 'user', text: 'Fix the login page', uuid: 'u-1', at: 1 },
      { kind: 'text', text: '<!-- re:k3f9q0 -->\nFixed.', at: 2 },
      { kind: 'text', text: 'No mark here.', at: 3 },
    ];
    const { s } = await open('super', false, true);
    await vi.waitFor(() => expect(s.getModel().history.length).toBe(3));
    const replayed = s.getModel().history.filter((it) => it.kind === 'text') as Array<{ text: string; replyTo?: string[] }>;
    expect(replayed[0]).toMatchObject({ text: 'Fixed.', replyTo: ['k3f9q0'] });
    expect(replayed[1].text).toBe('No mark here.');
    expect(replayed[1].replyTo).toBeUndefined();
  });
});

const result = (ws: FakeWebSocket) => frame(ws, { type: 'result', subtype: 'success', is_error: false, result: '' });
const meta = (ws: FakeWebSocket, subtype: 'exit' | 'error') => frame(ws, { type: '_meta', subtype, ...(subtype === 'exit' ? { code: 0 } : { message: 'relay lost' }) });
const thinkStart = (ws: FakeWebSocket) => frame(ws, { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'thinking' } } });
type Model = { getModel: () => { items: Array<{ kind: string; text?: string; done?: boolean; cut?: true; replySections?: Array<{ at: number; refs: string[] }> }>; history: Array<{ kind: string; replySections?: unknown }> } };

// Owner 2026-10-24 (pick A): a block answering several messages carries its sections, live and
// replayed, so the window can head every part with the chip of the message it answers.
describe('reply sections in a Super view', () => {
  const RAW = '<!-- re:aaaaaa -->\nOne.\n\n<!-- re:bbbbbb -->\nTwo.';

  it('live: a section shows only once its words came; the echo keeps them', async () => {
    const { s, ws } = await open('super');
    start(ws);
    delta(ws, '<!-- re:aaaaaa -->\nOne.\n\n<!-- re:bbbbbb -->\n');
    expect((s as unknown as Model).getModel().items.find((it) => it.kind === 'text')?.replySections).toEqual([{ at: 0, refs: ['aaaaaa'] }]);
    delta(ws, 'Two.');
    expect(texts(s)[0]).toMatchObject({ text: 'One.\n\nTwo.', replySections: [{ at: 0, refs: ['aaaaaa'] }, { at: 6, refs: ['bbbbbb'] }] });
    echo(ws, RAW);
    expect(texts(s)).toHaveLength(1);
    expect(texts(s)[0]).toMatchObject({ replyTo: ['aaaaaa', 'bbbbbb'], replySections: [{ at: 0, refs: ['aaaaaa'] }, { at: 6, refs: ['bbbbbb'] }] });
  });

  it('replayed: the same sections', async () => {
    history = [{ kind: 'user', text: 'one', uuid: 'u-1', at: 1 }, { kind: 'text', text: RAW, at: 2 }];
    const { s } = await open('super', false, true);
    await vi.waitFor(() => expect(s.getModel().history.length).toBe(2));
    expect(s.getModel().history[1]).toMatchObject({ text: 'One.\n\nTwo.', replySections: [{ at: 0, refs: ['aaaaaa'] }, { at: 6, refs: ['bbbbbb'] }] });
  });
});

// AC4b: a stream cut without its block-stop (Stop, a relay error, an exit) would stay
// `done=false` for good: no strip or heads, a caret forever. The turn's end closes it.
describe('a text cut mid-stream is closed by the turn\'s end', () => {
  for (const [name, end] of [
    ['Stop → result', (s: { interrupt: () => void }, ws: FakeWebSocket) => { s.interrupt(); result(ws); }],
    ['meta-exit', (_s: unknown, ws: FakeWebSocket) => meta(ws, 'exit')],
    ['meta-error', (_s: unknown, ws: FakeWebSocket) => meta(ws, 'error')],
  ] as const) {
    it(name, async () => {
      const { s, ws } = await open('super');
      thinkStart(ws);
      start(ws);
      delta(ws, '<!-- re:aaaaaa -->\nHalf an ans');
      end(s as never, ws);
      const m = (s as unknown as Model).getModel();
      expect(m.items.filter((it) => it.kind === 'text' || it.kind === 'thinking').every((it) => it.done)).toBe(true);
      expect(texts(s)[0]).toMatchObject({ text: 'Half an ans', done: true, cut: true, replyTo: ['aaaaaa'] });
      // A delta arriving afterwards finds no open block: dropped, the text unchanged.
      delta(ws, 'swer.');
      expect(texts(s)[0].text).toBe('Half an ans');
      if (name !== 'Stop → result') return;
      // The late full echo replaces the cut text in place, never a copy.
      echo(ws, '<!-- re:aaaaaa -->\nHalf an answer, finished.');
      expect(texts(s)).toHaveLength(1);
      expect(texts(s)[0]).toMatchObject({ text: 'Half an answer, finished.', replyTo: ['aaaaaa'] });
    });
  }

  it('a cut block only takes ITS late echo: an empty cut text never swallows a later turn\'s reply; thinking too', async () => {
    const { s, ws } = await open('basic');
    start(ws);
    s.interrupt(); result(ws);
    expect(texts(s)[0]).toMatchObject({ text: '', done: true, cut: true });
    // Every echo "starts with" an empty text: it is never the cut block's own.
    echo(ws, 'A later reply.');
    expect(texts(s).map((t) => t.text)).toEqual(['', 'A later reply.']);
    // A cut text is not replaced across his next message either.
    const b = await open('basic');
    start(b.ws); delta(b.ws, 'Half'); result(b.ws);
    (b.s as unknown as { send: (t: string) => void }).send('next question');
    expect((b.s as unknown as Model).getModel().items.map((it) => it.kind)).toEqual(['text', 'user']);
    echo(b.ws, 'Half and more.');
    expect((b.s as unknown as Model).getModel().items.map((it) => `${it.kind}:${it.text}`)).toEqual(['text:Half', 'user:next question', 'text:Half and more.']);
    // A thinking block cut mid-stream takes its late echo in place, never a second copy.
    const c = await open('basic');
    thinkStart(c.ws);
    frame(c.ws, { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'Weigh' } } });
    meta(c.ws, 'exit');
    frame(c.ws, { type: 'assistant', message: { role: 'assistant', model: 'claude-opus', content: [{ type: 'thinking', thinking: 'Weigh both options.', signature: 'x' }] } });
    const th = (c.s as unknown as Model).getModel().items.filter((it) => it.kind === 'thinking');
    expect(th).toHaveLength(1);
    expect(th[0]).toMatchObject({ text: 'Weigh both options.', done: true });
  });

  it('a finished text is left as it was, and an echo that is not its continuation still appends', async () => {
    const { s, ws } = await open('super');
    start(ws);
    delta(ws, 'Done.');
    frame(ws, { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
    result(ws);
    expect(texts(s)[0]).toMatchObject({ text: 'Done.', done: true });
    expect((texts(s)[0] as { cut?: true }).cut).toBeUndefined();
    echo(ws, 'Something else.');
    expect(texts(s)).toHaveLength(2);
  });
});

