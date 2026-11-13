// The resume seed tells when it has landed (historyPending): the Super pane's first landing judges
// the whole transcript, and live frames can arrive before the history (end review r2).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  send() {}
  close() { this.readyState = 3; }
}

/** The chat-history reply, held until the test lets it go. */
let release: (items: unknown[]) => void = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:4000', assign: vi.fn() });
  vi.stubGlobal('document', {
    createElement: () => ({ className: '', remove() {}, style: {}, appendChild() {} }),
    addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', querySelector: () => null,
  });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (!String(url).includes('/agent/chat-history')) return json({ messages: [], items: [] });
    return new Promise<Response>((resolve) => { release = (items) => resolve(json({ items })); });
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function open(resume: boolean) {
  const { createChatSession } = await import('../../dashboard/src/components/sleepy/chatSession');
  return createChatSession('demo', false, () => {}, '6f1c2e9a-a001-4a5b-8c9d-0123456789ab', resume, '', '', '', '', false, 'basic', '', '', null, '');
}

describe('the resume seed says when it has landed', () => {
  it('pending from the start of a resumed session until the history arrives', async () => {
    const s = await open(true);
    expect(s.getModel().historyPending).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.getModel().historyPending).toBe(true);
    release([{ kind: 'text', text: 'Durum A: bugünkü durum', ts: 1 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.getModel().historyPending).toBeUndefined();
    expect(s.getModel().history.length).toBe(1);
    s.dispose();
  });

  it('an empty transcript is a seed too (Mutation: cleared only when items came)', async () => {
    const s = await open(true);
    await vi.advanceTimersByTimeAsync(0);
    release([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.getModel().historyPending).toBeUndefined();
    s.dispose();
  });

  it('a fresh session has nothing pending', async () => {
    const s = await open(false);
    expect(s.getModel().historyPending).toBeUndefined();
    s.dispose();
  });
});
