/**
 * Every spawn carries the MCP stores (task mcp-management W1, criteria 1 + 2): chat (account #0
 * and a sandbox), an unscoped automation, the terminal's agent PTY and Settings' children get
 * `--mcp-config <computer> [<project>]`, the browser override still last; a board-scoped run and
 * a lean Super child never get a store. Run under a HOME whose path holds a space and `$(`:
 * the login-shell strings must never contain the path text — it rides in env variables.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const fakeHome = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-mcp-argv-'));
  const dir = path.join(base, 'home with space $(touch pwned)');
  fs.mkdirSync(dir, { recursive: true });
  process.env.HOME = dir;
  return dir;
});

const state = vi.hoisted(() => ({ transcripts: new Set<string>() }));

const spawned: FakeChild[] = [];
class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid = 4242;
  script = '';
  env: Record<string, string | undefined> = {};
}

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: vi.fn((_cmd: string, args: string[], opts: { env?: Record<string, string> }) => {
      const child = new FakeChild();
      child.script = args[args.length - 1] ?? '';
      child.env = opts?.env ?? {};
      spawned.push(child);
      return child as unknown as import('node:child_process').ChildProcess;
    }),
  };
});

vi.mock('../../src/server/routes/agent-spawn-shared.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/server/routes/agent-spawn-shared.js')>();
  return { ...real, claudeConversationExists: (id: string) => state.transcripts.has(id) };
});

const { startChatSession } = await import('../../src/server/routes/agent-chat.js');
const { _resetChatRegistry } = await import('../../src/lib/assistant/chat-registry.js');
const { setAutoSwitchEnabled, sandboxDirFor } = await import('../../src/lib/claude-accounts.js');
const { startPtySession, agentExecLine } = await import('../../src/server/routes/agent-terminal.js');
const { executeClaudeDetached } = await import('../../src/lib/automations/runner.js');
const { startLiveChild } = await import('../../src/lib/mcp-live.js');
const { computerStorePath, projectStorePath } = await import('../../src/lib/mcp-store.js');

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
}

let projectRoot: string;
const argvOf = (script: string): string[] => [...script.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
const after = (a: string[], flag: string): string[] => (a.includes(flag) ? a.slice(a.indexOf(flag) + 1) : []);

function spawnChat(o: { account?: string; leanMcp?: string[] } = {}): FakeChild {
  const before = spawned.length;
  startChatSession(new FakeWs() as unknown as import('ws').WebSocket, projectRoot, {
    bypass: false, sessionId: '', resumeId: '', model: '', effort: '', mode: 'develop', account: o.account ?? '',
    initialPrompt: '', deferPrompt: false, vault: 'demo-vault', ...(o.leanMcp ? { leanMcp: o.leanMcp } : {}),
  });
  expect(spawned.length).toBe(before + 1);
  return spawned[spawned.length - 1];
}

beforeEach(() => {
  spawned.length = 0;
  _resetChatRegistry();
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-mcp-argv-proj-'));
  mkdirSync(join(projectRoot, '_dream_context'), { recursive: true });
  setAutoSwitchEnabled(false, fakeHome);
  mkdirSync(join(fakeHome, '.dreamcontext'), { recursive: true });
  writeFileSync(join(fakeHome, '.dreamcontext', 'claude-accounts.json'), JSON.stringify({
    accounts: [{ id: 'work', email: 'work@example.test', configDir: sandboxDirFor('work', fakeHome) }],
    autoSwitch: false,
  }));
  writeFileSync(join(fakeHome, '.claude.json'), JSON.stringify({
    mcpServers: { posthog: { type: 'http', url: 'https://mcp.example.test/mcp' }, whatsapp: { command: 'whatsapp-mcp' } },
    projects: { [projectRoot]: { mcpServers: { supabase: { type: 'http', url: 'https://db.example.test/mcp' } } } },
  }));
});

afterEach(() => {
  while (spawned.length) spawned.shift()!.emit('close', 0);
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(join(fakeHome, '.dreamcontext'), { recursive: true, force: true });
  rmSync(join(fakeHome, '.claude.json'), { force: true });
});

describe('chat', () => {
  it('account #0 and a sandbox: both stores by env reference, the path text never in the script', () => {
    for (const account of ['', 'work']) {
      const child = spawnChat({ account });
      const a = argvOf(child.script);
      expect(after(a, '--mcp-config').slice(0, 2), account).toEqual(['$DREAMCONTEXT_MCP_CFG_0', '$DREAMCONTEXT_MCP_CFG_1']);
      expect(child.env.DREAMCONTEXT_MCP_CFG_0).toBe(computerStorePath(fakeHome));
      expect(child.env.DREAMCONTEXT_MCP_CFG_1).toBe(projectStorePath(projectRoot, fakeHome));
      expect(child.script).not.toContain(fakeHome);
      expect(child.script).not.toContain('$(touch');
      expect(child.script).not.toContain('--strict-mcp-config');
      if (account) expect(child.env.CLAUDE_CONFIG_DIR).toBe(sandboxDirFor('work', fakeHome));
    }
  });

  it('a lean Super child under a HOME that is not shell-safe is refused, never spawned with a store', () => {
    const before = spawned.length;
    const ws = new FakeWs();
    startChatSession(ws as unknown as import('ws').WebSocket, projectRoot, {
      bypass: false, sessionId: '', resumeId: '', model: '', effort: '', mode: 'develop', account: '',
      initialPrompt: '', deferPrompt: false, vault: 'demo-vault', leanMcp: ['whatsapp'],
    });
    expect(spawned.length).toBe(before);
    expect(ws.send.mock.calls.map((c) => String(c[0])).join('\n')).toContain('mcp_refused');
  });
});

describe('the terminal agent PTY', () => {
  function fakePty() {
    const calls: Array<{ shell: string; args: string[]; env: Record<string, string> }> = [];
    const pty = {
      spawn: (shell: string, args: string[], opts: { env: Record<string, string> }) => {
        calls.push({ shell, args, env: opts.env });
        return { pid: 77, onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {} };
      },
    };
    return { pty, calls };
  }

  it('with a prompt: the operand sits before the variadic flag and both stores ride by env', () => {
    const { pty, calls } = fakePty();
    startPtySession(new FakeWs() as never, pty as never, projectRoot, false, 'dark', '', '', 'agent', '', '', 'do the thing', false, '', '', { home: fakeHome });
    const [flag, line, operand] = calls[0].args;
    expect(flag).toBe('-ilc');
    expect(operand).toBe('do the thing');
    expect(line).toMatch(/ "\$0" --mcp-config "\$DREAMCONTEXT_MCP_CFG_0" "\$DREAMCONTEXT_MCP_CFG_1"$/);
    expect(line).not.toContain(fakeHome);
    expect(calls[0].env.DREAMCONTEXT_MCP_CFG_0).toBe(computerStorePath(fakeHome));
    expect(calls[0].env.DREAMCONTEXT_MCP_CFG_1).toBe(projectStorePath(projectRoot, fakeHome));
  });

  it('a promptless tab still gets both store files', () => {
    const { pty, calls } = fakePty();
    startPtySession(new FakeWs() as never, pty as never, projectRoot, false, 'dark', '', '', 'agent', '', '', '', false, '', '', { home: fakeHome });
    expect(calls[0].args).toHaveLength(2);
    expect(calls[0].args[1]).toMatch(/--mcp-config "\$DREAMCONTEXT_MCP_CFG_0" "\$DREAMCONTEXT_MCP_CFG_1"$/);
    expect(calls[0].env.DREAMCONTEXT_MCP_CFG_1).toBe(projectStorePath(projectRoot, fakeHome));
  });

  it('a plain shell tab gets nothing', () => {
    const { pty, calls } = fakePty();
    startPtySession(new FakeWs() as never, pty as never, projectRoot, false, 'dark', '', '', 'shell', '', '', '', false, '', '', { home: fakeHome });
    expect(calls[0].args).toEqual(['-il']);
    expect(calls[0].env.DREAMCONTEXT_MCP_CFG_0).toBeUndefined();
  });

  it('agentExecLine never swallows the prompt', () => {
    expect(agentExecLine(' --x', ' "$0"', ['$A'])).toBe('exec claude --x "$0" --mcp-config "$A"');
    expect(agentExecLine(' --x', '', [])).toBe('exec claude --x');
  });
});

describe('automations and Settings children', () => {
  async function runArgv(o: { env: Record<string, string | undefined>; shared: boolean }): Promise<string[]> {
    let argv: string[] = [];
    await executeClaudeDetached(['-p', 'x'], {
      cwd: projectRoot,
      env: o.env,
      timeoutMs: 1000,
      sharedMcpHome: o.shared ? fakeHome : undefined,
      spawnImpl: ((_cmd: string, args: string[]) => {
        argv = args;
        const c = new EventEmitter() as EventEmitter & { pid: number | null };
        c.pid = null;
        return c;
      }) as never,
    });
    return argv.includes('-ilc') ? argv.slice(3) : argv;
  }

  it('an unscoped run on #0 and on a sandbox: both stores, last in argv', async () => {
    for (const env of [{ CLAUDE_CONFIG_DIR: undefined }, { CLAUDE_CONFIG_DIR: sandboxDirFor('work', fakeHome) }]) {
      const a = await runArgv({ env, shared: true });
      expect(a.slice(-3)).toEqual(['--mcp-config', computerStorePath(fakeHome), projectStorePath(projectRoot, fakeHome)]);
    }
  });

  it('a board-scoped run carries none', async () => {
    expect(await runArgv({ env: {}, shared: false })).not.toContain('--mcp-config');
  });

  it('a Settings probe child carries both stores', () => {
    let args: string[] = [];
    startLiveChild({
      files: [computerStorePath(fakeHome), projectStorePath(projectRoot, fakeHome)], cwd: projectRoot, env: {},
      spawnImpl: ((_c: string, a: string[]) => { args = a; const c = new EventEmitter() as EventEmitter & { pid: null }; c.pid = null; return c; }) as never,
    });
    expect(after(args, '--mcp-config')).toEqual([computerStorePath(fakeHome), projectStorePath(projectRoot, fakeHome)]);
  });
});
