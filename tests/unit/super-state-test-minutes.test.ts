import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendLedger, ledgerPath, readLedger, recordCheck, recordStart, testMinutesToday, unattributedMinutes } from '../../src/lib/run-ledger.js';

/**
 * Ledger attribution (plan C6, 2026-11-08): every worktree of a repo writes ONE ledger, so its
 * rows carry the worktree and branch, and the Super shows each child its own test minutes today
 * (`super state` → children[sid].testsToday). Older rows count as unattributed.
 */

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
const MIN = 60_000;

describe('test minutes per worktree, one shared ledger', () => {
  let root: string;
  let a: string;
  let b: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'dc-ledger-split-')));
    a = join(root, 'a');
    b = join(root, 'b');
    execFileSync('git', ['init', '-q', '-b', 'main', a], { stdio: 'ignore' });
    writeFileSync(join(a, 'x'), 'x');
    git(a, 'add', '-A');
    git(a, '-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-q', '-m', 'i');
    git(a, 'worktree', 'add', '-q', '-b', 'super/other', b);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('two worktrees writing one ledger split correctly; a running check counts to now; old rows are unattributed', () => {
    expect(ledgerPath(a)).toBe(ledgerPath(b));
    const day = new Date(); day.setHours(0, 0, 0, 0);
    const t = day.getTime() + 60 * MIN;
    recordCheck(a, { label: 'tsc', line: 'fast', asked: t, ran: t + 2 * MIN, ended: t + 5 * MIN, exit: 0 });
    recordCheck(b, { label: 'suite', line: 'heavy', asked: t, ran: t + 10 * MIN, ended: t + 45 * MIN, exit: 1 });
    recordCheck(b, { label: 'tests', line: 'heavy', asked: t + 50 * MIN, ran: t + 51 * MIN, ended: t + 53 * MIN, exit: 0 });
    // Yesterday's check is not today's.
    recordCheck(b, { label: 'old', line: 'heavy', asked: t - 30 * 60 * MIN, ran: t - 29 * 60 * MIN, ended: t - 28 * 60 * MIN, exit: 0 });
    // A full run past a red, still running in b.
    recordStart(b, { label: 'suite', line: 'heavy', asked: t + 60 * MIN, ran: t + 61 * MIN, because: 'the owner asked for a second run' });
    appendLedger(ledgerPath(a), { type: 'check', run: '-', label: 'pre-0.41.7', line: 'heavy', asked: t, ran: t + MIN, ended: t + 4 * MIN, exit: 0 });
    const rows = readLedger(ledgerPath(a));
    expect(rows.filter((r) => r.type !== 'mark').every((r) => !('toplevel' in r) || r.toplevel === realpathSync(a) || r.toplevel === realpathSync(b))).toBe(true);
    const now = t + 70 * MIN;
    expect(testMinutesToday(rows, { toplevel: realpathSync(a), branch: 'main' }, day.getTime(), now)).toEqual({ queuedMin: 2, runningMin: 3, checks: 1, because: 0 });
    expect(testMinutesToday(rows, { toplevel: realpathSync(b), branch: 'super/other' }, day.getTime(), now)).toEqual({ queuedMin: 12, runningMin: 46, checks: 2, because: 1 });
    // Another branch in the same worktree is not this child's.
    expect(testMinutesToday(rows, { toplevel: realpathSync(b), branch: 'main' }, day.getTime(), now)).toEqual({ queuedMin: 0, runningMin: 0, checks: 0, because: 0 });
    expect(unattributedMinutes(rows, day.getTime(), now)).toBe(4);
    expect(readFileSync(ledgerPath(a), 'utf-8')).toContain('"branch":"super/other"');
  });

  it('a start whose runner died counts no running time', () => {
    const day = new Date(); day.setHours(0, 0, 0, 0);
    const t = day.getTime() + 60 * MIN;
    recordStart(a, { label: 'suite', line: 'heavy', asked: t, ran: t + MIN });
    const rows = readLedger(ledgerPath(a));
    expect(testMinutesToday(rows, { toplevel: realpathSync(a) }, day.getTime(), t + 20 * MIN, () => false)).toEqual({ queuedMin: 0, runningMin: 0, checks: 0, because: 0 });
    expect(testMinutesToday(rows, { toplevel: realpathSync(a) }, day.getTime(), t + 20 * MIN, () => true)).toEqual({ queuedMin: 1, runningMin: 19, checks: 0, because: 0 });
  });
});
