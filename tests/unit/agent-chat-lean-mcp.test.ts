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
import { join, sep } from 'node:path';
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
      // win32 spawns the chat's claude directly (argv starts with -p, chatSpawnCommand): present it
      // as the POSIX login-shell script these tests read.
      child.script = process.platform === 'win32' && args[0] === '-p'
        ? `exec claude ${args.map((x) => `"${x}"`).join(' ')}`
        : args[args.length - 1] ?? '';
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

const { startChatSession, leanChildMcpArgs, leanMcpForUpgrade, mcpConfigArgs } = await import('../../src/server/routes/agent-chat.js');
const { _resetChatRegistry } = await import('../../src/lib/assistant/chat-registry.js');
const { setAutoSwitchEnabled } = await import('../../src/lib/claude-accounts.js');
const {
  MAX_LEAN_MCP, knownMcpServers, leanMcpDir, mcpCardServers, mcpGrantFor, parseMcpNames, sweepLeanMcpDir, writeLeanMcpConfig,
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
    expect(f.startsWith(leanMcpDir(fakeHome) + sep)).toBe(true);
    expect(JSON.parse(readFileSync(f, 'utf-8'))).toEqual({ mcpServers: { whatsapp: USER_SERVERS.whatsapp } });
    if (process.platform !== 'win32') expect(statSync(f).mode & 0o777).toBe(0o600); // Windows has no POSIX mode bits
    if (process.platform !== 'win32') expect(statSync(leanMcpDir(fakeHome)).mode & 0o777).toBe(0o700); // Windows has no POSIX mode bits
    // No store (every user server) rides along: no path, no env reference (task mcp-management).
    expect(a.join(' ')).not.toContain('mcp-config.json');
    expect(a.join(' ')).not.toContain(join(fakeHome, '.dreamcontext', 'mcp.json'));
    expect(child!.script).not.toContain('DREAMCONTEXT_MCP_CFG');
    expect(child!.env.DREAMCONTEXT_MCP_CFG_0).toBeUndefined();
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

  it('a name the user no longer has at spawn time is dropped: the child still starts lean, never wider', () => {
    const a = argvOf(spawnChat({ leanMcp: ['posthog', 'whatsapp'] }).child!);
    expect(a).toContain('--strict-mcp-config');
    expect(Object.keys(JSON.parse(readFileSync(mcpFiles(a)[0], 'utf-8')).mcpServers)).toEqual(['whatsapp']);
    const b = argvOf(spawnChat({ leanMcp: ['posthog'] }).child!);
    expect(b).toContain('--strict-mcp-config');
    expect(b).not.toContain('--mcp-config');
  });

  it('a project folder a shell would expand keeps its .mcp.json out of the script (narrower, never an expansion)', () => {
    const odd = mkdtempSync(join(tmpdir(), 'dc-lean-proj-$x-'));
    mkdirSync(join(odd, '_dream_context'), { recursive: true });
    writeFileSync(join(odd, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
    const saved = projectRoot;
    projectRoot = odd;
    try {
      const a = argvOf(spawnChat({ leanMcp: [] }).child!);
      expect(a).toContain('--strict-mcp-config');
      expect(a.join(' ')).not.toContain('.mcp.json');
    } finally {
      projectRoot = saved;
      rmSync(odd, { recursive: true, force: true });
    }
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

  it('leftover subsets of a server that is gone are swept at start; a live server\'s stay', () => {
    const known = knownMcpServers(projectRoot, fakeHome);
    const dir = leanMcpDir(fakeHome);
    writeLeanMcpConfig(['whatsapp'], known, dir);
    writeFileSync(join(dir, 'lean-2147483000-dead.json'), '{}');
    writeFileSync(join(dir, `lean-${process.ppid}-live.json`), '{}');
    writeFileSync(join(dir, 'unrelated.txt'), 'x');
    expect(sweepLeanMcpDir(dir)).toBe(2);
    expect(readdirSync(dir).sort()).toEqual([`lean-${process.ppid}-live.json`, 'unrelated.txt']);
    expect(() => writeLeanMcpConfig(['nope'], known, dir)).toThrow(/unknown MCP server/);
  });
});

describe('the upgrade decides lean from the record (end review r1)', () => {
  const known = () => new Map<string, unknown>([['whatsapp', {}], ['fathom', {}]]);
  const base = { assistant: false, mode: 'basic', conversation: 'kid', lean: null, mcp: null, known };
  it('a delegated child is lean from its RECORD even when the URL asks for nothing (a reload before the record)', () => {
    expect(leanMcpForUpgrade({ ...base, recorded: (id) => (id === 'kid' ? ['whatsapp'] : null) })).toEqual(['whatsapp']);
    expect(leanMcpForUpgrade({ ...base, recorded: () => [] })).toEqual([]);
  });
  it('the record wins over the URL; a removed name is dropped, never a refusal', () => {
    expect(leanMcpForUpgrade({ ...base, lean: '1', mcp: 'fathom', recorded: () => ['whatsapp', 'gone'] })).toEqual(['whatsapp']);
  });
  it('no record: the URL\'s lean (a child opening before its record), malformed refused, unknown dropped', () => {
    const none = () => null;
    expect(leanMcpForUpgrade({ ...base, lean: '1', mcp: 'fathom,gone', recorded: none })).toEqual(['fathom']);
    expect(leanMcpForUpgrade({ ...base, lean: '1', mcp: '__proto__', recorded: none })).toBe('refuse');
    expect(leanMcpForUpgrade({ ...base, recorded: none })).toBeNull();
  });
  it('never the Assistant or a Super Agent\'s own session', () => {
    const rec = () => ['whatsapp'];
    expect(leanMcpForUpgrade({ ...base, mode: 'super', recorded: rec })).toBeNull();
    expect(leanMcpForUpgrade({ ...base, assistant: true, mode: 'assistant', recorded: rec })).toBeNull();
  });
  it('the record index: delegated children (live or ended) by own id; adopted ones are not', async () => {
    const { noteSuperState, resetSuperIndex, delegatedChildMcp } = await import('../../src/lib/super/store.js');
    const { emptySuperState } = await import('../../src/lib/super/types.js');
    resetSuperIndex();
    const ch = (sessionId: string, adopted: boolean, extra = {}) => ({ sessionId, brief: '', adopted, startedAt: 1, ...extra });
    noteSuperState('/v/_dream_context', { ...emptySuperState(), session: 'sup', enabled: false, children: {
      kid: ch('kid', false, { mcp: ['whatsapp'] }), old: ch('old', false, { endedAt: 5 }), mine: ch('mine', true, { mcp: ['whatsapp'] }),
    } });
    expect(delegatedChildMcp('kid')).toEqual(['whatsapp']);
    expect(delegatedChildMcp('old')).toEqual([]);
    expect(delegatedChildMcp('mine')).toBeNull();
    expect(delegatedChildMcp('sup')).toBeNull();
    expect(delegatedChildMcp('constructor')).toBeNull();
    resetSuperIndex();
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
    expect(mcpNames(['ok', 'Bad Name', 'ok', 7, '__proto__', 'constructor'])).toEqual(['ok']);
    const d = delegateArgs({ prompt: 'x', mcp: ['whatsapp'] });
    expect(d.ok && d.mcp).toEqual(['whatsapp']);
  });
});

describe('the surface briefing of a delegated child', () => {
  const briefingOf = (child: FakeChild): string => {
    const a = argvOf(child);
    const path = a[a.indexOf('--append-system-prompt-file') + 1];
    return readFileSync(path, 'utf-8');
  };

  it('a lean (delegated) child is told how to reach its Super Agent; a normal chat is not', () => {
    const lean = briefingOf(spawnChat({ leanMcp: [] }).child!);
    expect(lean).toContain('## Reaching the Super Agent');
    expect(lean).toContain('AskUserQuestion');
    expect(lean).toMatch(/Never look for it among peers/);
    expect(briefingOf(spawnChat().child!)).not.toContain('Reaching the Super Agent');
  });
});

describe('a set-up server the chat asks for on its card joins it (owner 2026-11-12, memoryos Slack)', () => {
  const card = (servers: unknown[]): string => `Slack is not in this chat.\n\n\`\`\`dream-view\n${JSON.stringify({ type: 'mcp', id: 'need', why: 'read the DM', servers })}\n\`\`\`\n`;
  const say = (child: FakeChild, frame: unknown): void => { child.stdout.emit('data', Buffer.from(`${JSON.stringify(frame)}\n`)); };
  const userTexts = (child: FakeChild): string[] => child.stdin.write.mock.calls
    .map(([raw]) => { try { return JSON.parse(String(raw)) as { type?: string; message?: { content?: Array<{ text?: string }> } }; } catch { return null; } })
    .filter((f) => f?.type === 'user').map((f) => f!.message?.content?.[0]?.text ?? '');

  it('the card\'s names: every mcp fence, in order, deduped; other cards and broken JSON ignored', () => {
    const text = `${card(['slack', 'github'])}\n\`\`\`dream-view\n{"type":"run","id":"r","command":"x"}\n\`\`\`\n\`\`\`dream-view\n{nope\n\`\`\`\n${card(['slack', ' posthog '])}`;
    expect(mcpCardServers(text)).toEqual(['slack', 'github', 'posthog']);
    expect(mcpCardServers('no card here')).toEqual([]);
  });

  it('the grant: known and missing only, own keys, never past the lean cap; an unknown name stays the owner\'s', () => {
    const known = new Map<string, unknown>([['slack', {}], ['github', {}], ['a', {}], ['b', {}], ['c', {}], ['d', {}], ['e', {}]]);
    expect(mcpGrantFor({ asked: ['slack', 'linear', '__proto__', 'Bad Name', 'github'], have: ['github'], known, lean: true })).toEqual(['slack']);
    expect(mcpGrantFor({ asked: ['slack', 'a', 'b'], have: ['c', 'd', 'e', 'github'], known, lean: true })).toEqual(['slack', 'a']);
    expect(mcpGrantFor({ asked: ['slack', 'a', 'b'], have: ['c', 'd', 'e', 'github'], known, lean: false })).toEqual(['slack', 'a', 'b']);
  });

  it('a lean child that asks for a set-up server respawns with it and is told it is connected', () => {
    const { child } = spawnChat({ mode: 'develop', leanMcp: ['whatsapp'] });
    const first = child!;
    expect(Object.keys(JSON.parse(readFileSync(mcpFiles(argvOf(first))[0], 'utf-8')).mcpServers)).toEqual(['whatsapp']);
    say(first, { type: 'system', subtype: 'init', session_id: 'aaaaaaaa-1111-4222-8333-444444444444', model: 'opus' });
    say(first, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: card(['github', 'linear']) }] } });
    // Mid-turn: nothing yet.
    expect(first.stdin.end).not.toHaveBeenCalled();
    say(first, { type: 'result', subtype: 'success', is_error: false, session_id: 'aaaaaaaa-1111-4222-8333-444444444444' });
    return vi.waitFor(() => expect(first.stdin.end).toHaveBeenCalled()).then(() => {
      const before = spawned.length;
      state.transcripts.add('aaaaaaaa-1111-4222-8333-444444444444');
      first.emit('close', 0);
      expect(spawned.length).toBe(before + 1);
      const next = spawned[spawned.length - 1];
      const a = argvOf(next);
      expect(a).toContain('--strict-mcp-config');
      expect(a).toContain('--resume');
      // github was set up (local scope); linear is not, so it stays out.
      expect(Object.keys(JSON.parse(readFileSync(mcpFiles(a)[0], 'utf-8')).mcpServers)).toEqual(['whatsapp', 'github']);
      // linear is still missing: no receipt, the card stays the owner's.
      return new Promise((r) => setTimeout(r, 20)).then(() => expect(userTexts(next).some((t) => t.startsWith('MCP connected'))).toBe(false));
    });
  });

  it('every name granted and none waiting on a sign-in: the successor\'s next turn is the card\'s receipt', async () => {
    const sid = 'dddddddd-1111-4222-8333-444444444444';
    const first = spawnChat({ mode: 'develop', leanMcp: ['whatsapp'] }).child!;
    say(first, { type: 'system', subtype: 'init', session_id: sid, model: 'opus' });
    say(first, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: card(['github', 'whatsapp']) }] } });
    say(first, { type: 'result', subtype: 'success', is_error: false, session_id: sid });
    await vi.waitFor(() => expect(first.stdin.end).toHaveBeenCalled());
    state.transcripts.add(sid);
    first.emit('close', 0);
    const next = spawned[spawned.length - 1];
    expect(Object.keys(JSON.parse(readFileSync(mcpFiles(argvOf(next))[0], 'utf-8')).mcpServers)).toEqual(['whatsapp', 'github']);
    await vi.waitFor(() => expect(userTexts(next).some((t) => t.startsWith('MCP connected: github\n'))).toBe(true));
  });

  it('a grant waits for the chat\'s background work to end (a dev server would die with the process)', async () => {
    const sid = 'eeeeeeee-1111-4222-8333-444444444444';
    const { ws, child } = spawnChat({ mode: 'develop', leanMcp: [] });
    const first = child!;
    say(first, { type: 'system', subtype: 'init', session_id: sid, model: 'opus' });
    say(first, { type: 'system', subtype: 'background_tasks_changed', tasks: [{ id: 'dev' }] });
    say(first, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: card(['github']) }] } });
    say(first, { type: 'result', subtype: 'success', is_error: false, session_id: sid });
    await new Promise((r) => setTimeout(r, 30));
    expect(first.stdin.end).not.toHaveBeenCalled();
    // Meanwhile the chat still takes messages (re-review r2: nothing is held while it waits).
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'user', text: 'how is it going?' })));
    await vi.waitFor(() => expect(userTexts(first)).toContain('how is it going?'));
    say(first, { type: 'result', subtype: 'success', is_error: false, session_id: sid });
    await new Promise((r) => setTimeout(r, 30));
    expect(first.stdin.end).not.toHaveBeenCalled();
    say(first, { type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    await vi.waitFor(() => expect(first.stdin.end).toHaveBeenCalled());
  });

  it('a server it already has, or one the project does not have, changes nothing', async () => {
    const { child } = spawnChat({ mode: 'develop', leanMcp: ['whatsapp'] });
    say(child!, { type: 'system', subtype: 'init', session_id: 'bbbbbbbb-1111-4222-8333-444444444444', model: 'opus' });
    say(child!, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: card(['whatsapp', 'linear']) }] } });
    say(child!, { type: 'result', subtype: 'success', is_error: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(child!.stdin.end).not.toHaveBeenCalled();
  });

  it('the grant is written into the child\'s record, so a reload or Resume keeps it (never past the cap, never an adopted chat)', async () => {
    const { updateSuperState, readSuperState, resetSuperIndex, delegatedChildMcp } = await import('../../src/lib/super/store.js');
    const { noteChildMcpGrant } = await import('../../src/lib/super/inbox.js');
    resetSuperIndex();
    const ctx = join(projectRoot, '_dream_context');
    mkdirSync(join(ctx, 'state'), { recursive: true });
    const ch = (sessionId: string, adopted: boolean, extra = {}) => ({ sessionId, brief: '', adopted, startedAt: 1, ...extra });
    await updateSuperState(ctx, (s) => {
      s.session = 'sup';
      s.children = { kid: ch('kid', false, { mcp: ['whatsapp'] }), full: ch('full', false, { mcp: ['a', 'b', 'c', 'd', 'e'] }), mine: ch('mine', true) } as typeof s.children;
    });
    await noteChildMcpGrant('kid', ['slack', 'whatsapp', 'Bad Name']);
    await noteChildMcpGrant('full', ['slack', 'github']);
    await noteChildMcpGrant('mine', ['slack']);
    const st = await readSuperState(ctx);
    expect(st.children.kid.mcp).toEqual(['whatsapp', 'slack']);
    expect(st.children.full.mcp).toEqual(['a', 'b', 'c', 'd', 'e', 'slack']);
    expect(st.children.mine.mcp ?? []).toEqual([]);
    expect(delegatedChildMcp('kid')).toEqual(['whatsapp', 'slack']);
    resetSuperIndex();
  });

  it('the Super Agent\'s own session is never respawned by a card', async () => {
    const { child } = spawnChat({ mode: 'super' });
    say(child!, { type: 'system', subtype: 'init', session_id: 'cccccccc-1111-4222-8333-444444444444', model: 'opus' });
    say(child!, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: card(['github']) }] } });
    say(child!, { type: 'result', subtype: 'success', is_error: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(child!.stdin.end).not.toHaveBeenCalled();
  });
});
