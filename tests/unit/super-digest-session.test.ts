/**
 * The agenda digest on the phone's chat session (task hands-free-telefonda-super-agent-sohbeti-
 * ajandayi…, AC1): a `super_digest` frame is taken only by the phone's Super mirror, kept as
 * `superDigest`, and told to its followers once per new key; any other chat drops it.
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

let history: unknown[] = [];

beforeEach(() => {
  FakeWebSocket.all = [];
  history = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:4173', assign: vi.fn() });
  vi.stubGlobal('document', {
    createElement: () => ({ className: '', remove() {}, style: {}, appendChild() {} }),
    addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', querySelector: () => null,
  });
  vi.stubGlobal('fetch', vi.fn(async (u: string) => new Response(
    JSON.stringify(String(u).includes('chat-history') ? { items: history } : { messages: [], items: [] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )));
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
});

afterEach(() => { vi.unstubAllGlobals(); });

async function open(mode: 'super' | 'basic' | 'assistant', superMirror = false, resume = false) {
  const { createChatSession } = await import('../../dashboard/src/components/sleepy/chatSession');
  const s = createChatSession('demo', false, () => {}, '6f1c2e9a-a001-4a5b-8c9d-0123456789ab', resume, '', '', '', '', false, mode, '', '', null, '', null, superMirror);
  const ws = FakeWebSocket.all.at(-1)!;
  ws.open();
  return { s, ws };
}
const frame = (ws: FakeWebSocket, f: Record<string, unknown>) => ws.onmessage?.({ data: `${JSON.stringify(f)}\n` });

const digest = (key: string, text = 'Fixing the paywall') => ({
  type: '_meta', subtype: 'super_digest', key, ownerBatches: ['b1'], names: { c1: 'Pricing card' },
  pad: [{ id: 'n1', section: 'now', text, at: 1 }],
  waiting: [{ id: 'q1', kind: 'ask', state: 'escalated', createdAt: 2, sessionId: 'S', text: 'Which design?' }],
});

describe('super_digest on a chat session', () => {
  it('the phone mirror keeps it and tells its followers once per key', async () => {
    const { s, ws } = await open('basic', true);
    const seen: Array<string | null> = [];
    s.onSuperDigest((d) => seen.push(d?.key ?? null));
    frame(ws, digest('k1'));
    frame(ws, digest('k1'));
    frame(ws, digest('k2', 'Done with the paywall'));
    expect(seen).toEqual([null, 'k1', 'k2']);
    expect(s.superDigest).toMatchObject({ key: 'k2', names: { c1: 'Pricing card' }, ownerBatches: ['b1'] });
    expect(s.superDigest!.pad[0].text).toBe('Done with the paywall');
    // A late follower gets the current one at once; nothing is drawn in the transcript.
    const late: Array<string | null> = [];
    s.onSuperDigest((d) => late.push(d?.key ?? null));
    expect(late).toEqual(['k2']);
    expect(s.getModel().items).toHaveLength(0);
  });

  it('the desktop Super chat and an ordinary chat drop it', async () => {
    for (const mode of ['super', 'basic'] as const) {
      const { s, ws } = await open(mode, false);
      frame(ws, digest('k1'));
      expect(s.superDigest).toBeNull();
    }
  });

  it('a malformed frame changes nothing', async () => {
    const { s, ws } = await open('basic', true);
    frame(ws, { type: '_meta', subtype: 'super_digest', pad: [] });
    expect(s.superDigest).toBeNull();
  });
});
