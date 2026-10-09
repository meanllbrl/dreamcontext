/**
 * The live browser view's server half (src/server/browser-mirror.ts), driven against a stand-in
 * CDP socket. The CDP method and event names are Chrome's; the screencast flow was measured
 * end to end against a real headless Chrome launched by @playwright/mcp on 2026-10-08.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  callsServerTool, createBrowserMirror, devtoolsUrlFrom, type BrowserMetaFrame, type CdpSocket,
} from '../../src/server/browser-mirror.js';

const PORT = 45001;
const WS = `ws://127.0.0.1:${PORT}/devtools/browser/abc-123`;

const browserCall = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__playwright__browser_navigate', input: {} }] } };

/** A CDP socket that answers commands and lets a test emit events. */
function fakeSocket() {
  const handlers: Record<string, Array<(d?: unknown) => void>> = {};
  const infoFor: Record<string, { url: string; title: string }> = {};
  const control = { infoDelayMs: 0 };
  const sent: Array<{ id: number; method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  const sock: CdpSocket = {
    send: (data) => {
      const msg = JSON.parse(data);
      sent.push(msg);
      const isInfo = msg.method === 'Target.getTargetInfo';
      // An info answer describes the page AT THE MOMENT IT WAS ASKED, and may take a while.
      const result = msg.method === 'Target.attachToTarget' ? { sessionId: `s-${msg.params.targetId}` }
        : isInfo && infoFor[msg.params.targetId] ? { targetInfo: { ...infoFor[msg.params.targetId] } }
        : {};
      const answer = () => emit('message', JSON.stringify({ id: msg.id, result }));
      if (isInfo && control.infoDelayMs) setTimeout(answer, control.infoDelayMs);
      else queueMicrotask(answer);
    },
    close: () => emit('close'),
    on: (event, fn) => { (handlers[event] ??= []).push(fn); },
  };
  function emit(event: string, data?: unknown) { for (const fn of handlers[event] ?? []) fn(data); }
  return { sock, sent, emit, infoFor, control, event: (method: string, params: Record<string, unknown>, sessionId?: string) => emit('message', JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) })) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => { vi.useRealTimers(); });

describe('callsServerTool', () => {
  it('matches a tool_use of this server only', () => {
    expect(callsServerTool(browserCall, 'playwright')).toBe(true);
    expect(callsServerTool(browserCall, 'pw')).toBe(false);
    expect(callsServerTool({ type: 'user', message: browserCall.message }, 'playwright')).toBe(false);
    expect(callsServerTool({ type: 'assistant', message: { content: [{ type: 'text', text: 'mcp__playwright__x' }] } }, 'playwright')).toBe(false);
  });
});

describe('devtoolsUrlFrom', () => {
  it("accepts only Chrome's browser endpoint on this exact loopback port", () => {
    expect(devtoolsUrlFrom({ webSocketDebuggerUrl: WS }, PORT)).toBe(WS);
    expect(devtoolsUrlFrom({ webSocketDebuggerUrl: WS }, PORT + 1)).toBeNull();
    expect(devtoolsUrlFrom({ webSocketDebuggerUrl: 'ws://evil.test:45001/devtools/browser/abc' }, PORT)).toBeNull();
    expect(devtoolsUrlFrom({ ok: true }, PORT)).toBeNull();
    expect(devtoolsUrlFrom(null, PORT)).toBeNull();
  });
});

