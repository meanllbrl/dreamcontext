/** The queue drain's `queued` mark on the item it writes, driven through the real session. */
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

type UserRow = { kind: string; text: string; queued?: true };
const users = (s: { getModel(): { items: unknown[] } }) => (s.getModel().items as UserRow[]).filter((i) => i.kind === 'user');
const endTurn = (ws: FakeWebSocket) => ws.onmessage?.({ data: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, session_id: 's' }) + '\n' });

describe('the queue drain marks what it sends (Super scroll rule 1, r1)', () => {
  it('a row the queue sends at the turn end is `queued`; his own send is not', async () => {
    const { s, ws } = await open();
    s.send('first');
    s.enqueue('later');
    expect(users(s).map((u) => [u.text, !!u.queued])).toEqual([['first', false]]);
    endTurn(ws);
    vi.advanceTimersByTime(5000);
    expect(users(s).map((u) => [u.text, !!u.queued])).toEqual([['first', false], ['later', true]]);
  });

  it('"Send now" is his press: never marked', async () => {
    const { s } = await open();
    s.enqueue('now please');
    s.sendQueuedNow(s.getModel().queued[0].id);
    expect(users(s).map((u) => [u.text, !!u.queued])).toEqual([['now please', false]]);
  });

  it('a send after the drain is unmarked again (the flag never sticks)', async () => {
    const { s, ws } = await open();
    s.send('first');
    s.enqueue('later');
    endTurn(ws);
    vi.advanceTimersByTime(5000);
    endTurn(ws);
    vi.advanceTimersByTime(5000);
    s.send('again');
    expect(users(s).find((u) => u.text === 'again')?.queued).toBeUndefined();
  });
});
