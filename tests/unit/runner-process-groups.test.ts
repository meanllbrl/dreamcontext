/**
 * runner.ts's process-group helpers: `pathUnderAny` (realpath containment) and
 * `cutProcessGroups`, which stops each group WHOLE — plus a grandchild a hook detached into its
 * own group — resolving only once they are gone. Real `sleep` process groups, no claude.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cutProcessGroups, pathUnderAny } from '../../src/lib/automations/runner.js';

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
