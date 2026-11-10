/**
 * A member's live chat follows its autonomy level (owner 2026-11-10: "the label can never lie").
 * The permission mode is argv, fixed for a process's life, so a level change by ANY path (the AI
 * Team page's route, the CLI, an approved synced change) respawns the chat in place with --resume:
 * at once when idle, right after the turn when one runs, never waiting for the owner's next
 * message. A change still waiting for the owner's card is not in force: the chat keeps its level
 * and the roster's label says that level, not the waiting one.
 *
 * Real `startChatSession` with a mocked spawn; the member is made and edited through the real
 * command tree in a scratch project and HOME.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const fakeHome = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-follow-level-home-')));
  process.env.HOME = dir;
  return dir;
});

const transcripts = vi.hoisted(() => new Set<string>());
const spawned: FakeChild[] = [];

class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid = 4343;
  script = '';
}

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: vi.fn((_cmd: string, args: string[]) => {
      const child = new FakeChild();
      child.script = process.platform === 'win32' ? `exec claude ${args.map((x) => `"${x}"`).join(' ')}` : (args[args.length - 1] ?? '');
      spawned.push(child);
      return child as unknown as import('node:child_process').ChildProcess;
    }),
  };
});
vi.mock('../../src/server/routes/agent-spawn-shared.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/server/routes/agent-spawn-shared.js')>();
  return { ...real, claudeConversationExists: (id: string) => transcripts.has(id) };
});

const { startChatSession } = await import('../../src/server/routes/agent-chat.js');
const { _resetChatRegistry } = await import('../../src/lib/assistant/chat-registry.js');
const { setAutoSwitchEnabled } = await import('../../src/lib/claude-accounts.js');
const { createProgram } = await import('../../src/cli/program.js');
const { notifyAgentLevel } = await import('../../src/lib/agents/level-follow.js');
const { listAgentSummaries } = await import('../../src/server/routes/agents.js');

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
}

const CONV = '22222222-3333-4444-8555-666666666666';
const ENVS = ['CLAUDECODE', 'DREAMCONTEXT_AGENT_SELF', 'DREAMCONTEXT_MEMBER_CREW', 'DREAMCONTEXT_AUTOMATION_RUN', 'DREAMCONTEXT_SUPER_CREW', 'DREAMCONTEXT_AGENT_CHAT'];
let repo: string;
let cwd: string;
const ctx = () => join(repo, '_dream_context');

async function dc(argv: string[]): Promise<number> {
  const spies = (['log', 'error', 'warn'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
  process.exitCode = undefined;
  try { await createProgram().parseAsync(argv, { from: 'user' }); } finally { for (const s of spies) s.mockRestore(); }
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  return code;
}

function memberChat(): { ws: FakeWs; child: FakeChild } {
  const ws = new FakeWs();
  transcripts.add(CONV);
  startChatSession(ws as unknown as import('ws').WebSocket, repo, {
    bypass: false, sessionId: '', resumeId: CONV, model: '', effort: '', mode: 'basic', account: '',
    initialPrompt: '', deferPrompt: false, vault: 'acme-shop', agent: 'desk',
  });
  return { ws, child: spawned[spawned.length - 1] };
}

const argvOf = (c: FakeChild): string[] => [...c.script.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
const flag = (c: FakeChild, f: string): string | null => { const a = argvOf(c); const i = a.indexOf(f); return i >= 0 ? a[i + 1] : null; };
const levelOnRoster = () => listAgentSummaries(ctx()).find((a) => a.slug === 'desk')?.autonomy;

beforeEach(async () => {
  for (const k of ENVS) vi.stubEnv(k, undefined as unknown as string);
  spawned.length = 0;
  transcripts.clear();
  _resetChatRegistry();
  cwd = process.cwd();
  repo = join(realpathSync(mkdtempSync(join(tmpdir(), 'dc-follow-level-'))), 'shop');
  mkdirSync(join(repo, '_dream_context', 'state'), { recursive: true });
  process.chdir(repo);
  setAutoSwitchEnabled(false, fakeHome);
  expect(await dc(['agents', 'create', 'desk', '--title', 'Front Desk', '--prompt', 'Keeps the front desk tidy.'])).toBe(0);
  expect(await dc(['agents', 'edit', 'desk', '--autonomy', 'free'])).toBe(0);
});

afterEach(() => {
  while (spawned.length) spawned.shift()!.emit('close', 0);
  vi.unstubAllEnvs();
  process.chdir(cwd);
  rmSync(join(repo, '..'), { recursive: true, force: true });
});

describe('an idle member chat follows a level change at once', () => {
  it('from this server\'s route: respawns with --resume under the new mode, socket kept', async () => {
    const { ws, child: first } = memberChat();
    expect(flag(first, '--permission-mode')).toBe('bypassPermissions');
    expect(await dc(['agents', 'edit', 'desk', '--autonomy', 'ask'])).toBe(0);
    notifyAgentLevel(ctx(), 'desk');
    await vi.waitFor(() => expect(first.stdin.end).toHaveBeenCalledTimes(1));
    first.emit('close', 0);
    expect(spawned).toHaveLength(2);
    expect(flag(spawned[1], '--permission-mode')).toBe('default');
    expect(flag(spawned[1], '--resume')).toBe(CONV);
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('from the CLI alone (no route said a word): the watch on its file catches it, no owner message needed', async () => {
    const { child: first } = memberChat();
    expect(await dc(['agents', 'edit', 'desk', '--autonomy', 'ask'])).toBe(0);
    await vi.waitFor(() => expect(first.stdin.end).toHaveBeenCalledTimes(1), { timeout: 6000, interval: 100 });
    first.emit('close', 0);
    expect(flag(spawned[1], '--permission-mode')).toBe('default');
  }, 10_000);

  it('another member\'s change, or no change at all, leaves it running', async () => {
    const { child: first } = memberChat();
    notifyAgentLevel(ctx(), 'desk');
    notifyAgentLevel(ctx(), 'someone-else');
    await new Promise((r) => setTimeout(r, 50));
    expect(first.stdin.end).not.toHaveBeenCalled();
  });
});

describe('a member chat mid-turn', () => {
  it('switches right after the turn ends, and the message typed meanwhile reaches the successor', async () => {
    const { ws, child: first } = memberChat();
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'user', text: 'long job' })));
    await vi.waitFor(() => expect(first.stdin.write).toHaveBeenCalled());
    expect(await dc(['agents', 'edit', 'desk', '--autonomy', 'ask'])).toBe(0);
    notifyAgentLevel(ctx(), 'desk');
    // Settled (the respawn is scheduled behind the switch gate): still not ended mid-turn.
    await new Promise((r) => setTimeout(r, 50));
    expect(first.stdin.end).not.toHaveBeenCalled();
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'user', text: 'after the switch' })));
    const wrote = (c: FakeChild) => c.stdin.write.mock.calls.map(([s]) => String(s)).join('');
    await new Promise((r) => setTimeout(r, 50));
    expect(wrote(first)).not.toContain('after the switch');
    first.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'));
    await vi.waitFor(() => expect(first.stdin.end).toHaveBeenCalledTimes(1));
    first.emit('close', 0);
    expect(flag(spawned[1], '--permission-mode')).toBe('default');
    await vi.waitFor(() => expect(wrote(spawned[1])).toContain('after the switch'));
  });
});

describe('a synced change waiting for the owner\'s card', () => {
  /** A teammate's pull: the agent's file now says Ask, approved by nobody on this Mac. */
  function syncedLevel(level: string): void {
    const file = join(ctx(), 'agents', 'desk.md');
    const text = readFileSync(file, 'utf-8');
    const next = /\nautonomy: \w+/.test(text) ? text.replace(/\nautonomy: \w+/, `\nautonomy: ${level}`) : text.replace(/^---\n/, `---\nautonomy: ${level}\n`);
    writeFileSync(file, next);
  }

  it('is not in force: the chat keeps its level and the label says that level, then follows the approval', async () => {
    const { child: first } = memberChat();
    syncedLevel('ask');
    expect(readFileSync(join(ctx(), 'agents', 'desk.md'), 'utf-8')).toContain('autonomy: ask');
    notifyAgentLevel(ctx(), 'desk');
    await new Promise((r) => setTimeout(r, 50));
    expect(first.stdin.end).not.toHaveBeenCalled();
    // The label is the level the chat runs at: Free, never the waiting Ask.
    expect(levelOnRoster()).toBe('free');

    expect(await dc(['agents', 'approve', 'desk', '--yes'])).toBe(0);
    expect(levelOnRoster()).toBe('ask');
    await vi.waitFor(() => expect(first.stdin.end).toHaveBeenCalledTimes(1), { timeout: 6000, interval: 100 });
    first.emit('close', 0);
    expect(flag(spawned[1], '--permission-mode')).toBe('default');
  }, 10_000);
});

