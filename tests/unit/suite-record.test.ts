import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { builderHeavy, HEAVY_BUILD_FIRST_EXIT, type BuilderDeps } from '../../src/cli/commands/builder.js';
import { builderTest, DEFAULT_SESSION_DEPS, type SessionDeps } from '../../src/cli/commands/builder-sessions.js';
import { HEAVY_LOCK_BUSY_EXIT, heavyLockPath, heavySlotPaths } from '../../src/lib/builder-tools.js';
import { contentTree } from '../../src/lib/check-receipt.js';
import { releaseFileLock } from '../../src/lib/file-lock.js';
import { HEAVY_OVER_BUDGET_EXIT, heavyStep, markPhase, suiteInCommand, wholeSuiteArgs } from '../../src/lib/run-budget.js';
import {
  branchOf, cliSpawnTests, distCheck, distProof, distProofHeld, judgeSuiteRun, parseVitestLog, pinTree, readSuiteRecord, suiteRecordId, writeSuiteRecord, type RunSummary,
} from '../../src/lib/suite-record.js';

/**
 * The suite record (task bir-is-tam-test-takimini-bir-kez-kosar…, plan §3 C1-C3, 2026-11-08): a
 * whole-suite run keeps its red files, a fix reruns only them, and NOTHING becomes green by
 * absence. Real git repos and real child processes; the logs are vitest 4's default reporter.
 */

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' }).trim();
const commit = (cwd: string, msg: string) => { git(cwd, 'add', '-A'); git(cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', msg); };

const SEP = '⎯⎯⎯⎯⎯⎯⎯';
/** A vitest 4 default-reporter log, as the real one prints it (captured 2026-11-08). */
function vitestLog(o: { tests?: [string, string][]; suites?: string[]; errorFrom?: string[]; passed?: number; own?: string }): string {
  const tests = o.tests ?? [];
  const suites = o.suites ?? [];
  const errs = o.errorFrom ?? [];
  const failedFiles = new Set([...tests.map((t) => t[0]), ...suites]).size;
  const passed = o.passed ?? 3;
  const out: string[] = [];
  if (o.own) out.push(`stdout | ${tests[0]?.[0] ?? 'tests/x.test.ts'} > one`, o.own, '');
  for (const t of tests) out.push(` ❯ ${t[0]} (2 tests | 1 failed) 12ms`, `   × ${t[1]} 3ms`);
  if (suites.length) {
    out.push('', `${SEP} Failed Suites ${suites.length} ${SEP}`, '');
    for (const s of suites) out.push(` FAIL  ${s} [ ${s} ]`, "Error: Cannot find module './missing-module'", ` ❯ ${s}:1:1`, '', `${SEP}${SEP}[1/1]⎯`, '');
  }
  if (tests.length) {
    out.push('', `${SEP} Failed Tests ${tests.length} ${SEP}`, '');
    tests.forEach((t, i) => out.push(` FAIL  ${t[0]} > ${t[1]}`, 'AssertionError: expected 1 to be 2 // Object.is equality', '', '- Expected', '+ Received', '', '    FAIL  not-a-header-because-indented.test.ts', ` ❯ ${t[0]}:2:63`, '', `${SEP}${SEP}[${i + 1}/${tests.length}]⎯`, ''));
  }
  if (errs.length) {
    out.push(`${SEP} Unhandled Errors ${SEP}`, '', `Vitest caught ${errs.length} unhandled error during the test run.`);
    for (const e of errs) out.push(`${SEP} Unhandled Rejection ${SEP}`, 'Error: boom unhandled', ` ❯ ${e}:2:34`, '', `This error originated in "${e}" test file. It doesn't mean the error was thrown inside the file itself, but while it was running.`);
  }
  out.push('', '');
  out.push(` Test Files  ${failedFiles ? `${failedFiles} failed | ` : ''}${passed} passed (${failedFiles + passed})`);
  out.push(`      Tests  ${tests.length ? `${tests.length} failed | ` : ''}${passed * 2} passed (${tests.length + passed * 2})`);
  if (errs.length) out.push(`     Errors  ${errs.length} error${errs.length > 1 ? 's' : ''}`);
  out.push('   Start at  20:55:41', '   Duration  261ms (transform 44ms, setup 0ms)');
  return out.join('\n');
}

const RED2 = vitestLog({ tests: [['tests/a.test.ts', 'one'], ['tests/b.test.ts', 'grp > two']], own: 'FAIL fake.test.ts' });
const GREEN = vitestLog({});

describe('judgeSuiteRun: green only on positive proof', () => {
  const judge = (log: string, exit: number | null, extra: Partial<Parameters<typeof judgeSuiteRun>[0]> = {}) =>
    judgeSuiteRun({ exit, exitNotOwned: null, summary: parseVitestLog(log), ...extra });

  it('reads the red list from the Failed Tests / Failed Suites blocks only', () => {
    const s = parseVitestLog(RED2);
    expect(s.listed).toEqual(['tests/a.test.ts', 'tests/b.test.ts']);
    expect(s.listed).not.toContain('fake.test.ts');
    expect(s.failedFiles).toBe(2);
    expect(judge(RED2, 1)).toMatchObject({ state: 'red', files: ['tests/a.test.ts', 'tests/b.test.ts'] });
    // An import error is a Failed Suites entry and is listed.
    const suite = vitestLog({ tests: [['tests/a.test.ts', 'one']], suites: ['tests/c.test.ts'] });
    expect(judge(suite, 1)).toMatchObject({ state: 'red', files: ['tests/a.test.ts', 'tests/c.test.ts'] });
    // ANSI colour does not change it.
    expect(parseVitestLog(RED2.split(' FAIL  ').join('\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m ')).listed).toEqual(['tests/a.test.ts', 'tests/b.test.ts']);
  });

  it('table: every gap is incomplete, never green', () => {
    expect(judge(GREEN, 0).state).toBe('green');
    // killed at the ceiling, or never ended
    expect(judge(GREEN, 0, { killed: 'ceiling' }).state).toBe('incomplete');
    expect(judge(GREEN.split('\n').slice(0, 2).join('\n'), null).state).toBe('incomplete');
    // all tests pass, exit 1 on an unhandled rejection
    expect(judge(vitestLog({ errorFrom: ['tests/d.test.ts'] }), 1).state).toBe('incomplete');
    // 2 red files plus an Errors line from an unlisted file
    const withErr = vitestLog({ tests: [['tests/a.test.ts', 'one'], ['tests/b.test.ts', 'two']], errorFrom: ['tests/d.test.ts'] });
    expect(judge(withErr, 1)).toMatchObject({ state: 'incomplete' });
    // ...but an error from a listed file keeps the red
    expect(judge(vitestLog({ tests: [['tests/a.test.ts', 'one']], errorFrom: ['tests/a.test.ts'] }), 1).state).toBe('red');
    // all passing behind `| tee`: the exit is tee's
    expect(judge(GREEN, 0, { exitNotOwned: 'a pipe' })).toMatchObject({ state: 'incomplete', reason: expect.stringMatching(/without \| tee/) });
    // two reds behind `| tee` are still proven red
    expect(judge(RED2, 0, { exitNotOwned: 'a pipe' }).state).toBe('red');
    // no summary, a short list, a stale build, exit 1 with a clean summary
    expect(judge('some output\nKilled', 137).state).toBe('incomplete');
    expect(judge(RED2.replace(' Test Files  2 failed', ' Test Files  3 failed'), 1).state).toBe('incomplete');
    expect(judge(GREEN, 0, { dist: { ok: false, why: 'stale' } }).state).toBe('incomplete');
    expect(judge(GREEN, 1).state).toBe('incomplete');
    // a required file that ran nothing keeps the record red
    const clean: RunSummary = { found: true, failedFiles: 0, failedTests: 0, errors: 0, failedSuites: false, listed: [], errorOrigins: [] };
    expect(judgeSuiteRun({ exit: 0, exitNotOwned: null, summary: clean, missing: ['tests/gone.test.ts'] })).toMatchObject({ state: 'red', files: ['tests/gone.test.ts'] });
  });
});

describe('builder heavy keeps a suite record; builder test --failed reruns only it', () => {
  let root: string;
  let repo: string;
  let slots: string;
  let out: string[];
  let err: string[];
  const deps = (cwd = repo): BuilderDeps => ({
    cwd: () => cwd, print: (l) => out.push(l), printErr: (l) => err.push(l), ps: () => '', kill: () => {},
    heavySlotDir: () => slots, heavyLimit: async () => 2, machineBusy: () => false,
  });
  const scenario = (s: string) => writeFileSync(join(root, 'scenario.txt'), s);
  const record = (cwd = repo, target = 'suite') => readSuiteRecord(realpathSync(cwd), branchOf(realpathSync(cwd)), target).record;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'dc-suite-')));
    repo = join(root, 'repo');
    slots = join(root, 'slots');
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'tests'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\ndist/\n');
    writeFileSync(join(repo, 'package.json'), `${JSON.stringify({ name: 'demo-app', version: '1.0.0', scripts: { test: 'node suite.mjs' } }, null, 2)}\n`);
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'tests/a.test.ts'), "import { a } from '../src/a';\n");
    writeFileSync(join(repo, 'tests/b.test.ts'), '// b\n');
    // The "suite" prints a canned vitest log picked by ../scenario.txt (outside the repo, so the tree holds still).
    writeFileSync(join(root, 'red2.log'), RED2);
    writeFileSync(join(root, 'green.log'), GREEN);
    writeFileSync(join(root, 'unhandled.log'), vitestLog({ errorFrom: ['tests/d.test.ts'] }));
    writeFileSync(join(repo, 'suite.mjs'), [
      "import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';",
      "import { spawn } from 'node:child_process';",
      "const s = readFileSync('../scenario.txt', 'utf-8').trim();",
      "appendFileSync('../runs.txt', s + '\\n');",
      "if (s === 'sleep') { const kids = [spawn('sleep', ['30']), spawn('sleep', ['30'])]; writeFileSync('../pids.txt', kids.map((k) => k.pid).join('\\n')); setTimeout(() => {}, 60_000); }",
      "else { process.stdout.write(readFileSync('../' + s + '.log', 'utf-8') + '\\n'); process.exit(s === 'green' ? 0 : 1); }",
    ].join('\n'));
    commit(repo, 'init');
    out = []; err = [];
  });
  afterEach(() => {
    for (const p of heavySlotPaths(slots)) releaseFileLock(p);
    releaseFileLock(heavyLockPath(repo));
    rmSync(root, { recursive: true, force: true });
  });
  const runs = () => (existsSync(join(root, 'runs.txt')) ? readFileSync(join(root, 'runs.txt'), 'utf-8').split('\n').filter(Boolean).length : 0);

  it('AC1: a red run with --tail 5 ends its output with the red file list and keeps a red record and its log', async () => {
    scenario('red2');
    expect(await builderHeavy(deps(), ['npm', 'test'], { tail: '5' })).toBe(1);
    expect(out.slice(-2)).toEqual(['  red: tests/a.test.ts', '  red: tests/b.test.ts']);
    const r = record()!;
    expect(r).toMatchObject({ state: 'red', files: ['tests/a.test.ts', 'tests/b.test.ts'], target: 'suite' });
    expect(readFileSync(r.log!, 'utf-8')).toContain('Failed Tests 2');
    expect(git(repo, 'rev-parse', `refs/dc-suite/${r.id}/red`)).toBe(r.redTree);
  });

  it('AC4: while red, a second full run exits 77 with no phase open and prints a line that runs; --because works once', async () => {
    scenario('red2');
    expect(await builderHeavy(deps(), ['npm', 'test'], {})).toBe(1);
    err = [];
    expect(await builderHeavy(deps(), ['npm', 'test'], { fresh: true })).toBe(HEAVY_OVER_BUDGET_EXIT);
    expect(runs()).toBe(1);
    expect(err.join('\n')).toContain('  dreamcontext builder test --failed');
    // The same with a phase open (a Develop run) and on a release branch.
    markPhase(repo, 'w1', 'task', Date.now());
    expect(await builderHeavy(deps(), ['npm', 'test'], {})).toBe(HEAVY_OVER_BUDGET_EXIT);
    // The printed line, run as printed (stubbed runner: everything passes), exits 0, 1 or 5.
    const code = await builderTest(sessionDeps(repo, () => 'pass'), undefined, { failed: true });
    expect([0, 1, 5]).toContain(code);
    // A second red, then the way out once, then refused again.
    scenario('red2');
    git(repo, 'checkout', '-q', '-b', 'release/9.9.9');
    expect(await builderHeavy(deps(), ['npm', 'test'], {})).toBe(1);
    expect(await builderHeavy(deps(), ['npm', 'test'], { because: 'the owner asked for a clean second run' })).toBe(1);
    err = [];
    expect(await builderHeavy(deps(), ['npm', 'test'], { because: 'and another one, please' })).toBe(HEAVY_OVER_BUDGET_EXIT);
    expect(err.join('\n')).toMatch(/already spent its one --because/);
  });

  it('AC4: incomplete and closed green do not refuse; two cuts in a row on one branch both start', async () => {
    scenario('unhandled');
    expect(await builderHeavy(deps(), ['npm', 'test'], {})).toBe(1);
    expect(record()!.state).toBe('incomplete');
    scenario('green');
    expect(await builderHeavy(deps(), ['npm', 'test'], {})).toBe(0);
    expect(record()!.state).toBe('green');
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2;\n');
    commit(repo, 'next cut');
    expect(await builderHeavy(deps(), ['npm', 'test'], {})).toBe(0);
    expect(runs()).toBe(3);
  });

  it('AC2: | tee with 2 reds is red, all passing behind | tee is incomplete; --failed on incomplete exits 3', async () => {
    scenario('red2');
    expect(await builderHeavy(deps(), ['npm test | tee ../tee.txt'], {})).toBe(0);
    expect(record()!.state).toBe('red');
    rmSync(join(realpathSync(join(repo, '.git')), 'dc-receipts'), { recursive: true, force: true });
    scenario('green');
    expect(await builderHeavy(deps(), ['npm test | tee ../tee.txt'], {})).toBe(0);
    expect(record()).toMatchObject({ state: 'incomplete', reason: expect.stringMatching(/without \| tee/) });
    expect(await builderTest(sessionDeps(repo, () => 'pass'), undefined, { failed: true })).toBe(3);
  });

  it('AC2 + AC7: the ceiling kills the whole group from ran time, frees the slot, records it; two in a row refuse the next', async () => {
    scenario('sleep');
    const t0 = Date.now();
    expect(await builderHeavy(deps(), ['npm', 'test'], { maxRun: String(1.5 / 60) })).not.toBe(0);
    expect(Date.now() - t0).toBeLessThan(10_000);
    const kids = readFileSync(join(root, 'pids.txt'), 'utf-8').split('\n').map(Number);
    await new Promise((r) => setTimeout(r, 300));
    for (const pid of kids) expect(() => process.kill(pid, 0)).toThrow();
    expect(heavySlotPaths(slots).filter((p) => existsSync(p))).toHaveLength(0);
    const ledger = readFileSync(join(realpathSync(join(repo, '.git')), 'dc-run-ledger.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(ledger.at(-1)).toMatchObject({ type: 'check', exit: null, reason: 'ceiling', branch: 'main', toplevel: realpathSync(repo) });
    expect(record()).toMatchObject({ state: 'incomplete', ceilingStreak: 1 });
    expect(await builderHeavy(deps(), ['npm', 'test'], { maxRun: String(1.5 / 60) })).not.toBe(0);
    expect(record()).toMatchObject({ state: 'incomplete', ceilingStreak: 2 });
    expect(await builderHeavy(deps(), ['npm', 'test'], { maxRun: String(1.5 / 60) })).toBe(HEAVY_OVER_BUDGET_EXIT);
    expect(runs()).toBe(2);
  }, 30_000);

  it('a partial run (--shard, --bail) writes no record and cannot close one; a suite in a chain is refused', async () => {
    scenario('green');
    expect(await builderHeavy(deps(), ['npm', 'test', '--', '--shard=1/2'], {})).toBe(0);
    expect(record()).toBeNull();
    expect(err.join('\n')).toMatch(/not provably the whole suite \(--shard=1\/2\)/);
    // From a subfolder, or through a cd, it is not the repo's whole suite either.
    mkdirSync(join(repo, 'sub'), { recursive: true });
    expect(await builderHeavy(deps(join(repo, 'sub')), ['npm', 'test'], {})).toBe(0);
    expect(await builderHeavy(deps(), ['cd sub && npm test'], {})).toBe(0);
    expect(record()).toBeNull();
    scenario('red2');
    expect(await builderHeavy(deps(), ['npm', 'test'], {})).toBe(1);
    scenario('green');
    // Gated like a whole run while red, and it never turns the red green.
    expect(await builderHeavy(deps(), ['npm', 'test', '--', '--bail=1'], {})).toBe(HEAVY_OVER_BUDGET_EXIT);
    expect(record()!.state).toBe('red');
    err = [];
    expect(await builderHeavy(deps(), ['npm run build --if-present && npm test'], {})).toBe(2);
    expect(await builderHeavy(deps(), ['npm run build --if-present && npm test'], { detach: true })).toBe(2);
    expect(err.join('\n')).toMatch(/a full test suite inside a chain/);
    expect(runs()).toBe(4);
  });

  it('only allow-listed arguments make a whole suite; deny by default', () => {
    for (const whole of ['npx vitest run', 'npx vitest run --reporter=json --outputFile out.json --maxWorkers=2', 'npx vitest run -c vitest.t3.config.ts', 'npm test -- --run --no-file-parallelism --testTimeout=30000']) {
      expect(heavyStep(whole), whole).toMatchObject({ kind: 'suite' });
      expect(heavyStep(whole)!.partial, whole).toBeUndefined();
    }
    for (const [cmd, why] of [['npx vitest run --dir tests/unit', '--dir'], ['npm test -- --dir tests/integration', '--dir'], ['npx vitest run --root packages/api', '--root'], ['npx vitest run --shard 1/4', '--shard'], ['npx vitest run --bail 1', '--bail'], ['npx vitest run --project web', '--project'], ['npx vitest run -c ../other.config.ts', '-c ../other.config.ts'], ['npx vitest run --changed', '--changed']] as const) {
      expect(heavyStep(cmd), cmd).toMatchObject({ kind: 'suite', partial: why });
    }
    expect(wholeSuiteArgs('run --reporter dot')).toBeNull();
    // A suite chained inside the scripts a script runs is still found.
    expect(suiteInCommand('npm run ci', { ci: 'npm run build && npm run test:unit', build: 'tsup', 'test:unit': 'vitest run' })).toMatchObject({ kind: 'suite' });
  });

  it('a run past a red (--because) that dies keeps the red list (one view for every reader)', () => {
    const top = realpathSync(repo);
    const tree = contentTree(top)!;
    writeSuiteRecord({ v: 1, id: suiteRecordId(top, 'main', 'suite'), state: 'running', pid: 2_147_483_000, toplevel: top, branch: 'main', target: 'suite', at: new Date().toISOString(), maxRunMs: 60_000, files: ['tests/a.test.ts'], overRed: { redTree: tree, because: 'the owner asked for one more run' } });
    expect(record()).toMatchObject({ state: 'red', files: ['tests/a.test.ts'], redTree: tree });
    writeSuiteRecord({ v: 1, id: suiteRecordId(top, 'main', 'suite'), state: 'running', pid: 2_147_483_000, toplevel: top, branch: 'main', target: 'suite', at: new Date().toISOString(), maxRunMs: 60_000, files: [] });
    expect(record()).toMatchObject({ state: 'incomplete', files: [] });
  });

  it('a run past a red (--because) that proves nothing keeps the red list', async () => {
    scenario('red2');
    expect(await builderHeavy(deps(), ['npm', 'test'], {})).toBe(1);
    scenario('unhandled');
    expect(await builderHeavy(deps(), ['npm', 'test'], { because: 'the owner asked for a second full run' })).toBe(1);
    expect(record()).toMatchObject({ state: 'red', files: ['tests/a.test.ts', 'tests/b.test.ts'], because: 'the owner asked for a second full run' });
  });

  it('a running record blocks a second start (75)', async () => {
    const top = realpathSync(repo);
    writeSuiteRecord({ v: 1, id: suiteRecordId(top, 'main', 'suite'), state: 'running', pid: process.pid, toplevel: top, branch: 'main', target: 'suite', at: new Date().toISOString(), maxRunMs: 60_000, files: [], checkId: 'habcdef12' });
    scenario('green');
    expect(await builderHeavy(deps(), ['npm', 'test'], {})).toBe(HEAVY_LOCK_BUSY_EXIT);
    expect(err.join('\n')).toContain('builder heavy --wait habcdef12');
    expect(runs()).toBe(0);
  });

  // ── --failed with no task, a stubbed test runner (it writes vitest's JSON report) ──
  const calls: string[][] = [];
  function sessionDeps(cwd: string, verdict: (file: string) => 'pass' | 'fail' | 'absent'): SessionDeps {
    return {
      ...DEFAULT_SESSION_DEPS, root: () => cwd, print: (l) => out.push(l), printErr: (l) => err.push(l),
      runCheck: async (argv, _cwd, log) => {
        calls.push(argv);
        const outFile = argv.find((a) => a.startsWith('--outputFile='))!.slice('--outputFile='.length);
        const files = argv.filter((a) => /\.(?:test\.)?ts$/.test(a) && !a.startsWith('-') && !a.includes('config'));
        const tests = argv[1] === 'related' ? ['tests/a.test.ts'] : files;
        const results = tests.filter((f) => verdict(f) !== 'absent').map((f) => ({
          name: join(cwd, f), status: verdict(f) === 'fail' ? 'failed' : 'passed',
          assertionResults: [{ fullName: 't', status: verdict(f) === 'fail' ? 'failed' : 'passed', failureMessages: verdict(f) === 'fail' ? ['boom'] : [] }],
        }));
        writeFileSync(outFile, JSON.stringify({ numTotalTests: results.length, testResults: results }));
        writeFileSync(log, '');
        return results.some((r) => r.status === 'failed') ? 1 : 0;
      },
    };
  }
  beforeEach(() => { calls.length = 0; });

  it('AC3: after a fix, --failed finds the record, reruns its files plus the importers of the fix, and closes it green (kept)', async () => {
    scenario('red2');
    expect(await builderHeavy(deps(), ['npm', 'test'], {})).toBe(1);
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 3;\n'); // the fix, no --related given
    expect(await builderTest(sessionDeps(repo, () => 'pass'), undefined, { failed: true })).toBe(0);
    expect(calls.find((c) => c[1] === 'related')).toEqual(expect.arrayContaining(['src/a.ts']));
    expect(calls.find((c) => c[1] === 'run')).toEqual(expect.arrayContaining(['tests/a.test.ts', 'tests/b.test.ts']));
    const r = record()!;
    expect(r).toMatchObject({ state: 'green', files: [] });
    expect(r.greenTree).toBe(contentTree(realpathSync(repo)));
    out = [];
    expect(await builderTest(sessionDeps(repo, () => 'pass'), undefined, { failed: true })).toBe(0);
    expect(out.join('\n')).toMatch(/nothing open since/);
  });

  it('AC3: a red file not on disk with no delete in git stays required, so the record stays red', async () => {
    scenario('red2');
    expect(await builderHeavy(deps(), ['npm', 'test'], {})).toBe(1);
    rmSync(join(repo, 'tests/b.test.ts'));
    git(repo, 'update-index', '--assume-unchanged', 'tests/b.test.ts');
    expect(await builderTest(sessionDeps(repo, (f) => (f === 'tests/b.test.ts' ? 'absent' : 'pass')), undefined, { failed: true })).toBe(1);
    expect(record()).toMatchObject({ state: 'red', files: ['tests/b.test.ts'] });
  });

  it('AC3: partly green rewrites the list; a file that ran no tests stays red', async () => {
    scenario('red2');
    expect(await builderHeavy(deps(), ['npm', 'test'], {})).toBe(1);
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 3;\n');
    expect(await builderTest(sessionDeps(repo, (f) => (f === 'tests/b.test.ts' ? 'fail' : 'pass')), undefined, { failed: true })).toBe(1);
    expect(record()).toMatchObject({ state: 'red', files: ['tests/b.test.ts'] });
    expect(await builderTest(sessionDeps(repo, (f) => (f === 'tests/b.test.ts' ? 'absent' : 'pass')), undefined, { failed: true })).toBe(1);
    expect(record()).toMatchObject({ state: 'red', files: ['tests/b.test.ts'] });
  });

  it('AC3: another worktree, another branch or another suite target is never read; a t3 red reruns with its own config', async () => {
    scenario('red2');
    expect(await builderHeavy(deps(), ['npm', 'test'], {})).toBe(1);
    const wt = join(root, 'wt2');
    git(repo, 'worktree', 'add', '-q', '-b', 'other', wt);
    expect(await builderTest(sessionDeps(wt, () => 'pass'), undefined, { failed: true })).toBe(3);
    expect(calls).toHaveLength(0);
    git(repo, 'checkout', '-q', '-b', 'side');
    expect(await builderTest(sessionDeps(repo, () => 'pass'), undefined, { failed: true })).toBe(3);
    // A t3-config red on this branch: rerun with -c, not dropped as missing.
    const top = realpathSync(repo);
    const tree = contentTree(top)!;
    const id = suiteRecordId(top, 'side', 'suite vitest.t3.config.ts');
    expect(pinTree(top, id, 'red', tree)).toBe(true);
    writeSuiteRecord({ v: 1, id, state: 'red', pid: 1, toplevel: top, branch: 'side', target: 'suite vitest.t3.config.ts', config: 'vitest.t3.config.ts', redTree: tree, at: new Date().toISOString(), files: ['tests/b.test.ts'] });
    expect(await builderTest(sessionDeps(repo, () => 'pass'), undefined, { failed: true })).toBe(0);
    expect(calls.at(-1)).toEqual(expect.arrayContaining(['-c', 'vitest.t3.config.ts', 'tests/b.test.ts']));
    expect(record(repo, 'suite vitest.t3.config.ts')!.state).toBe('green');
  });
});

