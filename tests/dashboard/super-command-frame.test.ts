// Wave 2 lane R: a Super verb frame reaches the window's handler with the super it names (a
// member's `m:<slug>`; main's frame goes on as `{ verb, args }`), and a member Super's delegated
// child carries its crew ticket on its connection URL (main's child URL unchanged).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const win = new EventTarget() as EventTarget & Record<string, unknown>;

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.all = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('window', win);
  vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:4000', assign: vi.fn() });
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

const SUPER = '6f1c2e9a-a001-4a5b-8c9d-0123456789ab';
const CHILD = '7a2d3f0b-b002-4b6c-9d0e-123456789abc';
const PLAIN = '8b3e4a1c-c003-4c7d-8e1f-23456789abcd';

async function open(claudeId: string, lean: readonly string[] | null = null) {
  const { createChatSession } = await import('../../dashboard/src/components/sleepy/chatSession');
  // The Super's own chat is mode `super`; a delegated child is a plain lean chat.
  return createChatSession('acme-app', false, () => {}, claudeId, false, '', '', '', '', false, lean ? 'basic' : 'super', '', '', null, '', lean);
}

type Cmd = { verb: string; args: Record<string, unknown>; superId?: string };

async function deliver(frame: Record<string, unknown>): Promise<{ seen: Cmd[]; replies: Array<Record<string, unknown>> }> {
  const s = await open(SUPER);
  const ws = FakeWebSocket.all[FakeWebSocket.all.length - 1];
  ws.open();
  const seen: Cmd[] = [];
  s.setSuperHandler(async (cmd) => { seen.push(cmd as Cmd); return { ok: true, result: { fine: 1 } }; });
  ws.onmessage?.({ data: JSON.stringify({ type: '_meta', subtype: 'super_command', id: 'c1', verb: 'answer', args: { child: 'x' }, ...frame }) });
  await vi.advanceTimersByTimeAsync(0);
  const replies = ws.sent.map((d) => JSON.parse(d) as Record<string, unknown>).filter((f) => f.type === 'super_command_result');
  s.dispose();
  return { seen, replies };
}

describe('a Super verb frame reaches the handler with its super', () => {
  it('a member frame (superId m:x) reaches the handler with superId m:x', async () => {
    const { seen, replies } = await deliver({ superId: 'm:x' });
    expect(seen).toEqual([{ verb: 'answer', args: { child: 'x' }, superId: 'm:x' }]);
    expect(replies).toEqual([{ type: 'super_command_result', id: 'c1', ok: true, result: { fine: 1 } }]);
  });

  it('a frame without superId reaches it exactly as before: { verb, args }, no superId key', async () => {
    const { seen } = await deliver({});
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ verb: 'answer', args: { child: 'x' } });
    expect(Object.keys(seen[0])).toEqual(['verb', 'args']);
  });

  it('a malformed superId is dropped by the parser and reads as main', async () => {
    const { seen } = await deliver({ superId: 'm:../etc' });
    expect(Object.keys(seen[0])).toEqual(['verb', 'args']);
  });
});

describe('a member delegate\'s crew ticket on the child\'s connection', () => {
  it('a bound ticket rides the child\'s URL as crewTicket, once', async () => {
    const { bindCrewTicket } = await import('../../dashboard/src/components/sleepy/chatSession');
    bindCrewTicket(CHILD, 'tk/1+2=3');
    await open(CHILD, ['github']);
    const url = new URL(FakeWebSocket.all[0].url);
    expect(url.searchParams.get('crewTicket')).toBe('tk/1+2=3');
    expect(url.searchParams.get('lean')).toBe('1');
    // Taken at spawn: a later chat of the same id carries none.
    await open(CHILD, ['github']);
    expect(new URL(FakeWebSocket.all[1].url).searchParams.has('crewTicket')).toBe(false);
  });

  it('without a ticket (main\'s delegate) the child URL carries nothing new', async () => {
    const { bindCrewTicket } = await import('../../dashboard/src/components/sleepy/chatSession');
    await open(PLAIN, ['github']);
    const before = FakeWebSocket.all[0].url;
    expect(before).not.toContain('crewTicket');
    // Main's frames carry no crewTicket: binding undefined, '' or a non-string binds nothing.
    for (const none of [undefined, '', 42, null]) bindCrewTicket(PLAIN, none);
    await open(PLAIN, ['github']);
    expect(FakeWebSocket.all[1].url).toBe(before);
  });

  it('the window binds the delegate frame\'s crewTicket to the child before spawning it', () => {
    const root = join(fileURLToPath(import.meta.url), '..', '..', '..');
    const src = readFileSync(join(root, 'dashboard/src/components/sleepy/AgentSurface.tsx'), 'utf-8');
    const handler = src.slice(src.indexOf('superCommandRef.current = async'), src.indexOf("if (verb === 'answer')"));
    const bind = handler.indexOf('bindCrewTicket(childId, args.crewTicket);');
    expect(bind).toBeGreaterThan(-1);
    expect(bind).toBeLessThan(handler.indexOf("spawn(false, childId, false, 'chat'"));
  });
});
