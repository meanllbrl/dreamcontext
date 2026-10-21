import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  HEAVY_LOCK_BUSY_EXIT, HEAVY_MACHINE_SLOTS, acquireHeavy, heavyLockPath, heavySlotPaths, heavySlotsHeld,
} from '../../src/lib/builder-tools.js';
import { acquireFileLock, releaseFileLock } from '../../src/lib/file-lock.js';
import { builderHeavy, type BuilderDeps } from '../../src/cli/commands/builder.js';

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