describe('the build the CLI-spawn tests run (AC5)', () => {
  let root: string;
  let repo: string;
  let slots: string;
  let err: string[];
  const deps = (): BuilderDeps => ({
    cwd: () => repo, print: () => {}, printErr: (l) => err.push(l), ps: () => '', kill: () => {},
    heavySlotDir: () => slots, heavyLimit: async () => 2, machineBusy: () => false,
  });
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'dc-suite-dist-')));
    repo = join(root, 'repo');
    slots = join(root, 'slots');
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'tests'), { recursive: true });
    mkdirSync(join(repo, 'dashboard'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\ndist/\n');
    writeFileSync(join(repo, 'package.json'), `${JSON.stringify({ name: 'demo-app', version: '1.0.0', scripts: { test: 'node suite.mjs', build: 'node build.mjs', 'test:t3': 'vitest run -c vitest.t3.config.ts' } }, null, 2)}\n`);
    writeFileSync(join(repo, 'src/cli.mjs'), "console.log('cli');\n");
    writeFileSync(join(repo, 'build.mjs'), "import { mkdirSync, copyFileSync } from 'node:fs'; mkdirSync('dist', { recursive: true }); copyFileSync('src/cli.mjs', 'dist/index.js');\n");
    writeFileSync(join(repo, 'suite.mjs'), `process.stdout.write(${JSON.stringify(GREEN)});\n`);
    writeFileSync(join(repo, 'tests/cli.test.ts'), "import { spawnSync } from 'node:child_process';\nimport { join } from 'node:path';\nconst CLI = join(__dirname, '..', 'dist', 'index.js');\nspawnSync(process.execPath, [CLI]);\n");
    writeFileSync(join(repo, 'vitest.t3.config.ts'), "export default { test: { include: ['src/vendor/a.test.ts'] } };\n");
    commit(repo, 'init');
    err = [];
  });
  afterEach(() => {
    for (const p of heavySlotPaths(slots)) releaseFileLock(p);
    releaseFileLock(heavyLockPath(repo));
    rmSync(root, { recursive: true, force: true });
  });

  it('finds the CLI-spawn tests of this repo, however they start the CLI', () => {
    const here = cliSpawnTests(process.cwd());
    for (const f of ['tests/integration/cli-commands.test.ts', 'tests/unit/apps-do.test.ts', 'tests/unit/apps-routes.test.ts', 'tests/unit/hook-app-tools.test.ts']) expect(here).toContain(f);
    expect(cliSpawnTests(repo)).toEqual(['tests/cli.test.ts']);
    expect(cliSpawnTests(repo, 'vitest.t3.config.ts')).toEqual([]);
  });

  it('a full run refuses to start (5) on a dist not built from this code; a test-only edit needs no rebuild; a dashboard change does', async () => {
    expect(await builderHeavy(deps(), ['npm', 'test'], {})).toBe(HEAVY_BUILD_FIRST_EXIT);
    expect(err.join('\n')).toMatch(/build first/);
    expect(err.join('\n')).toContain('dreamcontext builder heavy -- npm run build');
    expect(await builderHeavy(deps(), ['npm', 'run', 'build'], {})).toBe(0);
    expect(distCheck(realpathSync(repo)).ok).toBe(true);
    writeFileSync(join(repo, 'tests/cli.test.ts'), `${readFileSync(join(repo, 'tests/cli.test.ts'), 'utf-8')}// more\n`);
    expect(distCheck(realpathSync(repo)).ok).toBe(true);
    expect(await builderHeavy(deps(), ['npm', 'test'], {})).toBe(0);
    writeFileSync(join(repo, 'dashboard/app.tsx'), 'export {};\n');
    expect(distCheck(realpathSync(repo))).toMatchObject({ ok: false, why: expect.stringContaining('dashboard/app.tsx') });
    // The rebuild the gate asks for is a new build, never a refused repeat, even inside a phase.
    markPhase(repo, 'w1', 'task', Date.now());
    writeFileSync(join(repo, 'src/cli.mjs'), "console.log('changed');\n");
    expect(await builderHeavy(deps(), ['npm', 'run', 'build'], {})).toBe(0);
    writeFileSync(join(repo, 'src/cli.mjs'), "console.log('changed again');\n");
    expect(await builderHeavy(deps(), ['npm', 'run', 'build'], {})).toBe(0);
    // Nothing changed since: that one is a repeat, and the phase limit holds.
    expect(await builderHeavy(deps(), ['npm', 'run', 'build'], { fresh: true })).toBe(HEAVY_OVER_BUDGET_EXIT);
  });

  it('the build is judged on the tree a run started from, and held to its bytes', async () => {
    expect(await builderHeavy(deps(), ['npm', 'run', 'build'], {})).toBe(0);
    const top = realpathSync(repo);
    const proof = distProof(top, contentTree(top));
    expect(proof.check.ok).toBe(true);
    // An edit made while the run goes is not what it tested: the verdict stands.
    writeFileSync(join(repo, 'src/cli.mjs'), "console.log('edited mid-run');\n");
    expect(distProofHeld(top, proof).ok).toBe(true);
    // A dist that changed under the run is no proof.
    writeFileSync(join(repo, 'dist/index.js'), '// rebuilt mid-run\n');
    expect(distProofHeld(top, proof)).toMatchObject({ ok: false, why: 'dist/ changed while the tests ran' });
  });

  it('no gate for the t3 target, nor for a repo with no build', async () => {
    const t3 = await builderHeavy(deps(), ['npm', 'run', 'test:t3'], {});
    expect(t3).not.toBe(HEAVY_BUILD_FIRST_EXIT);
    expect(err.join('\n')).not.toMatch(/build first/);
    writeFileSync(join(repo, 'package.json'), `${JSON.stringify({ name: 'demo-app', version: '1.0.0', scripts: { test: 'node suite.mjs' } }, null, 2)}\n`);
    expect(await builderHeavy(deps(), ['npm', 'test'], {})).toBe(0);
  });
});
