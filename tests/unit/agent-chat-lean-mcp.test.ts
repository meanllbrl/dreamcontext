/**
 * Lean Super Agent children (orchestration plan r5 D14, AC "Lean children"): a delegated child
 * spawns with `--strict-mcp-config` and ONLY the MCP servers its job named, plus the app's own
 * configs (the project's `.mcp.json` passed explicitly, the browser override); the subset is a
 * 0600 file in the 0700 lean dir, removed when the child exits and swept at server start. A
 * normal chat, the Super Agent and the Assistant spawn as before. The window asks for a lean
 * spawn on every spawn of a delegated child's conversation (Resume included), from its record.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const fakeHome = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-assistant-latency-home-'));
  process.env.HOME = dir;
  return dir;
});

const state = vi.hoisted(() => ({
  modelOnDisk: false,
  vaultMode: 'haiku' as 'haiku' | 'raw' | 'hybrid' | 'off',
  transcripts: new Set<string>(),
  embedCalls: 0,
  releaseEmbed: null as null | (() => void),
  /** When set, auto-switch runs a (blind) usage probe that waits on this promise — a message
   *  then sits in the switch gate for as long as the test wants. */
  slowProbe: null as null | Promise<void>,
}));

vi.mock('../../src/lib/claude-accounts.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-accounts.js')>();
  return {
    ...real,
    autoSwitchEnabled: (...a: Parameters<typeof real.autoSwitchEnabled>) => (state.slowProbe ? true : real.autoSwitchEnabled(...a)),
    listClaudeAccounts: (...a: Parameters<typeof real.listClaudeAccounts>) => (state.slowProbe
      ? [{ id: 'acct-a' }, { id: 'acct-b', configDir: '/nonexistent-b' }] as ReturnType<typeof real.listClaudeAccounts>
      : real.listClaudeAccounts(...a)),
    switchStrategyFor: (...a: Parameters<typeof real.switchStrategyFor>) => (state.slowProbe ? 'parallel' : real.switchStrategyFor(...a)),
  };
});

vi.mock('../../src/lib/claude-usage.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-usage.js')>();
  return {
    ...real,
    usageReadingIsCurrent: (...a: Parameters<typeof real.usageReadingIsCurrent>) => (state.slowProbe ? false : real.usageReadingIsCurrent(...a)),
  };
});

vi.mock('../../src/lib/claude-usage-probe.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-usage-probe.js')>();
  return {
    ...real,
    probeAccountUsage: async () => {
      await state.slowProbe;
      return { status: 'error' } as unknown as Awaited<ReturnType<typeof real.probeAccountUsage>>;
    },
    probeAccountForDecision: async () => {
      await state.slowProbe;
      return { status: 'error' } as unknown as Awaited<ReturnType<typeof real.probeAccountUsage>>;
    },
  };
});

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

vi.mock('../../src/lib/embeddings/embedder.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/embeddings/embedder.js')>();
  return {
    ...real,
    isEmbedModelDownloaded: () => state.modelOnDisk,
    // A slow fake model: the build stays `building` until the test releases it.
    embedPassages: vi.fn(async (texts: string[]) => {
      state.embedCalls += 1;
      await new Promise<void>((r) => { state.releaseEmbed = r; });
      return texts.map(() => new Float32Array([1, 0, 0]));
    }),
  };
});

vi.mock('../../src/server/routes/agent-spawn-shared.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/server/routes/agent-spawn-shared.js')>();
  return { ...real, claudeConversationExists: (id: string) => state.transcripts.has(id) };
});

vi.mock('../../src/cli/commands/sleep.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/cli/commands/sleep.js')>();
  return { ...real, resolveRecallMode: () => state.vaultMode };
});

const { startChatSession, leanChildMcpArgs, mcpConfigArgs } = await import('../../src/server/routes/agent-chat.js');
const { _resetChatRegistry } = await import('../../src/lib/assistant/chat-registry.js');
const { setAutoSwitchEnabled } = await import('../../src/lib/claude-accounts.js');
const {
  MAX_LEAN_MCP, knownMcpServers, leanMcpDir, parseMcpNames, sweepLeanMcpDir, writeLeanMcpConfig,
} = await import('../../src/lib/super/lean-mcp.js');
const { leanMcpFor, leanMcpParam, mcpNames, delegateArgs } = await import('../../dashboard/src/components/sleepy/super/superHandover.js');

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
}

let projectRoot: string;

