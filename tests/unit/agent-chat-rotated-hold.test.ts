/**
 * One pinned chat, one process, across a `/clear` (field 2026-11-14: two Super processes per
 * project, the window's state pushed to the one nobody read). A `/clear` moves the process to a
 * new conversation behind the same pin; the tab map then names it for the pin. Before this, the
 * process held only the conversation it was SPAWNED on, so a second open of the pin either
 *  - resumed the rotated conversation the live process runs (it was not held), or
 *  - with the mapped conversation held, fell back to the pin's own transcript: the conversation
 *    from before the handoff, a second process beside the live one.
 * Now the hold follows the rotation and a held mapped conversation is never side-stepped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-rotated-hold-home-'));
});

const state = vi.hoisted(() => ({ transcripts: new Set<string>() }));

const spawned: FakeChild[] = [];
class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid = 4545;
  script = '';
  print(obj: unknown): void { this.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n')); }
}

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: vi.fn((_cmd: string, args: string[]) => {
      const child = new FakeChild();
      child.script = process.platform === 'win32' && args[0] === '-p'
        ? `exec claude ${args.map((x) => `"${x}"`).join(' ')}`
        : args[args.length - 1] ?? '';
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
const { findLiveChat } = await import('../../src/server/routes/agent-chat-live.js');

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; });
  ping = vi.fn(() => { this.emit('pong'); });
  terminate = vi.fn(() => { this.readyState = 3; this.emit('close'); });
  drop(): void { this.readyState = 3; this.emit('close'); }
  frames(): Array<Record<string, unknown>> {
    return this.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as Record<string, unknown>);
  }
}

const PIN = '1b0c2d3e-4f50-4a61-8b72-9c83d4e5f601';
const ROTATED = '2c1d3e4f-5061-4b72-8c83-9d94e5f60712';
const OLDER = '3d2e4f50-6172-4c83-8d94-ae05f6071823';

let projectRoot: string;
const argvOf = (child: FakeChild): string[] => [...child.script.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
const resumedOf = (child: FakeChild | undefined): string | null => {
  if (!child) return null;
  const a = argvOf(child);
  const i = a.indexOf('--resume');
  return i >= 0 ? a[i + 1] : null;
};

/** The tab map entry the SessionStart hook writes for the pin (agent-session-map.ts). */
function mapPin(conversation: string): void {
  const dir = join(projectRoot, '_dream_context', 'state', '.agent-session-map');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${PIN}.json`), JSON.stringify({ current: conversation, updated: new Date().toISOString() }));
}

/** A window opens the pin (a mount, a reload, a second screen): a plain resume. */
function openPin(): { ws: FakeWs; child: FakeChild | undefined } {
  const ws = new FakeWs();
  const before = spawned.length;
  startChatSession(ws as unknown as import('ws').WebSocket, projectRoot, {
    bypass: false, sessionId: '', resumeId: PIN, model: '', effort: '', mode: 'basic', account: '',
    initialPrompt: '', deferPrompt: false, vault: 'demo-vault',
  });
  return { ws, child: spawned.length > before ? spawned[spawned.length - 1] : undefined };
}

/** What the CLI prints when a `/clear` starts a new conversation in the same process. */
const rotate = (child: FakeChild, to: string): void => {
  child.print({ type: 'system', subtype: 'init', session_id: to, model: 'claude-opus-5-5', cwd: projectRoot });
  mapPin(to);
};

const refused = (ws: FakeWs): boolean => ws.frames().some((f) => f.subtype === 'error' && /still open in another pane/.test(String(f.message)));

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-rotated-hold-'));
  mkdirSync(join(projectRoot, '_dream_context', 'state'), { recursive: true });
  spawned.length = 0;
  state.transcripts = new Set([PIN, ROTATED, OLDER]);
});

afterEach(() => {
  for (const c of spawned) c.emit('close', 0);
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('a pinned chat after a /clear holds the conversation it runs now', () => {
  it('a second open of the pin starts no process on the conversation the live one runs', () => {
    const a = openPin();
    expect(resumedOf(a.child)).toBe(PIN);
    a.child!.print({ type: 'system', subtype: 'init', session_id: PIN, model: 'claude-opus-5-5' });
    rotate(a.child!, ROTATED);

    const b = openPin();
    expect(b.child).toBeUndefined();
    expect(refused(b.ws)).toBe(true);
    expect(findLiveChat(PIN)).not.toBeNull();
  });

  it('…nor on the pin\'s own pre-handoff transcript while its mapped conversation is held', () => {
    // The live process was spawned on the mapped conversation (an earlier rotation, then a reopen).
    mapPin(ROTATED);
    const a = openPin();
    expect(resumedOf(a.child)).toBe(ROTATED);

    const b = openPin();
    expect(resumedOf(b.child)).toBeNull();
    expect(b.child).toBeUndefined();
    expect(refused(b.ws)).toBe(true);
  });

  it('…and holds the newest one only: two rotations leave the first free again', () => {
    const a = openPin();
    rotate(a.child!, OLDER);
    rotate(a.child!, ROTATED);
    // The pin now names ROTATED, held; OLDER is history the live process left.
    const b = openPin();
    expect(b.child).toBeUndefined();
    mapPin(OLDER);
    const c = openPin();
    expect(resumedOf(c.child)).toBe(OLDER);
  });

  it('a /clear still queued when it drains takes no new hold: the pin is never left held by a leaving process', () => {
    const a = openPin();
    rotate(a.child!, OLDER);
    // The client says goodbye (a closed tab, a respawn): the socket's close drains it.
    a.ws.emit('message', JSON.stringify({ type: 'end' }));
    a.ws.drop();
    expect(a.child!.stdin.end).toHaveBeenCalled();
    // The CLI still works through what it had read: a queued /clear starts one more conversation.
    rotate(a.child!, ROTATED);
    const b = openPin();
    expect(resumedOf(b.child)).toBe(ROTATED);
  });

  it('once it exits, the pin resumes the rotated conversation: nothing is held any more', () => {
    const a = openPin();
    rotate(a.child!, ROTATED);
    a.child!.emit('close', 0);

    const b = openPin();
    expect(resumedOf(b.child)).toBe(ROTATED);
  });

  it('a respawn that supersedes a detached busy process takes over its rotated conversation', () => {
    const a = openPin();
    rotate(a.child!, ROTATED);
    a.ws.emit('message', JSON.stringify({ type: 'user', text: 'a long job' }));
    a.ws.drop();
    // The upgrade handler: supersede provisionally, open, then settle.
    const settle = findLiveChat(PIN)!.supersede();
    const b = openPin();
    expect(resumedOf(b.child)).toBe(ROTATED);
    settle(true);
    expect(a.child!.stdin.end).toHaveBeenCalled();
  });
});
