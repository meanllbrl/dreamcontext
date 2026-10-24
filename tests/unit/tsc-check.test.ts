import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkEditedFile, checkAtStop, takeTscResults, tscStateDir, tscWorkFor, SLOW_TSC_MS, TSC_TIMEOUT_MS, type TscRunner,
} from '../../src/lib/tsc-check.js';

let root: string;
let base: string;
let tsconfig: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-tsc-check-'));
  base = join(root, 'state');
  mkdirSync(join(root, 'proj', 'src'), { recursive: true });
  tsconfig = join(root, 'proj', 'tsconfig.json');
  writeFileSync(tsconfig, '{}');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const file = (name: string) => join(root, 'proj', 'src', name);

/** A fake tsc: reports an error for every file in `broken`, takes `ms`, counts its runs. */
function fakeRunner(broken: Set<string>, ms = 100, during?: () => void) {
  const calls: number[] = [];
  let active = 0;
  let maxActive = 0;
  const runner: TscRunner = () => {
    active++;
    maxActive = Math.max(maxActive, active);
    calls.push(calls.length + 1);
    try {
      if (calls.length === 1 && during) during();
      const out = [...broken].map((f) => `src/${f}(1,7): error TS2322: Type 'string' is not assignable to type 'number'.`).join('\n');
      return { output: out || null, ms };
    } finally {
      active--;
    }
  };
  return { runner, calls, maxActive: () => maxActive };
}

