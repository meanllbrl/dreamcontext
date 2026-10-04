/**
 * Hands-free lock, spawn chokepoints (AC6, laptop half): `executeClaudeDetached`,
 * `runPeerHeadless`, `broadcast` and `startPtySession` refuse a cwd inside a locked root with
 * one message naming the trip, and run outside it. Every test writes its trip state into a
 * temp HOME (`beginGoing` + `setPhase`), never the real ~/.dreamcontext.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginGoing, setPhase } from '../../src/lib/handsfree/trip-state.js';
import { handsfreeSpawnRefusal, runPeerHeadless } from '../../src/lib/peer-delivery.js';
import { executeClaudeDetached, type SpawnImpl } from '../../src/lib/automations/runner.js';
import { broadcast } from '../../src/lib/assistant/broadcast.js';
import { startPtySession } from '../../src/server/routes/agent-terminal.js';

let scratch: string;
let home: string;
let locked: string;
let free: string;

async function goAway(roots: string[]): Promise<void> {
  await beginGoing('trip-1', roots.map((path, i) => ({ rootId: `r${i}`, path })), home);
  await setPhase('away', 'trip-1', home);
}

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'hf-lock-cp-'));
  home = join(scratch, 'home');
  locked = join(scratch, 'locked');
  free = join(scratch, 'free');
  for (const d of [home, join(locked, '_dream_context', 'sub'), join(free, '_dream_context')]) mkdirSync(d, { recursive: true });
  await goAway([locked]);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('handsfreeSpawnRefusal', () => {
  it('names the trip inside a locked root (nested paths included) and is null outside', () => {
    const msg = handsfreeSpawnRefusal(join(locked, '_dream_context', 'sub'), home);
    expect(msg).toMatch(/hands-free mode on the cloud machine \(trip trip-1, away\); Return first/);
    expect(handsfreeSpawnRefusal(free, home)).toBeNull();
  });

  it('is null for everything once the laptop is home again', async () => {
    await setPhase('home', 'trip-1', home);
    expect(handsfreeSpawnRefusal(locked, home)).toBeNull();
  });
});

describe('executeClaudeDetached', () => {
  function fakeSpawn(calls: string[]): SpawnImpl {
    return ((_cmd: string, _args: string[], opts: { cwd?: string }) => {
      calls.push(String(opts.cwd));
      const child = new EventEmitter() as EventEmitter & { pid: number; stdout: EventEmitter; stderr: EventEmitter };
      child.pid = 999_999;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setTimeout(() => { child.emit('exit', 0); child.emit('close', 0); }, 5);
      return child;
    }) as unknown as SpawnImpl;
  }

  it('refuses inside a locked root without spawning', async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const out = await executeClaudeDetached(['-p', 'x'], { cwd: locked, timeoutMs: 5_000, spawnImpl: fakeSpawn(calls), home, log: (l) => logs.push(l) });
    expect(calls).toEqual([]);
    expect(out.spawned).toBe(false);
    expect(out.refused).toMatch(/trip trip-1/);
    expect(out.stderrTail).toBe(out.refused);
    expect(logs).toEqual([out.refused]);
  });

  it('runs outside it', async () => {
    const calls: string[] = [];
    const out = await executeClaudeDetached(['-p', 'x'], { cwd: free, timeoutMs: 5_000, spawnImpl: fakeSpawn(calls), home });
    expect(calls).toEqual([free]);
    expect(out.spawned).toBe(true);
    expect(out.refused).toBeUndefined();
  });
});

describe('runPeerHeadless', () => {
  const realShell = process.env.SHELL;
  afterEach(() => {
    if (realShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = realShell;
  });

  it('refuses inside a locked root', async () => {
    const r = await runPeerHeadless({ name: 'p', contextRoot: join(locked, '_dream_context'), projectRoot: locked }, 'hi', { home });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/hands-free mode .*trip trip-1/);
  });

  it('runs outside it (a stand-in login shell answers the headless JSON)', async () => {
    const shell = join(scratch, 'fake-shell');
    writeFileSync(shell, '#!/bin/sh\necho \'{"result":"done here","session_id":"s-1"}\'\n');
    chmodSync(shell, 0o755);
    process.env.SHELL = shell;
    const r = await runPeerHeadless({ name: 'p', contextRoot: join(free, '_dream_context'), projectRoot: free }, 'hi', { home, timeoutMs: 10_000 });
    expect(r).toEqual({ ok: true, reply: 'done here', sessionId: 's-1' });
  });
});

describe('broadcast', () => {
  it('refuses a locked vault without calling the runner and runs the others', async () => {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({
      vaults: [{ name: 'away', path: locked }, { name: 'here', path: free }],
    }));
    const ran: string[] = [];
    const rows = await broadcast('a rule', {
      home,
      runner: async (peer) => { ran.push(peer.name); return { ok: true, reply: 'written', sessionId: null }; },
    });
    expect(ran).toEqual(['here']);
    expect(rows.find((r) => r.vault === 'away')).toMatchObject({ status: 'failed', text: expect.stringMatching(/trip trip-1/) });
    expect(rows.find((r) => r.vault === 'here')).toMatchObject({ status: 'replied', text: 'written' });
  });
});

describe('startPtySession', () => {
  function fakeWs(): { ws: Parameters<typeof startPtySession>[0]; sent: string[]; closed: () => boolean } {
    const sent: string[] = [];
    let closed = false;
    const ws = Object.assign(new EventEmitter(), {
      OPEN: 1,
      readyState: 1,
      send: (d: unknown) => { sent.push(String(d)); },
      close: () => { closed = true; },
    });
    return { ws: ws as unknown as Parameters<typeof startPtySession>[0], sent, closed: () => closed };
  }

  function fakePty(spawned: string[]): Parameters<typeof startPtySession>[1] {
    return {
      spawn: (_shell: string, _args: string[], o: { cwd: string }) => {
        spawned.push(o.cwd);
        return {
          pid: 999_998,
          onData: () => {},
          onExit: () => {},
          write: () => {},
          resize: () => {},
          kill: () => {},
        };
      },
    } as unknown as Parameters<typeof startPtySession>[1];
  }

  it('refuses inside a locked root: nothing spawns, the tab is told why and closed', () => {
    const spawned: string[] = [];
    const { ws, sent, closed } = fakeWs();
    startPtySession(ws, fakePty(spawned), locked, false, 'dark', '', '', 'shell', '', '', '', false, '', '', { home });
    expect(spawned).toEqual([]);
    expect(sent.join('')).toMatch(/hands-free mode .*trip trip-1/);
    expect(closed()).toBe(true);
  });

  it('refuses an exec whose cwd is inside a locked root even from an unlocked project', () => {
    const spawned: string[] = [];
    const { ws } = fakeWs();
    startPtySession(ws, fakePty(spawned), free, false, 'dark', '', '', 'exec', '', '', '', false, 'ls', locked, { home });
    expect(spawned).toEqual([]);
  });

  it('runs outside it', () => {
    const spawned: string[] = [];
    const { ws, closed } = fakeWs();
    startPtySession(ws, fakePty(spawned), free, false, 'dark', '', '', 'shell', '', '', '', false, '', '', { home });
    expect(spawned).toEqual([free]);
    expect(closed()).toBe(false);
    (ws as unknown as EventEmitter).emit('close');
  });
});
