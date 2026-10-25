import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  HEAVY_LOCK_BUSY_EXIT, HEAVY_MACHINE_SLOTS, acquireHeavy, heavyLockPath, heavySlotPaths, heavySlotsHeld,
} from '../../src/lib/builder-tools.js';
import { acquireFileLock, releaseFileLock } from '../../src/lib/file-lock.js';
import { builderHeavy, type BuilderDeps } from '../../src/cli/commands/builder.js';
import { HEAT_RECHECK_MS } from '../../src/lib/builder-tools.js';
import { HEAVY_HOT_WAIT_S, acquireHeavyReporting } from '../../src/lib/heavy-acquire.js';

/**
 * Heavy steps, machine-wide N = 2 (orchestration plan r5 D12, AC13): `builder heavy` and
 * `builder test` take the repo's heavy lock, then one of the machine's two slots. A third
 * check from ANY repo waits; a dead holder's slot is reclaimed; the repo lock is always taken
 * first and released last.
 */

const DEAD_PID = 2_147_483_000;

describe('machine heavy slots', () => {
  let root: string;
  let slots: string;
  let repoA: string;
  let repoB: string;
  let err: string[];
  const deps = (cwd: string): BuilderDeps => ({
    cwd: () => cwd, print: () => {}, printErr: (l) => err.push(l), ps: () => '', kill: () => {}, heavySlotDir: () => slots,
    heavyLimit: async () => 2,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dc-heavy-slots-'));
    slots = join(root, 'heavy');
    repoA = join(root, 'a');
    repoB = join(root, 'b');
    mkdirSync(repoA);
    mkdirSync(repoB);
    err = [];
  });
  afterEach(() => {
    for (const p of heavySlotPaths(slots)) releaseFileLock(p);
    releaseFileLock(heavyLockPath(repoA, () => null));
    releaseFileLock(heavyLockPath(repoB, () => null));
    rmSync(root, { recursive: true, force: true });
  });

  const holdBoth = () => { for (const p of heavySlotPaths(slots)) expect(acquireFileLock(p, Date.now(), 5_000)).toBe(true); };

  it('is two slots', () => {
    expect(HEAVY_MACHINE_SLOTS).toBe(2);
    expect(heavySlotPaths(slots).map((p) => p.slice(slots.length + 1))).toEqual(['slot-0.lock', 'slot-1.lock']);
  });

  it('with both slots held by live checks, a third from another repo runs NOTHING and exits 75', async () => {
    holdBoth();
    expect(heavySlotsHeld(slots)).toBe(2);
    const marker = join(root, 'ran.txt');
    const code = await builderHeavy(deps(repoB), [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'x')`], { maxWait: '0' });
    expect(code).toBe(HEAVY_LOCK_BUSY_EXIT);
    expect(existsSync(marker)).toBe(false);
    expect(err.join('\n')).toMatch(/all 2 heavy slots of this machine/);
    // It let go of its own repo lock: the repo is free again.
    expect(existsSync(heavyLockPath(repoB, () => null))).toBe(false);
  });

  it('the third check runs as soon as a slot frees', async () => {
    holdBoth();
    const [s0] = heavySlotPaths(slots);
    setTimeout(() => releaseFileLock(s0), 600);
    const t = Date.now();
    expect(await builderHeavy(deps(repoA), [process.execPath, '-e', 'process.exit(0)'], { maxWait: '5' })).toBe(0);
    expect(Date.now() - t).toBeGreaterThanOrEqual(500);
    // Done: its slot is given back (only the one still held by the test remains).
    expect(heavySlotsHeld(slots)).toBe(1);
  });

  it('two checks of DIFFERENT repos run at once (one slot each)', async () => {
    const stamp = (n: string) => join(root, `${n}.txt`);
    const job = (n: string) => [process.execPath, '-e', `const f=require('fs');f.writeFileSync(${JSON.stringify(stamp(n))},String(Date.now()));setTimeout(()=>{},500)`];
    const t = Date.now();
    const [a, b] = await Promise.all([builderHeavy(deps(repoA), job('a'), {}), builderHeavy(deps(repoB), job('b'), {})]);
    expect([a, b]).toEqual([0, 0]);
    expect(Date.now() - t).toBeLessThan(2_500);
    expect(heavySlotsHeld(slots)).toBe(0);
  });

  it('a dead holder\'s slot is reclaimed', async () => {
    mkdirSync(slots, { recursive: true });
    for (const p of heavySlotPaths(slots)) writeFileSync(p, JSON.stringify({ pid: DEAD_PID, at: Date.now() - 60_000 }));
    expect(heavySlotsHeld(slots)).toBe(0);
    expect(await builderHeavy(deps(repoA), [process.execPath, '-e', 'process.exit(0)'], { maxWait: '2' })).toBe(0);
  });

  it('the repo lock comes first: while it is busy no slot is taken', async () => {
    const lock = heavyLockPath(repoA, () => null);
    expect(acquireFileLock(lock, Date.now(), 5_000)).toBe(true);
    const held = await acquireHeavy(repoA, { waitMs: 300, slotDir: slots, pollMs: 50, repoLock: lock });
    expect(held).toBeNull();
    expect(heavySlotsHeld(slots)).toBe(0);
  });

  it('release gives back the slot, then the repo lock', async () => {
    const lock = heavyLockPath(repoA, () => null);
    const held = await acquireHeavy(repoA, { waitMs: 0, slotDir: slots, repoLock: lock });
    expect(held).not.toBeNull();
    expect(existsSync(held!.slot)).toBe(true);
    expect(existsSync(lock)).toBe(true);
    held!.release();
    expect(existsSync(held!.slot)).toBe(false);
    expect(existsSync(lock)).toBe(false);
  });
});

/**
 * Heat (owner, 2026-10-24): while macOS says very hot the machine runs ONE heavy step, every repo
 * together; a running step is never stopped; the limit is read again every 20 s while waiting.
 * Each acquirer gets its OWN repo lock, so only the machine slots are under test.
 */
describe('machine heavy slots under heat', () => {
  let root: string;
  let slots: string;
  let err: string[];
  const lock = (n: string) => join(root, `repo-${n}.lock`);
  const deps = (cwd: string, limit: () => Promise<number>): BuilderDeps => ({
    cwd: () => cwd, print: () => {}, printErr: (l) => err.push(l), ps: () => '', kill: () => {}, heavySlotDir: () => slots, heavyLimit: limit,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dc-heavy-heat-'));
    slots = join(root, 'heavy');
    err = [];
  });
  afterEach(() => {
    for (const p of heavySlotPaths(slots)) releaseFileLock(p);
    rmSync(root, { recursive: true, force: true });
  });

  it('under limit 1 a new step waits while slot-1 alone is held by a live pid (it never takes slot-0 beside it)', async () => {
    const [, s1] = heavySlotPaths(slots);
    mkdirSync(slots, { recursive: true });
    expect(acquireFileLock(s1, Date.now(), 5_000)).toBe(true);
    const held = await acquireHeavy(root, { waitMs: 300, pollMs: 50, slotDir: slots, repoLock: lock('a'), limit: async () => 1 });
    expect(held).toBeNull();
    expect(heavySlotsHeld(slots)).toBe(1);
  });

  it('under limit 1 two concurrent acquirers: exactly one holds', async () => {
    const [a, b] = await Promise.all([
      acquireHeavy(root, { waitMs: 300, pollMs: 50, slotDir: slots, repoLock: lock('a'), limit: async () => 1 }),
      acquireHeavy(root, { waitMs: 300, pollMs: 50, slotDir: slots, repoLock: lock('b'), limit: async () => 1 }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((a ?? b)!.slot).toBe(heavySlotPaths(slots)[0]);
    (a ?? b)!.release();
  });

  it('the limit flips 1 -> 2 mid-wait: the waiter takes slot-1 at the next recheck (fake clock); the held slot is never revoked', async () => {
    let clock = 1_000_000;
    let limit = 1;
    const reads: number[] = [];
    const first = await acquireHeavy(root, { waitMs: 0, slotDir: slots, repoLock: lock('a'), limit: async () => 1 });
    expect(first).not.toBeNull();
    const waiting = acquireHeavy(root, {
      waitMs: 10 * HEAT_RECHECK_MS, pollMs: 5, slotDir: slots, repoLock: lock('b'), now: () => clock,
      limit: async () => limit, onLimit: (n) => reads.push(n),
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(reads).toEqual([1]);
    limit = 2;
    clock += HEAT_RECHECK_MS - 1;
    await new Promise((r) => setTimeout(r, 40));
    expect(reads).toEqual([1]); // not yet: under 20 s since the last read
    clock += 1;
    const second = await waiting;
    expect(reads).toEqual([1, 2]);
    expect(second!.slot).toBe(heavySlotPaths(slots)[1]);
    expect(existsSync(first!.slot)).toBe(true);
    second!.release();
    first!.release();
  });

  it('a limit that throws, is NaN or 0 reads as 2', async () => {
    for (const limit of [async () => { throw new Error('x'); }, async () => Number.NaN, async () => 0]) {
      const seen: number[] = [];
      const a = await acquireHeavy(root, { waitMs: 0, slotDir: slots, repoLock: lock('a'), limit, onLimit: (n) => seen.push(n) });
      const b = await acquireHeavy(root, { waitMs: 0, slotDir: slots, repoLock: lock('b'), limit, onLimit: (n) => seen.push(n) });
      expect(seen).toEqual([2, 2]);
      expect(a && b).toBeTruthy();
      a!.release(); b!.release();
    }
  });

  it('exit 75 names the heat and the slot holder when the slot wait ran out under limit 1', async () => {
    mkdirSync(slots, { recursive: true });
    expect(acquireFileLock(heavySlotPaths(slots)[0], Date.now(), 5_000)).toBe(true);
    const marker = join(root, 'ran.txt');
    const code = await builderHeavy(deps(join(root, 'x'), async () => 1), [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'x')`], { maxWait: '0' });
    expect(code).toBe(HEAVY_LOCK_BUSY_EXIT);
    expect(existsSync(marker)).toBe(false);
    expect(err.join('\n')).toMatch(/the Mac is very hot .*one heavy step at a time; slot held by pid \d+/);
  });

  it('a repo-lock timeout keeps the repo-lock text, never the heat text', async () => {
    const r = await (async () => {
      const lk = lock('busy');
      expect(acquireFileLock(lk, Date.now(), 5_000)).toBe(true);
      return acquireHeavyReporting({ cwd: root, lockPath: lk, slotDir: slots, maxWaitS: 0, heavyLimit: async () => 1, ps: () => '' });
    })();
    expect(r.held).toBeNull();
    expect(r.busy).toMatch(/^the heavy lock is held by pid \d+/);
    expect(r.busy).not.toMatch(/very hot/);
    releaseFileLock(lock('busy'));
  });

  it('the hot default wait is 120 s (no --max-wait), the cool one stays 300 s', async () => {
    expect(HEAVY_HOT_WAIT_S).toBe(120);
    const hot = await acquireHeavyReporting({ cwd: root, lockPath: lock('h'), slotDir: slots, heavyLimit: async () => 1, ps: () => '' });
    expect(hot.waitS).toBe(120);
    hot.held!.release();
    const cool = await acquireHeavyReporting({ cwd: root, lockPath: lock('c'), slotDir: slots, heavyLimit: async () => 2, ps: () => '' });
    expect(cool.waitS).toBe(300);
    cool.held!.release();
  });
});
