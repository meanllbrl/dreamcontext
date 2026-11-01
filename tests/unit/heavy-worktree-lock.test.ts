import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { heavyLockPath, heavyRepoDir, heavySlotPaths } from '../../src/lib/builder-tools.js';
import { acquireFileLock, releaseFileLock } from '../../src/lib/file-lock.js';
import { builderHeavy, type BuilderDeps } from '../../src/cli/commands/builder.js';
import { acquireHeavyReporting, heavyQueueDir, heavySlotQueueDir, queueReport } from '../../src/lib/heavy-acquire.js';
import { QUEUE_KEEP_MS, QueuePlace, queueOf, readTickets } from '../../src/lib/heavy-queue.js';
import { ledgerPath } from '../../src/lib/run-ledger.js';
import { budgetPath } from '../../src/lib/run-budget.js';

/**
 * The heavy lock is per CHECKOUT (task agir-kontrol-siniri…, 2026-11-01): two worktrees of one
 * repo run their heavy checks side by side, one worktree still runs them one at a time, and the
 * machine's slots (2, or 1 while very hot) still bound every repo and worktree together. Real git
 * repos and real `git worktree add`, real child processes; only the slot dir and heat are injected.
 */

const DEAD_PID = 2_147_483_000;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' });

describe('heavy lock per worktree', () => {
  let root: string;
  let slots: string;
  let main: string;
  let wtA: string;
  let wtB: string;
  let other: string;
  let err: string[];
  const deps = (cwd: string, limit = 2): BuilderDeps => ({
    cwd: () => cwd, print: () => {}, printErr: (l) => err.push(l), ps: () => '', kill: () => {}, heavySlotDir: () => slots,
    heavyLimit: async () => limit,
  });

  const repo = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    git(dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'dc-heavy-wt-')));
    slots = join(root, 'heavy');
    main = join(root, 'main');
    other = join(root, 'other');
    wtA = join(root, 'wt-a');
    wtB = join(root, 'wt-b');
    repo(main);
    repo(other);
    git(main, 'worktree', 'add', '-q', '-b', 'a', wtA);
    git(main, 'worktree', 'add', '-q', '-b', 'b', wtB);
    err = [];
  });
  afterEach(() => {
    for (const p of heavySlotPaths(slots)) releaseFileLock(p);
    for (const d of [main, wtA, wtB, other]) releaseFileLock(heavyLockPath(d));
    rmSync(root, { recursive: true, force: true });
  });

  /** A job that stamps its start and end, so the run intervals can be compared. */
  const job = (tag: string, ms = 700) => {
    const f = join(root, `${tag}.span`);
    return [process.execPath, '-e', `const fs=require('fs');const s=Date.now();setTimeout(()=>fs.writeFileSync(${JSON.stringify(f)},s+' '+Date.now()),${ms})`];
  };
  const span = (tag: string): [number, number] => readFileSync(join(root, `${tag}.span`), 'utf-8').split(' ').map(Number) as [number, number];
  /** The most intervals that were running at one instant. */
  const peak = (tags: string[]) => {
    const edges = tags.flatMap((t) => { const [s, e] = span(t); return [[s, 1], [e, -1]] as const; })
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let n = 0; let max = 0;
    for (const [, d] of edges) { n += d; max = Math.max(max, n); }
    return max;
  };

  it('each worktree has its own lock; the main checkout keeps the old path; ledger and budget stay repo-wide', () => {
    const common = join(main, '.git');
    expect(heavyLockPath(main)).toBe(join(common, 'dc-heavy.lock'));
    expect(heavyLockPath(wtA)).toBe(join(common, 'worktrees', 'wt-a', 'dc-heavy.lock'));
    expect(heavyLockPath(wtB)).toBe(join(common, 'worktrees', 'wt-b', 'dc-heavy.lock'));
    for (const d of [main, wtA, wtB]) {
      expect(heavyRepoDir(d)).toBe(common);
      expect(ledgerPath(d)).toBe(join(common, 'dc-run-ledger.jsonl'));
      expect(budgetPath(d)).toBe(join(common, 'dc-run-budget.json'));
    }
    expect(heavyLockPath(other)).toBe(join(other, '.git', 'dc-heavy.lock'));
  });

  it('two worktrees of one repo run their heavy checks at the same time', async () => {
    const [a, b] = await Promise.all([builderHeavy(deps(wtA), job('a'), {}), builderHeavy(deps(wtB), job('b'), {})]);
    expect([a, b]).toEqual([0, 0]);
    expect(peak(['a', 'b'])).toBe(2);
  });

  it('while one worktree holds its lock, the other starts without waiting when a slot is free', async () => {
    expect(acquireFileLock(heavyLockPath(wtA), Date.now(), 5_000)).toBe(true);
    const t = Date.now();
    expect(await builderHeavy(deps(wtB), [process.execPath, '-e', 'process.exit(0)'], { maxWait: '0' })).toBe(0);
    expect(Date.now() - t).toBeLessThan(2_000);
    // The main checkout is not the worktree: it does not wait either.
    expect(await builderHeavy(deps(main), [process.execPath, '-e', 'process.exit(0)'], { maxWait: '0' })).toBe(0);
  });

  it('two heavy checks in ONE worktree still take turns', async () => {
    const [a, b] = await Promise.all([builderHeavy(deps(wtA), job('a1', 400), {}), builderHeavy(deps(wtA), job('a2', 400), {})]);
    expect([a, b]).toEqual([0, 0]);
    expect(peak(['a1', 'a2'])).toBe(1);
  });

  it('the machine bound holds: three checks over two worktrees and another repo, at most 2 at once', async () => {
    const codes = await Promise.all([
      builderHeavy(deps(wtA), job('x'), {}), builderHeavy(deps(wtB), job('y'), {}), builderHeavy(deps(other), job('z'), {}),
    ]);
    expect(codes).toEqual([0, 0, 0]);
    expect(peak(['x', 'y', 'z'])).toBe(2);
  });

  it('very hot (limit 1): two worktrees run one heavy step at a time', async () => {
    const codes = await Promise.all([builderHeavy(deps(wtA, 1), job('h1', 400), {}), builderHeavy(deps(wtB, 1), job('h2', 400), {})]);
    expect(codes).toEqual([0, 0]);
    expect(peak(['h1', 'h2'])).toBe(1);
  });

  it('the machine slots have a line: across worktrees the smaller job gets the freed slot first', async () => {
    mkdirSync(slots, { recursive: true });
    for (const p of heavySlotPaths(slots).slice(0, 2)) expect(acquireFileLock(p, Date.now(), 5_000)).toBe(true);
    const got: string[] = [];
    const ask = (cwd: string, key: string, size: number) => acquireHeavyReporting({
      cwd, lockPath: heavyLockPath(cwd), slotDir: slots, maxWaitS: 8, heavyLimit: async () => 2, ps: () => '',
      job: { key, size, label: 'tests', line: 'heavy' },
    }).then((r) => { got.push(key); return r; });
    const big = ask(wtA, 'big', 5);
    await new Promise((r) => setTimeout(r, 300));
    const small = ask(wtB, 'small', 1);
    await new Promise((r) => setTimeout(r, 300));
    // Both hold their own checkout lock and stand in the one slot line, small first.
    expect(readTickets(heavySlotQueueDir(slots), Date.now()).map((t) => t.key).sort()).toEqual(['big', 'small']);
    releaseFileLock(heavySlotPaths(slots)[0]);
    const s = await small;
    expect(got).toEqual(['small']);
    s.held!.release();
    const b = await big;
    expect(got).toEqual(['small', 'big']);
    b.held!.release();
    expect(readTickets(heavySlotQueueDir(slots), Date.now())).toEqual([]);
  });

  it('a slot wait that runs out keeps its place in the slot line, and the retry takes it back', async () => {
    mkdirSync(slots, { recursive: true });
    for (const p of heavySlotPaths(slots).slice(0, 2)) expect(acquireFileLock(p, Date.now(), 5_000)).toBe(true);
    const job = { key: 'kept', size: 5, label: 'tests', line: 'heavy' as const };
    const first = await acquireHeavyReporting({ cwd: wtA, lockPath: heavyLockPath(wtA), slotDir: slots, maxWaitS: 0, heavyLimit: async () => 2, ps: () => '', job });
    expect(first.held).toBeNull();
    expect(first.busy).toMatch(/Your place is KEPT/);
    const [kept] = readTickets(heavySlotQueueDir(slots), Date.now());
    expect(kept.key).toBe('kept');
    releaseFileLock(heavySlotPaths(slots)[0]);
    const again = await acquireHeavyReporting({ cwd: wtA, lockPath: heavyLockPath(wtA), slotDir: slots, maxWaitS: 2, heavyLimit: async () => 2, ps: () => '', job });
    expect(again.held).not.toBeNull();
    again.held!.release();
    expect(readTickets(heavySlotQueueDir(slots), Date.now())).toEqual([]);
  });

  it('builder queue shows each worktree its own holder and its own waiters', () => {
    expect(acquireFileLock(heavyLockPath(wtA), Date.now(), 5_000)).toBe(true);
    mkdirSync(slots, { recursive: true });
    expect(acquireFileLock(heavySlotPaths(slots)[0], Date.now(), 5_000)).toBe(true);
    QueuePlace.enter(heavyQueueDir(heavyLockPath(wtA)), { key: 'waiter-a', size: 1, label: 'tests' }, Date.now());
    const fromA = queueReport(heavyLockPath(wtA), slots, () => '');
    const fromB = queueReport(heavyLockPath(wtB), slots, () => '');
    expect(fromA[0]).toBe(`heavy lock (this checkout): pid ${process.pid}`);
    expect(fromA[1]).toBe(`heavy slots: pid ${process.pid}`);
    expect(fromA).toContain('heavy line: 1 waiting or parked');
    expect(fromA.some((l) => /#1 tests \(first asked/.test(l))).toBe(true);
    expect(fromB[0]).toBe('heavy lock (this checkout): free');
    expect(fromB[1]).toBe(`heavy slots: pid ${process.pid}`);
    expect(fromB).toContain('heavy line: empty');
  });

  it('old repo-wide tickets never block a worktree, and dead or expired ones never block the main checkout', async () => {
    // The old shared line: a live waiter (this process), a dead one, and one past its keep.
    const shared = heavyQueueDir(join(main, '.git', 'dc-heavy.lock'));
    expect(shared).toBe(heavyQueueDir(heavyLockPath(main)));
    QueuePlace.enter(shared, { key: 'old-live', size: 1, label: 'tests' }, Date.now());
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, 'old-dead.json'), JSON.stringify({ key: 'old-dead', pid: DEAD_PID, at: Date.now() - 1_000, seen: Date.now(), size: 1, label: 'tests' }));
    writeFileSync(join(shared, 'old-gone.json'), JSON.stringify({ key: 'old-gone', pid: DEAD_PID, at: 0, seen: Date.now() - QUEUE_KEEP_MS - 1, size: 1, label: 'tests' }));

    // A worktree does not read the shared line at all: it runs at once, even behind a live old waiter.
    const wt = await acquireHeavyReporting({ cwd: wtA, lockPath: heavyLockPath(wtA), slotDir: slots, maxWaitS: 0, heavyLimit: async () => 2, ps: () => '', job: { key: 'new', size: 5, label: 'tests', line: 'heavy' } });
    expect(wt.held).not.toBeNull();
    wt.held!.release();

    // The main checkout: once the live old waiter is gone, the dead ticket blocks nobody and the
    // expired one is swept.
    rmSync(join(shared, 'old-live.json'));
    const m = await acquireHeavyReporting({ cwd: main, lockPath: heavyLockPath(main), slotDir: slots, maxWaitS: 0, heavyLimit: async () => 2, ps: () => '', job: { key: 'new-main', size: 5, label: 'tests', line: 'heavy' } });
    expect(m.held).not.toBeNull();
    m.held!.release();
    expect(existsSync(join(shared, 'old-gone.json'))).toBe(false);
    expect(readTickets(shared, Date.now()).map((t) => t.key)).toEqual(['old-dead']);
  });
});

