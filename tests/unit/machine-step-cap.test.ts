import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MACHINE_STEP_CAP, acquireFastSlot, acquireHeavy, clampHeavyLimit, fastSlotPaths, heavySlotPaths, machineStepLimit, stepsHeld,
} from '../../src/lib/builder-tools.js';
import { acquireFileLock, releaseFileLock } from '../../src/lib/file-lock.js';
import { heavyLimitFor } from '../../src/lib/heat.js';
import { acquireHeavyReporting } from '../../src/lib/heavy-acquire.js';

/**
 * AC13 (owner, 2026-11-21: load 124, four type-checks at once in four worktrees): the whole
 * machine runs at most 2 steps, the fast line counted in, and 1 while heat or load is serious.
 */

let root: string;
let slots: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-step-cap-'));
  slots = join(root, 'slots');
  mkdirSync(slots, { recursive: true });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const lock = (k: string) => join(root, `${k}.lock`);

describe('the machine step limit', () => {
  it('never passes 2, whatever the machine or the reader says', () => {
    expect(MACHINE_STEP_CAP).toBe(2);
    expect(machineStepLimit({ cores: 128, totalGb: 1024 })).toBe(2);
    expect(clampHeavyLimit(16)).toBe(2);
    expect(clampHeavyLimit(1)).toBe(1);
    expect(clampHeavyLimit(Number.NaN)).toBeLessThanOrEqual(2);
  });

  it('is 1 at serious or critical heat, critical memory, or a busy load', () => {
    expect(heavyLimitFor('nominal', false, 2, false)).toBe(2);
    expect(heavyLimitFor('nominal', false, 8, false)).toBe(2);
    expect(heavyLimitFor('serious')).toBe(1);
    expect(heavyLimitFor('critical')).toBe(1);
    expect(heavyLimitFor('nominal', true)).toBe(1);
    expect(heavyLimitFor('nominal', false, 2, true)).toBe(1);
  });
});

describe('one budget for heavy and fast steps together', () => {
  it('a heavy step and a fast step fill the machine: a second heavy step waits', async () => {
    expect(acquireFileLock(fastSlotPaths(slots)[0], Date.now(), 5_000)).toBe(true);
    const one = await acquireHeavy(root, { waitMs: 0, slotDir: slots, repoLock: lock('a'), limit: async () => 2 });
    expect(one).not.toBeNull();
    expect(stepsHeld(slots)).toBe(2);
    expect(await acquireHeavy(root, { waitMs: 0, slotDir: slots, repoLock: lock('b'), limit: async () => 2 })).toBeNull();
    one!.release();
    releaseFileLock(fastSlotPaths(slots)[0]);
  });

  it('two heavy steps running: a fast step does not start beside them', async () => {
    for (const p of heavySlotPaths(slots).slice(0, 2)) expect(acquireFileLock(p, Date.now(), 5_000)).toBe(true);
    const fast = await acquireFastSlot({
      waitMs: 0, paths: fastSlotPaths(slots), limit: () => 2, turn: () => true, room: () => 2 - stepsHeld(slots),
    });
    expect(fast).toBeNull();
    releaseFileLock(heavySlotPaths(slots)[1]);
    const next = await acquireFastSlot({
      waitMs: 0, paths: fastSlotPaths(slots), limit: () => 2, turn: () => true, room: () => 2 - stepsHeld(slots),
    });
    expect(next).not.toBeNull();
    next!.release();
    releaseFileLock(heavySlotPaths(slots)[0]);
  });

  it('through the reporting path: a tsc in the fast line waits while two heavy steps run, and nothing runs', async () => {
    for (const p of heavySlotPaths(slots).slice(0, 2)) expect(acquireFileLock(p, Date.now(), 5_000)).toBe(true);
    const r = await acquireHeavyReporting({
      cwd: root, lockPath: lock('c'), slotDir: slots, maxWaitS: 0, heavyLimit: async () => 2, ps: () => '', machineBusy: () => false,
      job: { key: 'tsc', size: 1, label: 'tsc', line: 'fast', shared: true },
    });
    expect(r.held).toBeNull();
    expect(r.busy).toMatch(/NOTHING ran/);
    for (const p of heavySlotPaths(slots).slice(0, 2)) releaseFileLock(p);
  });

  it('while the limit is 1, the one running step of either line holds the whole machine', async () => {
    const one = await acquireHeavy(root, { waitMs: 0, slotDir: slots, repoLock: lock('d'), limit: async () => 1 });
    expect(one).not.toBeNull();
    const r = await acquireHeavyReporting({
      cwd: root, lockPath: lock('e'), slotDir: slots, maxWaitS: 0, heavyLimit: async () => 1, ps: () => '',
      job: { key: 'tsc2', size: 1, label: 'tsc', line: 'fast', shared: true },
    });
    expect(r.held).toBeNull();
    one!.release();
  });
});