describe('a level that cannot be followed', () => {
  it('an approval with no stored approved text and a change waiting: the chat keeps running, never respawned into a refusal', async () => {
    const { child: first } = memberChat();
    // An approval stamped before the approved-text store: the store is empty.
    rmSync(join(fakeHome, '.dreamcontext', 'approved-texts'), { recursive: true, force: true });
    const file = join(ctx(), 'agents', 'desk.md');
    writeFileSync(file, readFileSync(file, 'utf-8').replace(/\nautonomy: \w+/, '\nautonomy: ask'));
    notifyAgentLevel(ctx(), 'desk');
    await new Promise((r) => setTimeout(r, 1500));
    expect(first.stdin.end).not.toHaveBeenCalled();
    expect(spawned).toHaveLength(1);
  });
});

describe('a member chat whose level changed while it was detached', () => {
  it('an idle detached chat is ended (no process keeps the old level); the conversation stays on disk', async () => {
    const { ws, child: first } = memberChat();
    ws.readyState = 3;
    ws.emit('close');
    // Detached, not drained: a closed pane keeps its process (until the level moves).
    await new Promise((r) => setTimeout(r, 50));
    expect(first.stdin.end).not.toHaveBeenCalled();
    expect(first.kill).not.toHaveBeenCalled();
    expect(await dc(['agents', 'edit', 'desk', '--autonomy', 'ask'])).toBe(0);
    notifyAgentLevel(ctx(), 'desk');
    await vi.waitFor(() => expect(first.stdin.end.mock.calls.length + first.kill.mock.calls.length).toBeGreaterThan(0), { timeout: 4000 });
  });
});

describe('a member Super\'s child (never wider than the member, r8-2)', () => {
  it('follows the member down when its level tightens', async () => {
    const ws = new FakeWs();
    transcripts.add(CONV);
    startChatSession(ws as unknown as import('ws').WebSocket, repo, {
      bypass: true, sessionId: '', resumeId: CONV, model: '', effort: '', mode: 'basic', account: '',
      initialPrompt: '', deferPrompt: false, vault: 'acme-shop', memberCrew: 'desk',
    });
    const first = spawned[spawned.length - 1];
    expect(flag(first, '--permission-mode')).toBe('bypassPermissions');
    expect(await dc(['agents', 'edit', 'desk', '--autonomy', 'ask'])).toBe(0);
    notifyAgentLevel(ctx(), 'desk');
    await vi.waitFor(() => expect(first.stdin.end).toHaveBeenCalledTimes(1));
    first.emit('close', 0);
    expect(flag(spawned[spawned.length - 1], '--permission-mode')).toBe('default');
  });
});
