/**
 * Hands-free go/return cut (AC12, pinned for lane E): `detachedRunsUnder` /
 * `cutDetachedRunsUnder` (runner.ts) and `ptySessionsUnder` / `cutPtySessionsUnder`
 * (agent-terminal.ts) list the live children whose cwd is under a root (realpath containment)
 * and stop each one's WHOLE process group — plus a grandchild a hook detached into its own
 * group — resolving only once they are gone. Real `sleep` process groups, no claude.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cutDetachedRunsUnder, cutProcessGroups, detachedRunsUnder, executeClaudeDetached, pathUnderAny, type SpawnImpl,
} from '../../src/lib/automations/runner.js';
import { cutPtySessionsUnder, ptySessionsUnder, startPtySession } from '../../src/server/routes/agent-terminal.js';

let scratch: string;
let home: string;
let inside: string;
let outside: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'hf-lock-cut-'));
  home = join(scratch, 'home');
  inside = join(scratch, 'proj', 'sub');
  outside = join(scratch, 'other');
  for (const d of [home, inside, outside]) mkdirSync(d, { recursive: true });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function alive(target: number): boolean {
  try { process.kill(target, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** A detached group: a shell that backgrounds a `sleep` in its own group, plus a node child
 *  that detaches a `sleep` into a NEW group (a hook's detached spawn), then waits. Prints the
 *  stray's pid. */
function spawnGroup(cwd: string, opts: Record<string, unknown> = {}): ChildProcess {
  const stray = "require('child_process').spawn('sleep',['60'],{detached:true,stdio:'ignore'}).pid";
  return spawn('/bin/sh', ['-c', `sleep 60 & ${JSON.stringify(process.execPath)} -e "console.log(${stray}); setTimeout(()=>{},60000)"; wait`], {
    cwd, detached: true, stdio: ['ignore', 'pipe', 'ignore'], ...opts,
  });
}

function strayPid(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.stdout?.once('data', (d: Buffer) => resolve(Number(String(d).trim())));
  });
}

describe('pathUnderAny', () => {
  it('contains by realpath (a symlinked root and a nested cwd) and refuses a sibling prefix', () => {
    const link = join(scratch, 'link');
    symlinkSync(join(scratch, 'proj'), link);
    expect(pathUnderAny(inside, [link])).toBe(true);
    expect(pathUnderAny(join(scratch, 'proj'), [join(scratch, 'proj')])).toBe(true);
    expect(pathUnderAny(join(scratch, 'projX'), [join(scratch, 'proj')])).toBe(false);
    expect(pathUnderAny(outside, [join(scratch, 'proj')])).toBe(false);
  });
});

describe('detached runs', () => {
  it('lists, then cuts the whole group and the detached grandchild, and the registry forgets it', async () => {
    let child: ChildProcess | null = null;
    const spawnImpl = ((_cmd: string, _args: string[], o: Record<string, unknown>) => {
      child = spawnGroup(String(o.cwd), { env: o.env });
      return child;
    }) as unknown as SpawnImpl;
    const run = executeClaudeDetached(['-p', 'x'], { cwd: inside, timeoutMs: 120_000, spawnImpl, home });
    const leader = (child as unknown as ChildProcess).pid as number;
    const stray = await strayPid(child as unknown as ChildProcess);

    expect(detachedRunsUnder([join(scratch, 'proj')])).toEqual([{ pid: leader, cwd: inside }]);
    expect(detachedRunsUnder([outside])).toEqual([]);
    expect(await cutDetachedRunsUnder([outside])).toBe(0);
    expect(alive(-leader)).toBe(true);

    expect(await cutDetachedRunsUnder([join(scratch, 'proj')])).toBe(1);
    expect(alive(-leader)).toBe(false);
    expect(alive(stray)).toBe(false);
    const out = await run;
    expect(out.spawned).toBe(true);
    expect(detachedRunsUnder([join(scratch, 'proj')])).toEqual([]);
  }, 30_000);
});

describe('PTY sessions', () => {
  function realPty(): Parameters<typeof startPtySession>[1] {
    return {
      spawn: (_shell: string, _args: string[], o: { cwd: string }) => {
        const child = spawnGroup(o.cwd);
        return {
          pid: child.pid as number,
          child,
          onData: () => {},
          onExit: (cb: (e: { exitCode: number }) => void) => { child.once('exit', (code) => cb({ exitCode: code ?? 0 })); },
          write: () => {},
          resize: () => {},
          kill: () => { try { process.kill(-(child.pid as number), 'SIGHUP'); } catch { /* gone */ } },
        };
      },
    } as unknown as Parameters<typeof startPtySession>[1];
  }

  function fakeWs(): Parameters<typeof startPtySession>[0] {
    return Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, send: () => {}, close: () => {} }) as unknown as Parameters<typeof startPtySession>[0];
  }

  it('lists, then cuts the whole group and resolves once it exited; the registry forgets it', async () => {
    const pty = realPty();
    let term: { pid: number; child: ChildProcess } | null = null;
    const spy = { spawn: (...a: unknown[]) => { term = (pty.spawn as (...x: unknown[]) => typeof term)(...a); return term; } } as unknown as Parameters<typeof startPtySession>[1];
    startPtySession(fakeWs(), spy, inside, false, 'dark', '', '', 'shell', '', '', '', false, '', '', { home });
    const t = term as unknown as { pid: number; child: ChildProcess };
    const stray = await strayPid(t.child);

    const listed = ptySessionsUnder([join(scratch, 'proj')]);
    expect(listed).toHaveLength(1);
    expect(listed[0].cwd).toBe(inside);
    expect(ptySessionsUnder([outside])).toEqual([]);

    expect(await cutPtySessionsUnder([join(scratch, 'proj')])).toBe(1);
    expect(alive(-t.pid)).toBe(false);
    expect(alive(stray)).toBe(false);
    await new Promise((r) => setTimeout(r, 50)); // the exit event lands after the group is gone
    expect(ptySessionsUnder([join(scratch, 'proj')])).toEqual([]);
  }, 30_000);
});

describe('cutProcessGroups (D22)', () => {
  it('never signals this process or its own group', async () => {
    await cutProcessGroups([process.pid], 100);
    expect(alive(process.pid)).toBe(true);
  });

  it('SIGKILLs a group after the grace even when its leader already exited (a member ignoring TERM)', async () => {
    const leader = spawn('/bin/sh', ['-c', 'trap "" TERM; sleep 60 & echo $!; exit 0'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const member = await new Promise<number>((r) => leader.stdout?.once('data', (d: Buffer) => r(Number(String(d).trim()))));
    await new Promise((r) => leader.once('exit', r));
    try {
      expect(alive(member)).toBe(true);
      const t0 = Date.now();
      await cutProcessGroups([leader.pid as number], 300);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
      expect(alive(member)).toBe(false);
      expect(alive(-(leader.pid as number))).toBe(false);
    } finally {
      try { process.kill(member, 'SIGKILL'); } catch { /* gone */ }
    }
  }, 30_000);
});
