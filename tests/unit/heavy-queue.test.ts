import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { execFileSync } from 'node:child_process';
import { acquireHeavy, fastSlotPaths, heavySlotPaths, heavyLockPath } from '../../src/lib/builder-tools.js';
import { acquireFileLock, releaseFileLock } from '../../src/lib/file-lock.js';
import { builderHeavy, type BuilderDeps } from '../../src/cli/commands/builder.js';
import { heavyQueueDir, queueReport } from '../../src/lib/heavy-acquire.js';
import {
  FAST_TEST_FILES, QUEUE_AGE_MS, QUEUE_KEEP_MS, QueuePlace, countRelatedTests, repoRelativeSource, fastSlotLimit, jobKey, ordered, queueOf, readTickets, safeLabel, type Ticket,
} from '../../src/lib/heavy-queue.js';

const files = (n: number) => Array.from({ length: n }, (_, i) => `tests/unit/f${i}.test.ts`).join(' ');

describe('queueOf: which command goes in which line', () => {
  it.each([
    ['npx vitest run tests/unit/a.test.ts', 'fast'],
    [`npx vitest run ${files(FAST_TEST_FILES)}`, 'fast'],
    [`npx vitest run ${files(FAST_TEST_FILES + 1)}`, 'heavy'],
    ['npx vitest run tests/unit', 'heavy'],
    ['npx vitest run -t "some name"', 'heavy'],
    ['npx vitest run', 'heavy'],
    ['vitest related --run src/a.ts', 'heavy'], // no count, no proof
    ['npx vitest run tests/unit/*.test.ts', 'heavy'],
    ['npx vitest related src/lib/*.ts --run', 'heavy'],
    ['npx tsc --noEmit & npm run build', 'heavy'],
    ['node scripts/verify/look.mjs / & npm run build', 'heavy'],
    ['npx tsc --noEmit 2>&1 | tail -3', 'fast'],
    ['npx tsc --noEmit -p tsconfig.json', 'fast'],
    ['node scripts/verify/look.mjs /chat --expect hi', 'fast'],
    ['node scripts/verify/look.mjs /chat --build', 'heavy'],
    ['node scripts/verify/chat-compact.mjs', 'heavy'],
    ['npm run build', 'heavy'],
    ['npx tsc --noEmit && npx vitest run tests/unit/a.test.ts', 'fast'],
    ['cd dashboard && npx tsc --noEmit | tail -5', 'fast'],
    ['node scripts/verify/look.mjs /; npm run build', 'heavy'],
    ['npx tsc --noEmit; sleep 900', 'heavy'],
    ['sleep 900', 'heavy'],
  ])('%s → %s', (command, line) => {
    expect(queueOf(command).line).toBe(line);
  });

  it('a related run goes by how many tests reach it, never by how many files it names', () => {
    const command = 'vitest related --run --maxWorkers=2 --reporter=json --outputFile=/x/o.json src/a.ts src/b.ts';
    expect(queueOf(command, {}, () => FAST_TEST_FILES).line).toBe('fast');
    expect(queueOf(command, {}, () => FAST_TEST_FILES + 1).line).toBe('heavy');
    expect(queueOf(command, {}, () => null).line).toBe('heavy');
  });

  it('reads through a package script', () => {
    expect(queueOf('npm run test -- tests/unit/a.test.ts', { test: 'vitest run' }).line).toBe('fast');
    expect(queueOf('npm test', { test: 'vitest run' }).line).toBe('heavy');
  });

  it('sizes the heavy line: a check, then a glance, then a build, a script, a suite', () => {
    const sizes = ['npx tsc --noEmit', 'node scripts/verify/look.mjs /', 'npm run build', 'node scripts/verify/x.mjs', 'npx vitest run'].map((c) => queueOf(c).size);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    expect(new Set(sizes).size).toBe(5);
  });
});

describe('safeLabel', () => {
  it('names the step or the program and carries no argument', () => {
    expect(safeLabel('API_KEY=sk-FAKE npx vitest run tests/a.test.ts --token=abc && npx tsc')).toBe('tests + tsc');
    expect(safeLabel('node scripts/verify/look.mjs /x')).toBe('look');
    expect(safeLabel("bash -c 'sleep 75'")).toBe('a check');
  });

  it.each([
    'export TOKEN=sk-FAKE && npx vitest run tests/a.test.ts',
    'TOKEN=sk-FAKE; npx tsc',
    'env TOKEN=sk-FAKE npx foo',
    'node s.mjs --password sk-FAKE',
    'npx x --token="sk-FAKE b"',
    'curl -H "Authorization: Bearer sk-FAKE" https://u:sk-FAKE@h/x',
    'npx jest --config={"key":"sk-FAKE"}',
    'curl --token \\\n sk-FAKE',
    'foo --pw=ab\\;sk-FAKE',
    'cat <<1EOF\nsk-FAKE\n1EOF',
  ])('no secret survives: %s', (command) => {
    expect(safeLabel(command)).not.toContain('sk-FAKE');
  });
});