describe('checkEditedFile', () => {
  it('a lone edit is checked at once and its own errors come back', () => {
    const t = fakeRunner(new Set(['a.ts']));
    const msgs = checkEditedFile(tsconfig, file('a.ts'), { sessionId: 's1', runner: t.runner, baseDir: base });
    expect(t.calls).toHaveLength(1);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/^TypeScript errors in a\.ts:\nsrc\/a\.ts\(1,7\): error TS2322/);
  });

  it('edits that land while a check runs are coalesced into ONE more check, and reach their sessions', () => {
    const broken = new Set(['b.ts', 'c.ts']);
    const others: string[][] = [];
    // While s1's check runs, three other agents edit: each finds the lock held and returns at once.
    const t = fakeRunner(broken, 100, () => {
      for (const [sid, f] of [['s2', 'b.ts'], ['s3', 'c.ts'], ['s4', 'd.ts']] as const) {
        others.push(checkEditedFile(tsconfig, file(f), { sessionId: sid, runner: () => { throw new Error('a second tsc ran'); }, baseDir: base }));
      }
    });
    const own = checkEditedFile(tsconfig, file('a.ts'), { sessionId: 's1', runner: t.runner, baseDir: base });
    expect(t.calls).toHaveLength(2); // four edits, two checks, never two at once
    expect(t.maxActive()).toBe(1);
    expect(own).toEqual([]);
    expect(others).toEqual([[], [], []]);
    // The re-run answered them: each session reads only its own file's errors.
    expect(takeTscResults('s2', { baseDir: base })).toEqual([expect.stringMatching(/^TypeScript errors in b\.ts/)]);
    expect(takeTscResults('s3', { baseDir: base })).toEqual([expect.stringMatching(/^TypeScript errors in c\.ts/)]);
    expect(takeTscResults('s4', { baseDir: base })).toEqual([]);
    expect(readdirSync(join(tscStateDir(tsconfig, base), 'pending'))).toEqual([]);
  });

  it('a check held by another live process is not duplicated; Stop collects the answer', () => {
    const dir = tscStateDir(tsconfig, base);
    mkdirSync(dir, { recursive: true });
    // A live holder (the test's parent process) that started just now.
    writeFileSync(join(dir, 'lock'), JSON.stringify({ pid: process.ppid, at: Date.now() }));
    const t = fakeRunner(new Set(['a.ts']));
    expect(checkEditedFile(tsconfig, file('a.ts'), { sessionId: 's1', runner: t.runner, baseDir: base })).toEqual([]);
    expect(t.calls).toHaveLength(0);
    rmSync(join(dir, 'lock')); // the holder finished without seeing s1's edit
    const atStop = checkAtStop('s1', { runner: t.runner, baseDir: base });
    expect(t.calls).toHaveLength(1);
    expect(atStop).toEqual([expect.stringMatching(/^TypeScript errors in a\.ts/)]);
  });

  it("a dead holder's lock waits out the check it may have left running, then is reclaimed", () => {
    const dir = tscStateDir(tsconfig, base);
    mkdirSync(dir, { recursive: true });
    const deadPid = 2 ** 22 + 12345;
    // Killed moments ago: its tsc may still be running, so no second one starts.
    writeFileSync(join(dir, 'lock'), JSON.stringify({ pid: deadPid, at: Date.now() }));
    const t = fakeRunner(new Set(['a.ts']));
    expect(checkEditedFile(tsconfig, file('a.ts'), { sessionId: 's1', runner: t.runner, baseDir: base })).toEqual([]);
    expect(t.calls).toHaveLength(0);
    // Killed longer ago than any check can run: reclaimed.
    writeFileSync(join(dir, 'lock'), JSON.stringify({ pid: deadPid, at: Date.now() - TSC_TIMEOUT_MS - 6000 }));
    const msgs = checkEditedFile(tsconfig, file('a.ts'), { sessionId: 's1', runner: t.runner, baseDir: base });
    expect(t.calls).toHaveLength(1);
    expect(msgs).toHaveLength(1);
  });

  it('a stale lock another process is already reclaiming is left to it', () => {
    const dir = tscStateDir(tsconfig, base);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'lock'), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() - 120_000 }));
    writeFileSync(join(dir, 'lock.reclaim'), String(Date.now()));
    const t = fakeRunner(new Set(['a.ts']));
    expect(checkEditedFile(tsconfig, file('a.ts'), { sessionId: 's1', runner: t.runner, baseDir: base })).toEqual([]);
    expect(t.calls).toHaveLength(0);
  });

  it('an answer about a file the session edited again since is never shown', () => {
    const broken = new Set(['b.ts']);
    // s1's check also answers s2's first edit of b.ts (broken at that moment).
    const t = fakeRunner(broken, 100, () => {
      checkEditedFile(tsconfig, file('b.ts'), { sessionId: 's2', runner: t.runner, baseDir: base });
    });
    checkEditedFile(tsconfig, file('a.ts'), { sessionId: 's1', runner: t.runner, baseDir: base });
    // s2 fixes b.ts while another agent's check holds the lock: its new edit pends.
    broken.delete('b.ts');
    const dir = tscStateDir(tsconfig, base);
    writeFileSync(join(dir, 'lock'), JSON.stringify({ pid: process.ppid, at: Date.now() }));
    expect(checkEditedFile(tsconfig, file('b.ts'), { sessionId: 's2', runner: t.runner, baseDir: base })).toEqual([]);
    expect(takeTscResults('s2', { baseDir: base })).toEqual([]);
    expect(tscWorkFor('s2', base)).toBe(true); // the fresh edit still waits for its answer
  });

  it('a slow project stops checking on every edit: the turn is checked once at Stop and the error still surfaces', () => {
    const broken = new Set<string>();
    const slow = fakeRunner(broken, SLOW_TSC_MS + 1000);
    checkEditedFile(tsconfig, file('a.ts'), { sessionId: 's1', runner: slow.runner, baseDir: base });
    expect(slow.calls).toHaveLength(1); // the check that measured the project as slow

    broken.add('b.ts');
    expect(checkEditedFile(tsconfig, file('b.ts'), { sessionId: 's1', runner: slow.runner, baseDir: base })).toEqual([]);
    expect(checkEditedFile(tsconfig, file('c.ts'), { sessionId: 's1', runner: slow.runner, baseDir: base })).toEqual([]);
    expect(slow.calls).toHaveLength(1); // deferred, not run

    const atStop = checkAtStop('s1', { runner: slow.runner, baseDir: base });
    expect(slow.calls).toHaveLength(2); // one check for the whole turn
    expect(atStop).toEqual([expect.stringMatching(/^TypeScript errors in b\.ts:\nsrc\/b\.ts/)]);
    expect(checkAtStop('s1', { runner: slow.runner, baseDir: base })).toEqual([]); // reported once
  });

  it('a later clean check of the same file replaces an earlier error', () => {
    const broken = new Set(['b.ts']);
    const t = fakeRunner(broken, 100, () => {
      checkEditedFile(tsconfig, file('b.ts'), { sessionId: 's2', runner: t.runner, baseDir: base });
    });
    checkEditedFile(tsconfig, file('a.ts'), { sessionId: 's1', runner: t.runner, baseDir: base });
    broken.delete('b.ts');
    const t2 = fakeRunner(broken, 100, () => {
      checkEditedFile(tsconfig, file('b.ts'), { sessionId: 's2', runner: t2.runner, baseDir: base });
    });
    checkEditedFile(tsconfig, file('a.ts'), { sessionId: 's1', runner: t2.runner, baseDir: base });
    expect(takeTscResults('s2', { baseDir: base })).toEqual([]);
  });
});

