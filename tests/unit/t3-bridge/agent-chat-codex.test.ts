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
