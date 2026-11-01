/**
 * The chat server's `?tool=codex` branch (Track T W1): a Codex pane spawns the bridge child
 * (`dreamcontext t3-chat`) on the SAME spawn path as Claude, so it gets its Eco seed and tab env,
 * and the rotation writes `/clear` to it exactly as to Claude. A Claude pane's script is unchanged.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawned: Array<{ child: FakeChild; file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];

class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(() => true), end: vi.fn(), on: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid = 4343;
}

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: vi.fn((file: string, args: string[], o: { env: NodeJS.ProcessEnv }) => {
      const child = new FakeChild();
      spawned.push({ child, file, args, env: o.env });
      return child as unknown as import('node:child_process').ChildProcess;
    }),
  };
});

const { startChatSession } = await import('../../../src/server/routes/agent-chat.js');
const { readTabHandoff, writeHandoffRecord, readHandoffRecord } = await import('../../../src/lib/context-watch.js');

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
}

const PANE = '7c4a1b2e-3d4f-4a5b-8c6d-0e1f2a3b4c5d';
let project = '';

beforeEach(() => {
  spawned.length = 0;
  project = mkdtempSync(join(tmpdir(), 'dc-codex-pane-'));
  mkdirSync(join(project, '_dream_context', 'state'), { recursive: true });
  process.env.DREAMCONTEXT_CLI = '/opt/dreamcontext/dist/index.js';
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
  delete process.env.DREAMCONTEXT_CLI;
});

function open(tool?: 'codex') {
  const ws = new FakeWs();
  startChatSession(ws as unknown as import('ws').WebSocket, project, {
    bypass: false, sessionId: PANE, resumeId: '', model: 'gpt-5.6-terra', effort: 'high', mode: 'basic' as never,
    account: '', initialPrompt: '', deferPrompt: false, ...(tool ? { tool } : {}),
  });
  return { ws, s: spawned[spawned.length - 1]! };
}

const scriptOf = (s: { args: string[] }) => s.args[s.args.length - 1]!;

describe('a Codex chat pane', () => {
  it('spawns the bridge child with no Claude flag, and a Claude pane still spawns claude', () => {
    const codex = scriptOf(open('codex').s);
    expect(codex).toMatch(/^exec ".+" "\/opt\/dreamcontext\/dist\/index\.js" "t3-chat" "--tool" "codex" /);
    expect(codex).toContain(`"--pane" "${PANE}"`);
    expect(codex).toContain('"--model" "gpt-5.6-terra"');
    expect(codex).toContain('"--mode" "auto"');
    expect(codex).not.toContain('--permission-prompt-tool');
    expect(codex).not.toMatch(/exec claude/);
    const claude = scriptOf(open().s);
    expect(claude.startsWith('exec claude "-p"')).toBe(true);
  });

  it('gets its Eco seed (tab-<pane>.json) and its tab env, like a pinned Claude pane', () => {
    const { s } = open('codex');
    expect(readTabHandoff(join(project, '_dream_context'), PANE)).not.toBeNull();
    expect(s.env.DREAMCONTEXT_TAB_SESSION).toBe(PANE);
  });

  it('rotates on a handoff record: writes /clear then the continue prompt to the bridge child', () => {
    const { s } = open('codex');
    const contextRoot = join(project, '_dream_context');
    writeHandoffRecord(contextRoot, PANE, {
      task: 'acme-checkout', title: 'Checkout redesign', at: new Date().toISOString(),
      contextTokens: 190_000, fromSession: '01a0d5eb-f0c0-7481-a417-5e8871805cbc', tab: PANE,
    });
    s.child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'system', subtype: 'init', session_id: '01a0d5eb-f0c0-7481-a417-5e8871805cbc', dc_tool: 'codex' }) + '\n'));
    s.child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: '01a0d5eb-f0c0-7481-a417-5e8871805cbc', dc_tool: 'codex' }) + '\n'));
    const written = s.child.stdin.write.mock.calls.map((c) => String(c[0]));
    const users = written.filter((w) => w.includes('"type":"user"'));
    expect(users[0]).toContain('"/clear"');
    expect(users[1]).toContain('acme-checkout');
    expect(readHandoffRecord(contextRoot, PANE)?.actedAt).toBeTruthy();
  });

  it('never runs a Claude account switch or usage reading for a Codex pane', () => {
    const { ws, s } = open('codex');
    const refusal = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 600 } };
    s.child.stdout.emit('data', Buffer.from(JSON.stringify(refusal) + '\n'));
    const metas = ws.send.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('account_switch'));
    expect(metas).toEqual([]);
  });
});

describe('an Antigravity pane at the socket', () => {
  const start = (leanMcp?: string[]) => {
    const ws = new FakeWs();
    startChatSession(ws as unknown as import('ws').WebSocket, project, {
      bypass: false, sessionId: PANE, resumeId: '', model: '', effort: '', mode: 'basic' as never,
      account: '', initialPrompt: '', deferPrompt: false, tool: 'antigravity', ...(leanMcp ? { leanMcp } : {}),
    });
    return ws;
  };

  it('refuses a lean child out loud: there is no write gate yet', () => {
    process.env.DREAMCONTEXT_NODE = process.execPath;
    const ws = start([]);
    expect(spawned).toHaveLength(0);
    expect(String(ws.send.mock.calls[0]?.[0])).toContain('no write gate');
    expect(ws.close).toHaveBeenCalled();
    delete process.env.DREAMCONTEXT_NODE;
  });

  it('still opens an ordinary chat', () => {
    start();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.args.join(' ')).toContain('t3-chat');
  });
});

describe('a Codex pane on the server\'s real turn counter', () => {
  const T1 = '01a0d5eb-f0c0-7481-a417-5e8871805cbc';
  const T2 = '01a0d5eb-aaaa-7481-a417-5e8871805cbd';
  const line = (s: { child: FakeChild }, f: Record<string, unknown>) => s.child.stdout.emit('data', Buffer.from(JSON.stringify(f) + '\n'));
  const metas = (ws: FakeWs) => ws.send.mock.calls.map((c) => String(c[0]));

  it('the bridge announcing its thread opens no turn: a reattach reads the pane idle', () => {
    const { s } = open('codex');
    line(s, { type: 'system', subtype: 'dc_thread', session_id: T1, dc_tool: 'codex', dc_ready: true });
    const next = new FakeWs();
    startChatSession(next as unknown as import('ws').WebSocket, project, {
      bypass: false, sessionId: '', resumeId: PANE, model: '', effort: '', mode: 'basic' as never,
      account: '', initialPrompt: '', deferPrompt: false, tool: 'codex', reattachFallback: true,
    });
    const reattached = metas(next).find((m) => m.includes('"reattached"'));
    expect(reattached).toBeTruthy();
    expect(reattached).toContain('"busy":false');
  });

  it('a rotation counted by the server reaches done on the frames the bridge prints', () => {
    const { ws, s } = open('codex');
    const contextRoot = join(project, '_dream_context');
    line(s, { type: 'system', subtype: 'dc_thread', session_id: T1, dc_tool: 'codex', dc_ready: true });
    ws.emit('message', JSON.stringify({ type: 'user', text: 'hello' }));
    writeHandoffRecord(contextRoot, PANE, { task: 'acme-checkout', title: 'Checkout redesign', at: new Date().toISOString(), contextTokens: 190_000, fromSession: T1, tab: PANE });
    // The owner's turn, as the bridge prints it.
    line(s, { type: 'system', subtype: 'init', session_id: T1, dc_tool: 'codex' });
    line(s, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 190000, output_tokens: 0 } }, parent_tool_use_id: null });
    line(s, { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: T1 });
    // The server wrote /clear and the continue prompt; the bridge answers both.
    line(s, { type: 'system', subtype: 'init', session_id: T2, dc_tool: 'codex', dc_rotated: true });
    line(s, { type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 0, session_id: T2 });
    line(s, { type: 'system', subtype: 'init', session_id: T2, dc_tool: 'codex' });
    line(s, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'continuing' }], usage: { input_tokens: 20000, output_tokens: 0 } }, parent_tool_use_id: null });
    line(s, { type: 'result', subtype: 'success', is_error: false, result: 'continuing', session_id: T2 });
    const progress = metas(ws).filter((m) => m.includes('handoff_progress'));
    expect(progress.some((m) => m.includes('"stage":"done"'))).toBe(true);
  });

  it('a live effort switch reaches the bridge as /effort (the bridge answers it locally)', () => {
    const { ws, s } = open('codex');
    ws.emit('message', JSON.stringify({ type: 'setEffort', effort: 'high' }));
    const users = s.child.stdin.write.mock.calls.map((c) => String(c[0])).filter((w) => w.includes('"type":"user"'));
    expect(users.at(-1)).toContain('/effort high');
  });

  it('a reopened pane whose mapped thread cannot be taken REFUSES instead of forking a new thread', async () => {
    const { recordAgentSession } = await import('../../../src/lib/agent-session-map.js');
    recordAgentSession(join(project, '_dream_context'), PANE, T2); // a thread with no rollout here
    const before = spawned.length;
    const ws = new FakeWs();
    startChatSession(ws as unknown as import('ws').WebSocket, project, {
      bypass: false, sessionId: '', resumeId: PANE, model: '', effort: '', mode: 'basic' as never,
      account: '', initialPrompt: '', deferPrompt: false, tool: 'codex',
    });
    expect(spawned.length).toBe(before);
    expect(metas(ws).join('\n')).toMatch(/Nothing was lost/);
  });
});
