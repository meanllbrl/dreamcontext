import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireFileLock, releaseFileLock } from '../../src/lib/file-lock.js';
import { heavyLockPath } from '../../src/lib/builder-tools.js';
import { builderHeavy, builderLedger, builderMark, type BuilderDeps } from '../../src/cli/commands/builder.js';
import { markPhase } from '../../src/lib/run-budget.js';
import { appendLedger, ledgerPath, readLedger } from '../../src/lib/run-ledger.js';
import { ledgerLine, summarize, type LedgerRow } from '../../src/lib/run-ledger.js';

const MIN = 60_000;
const mark = (what: 'open' | 'review-start' | 'review-end' | 'close', m: number): LedgerRow => ({ type: 'mark', run: 'r', what, at: m * MIN });
const check = (asked: number, ran: number, ended: number): LedgerRow => ({ type: 'check', run: 'r', label: 't', line: 'fast', asked: asked * MIN, ran: ran * MIN, ended: ended * MIN, exit: 0 });

describe('run ledger', () => {
  it('splits the clock: code is what the records do not cover', () => {
    const s = summarize([mark('open', 0), check(5, 25, 30), check(30, 30, 38), mark('review-start', 40), mark('review-end', 44), mark('close', 50)], 999 * MIN)!;
    expect(s).toMatchObject({ totalMs: 50 * MIN, queueMs: 20 * MIN, checkMs: 13 * MIN, reviewMs: 4 * MIN, codeMs: 13 * MIN, checks: 2, longestWaitMs: 20 * MIN, closed: true });
    expect(ledgerLine('r', s)).toBe('ledger r: code 13.0 min / queue 20.0 min / checks 13.0 min / review 4.0 min (total 50.0 min; 2 checks, longest wait 20.0 min)');
  });

  it('counts an overlap once in code', () => {
    const s = summarize([mark('open', 0), mark('review-start', 10), check(12, 12, 16), mark('review-end', 20), mark('close', 30)], 0)!;
    expect(s.codeMs).toBe(20 * MIN);
  });

  it('a check after close (a validator) does not bend the sums', () => {
    const s = summarize([mark('open', 0), mark('close', 100), check(200, 200, 300)], 999 * MIN)!;
    expect(s).toMatchObject({ totalMs: 100 * MIN, codeMs: 100 * MIN, queueMs: 0, checkMs: 0 });
  });

  it('says a review nobody marked is missing, never zero', () => {
    const s = summarize([mark('open', 0)], 10 * MIN)!;
    expect(s.reviewMs).toBeNull();
    expect(ledgerLine('r', s)).toMatch(/review not marked.*so far/);
  });

  it('a review still open counts up to now; no open record is no summary', () => {
    expect(summarize([mark('open', 0), mark('review-start', 4)], 10 * MIN)!.reviewMs).toBe(6 * MIN);
    expect(summarize([check(1, 2, 3)], 10 * MIN)).toBeNull();
  });
});

describe('the ledger through the commands', () => {
  it('writes real waits, a wait that ran out too, marks and close, and no secret', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'dc-ledger-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@e.st', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: repo });
    const out: string[] = [];
    const deps: BuilderDeps = {
      cwd: () => repo, print: (l) => out.push(l), printErr: () => {}, ps: () => '', kill: () => {},
      heavySlotDir: () => join(repo, 'slots'), heavyLimit: async () => 2, machineBusy: () => false,
    };
    const path = ledgerPath(repo);
    markPhase(repo, 'build', 'task', Date.now());
    appendLedger(path, { type: 'mark', run: 'task', what: 'open', at: Date.now() });
    const job = 'SECRET_KEY=sk-FAKE true';
    expect(await builderHeavy(deps, [job], { maxWait: '1' })).toBe(0);
    expect(acquireFileLock(heavyLockPath(repo), Date.now(), 5_000)).toBe(true);
    expect(await builderHeavy(deps, [job], { maxWait: '0' })).toBe(75);
    releaseFileLock(heavyLockPath(repo));
    expect(builderMark(deps, 'review-start')).toBe(0);
    expect(builderMark(deps, 'review-end')).toBe(0);
    expect(builderMark(deps, 'nonsense')).toBe(2);
    expect(builderLedger(deps, undefined, { close: true })).toBe(0);
    const rows = readLedger(path, 'task').filter((r) => r.type === 'check');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ exit: null });
    expect(readFileSync(path, 'utf-8')).not.toContain('sk-FAKE');
    expect(out.join('\n')).toMatch(/^ledger task: code .*queue .*checks .*review 0\.0 min \(total /m);
    rmSync(repo, { recursive: true, force: true });
  });
});