describe('tests and type-checks take no turn on the checkout', () => {
  it('only checks are shared: a build or a script keeps the lock, and a shared job runs beside the lock holder', async () => {
    expect(queueOf('npx vitest run tests/unit/a.test.ts').shared).toBe(true);
    expect(queueOf('npx vitest run').shared).toBe(false); // a whole suite keeps its turn
    expect(queueOf('npx tsc --noEmit').shared).toBe(true);
    expect(queueOf('npm run build', { build: 'tsup' }).shared).toBe(false);
    expect(queueOf('node scripts/verify/x.mjs').shared).toBe(false);
    expect(queueOf('sleep 900').shared).toBe(false);
    const root = mkdtempSync(join(tmpdir(), 'dc-heavy-shared-'));
    const lockPath = join(root, 'repo.lock');
    const slotDir = join(root, 'slots');
    try {
      expect(acquireFileLock(lockPath, Date.now(), 5_000)).toBe(true);
      const job = { key: 's', size: 3, label: 'tests', line: 'heavy' as const, shared: true };
      const r = await acquireHeavyReporting({ cwd: root, lockPath, slotDir, maxWaitS: 0, heavyLimit: async () => 2, ps: () => '', job });
      expect(r.held).not.toBeNull();
      expect(r.waits).toMatchObject({ lockMs: 0, limit: 2 });
      r.held!.release();
      expect(existsSync(lockPath)).toBe(true); // the holder's lock is not ours to drop
      const blocked = await acquireHeavyReporting({ cwd: root, lockPath, slotDir, maxWaitS: 0, heavyLimit: async () => 2, ps: () => '', job: { ...job, key: 'b', shared: false } });
      expect(blocked.held).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
