// Mac mode, client side of AC8: automatic reconnects are PASSIVE, a 4409 close stops the loop
// and offers "Buraya al" (an evicting reattach=1), Return makes a taken-over pane reattach by
// itself, and on the phone surface a restore is passive and a 4401 goes to the login page.
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
  const { setCloudSurfaceForTests } = await import('../../dashboard/src/lib/cloudSurface');
  setCloudSurfaceForTests(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function open(resume: boolean, reattach: '' | '1' | 'passive' = '') {
  const { createChatSession } = await import('../../dashboard/src/components/sleepy/chatSession');
  const s = createChatSession('demo', false, () => {}, '6f1c2e9a-a001-4a5b-8c9d-0123456789ab', resume, '', '', '', '', false, 'basic', '', '', null, reattach);
  return s;
}

describe('chat client takeover (AC8)', () => {
  it('a dropped socket reconnects PASSIVELY (never evicting a live holder)', async () => {
    const s = await open(false);
    FakeWebSocket.all[0].open();
    FakeWebSocket.all[0].drop(1006);
    await vi.advanceTimersByTimeAsync(1100);
    expect(FakeWebSocket.all).toHaveLength(2);
    expect(FakeWebSocket.all[1].url).toMatch(/[?&]reattach=passive(&|$)/);
    expect(FakeWebSocket.all[1].url).toMatch(/[?&]resume=6f1c2e9a/);
    s.dispose();
  });

  it('4409 stops the reconnect loop and offers "Buraya al"; takeBack sends the evicting reattach=1', async () => {
    const s = await open(false);
    FakeWebSocket.all[0].open();
    FakeWebSocket.all[0].drop(4409);
    expect(s.takenOver).toBe(true);
    expect(s.status).toBe('closed');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeWebSocket.all).toHaveLength(1); // nothing reconnected: no ping-pong
    s.takeBack();
    expect(s.takenOver).toBe(false);
    expect(FakeWebSocket.all).toHaveLength(2);
    expect(FakeWebSocket.all[1].url).toMatch(/[?&]reattach=1(&|$)/);
    s.dispose();
  });

  it('Return on this desktop: a taken-over pane reattaches by itself, passively', async () => {
    const { MAC_MODE_ENDED_EVENT } = await import('../../dashboard/src/components/handsfree/macContract');
    const s = await open(false);
    FakeWebSocket.all[0].drop(4409);
    win.dispatchEvent(new Event(MAC_MODE_ENDED_EVENT));
    expect(FakeWebSocket.all).toHaveLength(2);
    expect(FakeWebSocket.all[1].url).toMatch(/[?&]reattach=passive(&|$)/);
    // A pane that was NOT taken over ignores it.
    const before = FakeWebSocket.all.length;
    FakeWebSocket.all[1].open();
    win.dispatchEvent(new Event(MAC_MODE_ENDED_EVENT));
    expect(FakeWebSocket.all.length).toBe(before);
    s.dispose();
  });

  it('a plain resume (a respawn: account, mode, Resume) never reattaches, on any surface; an explicit tap sends reattach=1', async () => {
    const { setCloudSurfaceForTests } = await import('../../dashboard/src/lib/cloudSurface');
    setCloudSurfaceForTests('mac');
    const r = await open(true);
    expect(FakeWebSocket.all[0].url).not.toMatch(/reattach=/);
    r.dispose();
    FakeWebSocket.all = [];
    setCloudSurfaceForTests(null);
    const a = await open(true);
    expect(FakeWebSocket.all[0].url).not.toMatch(/reattach=/);
    a.dispose();
    const b = await open(true, '1');
    expect(FakeWebSocket.all[1].url).toMatch(/[?&]resume=.*&reattach=1/);
    b.dispose();
  });

  it('a roster restore opens passive; on the Mac phone surface a 4401 goes to the login page', async () => {
    const { setCloudSurfaceForTests } = await import('../../dashboard/src/lib/cloudSurface');
    setCloudSurfaceForTests('mac');
    const s = await open(true, 'passive');
    expect(FakeWebSocket.all[0].url).toMatch(/[?&]reattach=passive(&|$)/);
    FakeWebSocket.all[0].open();
    FakeWebSocket.all[0].drop(4401);
    expect(assign).toHaveBeenCalledWith('/login?revoked=1');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.all).toHaveLength(1);
    s.dispose();
  });
});

describe('dock status of a taken-over chat', () => {
  it('reads "on another screen", never "ended" (the process runs on the other screen)', async () => {
    const { deriveSessionStatus } = await import('../../dashboard/src/components/sleepy/agentStatus');
    expect(deriveSessionStatus({ status: 'closed', takenOver: true })).toEqual({ kind: 'saved', label: 'on another screen', mood: 'sleeps' });
    expect(deriveSessionStatus({ status: 'closed' }).label).toBe('ended');
  });
});