describe('checkAtStop', () => {
  it('is free when the session has nothing pending', () => {
    const t = fakeRunner(new Set(['a.ts']));
    expect(checkAtStop('nobody', { runner: t.runner, baseDir: base })).toEqual([]);
    expect(t.calls).toHaveLength(0);
  });
});

describe('the shared state is used only when it is this user\'s own private directory', () => {
  it('a base dir others can write to is not trusted: the edit is checked on its own, nothing is shared', () => {
    mkdirSync(base, { recursive: true });
    chmodSync(base, 0o777);
    const t = fakeRunner(new Set(['a.ts']));
    const msgs = checkEditedFile(tsconfig, file('a.ts'), { sessionId: 's1', runner: t.runner, baseDir: base });
    expect(t.calls).toHaveLength(1);
    expect(msgs).toEqual([expect.stringMatching(/^TypeScript errors in a\.ts/)]);
    expect(readdirSync(base)).toEqual([]);
    expect(checkAtStop('s1', { runner: t.runner, baseDir: base })).toEqual([]);
  });

  it('a base dir that is a symlink is not trusted', () => {
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, base);
    const t = fakeRunner(new Set(['a.ts']));
    expect(checkEditedFile(tsconfig, file('a.ts'), { sessionId: 's1', runner: t.runner, baseDir: base })).toHaveLength(1);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(existsSync(join(elsewhere, 'pending'))).toBe(false);
  });
});

describe('the Stop hook never plans a check past its own timeout', () => {
  it('Stop leaves the edits pending when the last check does not fit in the time it has', () => {
    const broken = new Set(['b.ts']);
    const slow = fakeRunner(broken, SLOW_TSC_MS + 1000);
    checkEditedFile(tsconfig, file('a.ts'), { sessionId: 's1', runner: slow.runner, baseDir: base });
    checkEditedFile(tsconfig, file('b.ts'), { sessionId: 's1', runner: slow.runner, baseDir: base });
    expect(slow.calls).toHaveLength(1);
    // A 5 s Stop (an older install) has ~3 s left: the 5 s check does not fit.
    expect(checkAtStop('s1', { runner: slow.runner, baseDir: base, budgetMs: 3000 })).toEqual([]);
    expect(slow.calls).toHaveLength(1);
    expect(tscWorkFor('s1', base)).toBe(true);
    expect(checkAtStop('s1', { runner: slow.runner, baseDir: base, budgetMs: 40_000 })).toEqual([expect.stringMatching(/^TypeScript errors in b\.ts/)]);
  });

  it('a slow project whose Stop has no room keeps checking every edit (an older install loses nothing)', () => {
    const broken = new Set<string>();
    const slow = fakeRunner(broken, SLOW_TSC_MS + 1000);
    checkEditedFile(tsconfig, file('a.ts'), { sessionId: 's1', runner: slow.runner, baseDir: base });
    broken.add('b.ts');
    const msgs = checkEditedFile(tsconfig, file('b.ts'), { sessionId: 's1', runner: slow.runner, baseDir: base, stopBudgetMs: 3000 });
    expect(slow.calls).toHaveLength(2);
    expect(msgs).toEqual([expect.stringMatching(/^TypeScript errors in b\.ts/)]);
  });
});

describe('the check timeout handed to tsc', () => {
  it('is a whole number of milliseconds even when the hook start time is fractional', () => {
    const seen: number[] = [];
    const runner: TscRunner = (_root, timeoutMs) => { seen.push(timeoutMs); return { output: null, ms: 5 }; };
    checkEditedFile(tsconfig, file('a.ts'), { sessionId: 's1', runner, baseDir: base, startedAt: Date.now() - 123.456 });
    expect(seen).toHaveLength(1);
    expect(Number.isInteger(seen[0])).toBe(true);
  });
});

