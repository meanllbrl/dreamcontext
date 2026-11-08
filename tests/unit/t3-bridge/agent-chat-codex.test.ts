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

// Whether Codex is installed is this machine's business, not the pane's: a runner without
// `codex` on it would refuse every Codex pane before it spawns. Each test says what it finds.
const codexProblem = vi.hoisted(() => ({ value: null as string | null }));
vi.mock('../../../src/lib/codex-bin.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/codex-bin.js')>()),
  codexStartProblem: () => codexProblem.value,
}));

const { startChatSession } = await import('../../../src/server/routes/agent-chat.js');
const { readTabHandoff, writeHandoffRecord, readHandoffRecord } = await import('../../../src/lib/context-watch.js');

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
}

const PANE = '7c4a1b2e-3d4f-4a5b-8c6d-0e1f2a3b4c5d';
const WIN = process.platform === 'win32';
/** An install path each platform accepts: win32 starts the bridge with no shell, from a drive path. */
const CLI = WIN ? 'C:\\dreamcontext\\dist\\index.js' : '/opt/dreamcontext/dist/index.js';
let project = '';

beforeEach(() => {
  spawned.length = 0;
  codexProblem.value = null;
  project = mkdtempSync(join(tmpdir(), 'dc-codex-pane-'));
  mkdirSync(join(project, '_dream_context', 'state'), { recursive: true });
  process.env.DREAMCONTEXT_CLI = CLI;
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

/**
 * The command a spawn runs, as one quoted line: POSIX passes the login-shell script itself; win32
 * spawns the program with an argv array (`chatSpawnCommand`), quoted here the same way.
 */
const scriptOf = (s: { file: string; args: string[] }) => (WIN
  ? `exec ${/claude(\.exe)?$/i.test(s.file) ? 'claude' : `"${s.file}"`} ${s.args.map((a) => `"${a}"`).join(' ')}`
  : s.args[s.args.length - 1]!);
const CLI_RE = CLI.replace(/[\\.]/g, (c) => `\\${c}`);

describe('a Codex chat pane', () => {
  it('spawns the bridge child with no Claude flag, and a Claude pane still spawns claude', () => {
    const codex = scriptOf(open('codex').s);
    expect(codex).toMatch(new RegExp(`^exec ".+" "${CLI_RE}" "t3-chat" "--tool" "codex" `));
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

  it('a machine without Codex refuses the pane out loud and spawns nothing', () => {
    codexProblem.value = 'Codex is not installed. Open the model menu and press Install, or run dreamcontext setup.';
    const ws = new FakeWs();
    startChatSession(ws as unknown as import('ws').WebSocket, project, {
      bypass: false, sessionId: PANE, resumeId: '', model: 'gpt-5.6-terra', effort: 'high', mode: 'basic' as never,
      account: '', initialPrompt: '', deferPrompt: false, tool: 'codex',
    });
    expect(spawned).toHaveLength(0);
    const sent = ws.send.mock.calls.map((c) => String(c[0]));
    expect(sent.some((m) => m.includes('"code":"tool_refused"') && m.includes('Codex is not installed'))).toBe(true);
    expect(ws.close).toHaveBeenCalled();
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

  it('refuses a lean child out loud when the gate hook does not refuse a test write', () => {
    const home = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), 'dc-agy-socket-'));
    process.env.DREAMCONTEXT_NODE = process.execPath;
    const ws = start([]);
    expect(spawned).toHaveLength(0);
    expect(String(ws.send.mock.calls[0]?.[0])).toContain('no child starts');
    expect(ws.close).toHaveBeenCalled();
    delete process.env.DREAMCONTEXT_NODE;
    rmSync(process.env.HOME, { recursive: true, force: true });
    process.env.HOME = home;
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

describe('a bridge pane on Windows (pure, runs everywhere)', () => {
  const input = { tool: 'codex' as const, model: 'gpt-5.6-terra', effort: 'high', mode: 'auto', pane: PANE, resume: '', briefingArg: ['--append-system-prompt-file', 'C:\\Users\\Öğretmen\\AppData\\Local\\Temp\\brief.md'], account: 'acct-5e5e5e', node: 'C:\\Program Files\\nodejs\\node.exe', cli: 'C:\\Users\\Öğretmen\\AppData\\Roaming\\npm\\node_modules\\dreamcontext\\dist\\index.js', extraRoots: ['D:\\code\\acme-app'], home: project };

  it('REGRESSION: a drive path is a path the bridge starts from, not a reason to refuse the pane', async () => {
    const { bridgeChatCommand } = await import('../../../src/lib/t3-bridge/spawn.js');
    const c = bridgeChatCommand(input, 'win32')!;
    expect(c.file).toBe(input.node);
    expect(c.args.slice(0, 4)).toEqual([input.cli, 't3-chat', '--tool', 'codex']);
    expect(c.args).toEqual(expect.arrayContaining(['--account', 'acct-5e5e5e', '--briefing-file', input.briefingArg[1], '--extra-root', 'D:\\code\\acme-app']));
    // The same paths are still refused where a shell would read them.
    expect(bridgeChatCommand(input, 'darwin')).toBeNull();
    // A quote never reaches the argv.
    expect(bridgeChatCommand({ ...input, cli: 'C:\\x"y\\index.js' }, 'win32')).toBeNull();
  });

  it('REGRESSION: win32 spawns the bridge child, never claude, when the pane is a bridge pane', async () => {
    const { chatSpawnCommand } = await import('../../../src/server/routes/agent-chat.js');
    const bridge = { file: 'C:\\node.exe', args: ['C:\\dc\\index.js', 't3-chat', '--tool', 'codex'] };
    expect(chatSpawnCommand({ argv: ['-p'], script: 'exec x', platform: 'win32', bridge })).toMatchObject({ ...bridge, detached: false, windowsHide: true });
    // POSIX keeps the login-shell script, bridge or not.
    expect(chatSpawnCommand({ argv: ['-p'], script: 'exec x', platform: 'darwin', shell: '/bin/zsh', bridge })).toMatchObject({ file: '/bin/zsh', args: ['-ilc', 'exec x'] });
  });
});
