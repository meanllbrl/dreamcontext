/**
 * TABLO row 41, the client half: the frames a REAL Codex turn produced (2 Nov 2026, one
 * sub-agent running `ls -a`; recorded from `dreamcontext t3-chat`, paths scrubbed to a fixture)
 * fed into the chat's own session. The owner sees one sub-agent card with its result, and none
 * of the sub-agent's steps in the chat.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeWebSocket {
  static all: FakeWebSocket[] = [];
  readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeWebSocket.all.push(this); }
  send() { /* nothing */ }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
}

beforeEach(() => {
  FakeWebSocket.all = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost', assign() {} });
  vi.stubGlobal('document', {
    createElement: () => ({ className: '', remove() {}, style: {}, appendChild() {} }),
    addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', querySelector: () => null,
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ messages: [], items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('a Codex sub-agent in the chat client', () => {
  it('is one finished card with its result, and its steps are not in the transcript', async () => {
    const { createChatSession } = await import('../../../dashboard/src/components/sleepy/chatSession');
    const s = createChatSession('demo', false, () => {}, '6f1c2e9a-a001-4a5b-8c9d-0123456789ab', false, '', '', '', '', false, 'basic', '', '', null, '');
    const ws = FakeWebSocket.all[0]!;
    ws.open();
    const lines = readFileSync(join(__dirname, '..', '..', 'fixtures', 't3-bridge', 'codex-subagent-turn.jsonl'), 'utf-8').split('\n').filter(Boolean);
    for (const l of lines) ws.onmessage?.({ data: l });
    const m = s.getModel();
    expect(m.subAgents).toHaveLength(1);
    const run = m.subAgents[0]!;
    expect(run).toMatchObject({ name: 'list project folders', status: 'completed', taskType: 'local_agent', lastToolName: 'Bash' });
    expect(run.summary).toContain('_dream_context');
    // The sub-agent's own `ls -a` is on its card, never a tool row of the chat's.
    const tools = m.items.filter((i) => i.kind === 'tool') as Array<{ name: string }>;
    expect(tools.filter((t) => t.name === 'Bash')).toHaveLength(0);
    // The chat's own answer is there.
    expect(JSON.stringify(m.items)).toContain('_dream_context');
    s.dispose();
  });
});