describe('a check cut off by its timeout answers nobody', () => {
  it('keeps every edit pending (its own and other sessions\') and records the cut-off as the floor', () => {
    const broken = new Set(['b.ts']);
    let timeOut = true;
    let calls = 0;
    const runner: TscRunner = () => {
      calls++;
      if (timeOut) return { output: null, ms: 2500, timedOut: true };
      return { output: [...broken].map((f) => `src/${f}(1,7): error TS2322: x`).join('\n'), ms: 900 };
    };
    // s2's edit pends behind a live holder, then the holder finishes without seeing it.
    const dir = tscStateDir(tsconfig, base);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'lock'), JSON.stringify({ pid: process.ppid, at: Date.now() }));
    checkEditedFile(tsconfig, file('b.ts'), { sessionId: 's2', runner, baseDir: base });
    rmSync(join(dir, 'lock'));
    // s1's own check is cut off: nothing is reported as clean, nothing is dropped.
    expect(checkEditedFile(tsconfig, file('a.ts'), { sessionId: 's1', runner, baseDir: base })).toEqual([]);
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(tscWorkFor('s1', base)).toBe(true);
    expect(tscWorkFor('s2', base)).toBe(true);
    expect(takeTscResults('s2', { baseDir: base })).toEqual([]);
    // A check that finishes answers both, including s2's broken file.
    timeOut = false;
    expect(checkAtStop('s2', { runner, baseDir: base, budgetMs: 20_000 })).toEqual([expect.stringMatching(/^TypeScript errors in b\.ts/)]);
    expect(tscWorkFor('s1', base)).toBe(true); // s1's answer (clean) waits as a result
    expect(takeTscResults('s1', { baseDir: base })).toEqual([]);
  });
});

describe('a project whose check cannot finish within the cap', () => {
  it('is not retried for ten minutes, per edit or at Stop, then is tried again', () => {
    let clock = Date.now();
    const now = () => clock;
    let calls = 0;
    let slowAsEver = true;
    const runner: TscRunner = () => {
      calls++;
      return slowAsEver ? { output: null, ms: TSC_TIMEOUT_MS, timedOut: true } : { output: 'src/a.ts(1,1): error TS1: x', ms: 800 };
    };
    checkEditedFile(tsconfig, file('a.ts'), { sessionId: 's1', runner, baseDir: base, now, budgetMs: 1_000_000 });
    const afterCap = calls;
    expect(afterCap).toBeGreaterThanOrEqual(1);
    clock += 60_000;
    expect(checkEditedFile(tsconfig, file('a.ts'), { sessionId: 's1', runner, baseDir: base, now })).toEqual([]);
    expect(checkAtStop('s1', { runner, baseDir: base, now, budgetMs: 1_000_000 })).toEqual([]);
    expect(calls).toBe(afterCap);
    clock += 10 * 60_000;
    slowAsEver = false;
    // Still measured as slow (~30 s): the edit is deferred, and the Stop's check answers it.
    expect(checkEditedFile(tsconfig, file('a.ts'), { sessionId: 's1', runner, baseDir: base, now })).toEqual([]);
    expect(checkAtStop('s1', { runner, baseDir: base, now, budgetMs: 1_000_000 })).toEqual([expect.stringMatching(/^TypeScript errors in a\.ts/)]);
    expect(calls).toBe(afterCap + 1);
  });
});

describe('filterTscErrors on Windows paths', () => {
  it('matches tsc\'s forward-slash output against a backslash file path', async () => {
    const { win32 } = await import('node:path');
    // The function uses the host's path module; the forward-slash spellings it now also tries
    // are what a Windows host computes from `C:\p\src\a.ts` under `C:\p`.
    const rel = win32.relative('C:\\p', 'C:\\p\\src\\a.ts');
    expect(rel).toBe('src\\a.ts');
    expect(rel.split(win32.sep).join('/')).toBe('src/a.ts');
    const { relPosix } = await import('../../src/lib/paths.js');
    expect(relPosix('C:\\p', 'C:\\p\\src\\a.ts', win32)).toBe('src/a.ts');
  });
});
