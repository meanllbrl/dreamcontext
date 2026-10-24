/**
 * A chat pane nobody can see follows its session at most once a second (hiddenRenderGate.ts) and
 * catches up the moment it is shown (chatSession's `minimized` setter fires the subscribers once).
 * Measured cause: a handed-over Super Agent's garaged children re-rendered on every token
 * (task super-agent-ekrani-kasmaz-olculen-3-sebep-duzeltilir).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHiddenRenderGate, HIDDEN_RENDER_MS, type GateClock } from '../../dashboard/src/components/sleepy/chat/hiddenRenderGate.js';

function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; cb: () => void }>();
  const clock: GateClock = {
    now: () => now,
    timeout: (cb, ms) => { const h = next++; timers.set(h, { at: now + ms, cb }); return h; },
    cancelTimeout: (h) => { timers.delete(h); },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [h, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at <= now && timers.has(h)) { timers.delete(h); t.cb(); }
    }
  };
  return { clock, advance, armed: () => timers.size };
}

describe('hidden render gate', () => {
  it('a visible pane renders on every event, synchronously', () => {
    const { clock } = fakeClock();
    const render = vi.fn();
    const gate = createHiddenRenderGate(render, () => false, clock);
    for (let i = 0; i < 30; i++) gate.notify();
    expect(render).toHaveBeenCalledTimes(30);
  });

  it('a hidden pane renders the first event, then at most once per HIDDEN_RENDER_MS, trailing', () => {
    const { clock, advance, armed } = fakeClock();
    const render = vi.fn();
    const gate = createHiddenRenderGate(render, () => true, clock);
    gate.notify();
    expect(render).toHaveBeenCalledTimes(1);
    // A token storm: 30 a second for 3 seconds.
    for (let i = 0; i < 90; i++) { advance(33); gate.notify(); }
    // ~3 s of storm -> about 3 trailing renders, never one per token.
    expect(render.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(render.mock.calls.length).toBeLessThanOrEqual(4);
    // The last event is never dropped: a trailing render lands within the interval.
    const before = render.mock.calls.length;
    advance(HIDDEN_RENDER_MS);
    expect(render.mock.calls.length).toBe(before + 1);
    expect(armed()).toBe(0);
  });

  it('shown again: the next event renders at once and drops the trailing one', () => {
    const { clock, advance, armed } = fakeClock();
    let hidden = true;
    const render = vi.fn();
    const gate = createHiddenRenderGate(render, () => hidden, clock);
    gate.notify();
    advance(10);
    gate.notify();
    expect(armed()).toBe(1);
    hidden = false;
    gate.notify();
    expect(render).toHaveBeenCalledTimes(2);
    expect(armed()).toBe(0);
    advance(HIDDEN_RENDER_MS * 2);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('dispose drops a pending trailing render', () => {
    const { clock, advance } = fakeClock();
    const render = vi.fn();
    const gate = createHiddenRenderGate(render, () => true, clock);
    gate.notify();
    advance(5);
    gate.notify();
    gate.dispose();
    advance(HIDDEN_RENDER_MS * 2);
    expect(render).toHaveBeenCalledTimes(1);
  });
});

// ─── chatSession: `minimized` is the switch, and turning it off fires the subscribers once ───

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

describe('chatSession minimized', () => {
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
    FakeWebSocket.all[0].open();
    return s;
  }

  it('starts shown; hiding fires nothing; showing fires the subscribers exactly once', async () => {
    const s = await open();
    expect(s.minimized).toBe(false);
    const cb = vi.fn();
    s.subscribe(cb);
    s.minimized = true;
    s.minimized = true;
    expect(s.minimized).toBe(true);
    expect(cb).not.toHaveBeenCalled();
    s.minimized = false;
    expect(s.minimized).toBe(false);
    expect(cb).toHaveBeenCalledTimes(1);
    // Re-setting the same value (every placement pass does) fires nothing.
    s.minimized = false;
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('a disposed session fires nothing when shown', async () => {
    const s = await open();
    const cb = vi.fn();
    s.subscribe(cb);
    s.minimized = true;
    s.dispose();
    s.minimized = false;
    expect(cb).not.toHaveBeenCalled();
  });
});
