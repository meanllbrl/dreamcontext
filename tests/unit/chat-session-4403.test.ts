// Hands-free sekmeler W1: a 4403 close (the chat is a Super Agent child of a handed-over
// project) stops the reconnect loop and makes the tab watch-only (no composer, no "Buraya al");
// a watch-only reattach frame does the same while the socket stays open and streams; an ordinary
// reattach after the take-back clears it.
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
  drop(code: number) { this.readyState = 3; this.onclose?.({ code }); }
}

const win = new EventTarget() as EventTarget & Record<string, unknown>;
const assign = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.all = [];
  assign.mockReset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('window', win);
  vi.stubGlobal('location', { protocol: 'https:', host: 'quiet-lake-1234.trycloudflare.com', assign });
  vi.stubGlobal('document', {
    createElement: () => ({ className: '', remove() {}, style: {}, appendChild() {} }),
    addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', querySelector: () => null,
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ messages: [], items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
});

afterEach(async () => {
  const { setPhoneSurfaceForTests } = await import('../../dashboard/src/lib/phoneSurface');
  setPhoneSurfaceForTests(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function open(resume: boolean, reattach: '' | '1' | 'passive' = '') {
  const { createChatSession } = await import('../../dashboard/src/components/sleepy/chatSession');
  const s = createChatSession('demo', false, () => {}, '6f1c2e9a-a001-4a5b-8c9d-0123456789ab', resume, '', '', '', '', false, 'basic', '', '', null, reattach);
  return s;
}

describe('the chat client on 4403 and a watch-only mirror', () => {
  it('4403 stops the reconnect loop for good and marks the tab watch-only (not "taken over")', async () => {
    const s = await open(true, 'passive');
    FakeWebSocket.all[0].open();
    FakeWebSocket.all[0].drop(4403);
    expect(s.handedOver).toBe(true);
    expect(s.takenOver).toBe(false);
    expect(s.status).toBe('closed');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(FakeWebSocket.all).toHaveLength(1);
    s.dispose();
  });

  it('a watch-only reattach keeps the socket and marks the tab; an ordinary reattach clears it', async () => {
    const s = await open(true, 'passive');
    const ws = FakeWebSocket.all[0];
    ws.open();
    ws.onmessage?.({ data: JSON.stringify({ type: '_meta', subtype: 'reattached', adopted: true, busy: true, watchOnly: true }) });
    expect(s.handedOver).toBe(true);
    expect(s.busy).toBe(true);
    // A turn_state frame says nothing about who holds the chat.
    ws.onmessage?.({ data: JSON.stringify({ type: '_meta', subtype: 'turn_state', adopted: false, busy: false }) });
    expect(s.handedOver).toBe(true);
    // Taken back: the watch closes 4410, the client reconnects and is decided as an ordinary open.
    ws.drop(4410);
    await vi.advanceTimersByTimeAsync(1100);
    expect(FakeWebSocket.all).toHaveLength(2);
    FakeWebSocket.all[1].open();
    FakeWebSocket.all[1].onmessage?.({ data: JSON.stringify({ type: '_meta', subtype: 'reattached', adopted: true, busy: false }) });
    expect(s.handedOver).toBe(false);
    s.dispose();
  });

  it('"Buraya al" (takeBack): a double press shares one take; 4409 answers false, a bound reattach true', async () => {
    const s = await open(true, 'passive');
    FakeWebSocket.all[0].open();
    FakeWebSocket.all[0].drop(4409);
    expect(s.takenOver).toBe(true);
    const first = s.takeBack();
    const second = s.takeBack();
    expect(second).toBe(first);
    await vi.advanceTimersByTimeAsync(50);
    expect(FakeWebSocket.all).toHaveLength(2);
    // Another screen still holds it: the evicting open is refused, the take did not happen.
    FakeWebSocket.all[1].drop(4409);
    await expect(first).resolves.toBe(false);
    // A new press is a new take, and a bound (not watch-only) reattach answers it.
    const third = s.takeBack();
    expect(third).not.toBe(first);
    await vi.advanceTimersByTimeAsync(50);
    const ws = FakeWebSocket.all[FakeWebSocket.all.length - 1];
    ws.open();
    ws.onmessage?.({ data: JSON.stringify({ type: '_meta', subtype: 'reattached', adopted: true, busy: false }) });
    await expect(third).resolves.toBe(true);
    s.dispose();
  });

  it('a take that lands on a watch-only join did not take the chat', async () => {
    const s = await open(true, 'passive');
    FakeWebSocket.all[0].open();
    FakeWebSocket.all[0].drop(4409);
    const take = s.takeBack();
    await vi.advanceTimersByTimeAsync(50);
    const ws = FakeWebSocket.all[FakeWebSocket.all.length - 1];
    ws.open();
    ws.onmessage?.({ data: JSON.stringify({ type: '_meta', subtype: 'reattached', adopted: true, busy: true, watchOnly: true }) });
    await expect(take).resolves.toBe(false);
    expect(s.handedOver).toBe(true);
    s.dispose();
  });

  it('the composer sends only after the take resolves true, never on a refused take', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../dashboard/src/components/sleepy/chat/Composer.tsx', import.meta.url), 'utf-8');
    const at = src.indexOf('session.takeBack().then(');
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf('sent();', at));
    expect(body).toMatch(/if \(!ok\) return;/);
    expect(body.indexOf('if (!ok) return;')).toBeLessThan(body.indexOf('session.send('));
  });

  it('the pane puts the watch-only banner BEFORE the taken-over branch (its "Buraya al" would reopen into 4403)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../dashboard/src/components/sleepy/ChatPane.tsx', import.meta.url), 'utf-8');
    const at = src.indexOf(') : session.handedOver ? (');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(src.indexOf(') : session.takenOver && !remoteDesktop ? ('));
    expect(src.slice(at, src.indexOf(') : session.takenOver && !remoteDesktop ? ('))).toContain('<HandedOverBanner />');
  });
});
