// A tool that refuses twice says it twice (2026-11-11): the echo guard that drops a late copy of a
// block must not drop the same words given as the reply to a NEW message. Before, a second Codex
// limit refusal in a row drew nothing, and the turn looked like it never ran.
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

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.all = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:4000', assign: vi.fn() });
  vi.stubGlobal('document', {
    createElement: () => ({ className: '', remove() {}, style: {}, appendChild() {} }),
    addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', querySelector: () => null,
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ messages: [], items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ID = '9c4f5b2d-d004-4d8e-9f20-3456789abcde';
const REFUSAL = 'You’ve hit your usage limit. Upgrade to Plus to continue using Codex, or try again at Nov 24th.';
const said = (text: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: 't1' });
const failed = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: REFUSAL, session_id: 't1', dc_tool: 'codex' });

async function chat() {
  const { createChatSession } = await import('../../dashboard/src/components/sleepy/chatSession');
  const s = createChatSession('acme-app', false, () => {}, ID, false, '', '', '', '', false, 'basic', '');
  const ws = FakeWebSocket.all[FakeWebSocket.all.length - 1];
  ws.open();
  ws.onmessage?.({ data: JSON.stringify({ type: 'system', subtype: 'init', session_id: 't1', model: 'gpt-6-luna', cwd: '/x', permissionMode: 'default', slash_commands: [] }) });
  await vi.advanceTimersByTimeAsync(0);
  const texts = () => s.getModel().items.filter((it) => it.kind === 'text').map((it) => (it as { text: string }).text);
  return { s, ws, texts };
}

describe('the same reply to two messages', () => {
  it('draws both refusals, one under each message', async () => {
    const { s, ws, texts } = await chat();
    s.send('first');
    ws.onmessage?.({ data: said(REFUSAL) });
    ws.onmessage?.({ data: failed });
    s.send('second');
    ws.onmessage?.({ data: said(REFUSAL) });
    ws.onmessage?.({ data: failed });
    await vi.advanceTimersByTimeAsync(0);
    expect(texts()).toEqual([REFUSAL, REFUSAL]);
    s.dispose();
  });

  it('still drops a late echo of the block just drawn (no message in between)', async () => {
    const { s, ws, texts } = await chat();
    s.send('first');
    ws.onmessage?.({ data: said(REFUSAL) });
    ws.onmessage?.({ data: said(REFUSAL) });
    await vi.advanceTimersByTimeAsync(0);
    expect(texts()).toEqual([REFUSAL]);
    s.dispose();
  });
});
