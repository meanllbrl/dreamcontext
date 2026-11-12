import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readCycleReport,
  recordCycleFlag,
  recordNoFlags,
  recordCycleAsks,
  consumeCycleReport,
  CYCLE_REPORT_REL,
  CYCLE_REPORT_LAST_REL,
} from '../../src/lib/sleep-cycle-report.js';
import { reconcileFlags, type SleepFlag } from '../../src/lib/sleep-flags.js';

/**
 * SL-3: specialists record their own flags and ask counts; `sleep done` reads them. A cycle
 * nobody reported in keeps the streaks as they were (absence is not a resolution).
 */

let root: string;
beforeEach(() => {
  root = join(tmpdir(), `cycle-report-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('the cycle report', () => {
  it('an absent report reads as nothing reported', () => {
    expect(readCycleReport(root)).toEqual({ reported_by: [], flags: [], asks: null });
  });

  it('records flags from several specialists, one entry per key (the latest label wins)', () => {
    recordCycleFlag(root, { key: 'recurring-task:x', label: 'first', task_slug: 'x' }, 'sleep-tasks');
    recordCycleFlag(root, { key: 'ceiling-blocked:2.memory.md', label: 'blocked', task_slug: null }, 'sleep-state');
    recordCycleFlag(root, { key: 'recurring-task:x', label: 'second', task_slug: 'x' }, 'sleep-tasks');
    const r = readCycleReport(root);
    expect(r.reported_by).toEqual(['sleep-tasks', 'sleep-state']);
    expect(r.flags.map((f) => [f.key, f.label])).toEqual([
      ['ceiling-blocked:2.memory.md', 'blocked'],
      ['recurring-task:x', 'second'],
    ]);
  });

  it('`flag none` counts the cycle as reported without a flag', () => {
    recordNoFlags(root, 'sleep-state');
    expect(readCycleReport(root)).toMatchObject({ reported_by: ['sleep-state'], flags: [] });
  });

  it('records the ask counts; a second call replaces the first', () => {
    recordCycleAsks(root, { criterion: 1, subtask: 0, task: 0, unplaced: 0 }, 'sleep-tasks');
    recordCycleAsks(root, { criterion: 3, subtask: 0, task: 1, unplaced: 2 }, 'sleep-tasks');
    expect(readCycleReport(root).asks?.counts).toEqual({ criterion: 3, subtask: 0, task: 1, unplaced: 2 });
  });

  it('consuming moves the report to cycle.last.json (a receipt), never deletes it', () => {
    recordCycleFlag(root, { key: 'k', label: 'l', task_slug: null }, 'sleep-state');
    expect(consumeCycleReport(root)).toBe(true);
    expect(existsSync(join(root, CYCLE_REPORT_REL))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, CYCLE_REPORT_LAST_REL), 'utf-8')).flags[0].key).toBe('k');
    expect(readCycleReport(root).flags).toEqual([]);
    expect(consumeCycleReport(root)).toBe(false);
  });

  it('refuses a symlinked tmp/', () => {
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    const ctx = join(root, 'ctx');
    mkdirSync(ctx);
    symlinkSync(elsewhere, join(ctx, 'tmp'));
    expect(() => recordNoFlags(ctx, 'sleep-state')).toThrow(/symlink/);
  });
});

describe('reconcileFlags: a cycle with no report keeps the streaks', () => {
  const prev: SleepFlag[] = [
    { key: 'a', label: 'A', task_slug: null, first_seen: '2026-11-01', last_seen: '2026-11-10', consecutive_cycles: 2 },
  ];

  it('nothing reported: the flags come back unchanged', () => {
    expect(reconcileFlags(prev, [], '2026-11-12', { reported: false })).toBe(prev);
  });

  it('reported, not re-observed: dropped by the consecutive contract (unchanged behaviour)', () => {
    expect(reconcileFlags(prev, [], '2026-11-12', { reported: true })).toEqual([]);
    expect(reconcileFlags(prev, [], '2026-11-12')).toEqual([]);
  });

  it('re-observed: the streak advances to the escalation count', () => {
    const next = reconcileFlags(prev, [{ key: 'a', label: 'A again', task_slug: null }], '2026-11-12', { reported: true });
    expect(next[0]).toMatchObject({ consecutive_cycles: 3, first_seen: '2026-11-01', label: 'A again' });
  });
});