describe('countRelatedTests', () => {
  let repo: string;
  const put = (p: string, text: string) => { mkdirSync(dirname(join(repo, p)), { recursive: true }); writeFileSync(join(repo, p), text); };
  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'dc-related-')));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    put('src/leaf.ts', 'export const a = 1;\n');
    put('src/mid.ts', "export { a } from './leaf.js';\n");
    put('src/alone.ts', 'export const b = 1;\n');
    put('tests/mid.test.ts', "import { a } from '../src/mid.js';\n");
    put('tests/leaf.test.ts', "import { a } from '../src/leaf.js';\n");
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  it('follows imports to the tests, stops past the cap, and an unknown file is no count', () => {
    expect(countRelatedTests(repo, ['src/leaf.ts'])).toBe(2);
    expect(countRelatedTests(repo, ['src/mid.ts'])).toBe(1);
    expect(countRelatedTests(repo, ['src/alone.ts'])).toBe(0);
    expect(countRelatedTests(repo, ['src/leaf.ts'], 1)).toBe(2);
    expect(countRelatedTests(repo, ['src/nope.ts'])).toBeNull();
    expect(countRelatedTests(tmpdir(), ['x.ts'])).toBeNull();
  });

  it('names a source the way git ls-files does, on Windows too (git prints D:/a/repo)', () => {
    expect(repoRelativeSource('D:/a/repo', 'D:\\a\\repo', 'src\\leaf.ts', win32)).toBe('src/leaf.ts');
    expect(repoRelativeSource('D:/a/repo', 'D:\\a\\repo\\src', 'leaf.ts', win32)).toBe('src/leaf.ts');
    expect(repoRelativeSource('D:/a/repo', 'C:\\x', 'D:\\a\\repo\\src\\leaf.ts', win32)).toBe('src/leaf.ts');
    expect(repoRelativeSource('D:/a/repo', 'D:\\a\\repo', 'E:\\other\\x.ts', win32)).toBeNull();
    expect(repoRelativeSource('D:/a/repo', 'D:\\a\\repo', '..\\x.ts', win32)).toBeNull();
    expect(repoRelativeSource('/r', '/r', 'src/leaf.ts', posix)).toBe('src/leaf.ts');
    expect(repoRelativeSource('/r', '/elsewhere', '/r/src/leaf.ts', posix)).toBe('src/leaf.ts');
  });
});

describe('fastSlotLimit', () => {
  it('stays bounded, narrows under load, and gives way to the heat rule', () => {
    expect(fastSlotLimit(2, false)).toBe(2);
    expect(fastSlotLimit(2, true)).toBe(1);
    expect(fastSlotLimit(1, false)).toBe(0);
  });
});

describe('the line', () => {
  const t = (key: string, size: number, at: number): Ticket => ({ key, pid: process.pid, at, seen: at, size, label: key });
  const NOW = 10 * QUEUE_AGE_MS;

  it('smaller first, then first to ask', () => {
    const line = ordered([t('suite', 5, NOW - 2000), t('late-check', 1, NOW - 100), t('check', 1, NOW - 200)], NOW);
    expect(line.map((x) => x.key)).toEqual(['check', 'late-check', 'suite']);
  });

  it('nobody starves: past the age a big job outranks every small one', () => {
    const line = ordered([t('check', 1, NOW - 100), t('old-suite', 5, NOW - QUEUE_AGE_MS)], NOW);
    expect(line[0].key).toBe('old-suite');
  });

  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dc-queue-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('a parked ticket keeps its age and blocks nobody; the same job takes the place back', () => {
    writeFileSync(join(dir, 'gone.json'), JSON.stringify({ ...t('gone', 1, NOW - 5000), pid: 2_147_483_000 }));
    const mine = QueuePlace.enter(dir, { key: 'mine', size: 5, label: 'mine' }, NOW);
    expect(mine.spot(NOW).position).toBe(1); // the dead waiter's ticket is parked, not ahead
    const back = QueuePlace.enter(dir, { key: 'gone', size: 1, label: 'gone' }, NOW);
    expect(readTickets(dir, NOW).find((x) => x.key === 'gone')!.at).toBe(NOW - 5000);
    expect(back.spot(NOW).position).toBe(1);
    expect(mine.spot(NOW).ahead.map((x) => x.key)).toEqual(['gone']);
  });

  it('a place is not kept for ever', () => {
    writeFileSync(join(dir, 'gone.json'), JSON.stringify({ ...t('gone', 1, NOW - 5000), pid: 2_147_483_000 }));
    expect(readTickets(dir, NOW - 5000 + QUEUE_KEEP_MS).map((x) => x.key)).toEqual(['gone']);
    expect(readTickets(dir, NOW - 5000 + QUEUE_KEEP_MS + 1)).toEqual([]);
  });

  it('a torn ticket is dropped and no ticket at all reads as first in line', () => {
    writeFileSync(join(dir, 'torn.json'), '{');
    expect(readTickets(dir, NOW)).toEqual([]);
    expect(QueuePlace.enter(join(dir, 'x'), { key: 'k', size: 1, label: 'k' }, NOW).myTurn(NOW)).toBe(true);
  });

  it('jobKey is per checkout and command', () => {
    expect(jobKey('/a', 'x')).toBe(jobKey('/a', 'x'));
    expect(jobKey('/a', 'x')).not.toBe(jobKey('/b', 'x'));
  });
});

