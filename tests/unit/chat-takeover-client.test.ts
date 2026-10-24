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
    const { setPhoneSurfaceForTests } = await import('../../dashboard/src/lib/phoneSurface');
    setPhoneSurfaceForTests('mac');
    const r = await open(true);
    expect(FakeWebSocket.all[0].url).not.toMatch(/reattach=/);
    r.dispose();
    FakeWebSocket.all = [];
    setPhoneSurfaceForTests(null);
    const a = await open(true);
    expect(FakeWebSocket.all[0].url).not.toMatch(/reattach=/);
    a.dispose();
    const b = await open(true, '1');
    expect(FakeWebSocket.all[1].url).toMatch(/[?&]resume=.*&reattach=1/);
    b.dispose();
  });

  it('a roster restore opens passive; on the Mac phone surface a 4401 goes to the login page', async () => {
    const { setPhoneSurfaceForTests } = await import('../../dashboard/src/lib/phoneSurface');
    setPhoneSurfaceForTests('mac');
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

describe('the backoff climbs through an open-then-drop loop (2026-10-23)', () => {
  /** Drop the newest socket right after it opened, and measure how long until the next one. */
  async function waitForNext(): Promise<number> {
    const before = FakeWebSocket.all.length;
    let waited = 0;
    while (FakeWebSocket.all.length === before && waited < 60_000) { await vi.advanceTimersByTimeAsync(100); waited += 100; }
    return waited;
  }
  const last = () => FakeWebSocket.all[FakeWebSocket.all.length - 1];

  it('open-then-drop climbs 1 → 2 → 5 s instead of retrying every second', async () => {
    const s = await open(false);
    last().open(); last().drop(1005);
    expect(await waitForNext()).toBe(1000);
    last().open(); last().drop(1005);
    expect(await waitForNext()).toBe(2000);
    last().open(); last().drop(1005);
    expect(await waitForNext()).toBe(5000);
    s.dispose();
  });

  it('an open that lasts 5 s resets the ladder; a drop before 5 s cancels the reset', async () => {
    const { STABLE_OPEN_MS } = await import('../../dashboard/src/components/sleepy/chatSession');
    expect(STABLE_OPEN_MS).toBe(5000);
    const s = await open(false);
    last().open(); last().drop(1005);
    expect(await waitForNext()).toBe(1000);
    last().open(); last().drop(1005);
    expect(await waitForNext()).toBe(2000);
    last().open();
    await vi.advanceTimersByTimeAsync(4900);
    last().drop(1005);   // 4.9 s: not stable yet
    expect(await waitForNext()).toBe(5000);
    last().open();
    await vi.advanceTimersByTimeAsync(5000);
    last().drop(1005);   // stable: back to the first rung
    expect(await waitForNext()).toBe(1000);
    s.dispose();
  });

  it('4409 still stops the loop; takeBack starts the ladder over', async () => {
    const s = await open(false);
    last().open(); last().drop(1005);
    await waitForNext();
    last().open(); last().drop(1005);
    await waitForNext();
    last().drop(4409);
    await vi.advanceTimersByTimeAsync(120_000);
    const n = FakeWebSocket.all.length;
    expect(s.takenOver).toBe(true);
    s.takeBack();
    expect(FakeWebSocket.all.length).toBe(n + 1);
    last().open(); last().drop(1005);
    expect(await waitForNext()).toBe(1000);
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
