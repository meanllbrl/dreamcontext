/**
 * The window half of parking: a `_meta park` frame reaches the surface's park handler, the
 * answer goes back up the same socket BEFORE the tab is closed, live work refuses on its own,
 * and the `focus` frame is throttled to one per 30 s.
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

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.all = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:4173', assign: vi.fn() });
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

async function open() {
  const { createChatSession } = await import('../../dashboard/src/components/sleepy/chatSession');
  const s = createChatSession('demo', false, () => {}, '6f1c2e9a-a001-4a5b-8c9d-0123456789ab', true, '', '', '', '', false, 'basic', '', '', null, '');
  const ws = FakeWebSocket.all[0];
  ws.open();
  return { s, ws };
}

const frames = (ws: FakeWebSocket) => ws.sent.map((d) => { try { return JSON.parse(d) as Record<string, unknown>; } catch { return {}; } });
const park = (ws: FakeWebSocket, id: string) => ws.onmessage?.({ data: JSON.stringify({ type: '_meta', subtype: 'park', id, reason: 'machine' }) });

describe('park frame (chat)', () => {
  it('asks the surface, answers ok, THEN closes the tab', async () => {
    const { s, ws } = await open();
    const order: string[] = [];
    s.setParkHandler(() => ({ ok: true, commit: () => { order.push(`commit after ${frames(ws).filter((f) => f.type === 'park_result').length} answer(s)`); } }));
    park(ws, 'p1');
    expect(frames(ws).find((f) => f.type === 'park_result')).toEqual({ type: 'park_result', id: 'p1', ok: true });
    expect(order).toEqual(['commit after 1 answer(s)']);
  });

  it('refuses with the surface reason, and with no surface at all', async () => {
    const { s, ws } = await open();
    park(ws, 'p0');
    s.setParkHandler(() => ({ ok: false, error: 'focused' }));
    park(ws, 'p1');
    const results = frames(ws).filter((f) => f.type === 'park_result');
    expect(results).toEqual([
      { type: 'park_result', id: 'p0', ok: false, error: 'refused' },
      { type: 'park_result', id: 'p1', ok: false, error: 'focused' },
    ]);
  });

  it('a running turn refuses before the surface is even asked', async () => {
    const { s, ws } = await open();
    const handler = vi.fn(() => ({ ok: true as const, commit: () => {} }));
    s.setParkHandler(handler);
    s.send('hello');
    park(ws, 'p2');
    expect(handler).not.toHaveBeenCalled();
    expect(frames(ws).find((f) => f.type === 'park_result')).toMatchObject({ ok: false, error: 'busy' });
  });
});

describe('queued messages are work', () => {
  it('a chat with queued rows refuses to park (they would die with the process)', async () => {
    const { s, ws } = await open();
    const handler = vi.fn(() => ({ ok: true as const, commit: () => {} }));
    s.setParkHandler(handler);
    s.send('first');
    s.enqueue('later');
    s.interrupt();   // Stop: the queue is held, the turn ends
    ws.onmessage?.({ data: JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, session_id: 's' }) + '\n' });
    vi.advanceTimersByTime(5000);
    expect(s.busy).toBe(false);
    expect(s.getModel().queued.length).toBe(1);
    expect(s.hasLiveWork()).toBe(true);
    park(ws, 'p3');
    expect(handler).not.toHaveBeenCalled();
    expect(frames(ws).find((f) => f.type === 'park_result')).toMatchObject({ ok: false });
  });
});

describe('focus frame', () => {
  it('goes at most once per 30 s', async () => {
    const { s, ws } = await open();
    s.markFocus(); s.markFocus(); s.markFocus();
    expect(frames(ws).filter((f) => f.type === 'focus')).toHaveLength(1);
    vi.advanceTimersByTime(29_000);
    s.markFocus();
    expect(frames(ws).filter((f) => f.type === 'focus')).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    s.markFocus();
    expect(frames(ws).filter((f) => f.type === 'focus')).toHaveLength(2);
  });
});
