/**
 * The Assistant's chat registry: every live chat, with a status DERIVED from the frames the
 * chat bridge already parses (agent-chat.ts's single stdout parse point). Driven here through
 * the REAL `startChatSession` with a mocked `claude` child, so what is pinned is the tap at the
 * parse point — not a registry fed by hand.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Isolated HOME: the account auto-switch must see a single-account machine, or a real
// multi-account HOME would send the first user frame through a (mocked, never-ending) probe.
vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/assistant-registry-home-`);
});

const spawned: Array<{ child: FakeChild; env: Record<string, string> }> = [];

class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid = 4243;
}

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: vi.fn((_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
      const child = new FakeChild();
      spawned.push({ child, env: opts.env });
      return child as unknown as import('node:child_process').ChildProcess;
    }),
  };
});

const { startChatSession } = await import('../../src/server/routes/agent-chat.js');
const registry = await import('../../src/lib/assistant/chat-registry.js');

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
}

const SID = '11111111-2222-4333-8444-555555555555';

function start(opts: { mode?: 'basic' | 'assistant'; vault?: string; sessionId?: string; assistantEnv?: Record<string, string> } = {}) {
  const ws = new FakeWs();
  startChatSession(ws as unknown as import('ws').WebSocket, '/tmp/assistant-registry-test', {
    bypass: false, sessionId: opts.sessionId ?? SID, resumeId: '', model: '', effort: '', initialPrompt: '', deferPrompt: false,
    account: '', mode: opts.mode ?? 'basic', vault: opts.vault ?? 'acme-app', assistantEnv: opts.assistantEnv,
  });
  return { ws, ...spawned[spawned.length - 1] };
}

const line = (child: FakeChild, frame: Record<string, unknown>) => child.stdout.emit('data', Buffer.from(JSON.stringify(frame) + '\n'));

describe('chat registry — status derived at the agent-chat.ts parse point', () => {
  beforeEach(() => { spawned.length = 0; registry._resetChatRegistry(); });
  afterEach(() => { vi.useRealTimers(); });

  it('lists a new chat as starting, under its vault and mode', () => {
    start();
    const [c] = registry.listChats();
    expect(c).toMatchObject({ sessionId: SID, vault: 'acme-app', mode: 'basic', status: 'starting' });
  });

  it('walks starting → working → asking → working → idle → gone from the real frames', async () => {
    const { ws, child } = start();
    ws.emit('message', JSON.stringify({ type: 'user', text: 'fix the login bug' }));
    // The user frame goes through the switch gate's promise chain before it reaches stdin.
    await vi.waitFor(() => expect(registry.getChat(SID)?.status).toBe('working'), { timeout: 4000 });
    {
      expect(registry.getChat(SID)?.title).toBe('fix the login bug');

      line(child, { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at auth.ts now.' }] } });
      expect(registry.getChat(SID)?.lastAssistantText).toEqual(['Looking at auth.ts now.']);

      line(child, { type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] } } });
      const asking = registry.getChat(SID)!;
      expect(asking.status).toBe('asking');
      expect(asking.pendingQuestion).toMatchObject({ requestId: 'req-1', isPermission: false, text: 'Which DB?', options: ['Postgres', 'SQLite'] });

      ws.emit('message', JSON.stringify({ type: 'answer', requestId: 'req-1', behavior: 'allow', updatedInput: {} }));
      expect(registry.getChat(SID)?.status).toBe('working');
      expect(registry.getChat(SID)?.pendingQuestion).toBeNull();

      line(child, { type: 'result', subtype: 'success' });
      expect(registry.getChat(SID)?.status).toBe('idle');

      child.emit('close', 0);
      expect(registry.getChat(SID)?.status).toBe('gone');
    }
  });

  it('a tool-permission prompt is marked as a PERMISSION, not a question', () => {
    const { child } = start();
    line(child, { type: 'control_request', request_id: 'req-2', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf build' } } });
    expect(registry.getChat(SID)?.pendingQuestion).toMatchObject({ isPermission: true, toolName: 'Bash', text: 'rm -rf build' });
  });

  it('a sub-agent result does not end the main turn', () => {
    const { child } = start();
    line(child, { type: 'result', subtype: 'success', parent_tool_use_id: 'toolu_x' });
    expect(registry.getChat(SID)?.status).toBe('starting');
  });

  it('a top-level result carrying parent_tool_use_id: null ends the turn (idle)', async () => {
    const { ws, child } = start();
    ws.emit('message', JSON.stringify({ type: 'user', text: 'fix the login bug' }));
    await vi.waitFor(() => expect(registry.getChat(SID)?.status).toBe('working'), { timeout: 4000 });
    line(child, { type: 'result', subtype: 'success', parent_tool_use_id: null });
    expect(registry.getChat(SID)?.status).toBe('idle');
  });

  it('main-agent output after a result (a queued second message) reads as working again', async () => {
    const { ws, child } = start();
    ws.emit('message', JSON.stringify({ type: 'user', text: 'first' }));
    await vi.waitFor(() => expect(registry.getChat(SID)?.status).toBe('working'), { timeout: 4000 });
    line(child, { type: 'result', subtype: 'success' });
    expect(registry.getChat(SID)?.status).toBe('idle');
    line(child, { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'On the second one now.' }] } });
    expect(registry.getChat(SID)?.status).toBe('working');
    // A sub-agent's output alone does not reopen the main turn.
    line(child, { type: 'result', subtype: 'success' });
    line(child, { type: 'assistant', parent_tool_use_id: 'toolu_sub', message: { content: [{ type: 'text', text: 'sub' }] } });
    expect(registry.getChat(SID)?.status).toBe('idle');
  });

  it('a restored tab nobody typed in stays status starting but reads as idle after the grace', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-09-26T20:00:00.000Z'));
    start();
    const t0 = Date.now();
    expect(registry.activityOf(registry.getChat(SID)!, t0 + registry.STARTING_GRACE_MS)).toBe('starting');
    expect(registry.activityOf(registry.getChat(SID)!, t0 + registry.STARTING_GRACE_MS + 1)).toBe('idle');
    expect(registry.getChat(SID)?.status).toBe('starting');
  });

  it('a working turn with no frame past STALE_MS is stale; a frame brings it back', async () => {
    const { ws, child } = start();
    ws.emit('message', JSON.stringify({ type: 'user', text: 'fix the login bug' }));
    await vi.waitFor(() => expect(registry.getChat(SID)?.status).toBe('working'), { timeout: 4000 });
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-09-26T20:00:00.000Z');
    vi.setSystemTime(t0);
    line(child, { type: 'stream_event', event: { type: 'content_block_delta' } });

    vi.setSystemTime(t0 + registry.STALE_MS);
    expect(registry.activityOf(registry.getChat(SID)!)).toBe('working');
    vi.setSystemTime(t0 + registry.STALE_MS + 1);
    expect(registry.activityOf(registry.getChat(SID)!)).toBe('stale');
    expect(registry.getChat(SID)?.status).toBe('working');

    line(child, { type: 'stream_event', event: { type: 'content_block_delta' } });
    expect(registry.activityOf(registry.getChat(SID)!)).toBe('working');
  });

  it('an open tool call earns the longer TOOL_STALE_MS bar until its tool_result arrives', async () => {
    const { ws, child } = start();
    ws.emit('message', JSON.stringify({ type: 'user', text: 'run the build' }));
    await vi.waitFor(() => expect(registry.getChat(SID)?.status).toBe('working'), { timeout: 4000 });
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-09-26T20:00:00.000Z');
    vi.setSystemTime(t0);
    line(child, { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm run build' } }] } });
    expect(registry.getChat(SID)?.toolsInFlight).toBe(1);

    vi.setSystemTime(t0 + registry.STALE_MS + 1);
    expect(registry.activityOf(registry.getChat(SID)!)).toBe('working');
    vi.setSystemTime(t0 + registry.TOOL_STALE_MS + 1);
    expect(registry.activityOf(registry.getChat(SID)!)).toBe('stale');

    line(child, { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } });
    expect(registry.getChat(SID)?.toolsInFlight).toBe(0);
    vi.setSystemTime(t0 + registry.TOOL_STALE_MS + 1 + registry.STALE_MS + 1);
    expect(registry.activityOf(registry.getChat(SID)!)).toBe('stale');
  });

  it('an asking chat never goes stale: it is waiting on the owner', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-09-26T20:00:00.000Z');
    vi.setSystemTime(t0);
    const { child } = start();
    line(child, { type: 'control_request', request_id: 'req-9', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
    expect(registry.activityOf(registry.getChat(SID)!, t0 + registry.TOOL_STALE_MS * 10)).toBe('asking');
  });

  it('the Assistant\'s OWN session is never registered', () => {
    start({ mode: 'assistant', vault: '__assistant__' });
    expect(registry.listChats()).toEqual([]);
  });

  it('watch resolves IMMEDIATELY with ended:true on a gone chat', async () => {
    const { child } = start();
    child.emit('close', 0);
    const t0 = Date.now();
    const r = await registry.watchChat(SID, 'idle', 60_000);
    expect(r.ended).toBe(true);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it('watch resolves with ended:true when the chat goes WHILE it waits', async () => {
    const { child } = start();
    const p = registry.watchChat(SID, 'idle', 60_000);
    child.emit('close', 0);
    const r = await p;
    expect(r.ended).toBe(true);
    expect(r.entry?.status).toBe('gone');
  });

  it('watch --until idle resolves on the result frame; already-idle resolves at once', async () => {
    const { child } = start();
    const p = registry.watchChat(SID, 'idle', 60_000);
    line(child, { type: 'result', subtype: 'success' });
    expect((await p).entry?.status).toBe('idle');
    expect((await registry.watchChat(SID, 'idle', 60_000)).entry?.status).toBe('idle');
  });

  it('watch times out honestly', async () => {
    start();
    const r = await registry.watchChat(SID, 'idle', 10);
    expect(r.timedOut).toBe(true);
  });

  it('gone entries are DELETED ten minutes later (every key has a death)', () => {
    vi.useFakeTimers();
    const { child } = start();
    child.emit('close', 0);
    vi.advanceTimersByTime(registry.GONE_TTL_MS - 1);
    expect(registry.getChat(SID)?.status).toBe('gone');
    vi.advanceTimersByTime(1);
    expect(registry.getChat(SID)).toBeNull();
    expect(registry.listChats()).toEqual([]);
  });

  it('keeps at most 20 assistant texts per chat', () => {
    const { child } = start();
    for (let i = 0; i < 25; i++) line(child, { type: 'assistant', message: { content: [{ type: 'text', text: `t${i}` }] } });
    const texts = registry.getChat(SID)!.lastAssistantText;
    expect(texts).toHaveLength(registry.TEXT_RING);
    expect(texts[0]).toBe('t5');
  });
});

const ask = (child: FakeChild, requestId: string, question = 'Which DB?') =>
  line(child, { type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question, options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] } } });

describe('watch --until settled: the chat stopped for the owner (idle OR asking)', () => {
  beforeEach(() => { spawned.length = 0; registry._resetChatRegistry(); });

  it('resolves when a working chat starts ASKING — where --until idle would keep waiting', async () => {
    const { ws, child } = start();
    ws.emit('message', JSON.stringify({ type: 'user', text: 'plan the migration' }));
    await vi.waitFor(() => expect(registry.getChat(SID)?.status).toBe('working'), { timeout: 4000 });
    const settled = registry.watchChat(SID, 'settled', 60_000);
    const idle = registry.watchChat(SID, 'idle', 50);
    ask(child, 'req-s1');
    const r = await settled;
    expect(r.timedOut).toBeUndefined();
    expect(r.entry).toMatchObject({ status: 'asking', pendingQuestion: { requestId: 'req-s1' } });
    // `idle` stays strict: asking is not idle.
    expect((await idle).timedOut).toBe(true);
  });

  it('resolves when a working chat goes idle', async () => {
    const { ws, child } = start();
    ws.emit('message', JSON.stringify({ type: 'user', text: 'plan the migration' }));
    await vi.waitFor(() => expect(registry.getChat(SID)?.status).toBe('working'), { timeout: 4000 });
    const p = registry.watchChat(SID, 'settled', 60_000);
    line(child, { type: 'result', subtype: 'success' });
    expect((await p).entry?.status).toBe('idle');
  });

  it('resolves AT ONCE when the chat is already idle or already asking', async () => {
    const { child } = start();
    line(child, { type: 'result', subtype: 'success' });
    const a = await registry.watchChat(SID, 'settled', 60_000);
    expect(a.entry?.status).toBe('idle');
    expect(a.timedOut).toBeUndefined();
    ask(child, 'req-s2');
    const b = await registry.watchChat(SID, 'settled', 60_000);
    expect(b.entry?.status).toBe('asking');
    expect(b.timedOut).toBeUndefined();
    // …but an already-asking chat does not satisfy a strict `idle` watch.
    expect((await registry.watchChat(SID, 'idle', 20)).timedOut).toBe(true);
  });

  it('does not resolve on a starting → working change, and ends with ended:true on close', async () => {
    const { ws, child } = start();
    const p = registry.watchChat(SID, 'settled', 60_000);
    ws.emit('message', JSON.stringify({ type: 'user', text: 'go' }));
    await vi.waitFor(() => expect(registry.getChat(SID)?.status).toBe('working'), { timeout: 4000 });
    child.emit('close', 0);
    const r = await p;
    expect(r.ended).toBe(true);
    expect(r.entry?.status).toBe('gone');
  });
});

describe('onChatChange: every status change, and a new question while still asking', () => {
  beforeEach(() => { spawned.length = 0; registry._resetChatRegistry(); });

  it('fires once per status change with the entry and the status it came from', async () => {
    const seen: Array<[string, string]> = [];
    registry.onChatChange(({ entry, from }) => seen.push([from, entry.status]));
    const { ws, child } = start();
    ws.emit('message', JSON.stringify({ type: 'user', text: 'fix it' }));
    await vi.waitFor(() => expect(registry.getChat(SID)?.status).toBe('working'), { timeout: 4000 });
    ask(child, 'req-c1');
    ws.emit('message', JSON.stringify({ type: 'answer', requestId: 'req-c1', behavior: 'allow', updatedInput: {} }));
    // A frame that keeps the status where it is is not a change.
    line(child, { type: 'assistant', message: { content: [{ type: 'text', text: 'working on it' }] } });
    line(child, { type: 'result', subtype: 'success' });
    child.emit('close', 0);
    expect(seen).toEqual([
      ['starting', 'working'],
      ['working', 'asking'],
      ['asking', 'working'],
      ['working', 'idle'],
      ['idle', 'gone'],
    ]);
  });

  it('carries the pending question on the asking change', () => {
    const changes: registry.ChatChange[] = [];
    registry.onChatChange((c) => changes.push(c));
    const { child } = start();
    ask(child, 'req-c2', 'Ship it?');
    expect(changes).toHaveLength(1);
    expect(changes[0].from).toBe('starting');
    expect(changes[0].entry).toMatchObject({ sessionId: SID, status: 'asking', pendingQuestion: { requestId: 'req-c2', text: 'Ship it?' } });
  });

  it('fires when a NEW question replaces the pending one while status stays asking — not on a repeat of the same one', () => {
    const changes: registry.ChatChange[] = [];
    registry.onChatChange((c) => changes.push(c));
    const { child } = start();
    ask(child, 'req-a', 'First?');
    ask(child, 'req-a', 'First?');
    expect(changes).toHaveLength(1);
    ask(child, 'req-b', 'Second?');
    expect(changes).toHaveLength(2);
    expect(changes[1].from).toBe('asking');
    expect(changes[1].entry).toMatchObject({ status: 'asking', pendingQuestion: { requestId: 'req-b', text: 'Second?' } });
  });

  it('hands each listener its own copy of the entry', () => {
    const changes: registry.ChatChange[] = [];
    registry.onChatChange((c) => { c.entry.lastAssistantText.push('mutated'); changes.push(c); });
    const { child } = start();
    line(child, { type: 'result', subtype: 'success' });
    expect(changes).toHaveLength(1);
    expect(registry.getChat(SID)?.lastAssistantText).toEqual([]);
  });

  it('a throwing listener neither breaks the registry nor starves the other listeners', () => {
    const got: string[] = [];
    registry.onChatChange(() => { throw new Error('boom'); });
    registry.onChatChange(({ entry }) => got.push(entry.status));
    const { child } = start();
    expect(() => line(child, { type: 'result', subtype: 'success' })).not.toThrow();
    expect(registry.getChat(SID)?.status).toBe('idle');
    expect(got).toEqual(['idle']);
  });

  it('the returned function unsubscribes', () => {
    const got: string[] = [];
    const off = registry.onChatChange(({ entry }) => got.push(entry.status));
    const { child } = start();
    ask(child, 'req-u');
    off();
    line(child, { type: 'result', subtype: 'success' });
    expect(got).toEqual(['asking']);
  });

  it('_resetChatRegistry drops every listener', () => {
    const got: string[] = [];
    registry.onChatChange(({ entry }) => got.push(entry.status));
    registry._resetChatRegistry();
    const { child } = start();
    line(child, { type: 'result', subtype: 'success' });
    expect(got).toEqual([]);
  });
});

describe('the assistant token reaches ONLY the __assistant__ spawn', () => {
  beforeEach(() => { spawned.length = 0; registry._resetChatRegistry(); });

  const env = { DREAMCONTEXT_ASSISTANT_URL: 'http://127.0.0.1:4173', DREAMCONTEXT_ASSISTANT_TOKEN: 'dca_x' };

  it('is injected into the assistant session', () => {
    const { env: childEnv } = start({ mode: 'assistant', vault: '__assistant__', assistantEnv: env });
    expect(childEnv.DREAMCONTEXT_ASSISTANT_TOKEN).toBe('dca_x');
    expect(childEnv.DREAMCONTEXT_ASSISTANT_URL).toBe('http://127.0.0.1:4173');
  });

  it('is NOT injected into any other mode, even if a caller passed it', () => {
    const { env: childEnv } = start({ mode: 'basic', vault: 'acme-app', assistantEnv: env });
    expect(childEnv.DREAMCONTEXT_ASSISTANT_TOKEN).toBeUndefined();
    expect(childEnv.DREAMCONTEXT_ASSISTANT_URL).toBeUndefined();
  });
});
