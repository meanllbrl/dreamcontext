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