describe('builder heavy in two lines', () => {
  let root: string;
  let slots: string;
  let err: string[];
  let limit: number;
  const deps = (): BuilderDeps => ({
    cwd: () => root, print: () => {}, printErr: (l) => err.push(l), ps: () => '', kill: () => {},
    heavySlotDir: () => slots, heavyLimit: async () => limit, machineBusy: () => false,
  });
  const lock = () => heavyLockPath(root);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dc-lines-'));
    slots = join(root, 'heavy');
    err = [];
    limit = 2;
  });
  afterEach(() => {
    releaseFileLock(lock());
    for (const p of [...fastSlotPaths(slots), ...heavySlotPaths(slots)]) releaseFileLock(p);
    rmSync(root, { recursive: true, force: true });
  });

  /** A runnable stand-in for a one-file test: `npx` resolves nothing, so run a shim named vitest. */
  const shim = () => {
    writeFileSync(join(root, 'vitest'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    return `PATH=${root}:$PATH vitest run tests/unit/a.test.ts`;
  };

  it('a short check runs while the heavy lock is held', async () => {
    expect(acquireFileLock(lock(), Date.now(), 5_000)).toBe(true);
    expect(await builderHeavy(deps(), [shim()], { maxWait: '0' })).toBe(0);
    expect(err.join('\n')).toMatch(/fast line/);
  });

  it('while very hot it takes the one heavy line, and so waits', async () => {
    limit = 1;
    expect(acquireFileLock(heavySlotPaths(slots)[0], Date.now(), 5_000)).toBe(true);
    expect(await builderHeavy(deps(), [shim()], { maxWait: '0' })).toBe(75);
  });

  it('very hot: a heavy step does not start beside a running short check', async () => {
    expect(acquireFileLock(fastSlotPaths(slots)[0], Date.now(), 5_000)).toBe(true);
    expect(await acquireHeavy(root, { waitMs: 0, slotDir: slots, repoLock: lock(), limit: async () => 1, pollMs: 5 })).toBeNull();
    const hold = await acquireHeavy(root, { waitMs: 0, slotDir: slots, repoLock: lock(), limit: async () => 2, pollMs: 5 });
    expect(hold).not.toBeNull();
    hold!.release();
  });

  it('fast slots are bounded: both taken, the third waits, runs nothing, and its place is kept', async () => {
    for (const p of fastSlotPaths(slots)) expect(acquireFileLock(p, Date.now(), 5_000)).toBe(true);
    expect(await builderHeavy(deps(), [shim()], { maxWait: '0' })).toBe(75);
    expect(err.join('\n')).toMatch(/all fast slots.*held by pid \d+.*NOTHING ran.*KEPT/);
  });

  it('a wait that runs out says who holds the lock and keeps the place', async () => {
    expect(acquireFileLock(lock(), Date.now(), 5_000)).toBe(true);
    const job = [process.execPath, '-e', 'process.exit(0)'];
    expect(await builderHeavy({ ...deps(), ps: () => `${process.pid} 1 0:01 the long script` }, job, { maxWait: '0' })).toBe(75);
    expect(err.join('\n')).toMatch(/held by pid \d+ \(the long script\).*NOTHING ran.*KEPT/);
    const dir = heavyQueueDir(lock());
    const [kept] = readTickets(dir, Date.now());
    expect(kept.label).toBe('a check');
    expect(await builderHeavy(deps(), job, { maxWait: '0' })).toBe(75);
    expect(readTickets(dir, Date.now())[0].at).toBe(kept.at);
    expect(queueReport(lock(), slots, () => '').join('\n')).toMatch(/heavy line: 1 waiting or parked/);
    releaseFileLock(lock());
    expect(await builderHeavy(deps(), job, { maxWait: '1' })).toBe(0);
    expect(readTickets(dir, Date.now())).toEqual([]);
  });

  it('the smaller job goes first when the lock frees', async () => {
    expect(acquireFileLock(lock(), Date.now(), 5_000)).toBe(true);
    const dir = heavyQueueDir(lock());
    const big = QueuePlace.enter(dir, { key: 'big', size: 5, label: 'big' }, Date.now());
    const small = QueuePlace.enter(dir, { key: 'small', size: 1, label: 'small' }, Date.now());
    expect(big.myTurn(Date.now())).toBe(false);
    expect(small.myTurn(Date.now())).toBe(true);
    small.leave();
    expect(big.myTurn(Date.now())).toBe(true);
  });
});