function spawnChat(o: { mode?: 'basic' | 'develop' | 'super'; leanMcp?: string[]; resumeId?: string } = {}): { ws: FakeWs; child: FakeChild | undefined } {
  const ws = new FakeWs();
  const before = spawned.length;
  startChatSession(ws as unknown as import('ws').WebSocket, projectRoot, {
    bypass: false, sessionId: '', resumeId: o.resumeId ?? '', model: '', effort: '', mode: o.mode ?? 'basic', account: '',
    initialPrompt: '', deferPrompt: false, vault: 'demo-vault', ...(o.leanMcp ? { leanMcp: o.leanMcp } : {}),
  });
  return { ws, child: spawned.length > before ? spawned[spawned.length - 1] : undefined };
}
const argvOf = (child: FakeChild): string[] => [...child.script.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
const mcpFiles = (a: string[]): string[] => (a.includes('--mcp-config') ? a.slice(a.indexOf('--mcp-config') + 1) : []);

const USER_SERVERS = {
  whatsapp: { command: 'whatsapp-mcp' }, 'apple-mail': { command: 'mail-mcp' }, fathom: { command: 'npx', args: ['mcp-remote', 'x'] },
};

beforeEach(() => {
  spawned.length = 0;
  state.transcripts.clear();
  _resetChatRegistry();
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-lean-proj-'));
  mkdirSync(join(projectRoot, '_dream_context'), { recursive: true });
  setAutoSwitchEnabled(false, fakeHome);
  writeFileSync(join(fakeHome, '.claude.json'), JSON.stringify({
    mcpServers: USER_SERVERS,
    projects: { [projectRoot]: { mcpServers: { github: { command: 'gh-mcp' } } } },
  }));
});

afterEach(() => {
  while (spawned.length) spawned.shift()!.emit('close', 0);
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(join(fakeHome, '.claude.json'), { force: true });
  rmSync(leanMcpDir(fakeHome), { recursive: true, force: true });
});

describe('names', () => {
  it('a comma list or an array; malformed, prototype keys and more than six are refused', () => {
    expect(parseMcpNames('whatsapp, apple-mail,whatsapp')).toEqual({ names: ['whatsapp', 'apple-mail'] });
    expect(parseMcpNames(undefined)).toEqual({ names: [] });
    expect(parseMcpNames(['fathom'])).toEqual({ names: ['fathom'] });
    for (const bad of ['Bad Name', 'constructor', '__proto__', 'a;rm -rf', '$(x)', 'x'.repeat(41)]) expect(parseMcpNames(bad), bad).toHaveProperty('error');
    expect(parseMcpNames(Array.from({ length: MAX_LEAN_MCP + 1 }, (_, i) => `s${i}`))).toHaveProperty('error');
    expect(parseMcpNames(42)).toHaveProperty('error');
  });

  it('the known servers are user scope + this project\'s local scope, by own key only', () => {
    writeFileSync(join(fakeHome, '.claude.json'), `{"mcpServers":{"whatsapp":{"command":"w"},"__proto__":{"command":"evil"},"Bad Name":{"command":"x"}},"projects":{${JSON.stringify(projectRoot)}:{"mcpServers":{"github":{"command":"g"}}},"/other":{"mcpServers":{"paddle":{"command":"p"}}}}}`);
    expect([...knownMcpServers(projectRoot, fakeHome).keys()].sort()).toEqual(['github', 'whatsapp']);
  });
});

describe('the spawn', () => {
  it('a lean child: --strict-mcp-config and only its named servers, in a 0600 file inside the 0700 lean dir', () => {
    const { child } = spawnChat({ mode: 'develop', leanMcp: ['whatsapp'] });
    const a = argvOf(child!);
    expect(a).toContain('--strict-mcp-config');
    expect(a.indexOf('--strict-mcp-config')).toBeLessThan(a.indexOf('--mcp-config'));
    const files = mcpFiles(a);
    expect(files).toHaveLength(1);
    const f = files[0];
    expect(f.startsWith(leanMcpDir(fakeHome) + '/')).toBe(true);
    expect(JSON.parse(readFileSync(f, 'utf-8'))).toEqual({ mcpServers: { whatsapp: USER_SERVERS.whatsapp } });
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(leanMcpDir(fakeHome)).mode & 0o777).toBe(0o700);
    // The shared config (every user server) never rides along.
    expect(a.join(' ')).not.toContain('mcp-config.json');
    // Removed when the child exits.
    child!.emit('close', 0);
    expect(existsSync(f)).toBe(false);
  });

  it('a lean child with no servers named starts no user MCP server: strict and no config file', () => {
    const a = argvOf(spawnChat({ leanMcp: [] }).child!);
    expect(a).toContain('--strict-mcp-config');
    expect(a).not.toContain('--mcp-config');
  });

  it('a local-scope server (the project\'s own entry in ~/.claude.json) can be granted', () => {
    const f = mcpFiles(argvOf(spawnChat({ leanMcp: ['github', 'apple-mail'] }).child!))[0];
    expect(Object.keys(JSON.parse(readFileSync(f, 'utf-8')).mcpServers)).toEqual(['github', 'apple-mail']);
  });

  it('the project\'s own .mcp.json is passed explicitly (strict would drop it)', () => {
    writeFileSync(join(projectRoot, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
    const files = mcpFiles(argvOf(spawnChat({ leanMcp: ['fathom'] }).child!));
    expect(files).toEqual([expect.stringContaining(leanMcpDir(fakeHome)), join(projectRoot, '.mcp.json')]);
  });

  it('a name the user no longer has at spawn time refuses the spawn: nothing starts, nothing is widened', () => {
    const { ws, child } = spawnChat({ leanMcp: ['posthog'] });
    expect(child).toBeUndefined();
    expect(String(ws.send.mock.calls[0]?.[0])).toMatch(/mcp_refused/);
    expect(ws.close).toHaveBeenCalled();
  });

  it('a resumed lean child keeps its set; its successor process too', () => {
    state.transcripts.add('11111111-2222-4333-8444-555555555555');
    const a = argvOf(spawnChat({ mode: 'develop', leanMcp: ['whatsapp'], resumeId: '11111111-2222-4333-8444-555555555555' }).child!);
    expect(a).toContain('--strict-mcp-config');
    expect(a).toContain('--resume');
    expect(Object.keys(JSON.parse(readFileSync(mcpFiles(a)[0], 'utf-8')).mcpServers)).toEqual(['whatsapp']);
  });

  it('normal chats and the Super Agent spawn as before: no strict flag, no lean file', () => {
    for (const mode of ['basic', 'develop', 'super'] as const) {
      const a = argvOf(spawnChat({ mode }).child!);
      expect(a, mode).not.toContain('--strict-mcp-config');
      expect(a.join(' '), mode).not.toContain('/lean/');
    }
    // The argv helper itself: no lean = exactly today's.
    const normal = ['/shared.json', null, '/browser.json'];
    expect(leanChildMcpArgs(null, normal)).toEqual(mcpConfigArgs(normal));
    expect(leanChildMcpArgs({ leanMcpPath: null, projectMcp: null, browser: '/b.json' }, normal)).toEqual(['--strict-mcp-config', '--mcp-config', '/b.json']);
  });

  it('leftover subsets (a SIGKILLed child) are swept at server start', () => {
    const known = knownMcpServers(projectRoot, fakeHome);
    const dir = leanMcpDir(fakeHome);
    writeLeanMcpConfig(['whatsapp'], known, dir);
    writeFileSync(join(dir, 'unrelated.txt'), 'x');
    expect(sweepLeanMcpDir(dir)).toBe(1);
    expect(readdirSync(dir)).toEqual(['unrelated.txt']);
    expect(() => writeLeanMcpConfig(['nope'], known, dir)).toThrow(/unknown MCP server/);
  });
});

describe('the window asks for a lean spawn', () => {
  const st = {
    session: 'sup', children: {
      kid: { adopted: false, mcp: ['whatsapp'] }, bare: { adopted: false }, mine: { adopted: true, mcp: ['whatsapp'] },
      sup: { adopted: false },
    },
  };
  it('a delegated child: its set; the owner\'s adopted chat, the super, a non-child: not lean', () => {
    expect(leanMcpFor(st, 'kid')).toEqual(['whatsapp']);
    expect(leanMcpFor(st, 'bare')).toEqual([]);
    expect(leanMcpFor(st, 'mine')).toBeNull();
    expect(leanMcpFor(st, 'sup')).toBeNull();
    expect(leanMcpFor(st, 'other')).toBeNull();
    expect(leanMcpFor(null, 'kid')).toBeNull();
    expect(leanMcpFor(st, 'constructor')).toBeNull();
    // A child being opened, before the record names it.
    expect(leanMcpFor(null, 'new', new Map([['new', ['fathom']]]))).toEqual(['fathom']);
  });
  it('the URL part, and the delegate frame\'s names', () => {
    expect(leanMcpParam(null)).toBe('');
    expect(leanMcpParam([])).toBe('&lean=1');
    expect(leanMcpParam(['whatsapp', 'apple-mail'])).toBe('&lean=1&mcp=whatsapp%2Capple-mail');
    expect(mcpNames(['ok', 'Bad Name', 'ok', 7])).toEqual(['ok']);
    const d = delegateArgs({ prompt: 'x', mcp: ['whatsapp'] });
    expect(d.ok && d.mcp).toEqual(['whatsapp']);
  });
});