describe('createBrowserMirror', () => {
  async function attached() {
    const fake = fakeSocket();
    const frames: BrowserMetaFrame[] = [];
    const fetchJson = vi.fn(async () => ({ webSocketDebuggerUrl: WS }));
    const mirror = createBrowserMirror({
      port: PORT, server: 'playwright', send: (f) => frames.push(f), fetchJson,
      connect: () => { queueMicrotask(() => fake.emit('open')); return fake.sock; },
    });
    mirror.observe(browserCall);
    await flush(); await flush();
    return { fake, frames, fetchJson, mirror };
  }

  it('does nothing until the agent calls a browser tool', async () => {
    const fetchJson = vi.fn(async () => null);
    const mirror = createBrowserMirror({ port: PORT, server: 'playwright', send: () => {}, fetchJson });
    mirror.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } });
    await flush();
    expect(fetchJson).not.toHaveBeenCalled();
    mirror.dispose();
  });

  it('attaches to the newest page, screencasts it, acks every frame and forwards it with the page it shows', async () => {
    const { fake, frames, mirror } = await attached();
    expect(fake.sent.map((m) => m.method)).toContain('Target.setDiscoverTargets');
    fake.event('Target.targetCreated', { targetInfo: { targetId: 'P1', type: 'page', url: 'https://example.test/', title: 'Example' } });
    await flush(); await flush();
    expect(fake.sent.find((m) => m.method === 'Page.startScreencast')?.sessionId).toBe('s-P1');
    fake.event('Page.screencastFrame', { data: 'JPEG1', sessionId: 7, metadata: { deviceWidth: 1280, deviceHeight: 720 } }, 's-P1');
    await flush();
    expect(fake.sent.find((m) => m.method === 'Page.screencastFrameAck')?.params).toEqual({ sessionId: 7 });
    expect(frames).toEqual([expect.objectContaining({ subtype: 'browser_frame', data: 'JPEG1', width: 1280, height: 720, url: 'https://example.test/', title: 'Example' })]);
    mirror.dispose();
  });

  it('a title that lands after the frame re-sends the frame under the new name', async () => {
    const { fake, frames, mirror } = await attached();
    fake.event('Target.targetCreated', { targetInfo: { targetId: 'P1', type: 'page', url: 'https://example.test/', title: 'https://example.test/' } });
    await flush(); await flush();
    fake.event('Page.screencastFrame', { data: 'F', sessionId: 1, metadata: { deviceWidth: 10, deviceHeight: 10 } }, 's-P1');
    await flush();
    await new Promise((r) => setTimeout(r, 200));
    fake.event('Target.targetInfoChanged', { targetInfo: { targetId: 'P1', type: 'page', url: 'https://example.test/', title: 'Example' } });
    await new Promise((r) => setTimeout(r, 200));
    expect(frames.map((f) => (f.subtype === 'browser_frame' ? f.title : f.subtype))).toEqual(['https://example.test/', 'Example']);
    mirror.dispose();
  });

  it("the document's own <title>, which Chrome never announces, is asked for and re-sent", async () => {
    const { fake, frames, mirror } = await attached();
    fake.event('Target.targetCreated', { targetInfo: { targetId: 'P1', type: 'page', url: 'https://example.test/', title: 'https://example.test/' } });
    await flush(); await flush();
    fake.infoFor.P1 = { url: 'https://example.test/', title: 'Parsed title' };
    fake.event('Page.screencastFrame', { data: 'F', sessionId: 1, metadata: { deviceWidth: 10, deviceHeight: 10 } }, 's-P1');
    await new Promise((r) => setTimeout(r, 900));
    expect(frames.map((f) => (f.subtype === 'browser_frame' ? f.title : f.subtype))).toEqual(['https://example.test/', 'Parsed title']);
    mirror.dispose();
  });

  it('an answer about the page asked for before a navigation does not overwrite the new page', async () => {
    const { fake, frames, mirror } = await attached();
    fake.event('Target.targetCreated', { targetInfo: { targetId: 'P1', type: 'page', url: 'https://one.test/', title: 'One' } });
    await flush(); await flush();
    fake.infoFor.P1 = { url: 'https://one.test/', title: 'One' };
    fake.control.infoDelayMs = 300;
    fake.event('Page.screencastFrame', { data: 'F1', sessionId: 1, metadata: { deviceWidth: 10, deviceHeight: 10 } }, 's-P1');
    // The info request goes out at ~250 ms and is answered at ~550 ms; the navigation lands
    // between the two, so the answer describes page one.
    await new Promise((r) => setTimeout(r, 350));
    fake.infoFor.P1 = { url: 'https://two.test/', title: 'Two' };
    fake.event('Target.targetInfoChanged', { targetInfo: { targetId: 'P1', type: 'page', url: 'https://two.test/', title: 'https://two.test/' } });
    fake.event('Page.screencastFrame', { data: 'F2', sessionId: 2, metadata: { deviceWidth: 10, deviceHeight: 10 } }, 's-P1');
    await new Promise((r) => setTimeout(r, 300));
    const last = frames.filter((f) => f.subtype === 'browser_frame').pop();
    expect(last && last.subtype === 'browser_frame' && last.url).toBe('https://two.test/');
    mirror.dispose();
  });

  it('a page that navigates and then paints nothing gets its screencast restarted', async () => {
    const { fake, mirror } = await attached();
    fake.event('Target.targetCreated', { targetInfo: { targetId: 'P1', type: 'page', url: 'https://one.test/', title: 'One' } });
    await flush(); await flush();
    fake.event('Target.targetInfoChanged', { targetInfo: { targetId: 'P1', type: 'page', url: 'https://two.test/', title: '' } });
    await new Promise((r) => setTimeout(r, 1700));
    expect(fake.sent.filter((m) => m.method === 'Page.startScreencast')).toHaveLength(2);
    mirror.dispose();
  });

  it('a frame from a page no longer shown is acked but not forwarded', async () => {
    const { fake, frames, mirror } = await attached();
    fake.event('Target.targetCreated', { targetInfo: { targetId: 'P1', type: 'page', url: 'a', title: '' } });
    await flush(); await flush();
    fake.event('Target.targetCreated', { targetInfo: { targetId: 'P2', type: 'page', url: 'b', title: '' } });
    await flush(); await flush();
    fake.event('Page.screencastFrame', { data: 'OLD', sessionId: 1, metadata: { deviceWidth: 10, deviceHeight: 10 } }, 's-P1');
    await flush();
    expect(frames).toEqual([]);
    expect(fake.sent.some((m) => m.method === 'Page.stopScreencast' && m.sessionId === 's-P1')).toBe(true);
    mirror.dispose();
  });

  it('the browser going away says closed once; a socket that adopts gets the last frame again', async () => {
    const { fake, frames, mirror } = await attached();
    fake.event('Target.targetCreated', { targetInfo: { targetId: 'P1', type: 'page', url: 'a', title: '' } });
    await flush(); await flush();
    fake.event('Page.screencastFrame', { data: 'F', sessionId: 1, metadata: { deviceWidth: 10, deviceHeight: 10 } }, 's-P1');
    await flush();
    mirror.replay();
    expect(frames.filter((f) => f.subtype === 'browser_frame')).toHaveLength(2);
    fake.emit('close');
    expect(frames[frames.length - 1]).toEqual({ subtype: 'browser_state', state: 'closed' });
    mirror.replay();
    expect(frames).toHaveLength(3);
    mirror.dispose();
  });

  it('refuses whatever answers on the port when it is not Chrome', async () => {
    vi.useFakeTimers();
    const connect = vi.fn();
    const mirror = createBrowserMirror({
      port: PORT, server: 'playwright', send: () => {}, fetchJson: async () => ({ hello: 'not chrome' }), connect,
    });
    mirror.observe(browserCall);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(connect).not.toHaveBeenCalled();
    mirror.dispose();
  });
});
