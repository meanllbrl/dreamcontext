/**
 * The unseen dot's rule (ownerSees.ts, owner 2026-11-01: "sadece tab'a bastığımda geçiyor"):
 * a chat on screen with the window in front never carries the dot, however it got there; a chat
 * off screen, or any chat while the window is behind, still earns it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { applySeen, sessionsInView } from '../../dashboard/src/components/sleepy/ownerSees';

const wide = { projectOnScreen: true, foreground: new Set(['a', 'b']), panesCovered: false, phoneChat: null };

describe('sessionsInView', () => {
  it('is what the surface draws, split panes included', () => {
    expect([...sessionsInView(wide)]).toEqual(['a', 'b']);
  });
  it('is nothing for a project behind another project', () => {
    expect(sessionsInView({ ...wide, projectOnScreen: false }).size).toBe(0);
  });
  it('is nothing while a panel lies over the panes', () => {
    expect(sessionsInView({ ...wide, panesCovered: true }).size).toBe(0);
  });
  it('is the one chat on a narrow screen, nothing on its list', () => {
    expect([...sessionsInView({ ...wide, phoneChat: 'c' })]).toEqual(['c']);
    expect(sessionsInView({ ...wide, phoneChat: '' }).size).toBe(0);
  });
});

describe('applySeen', () => {
  const rows = () => [{ id: 'a', seen: false, attention: true }, { id: 'b', seen: true, attention: true }];
  it('takes the dot off the chat in view and leaves the rest', () => {
    const r = rows();
    expect(applySeen(r, new Set(['a']), true)).toBe(true);
    expect(r).toEqual([{ id: 'a', seen: true, attention: false }, { id: 'b', seen: false, attention: true }]);
  });
  it('keeps every dot while the window is behind, and drops seen', () => {
    const r = rows();
    expect(applySeen(r, new Set(['a', 'b']), false)).toBe(false);
    expect(r).toEqual([{ id: 'a', seen: false, attention: true }, { id: 'b', seen: false, attention: true }]);
  });
  it('reports nothing when no dot went, so the surface does not redraw for nothing', () => {
    expect(applySeen([{ id: 'a', seen: true, attention: false }], new Set(['a']), true)).toBe(false);
  });
});

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static all: FakeWebSocket[] = [];
  readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeWebSocket.all.push(this); }
  send() {}
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  frame(o: unknown) { this.onmessage?.({ data: JSON.stringify(o) }); }
}
const CID = '6f1c2e9a-a001-4a5b-8c9d-0123456789ab';
const result = { type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 1 };

describe('a chat session finishing a turn', () => {
  beforeEach(() => {
    FakeWebSocket.all = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost', assign: vi.fn() });
    vi.stubGlobal('document', {
      createElement: () => ({ className: '', remove() {}, style: {}, appendChild() {} }),
      addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', querySelector: () => null,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"messages":[],"items":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } })));
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  async function finish(seen: boolean, minimized: boolean) {
    const { createChatSession } = await import('../../dashboard/src/components/sleepy/chatSession');
    const s = createChatSession('demo', false, () => {}, CID, false, '', '', '', '', false, 'basic', '', '', null, '');
    s.seen = seen;
    s.minimized = minimized;
    const ws = FakeWebSocket.all[FakeWebSocket.all.length - 1];
    ws.open();
    ws.frame(result);
    return s.attention;
  }

  it('raises no dot on the chat the owner sees', async () => {
    expect(await finish(true, false)).toBe(false);
  });
  it('raises the dot on a tab drawn while the window is behind', async () => {
    expect(await finish(false, false)).toBe(true);
  });
  it('raises the dot on a chat off screen', async () => {
    expect(await finish(false, true)).toBe(true);
  });
});
