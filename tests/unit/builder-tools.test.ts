import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  HEAVY_LOCK_BUSY_EXIT,
  classifyBuilderResult,
  findOrphanChecks,
  formatLoad,
  heavyLockPath,
  heavySpawnPlan,
  lastResultObject,
  machineLoad,
} from '../../src/lib/builder-tools.js';
import { acquireFileLock, releaseFileLock } from '../../src/lib/file-lock.js';
import { builderHeavy, builderLoad, builderReport, type BuilderDeps } from '../../src/cli/commands/builder.js';

/**
 * `dreamcontext builder load | heavy | report` — the tools behind the 2026-10-04 fix (see
 * src/lib/builder-tools.ts). The fixtures below are the shapes the real run produced: T4 and
 * T5 closed `subtype: success` with a "waiting" sentence instead of a report.
 */

const run = (o: Record<string, unknown>) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, ...o });

describe('classifyBuilderResult: did the builder finish?', () => {
  it('the 2026-10-04 T4 and T5 endings are unfinished, not done', () => {
    const t4 = classifyBuilderResult(run({ result: 'Waiting for the full unit suite to finish; the targeted suites (15 files, 499 tests) and root tsc are already green.' }), 'T4');
    const t5 = classifyBuilderResult(run({ result: "Type-checks are still running; I'll pick up when they report." }), 'T5');
    expect(t4.verdict).toBe('unfinished');
    expect(t5.verdict).toBe('unfinished');
    expect(t4.detail).toMatch(/^Waiting for the full unit suite/);
  });

  it('a report that opens with the sentinel is reported', () => {
    const r = classifyBuilderResult(run({ result: '## T4 report\n\nFiles changed:\n- a.ts\n\nChecks: npx tsc --noEmit exit 0' }), 'T4');
    expect(r).toEqual({ verdict: 'reported', detail: '## T4 report' });
  });

  it('leading blank lines and whitespace before the sentinel still count', () => {
    expect(classifyBuilderResult(run({ result: '\n\n   ## w2-A report\nfiles changed:\n- x.ts' }), 'w2-A').verdict).toBe('reported');
  });

  it('the sentinel must be the FIRST line, not buried in the body', () => {
    expect(classifyBuilderResult(run({ result: 'Done.\n## T4 report\n- a.ts' }), 'T4').verdict).toBe('unfinished');
  });

  it('another task\'s sentinel is not this one\'s (T1 vs T10)', () => {
    expect(classifyBuilderResult(run({ result: '## T10 report\n- a.ts' }), 'T1').verdict).toBe('unfinished');
    expect(classifyBuilderResult(run({ result: '## T1 report\n- a.ts' }), 'T10').verdict).toBe('unfinished');
  });

  it('a sentinel report that still ends on a promise is unfinished', () => {
    const r = classifyBuilderResult(run({ result: '## T4 report\n- a.ts\nType-checks are still running; I\'ll report when they finish.' }), 'T4');
    expect(r.verdict).toBe('unfinished');
  });

  it('a run that errored is stopped, with its subtype (usage limit, max turns)', () => {
    expect(classifyBuilderResult(run({ subtype: 'error_max_turns', is_error: true }), 'T4')).toEqual({ verdict: 'stopped', detail: 'error_max_turns' });
    const limit = classifyBuilderResult(run({ is_error: true, result: 'Claude AI usage limit reached|1759600000' }), 'T4');
    expect(limit.verdict).toBe('stopped');
    expect(limit.detail).toMatch(/usage limit/);
  });

  it('no file, an empty file or no result object is missing', () => {
    expect(classifyBuilderResult(null, 'T4').verdict).toBe('missing');
    expect(classifyBuilderResult('', 'T4').verdict).toBe('missing');
    expect(classifyBuilderResult('Error: spawn claude ENOENT\n', 'T4').verdict).toBe('missing');
  });

  it('a Develop log appended across resumes, stderr mixed in: the LAST result decides', () => {
    const log = [
      run({ result: 'Waiting for tsc.' }),
      'some stderr line',
      '{ not json either',
      run({ result: '## w1-A report\nfiles changed:\n- a.ts' }),
      '',
    ].join('\n');
    expect(lastResultObject(log)?.result).toMatch(/^## w1-A report/);
    expect(classifyBuilderResult(log, 'w1-A').verdict).toBe('reported');
  });
});

describe('machineLoad: locale-proof, from Node', () => {
  it('busy only when the 1-min load is above the core count', () => {
    expect(machineLoad({ loadavg: () => [11.65, 9, 8], cores: () => 8 })).toEqual({ cores: 8, load1: 11.65, busy: true });
    expect(machineLoad({ loadavg: () => [8, 9, 8], cores: () => 8 }).busy).toBe(false);
    expect(formatLoad({ cores: 8, load1: 3.414, busy: false })).toBe('cores 8 load1 3.41 quiet');
  });

  it('a machine reporting no cores is treated as one, not divided by zero', () => {
    expect(machineLoad({ loadavg: () => [0.5], cores: () => 0 })).toEqual({ cores: 1, load1: 0.5, busy: false });
  });
});

describe('findOrphanChecks: only this repo\'s parentless checkers', () => {
  const ROOT = '/Users/dev/projects/sample-app';
  const PS = [
    `  501     1   05:12 node ${ROOT}/node_modules/.bin/tsc --noEmit`,
    `  502     1   01:00 node ${ROOT}/dashboard/node_modules/.bin/tsc --noEmit`,
    `  503     1   02:00 node ${ROOT}/node_modules/.bin/vitest run tests/unit`,
    `  504   777   02:00 node ${ROOT}/node_modules/.bin/vitest run tests/unit`,       // live parent
    `  505     1   02:00 node /Users/dev/projects/other/node_modules/.bin/tsc`,       // other repo
    `  506     1   02:00 node ${ROOT}/node_modules/.bin/vite --port 5173`,            // a dev server
    `  507     1   02:00 node ${ROOT}-fork/node_modules/.bin/tsc --noEmit`,           // prefix-alike repo
    `  508     1   02:00 claude -p --resume abc --output-format json`,                // a builder
  ].join('\n');

  it('lists tsc and vitest under this repo whose parent is gone, nothing else', () => {
    expect(findOrphanChecks(PS, ROOT).map((o) => o.pid)).toEqual([501, 502, 503]);
    expect(findOrphanChecks(PS, `${ROOT}/`).map((o) => o.pid)).toEqual([501, 502, 503]);
  });
});

describe('heavySpawnPlan', () => {
  it('argv as given; one argument holding a whole line goes through the shell', () => {
    expect(heavySpawnPlan(['npx', 'tsc', '--noEmit'])).toEqual({ file: 'npx', args: ['tsc', '--noEmit'], shell: false });
    expect(heavySpawnPlan(['npx tsc --noEmit'])).toEqual({ file: 'npx tsc --noEmit', args: [], shell: true });
    expect(heavySpawnPlan([])).toBeNull();
  });
});

describe('builder commands (real processes, a scratch dir outside git)', () => {
  let dir: string;
  let out: string[];
  let err: string[];
  let deps: BuilderDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dc-builder-'));
    out = [];
    err = [];
    deps = { cwd: () => dir, print: (l) => out.push(l), printErr: (l) => err.push(l), ps: () => '', kill: () => {} };
  });
  afterEach(() => {
    releaseFileLock(heavyLockPath(dir, () => null));
    rmSync(dir, { recursive: true, force: true });
  });

  it('heavy runs the command and passes its exit code through', async () => {
    expect(await builderHeavy(deps, [process.execPath, '-e', 'process.exit(0)'], {})).toBe(0);
    expect(await builderHeavy(deps, [process.execPath, '-e', 'process.exit(4)'], {})).toBe(4);
  });

  it('heavy releases the lock when the command is done, even when it failed', async () => {
    await builderHeavy(deps, [process.execPath, '-e', 'process.exit(1)'], {});
    expect(existsSync(heavyLockPath(dir))).toBe(false);
  });

  it('two heavy checks take turns: the second starts only after the first ended', async () => {
    const stamp = join(dir, 'order.txt');
    const job = (tag: string) => [process.execPath, '-e',
      `const f=require('fs');f.appendFileSync(${JSON.stringify(stamp)},'${tag}-start\\n');setTimeout(()=>f.appendFileSync(${JSON.stringify(stamp)},'${tag}-end\\n'),400)`];
    const [a, b] = await Promise.all([builderHeavy(deps, job('a'), {}), builderHeavy(deps, job('b'), {})]);
    expect([a, b]).toEqual([0, 0]);
    const lines = readFileSync(stamp, 'utf-8').trim().split('\n') as string[];
    // never interleaved: X-start, X-end, Y-start, Y-end
    expect(lines[0].replace('-start', '')).toBe(lines[1].replace('-end', ''));
    expect(lines[2].replace('-start', '')).toBe(lines[3].replace('-end', ''));
  });

  it('a lock held by a live process past --max-wait exits 75 and runs NOTHING', async () => {
    const lock = heavyLockPath(dir);
    expect(acquireFileLock(lock, Date.now(), 5_000)).toBe(true); // held by THIS (live) process
    const marker = join(dir, 'ran.txt');
    const code = await builderHeavy(deps, [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'x')`], { maxWait: '0' });
    expect(code).toBe(HEAVY_LOCK_BUSY_EXIT);
    expect(existsSync(marker)).toBe(false);
    expect(err.join('\n')).toMatch(/NOTHING ran/);
  });

  it('a lock left by a dead process is reclaimed', async () => {
    const lock = heavyLockPath(dir);
    writeFileSync(lock, JSON.stringify({ pid: 2_147_483_000, at: Date.now() - 60_000 }));
    expect(await builderHeavy(deps, [process.execPath, '-e', 'process.exit(0)'], { maxWait: '2' })).toBe(0);
  });

  it('no command is a usage error, not a run', async () => {
    expect(await builderHeavy(deps, [], {})).toBe(2);
  });

  it('report prints the verdict line and exits 0 only when reported', () => {
    const f = join(dir, 'T5-r1.json');
    writeFileSync(f, run({ result: "Type-checks are still running; I'll pick up when they report." }));
    expect(builderReport(deps, f, 'T5')).toBe(3);
    writeFileSync(f, run({ result: '## T5 report\n- b.ts' }));
    expect(builderReport(deps, f, 'T5')).toBe(0);
    expect(out).toEqual([
      "T5 unfinished: Type-checks are still running; I'll pick up when they report.",
      'T5 reported: ## T5 report',
    ]);
    expect(builderReport(deps, join(dir, 'absent.json'), 'T5')).toBe(3);
    expect(builderReport(deps, f, 'T5; rm -rf /')).toBe(3);
  });

  it('load prints the load line, lists orphans, and reaps them only with --reap', () => {
    const killed: number[] = [];
    const ps = `  901     1   03:00 node ${dir}/node_modules/.bin/tsc --noEmit`;
    builderLoad({ ...deps, ps: () => ps, kill: (pid) => { killed.push(pid); } }, {});
    expect(out[0]).toMatch(/^cores \d+ load1 \d+\.\d\d (busy|quiet)$/);
    expect(out[1]).toMatch(/^orphan pid 901 up 03:00 /);
    expect(killed).toEqual([]);
    out.length = 0;
    builderLoad({ ...deps, ps: () => ps, kill: (pid) => { killed.push(pid); } }, { reap: true });
    expect(out[1]).toMatch(/^reaped pid 901 /);
    expect(killed).toEqual([901]);
  });
});
