import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { builderTest, type SessionDeps } from '../../src/cli/commands/builder-sessions.js';
import { contentTree, distFingerprint, receiptsDir } from '../../src/lib/check-receipt.js';
import {
  nearestBaseRed, noteBaseRed, parseVitestFailedIds, seedDist, splitBaseRed, suiteRecordId, writeSuiteRecord,
} from '../../src/lib/suite-record.js';

/**
 * Audit OR-2: a failure already red on the base a branch grew from is printed as BASE-RED (not
 * yours) and never counted; a fresh worktree gets a sibling's green build of its code as dist/.
 * Real git repos; the test runner is stubbed (it writes vitest's JSON report).
 */

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' }).trim();
const commit = (cwd: string, msg: string) => { git(cwd, 'add', '-A'); git(cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', msg); };
const head = (cwd: string) => git(cwd, 'rev-parse', 'HEAD');
const headTree = (cwd: string) => git(cwd, 'rev-parse', 'HEAD^{tree}');

let repo: string;
beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'dc-base-red-')));
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ devDependencies: { vitest: '4' } }));
  mkdirSync(join(repo, 'src')); mkdirSync(join(repo, 'tests'));
  writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'tests/a.test.ts'), "import { a } from '../src/a';\nvoid a;\n");
  writeFileSync(join(repo, 'tests/b.test.ts'), "import { a } from '../src/a';\nvoid a;\n");
  commit(repo, 'base');
  // A job's branch, cut from the base: its reflog says "Created from", the fork point.
  git(repo, 'checkout', '-q', '-b', 'job');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

const f = (file: string, test: string | null | undefined, key = `${file} > ${test} :: boom`) => ({ file, test, key, message: 'boom' });

describe('the base-red record', () => {
  it('reads test ids off the Failed Tests and Failed Suites blocks only', () => {
    const SEP = '⎯⎯⎯⎯⎯⎯⎯';
    const log = [
      ` ❯ tests/a.test.ts (2 tests | 1 failed)`, '',
      `${SEP} Failed Suites 1 ${SEP}`, '', ' FAIL  tests/c.test.ts [ tests/c.test.ts ]', 'Error: no module', `${SEP}${SEP}[1/1]⎯`, '',
      `${SEP} Failed Tests 2 ${SEP}`, '', '\u001b[41m FAIL \u001b[49m tests/a.test.ts > grp > one', '    FAIL  indented.test.ts', `${SEP}${SEP}[1/2]⎯`,
      ' FAIL  tests/b.test.ts > two', '', ' Test Files  3 failed (3)', ' FAIL  tests/after.test.ts > x',
    ].join('\n');
    expect(parseVitestFailedIds(log)).toEqual([
      { file: 'tests/c.test.ts', test: null },
      { file: 'tests/a.test.ts', test: 'grp > one' },
      { file: 'tests/b.test.ts', test: 'two' },
    ]);
  });

  it('is written only for a clean commit; a red on uncommitted code proves nothing about a commit', () => {
    expect(noteBaseRed(repo, headTree(repo), [{ file: 'tests/a.test.ts', test: 'one' }])).toMatch(new RegExp(`${head(repo)}\\.json$`));
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2;\n');
    expect(noteBaseRed(repo, contentTree(repo)!, [])).toBeNull();
  });

  it('a red suite record on a clean commit writes its test ids, mapped onto the record files', () => {
    const log = join(repo, '..', `${repo.split('/').pop()}.log`);
    writeFileSync(log, ['⎯⎯ Failed Tests 1 ⎯⎯', ' FAIL  a.test.ts > grp > one', ' Test Files  2 failed (2)'].join('\n'));
    const id = suiteRecordId(repo, 'main', 'suite');
    writeSuiteRecord({ v: 1, id, state: 'red', pid: process.pid, toplevel: repo, branch: 'main', target: 'suite', at: new Date().toISOString(), files: ['tests/a.test.ts', 'tests/b.test.ts'], redTree: headTree(repo), log });
    rmSync(log, { force: true });
    expect(nearestBaseRed(repo)?.tests).toEqual([{ file: 'tests/a.test.ts', test: 'grp > one' }, { file: 'tests/b.test.ts', test: null }]);
  });

  it('a failure with the same test id, on a descendant, with the test file unchanged, is base-red', () => {
    noteBaseRed(repo, headTree(repo), [{ file: 'tests/a.test.ts', test: 'one' }, { file: 'tests/b.test.ts', test: null }]);
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2;\n');
    commit(repo, 'job');
    const s = splitBaseRed(repo, [f('tests/a.test.ts', 'one'), f('tests/a.test.ts', 'other'), f('tests/b.test.ts', null), f('tests/b.test.ts', 'x'), { file: 'src/a.ts', key: 'tsc TS2322 src/a.ts:1', message: '' }]);
    expect(s.baseRed.map((x) => x.key)).toEqual(['tests/a.test.ts > one :: boom', 'tests/b.test.ts > null :: boom']);
    expect(s.mine.map((x) => x.key)).toEqual(['tests/a.test.ts > other :: boom', 'tests/b.test.ts > x :: boom', 'tsc TS2322 src/a.ts:1']);
  });

  it('a test file changed since the base is the job\'s, even with the same id', () => {
    noteBaseRed(repo, headTree(repo), [{ file: 'tests/a.test.ts', test: 'one' }]);
    writeFileSync(join(repo, 'tests/a.test.ts'), '// edited\n');
    expect(splitBaseRed(repo, [f('tests/a.test.ts', 'one')]).baseRed).toEqual([]);
  });

  it('a commit that is not an ancestor never applies', () => {
    const base = head(repo);
    git(repo, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 3;\n');
    commit(repo, 'side');
    noteBaseRed(repo, headTree(repo), [{ file: 'tests/a.test.ts', test: 'one' }]);
    git(repo, 'checkout', '-q', base);
    expect(nearestBaseRed(repo)).toBeNull();
    expect(splitBaseRed(repo, [f('tests/a.test.ts', 'one')]).mine).toHaveLength(1);
  });

  it('expires on a green: a branch cut after a green cut reads the green, not the older red', () => {
    git(repo, 'checkout', '-q', 'main');
    noteBaseRed(repo, headTree(repo), [{ file: 'tests/a.test.ts', test: 'one' }]);
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 4;\n');
    commit(repo, 'the cut fixed it');
    noteBaseRed(repo, headTree(repo), []);
    git(repo, 'checkout', '-q', '-b', 'job-after-green');
    expect(nearestBaseRed(repo)?.sha).toBe(git(repo, 'rev-parse', 'main'));
    expect(splitBaseRed(repo, [f('tests/a.test.ts', 'one')]).baseRed).toEqual([]);
  });

  it('a branch that took in newer base code (merge, rebase) has no known base: nothing is base-red', () => {
    noteBaseRed(repo, headTree(repo), [{ file: 'tests/a.test.ts', test: 'one' }]);
    git(repo, 'checkout', '-q', 'main');
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 11;\n');
    commit(repo, 'main fixes the red in src');
    git(repo, 'checkout', '-q', 'job');
    git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'merge', '-q', '--no-ff', '-m', 'take main', 'main');
    expect(nearestBaseRed(repo)).toBeNull();
    expect(splitBaseRed(repo, [f('tests/a.test.ts', 'one')]).mine).toHaveLength(1);
  });

  it('a branch whose reflog does not start with its creation has no known base', () => {
    git(repo, 'checkout', '-q', 'main');
    noteBaseRed(repo, headTree(repo), [{ file: 'tests/a.test.ts', test: 'one' }]);
    // main's oldest entry is "commit (initial)": one of its own commits, never a fork point.
    expect(nearestBaseRed(repo)).toBeNull();
  });

  it('a red recorded on a commit the branch made itself never hides that branch\'s failure', () => {
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 8;\n');
    commit(repo, 'the job breaks a test');
    // The lead runs the whole suite on its own clean commit: the record is written, and ignored.
    expect(noteBaseRed(repo, headTree(repo), [{ file: 'tests/a.test.ts', test: 'one' }])).not.toBeNull();
    expect(nearestBaseRed(repo)).toBeNull();
    expect(splitBaseRed(repo, [f('tests/a.test.ts', 'one')]).mine).toHaveLength(1);
  });

  it('a child merged into an integration branch does not lend it its reds', () => {
    git(repo, 'checkout', '-q', '-b', 'topic', 'main');
    git(repo, 'checkout', '-q', '-b', 'child', 'main');
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 10;\n');
    commit(repo, 'child work');
    noteBaseRed(repo, headTree(repo), [{ file: 'tests/a.test.ts', test: 'one' }]);
    git(repo, 'checkout', '-q', 'topic');
    git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'merge', '-q', '--no-ff', '-m', 'merge child', 'child');
    expect(splitBaseRed(repo, [f('tests/a.test.ts', 'one')]).baseRed).toEqual([]);
  });
});

describe('a red proven on a stale build', () => {
  it('leaves the CLI-spawn tests out of the base-red record', () => {
    writeFileSync(join(repo, 'tests/cli.test.ts'), "const CLI = 'dist/index.js';\nvoid CLI;\n");
    commit(repo, 'a cli test');
    const log = join(repo, '..', `${repo.split('/').pop()}-cli.log`);
    writeFileSync(log, ['⎯⎯ Failed Tests 2 ⎯⎯', ' FAIL  tests/cli.test.ts > runs', ' FAIL  tests/a.test.ts > one', ' Test Files  2 failed (3)'].join('\n'));
    writeSuiteRecord({ v: 1, id: suiteRecordId(repo, 'job', 'suite'), state: 'red', pid: process.pid, toplevel: repo, branch: 'job', target: 'suite', at: new Date().toISOString(), files: ['tests/a.test.ts', 'tests/cli.test.ts'], redTree: headTree(repo), log });
    rmSync(log, { force: true });
    const rec = JSON.parse(readFileSync(join(receiptsDir(repo)!, 'base-red', `${head(repo)}.json`), 'utf-8'));
    expect(rec.tests).toEqual([{ file: 'tests/a.test.ts', test: 'one' }]);
  });
});

describe('builder test prints base reds apart and does not count them', () => {
  const out: string[] = [];
  const deps = (fail: { file: string; title: string }[]): SessionDeps => ({
    root: () => repo,
    now: () => Date.parse('2026-11-12T00:00:00Z'),
    print: (l: string) => out.push(l),
    printErr: (l: string) => out.push(`ERR ${l}`),
    runCheck: async (argv: string[], _cwd: string, log: string) => {
      writeFileSync(log, '');
      if (argv[0] === 'tsc') return 0;
      const outFile = argv.find((a) => a.startsWith('--outputFile='))!.slice('--outputFile='.length);
      const files = ['tests/a.test.ts', 'tests/b.test.ts'];
      const results = files.map((file) => {
        const mine = fail.filter((x) => x.file === file);
        return {
          name: join(repo, file), status: mine.length ? 'failed' : 'passed',
          assertionResults: mine.length
            ? mine.map((m) => ({ fullName: `grp ${m.title}`, ancestorTitles: ['grp'], title: m.title, status: 'failed', failureMessages: ['boom'] }))
            : [{ fullName: 'ok', title: 'ok', ancestorTitles: [], status: 'passed' }],
        };
      });
      writeFileSync(outFile, JSON.stringify({ numTotalTests: 2, testResults: results }));
      return fail.length ? 1 : 0;
    },
  } as unknown as SessionDeps);
  beforeEach(() => { out.length = 0; });

  it('only base reds: exit 0, GREEN with the count, each printed as BASE-RED outside the FAIL list', async () => {
    noteBaseRed(repo, headTree(repo), [{ file: 'tests/a.test.ts', test: 'grp > one' }]);
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 5;\n');
    expect(await builderTest(deps([{ file: 'tests/a.test.ts', title: 'one' }]), 'demo', { wave: '1', related: ['src/a.ts'] })).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('BASE-RED (not yours): tests/a.test.ts > grp one :: boom');
    expect(text).toMatch(/wave 1: GREEN \(1 base-red, not yours\)/);
    expect(text).not.toMatch(/^FAIL/m);
  });

  it('a new red next to a base red: exit 1, only the new one is a FAIL', async () => {
    noteBaseRed(repo, headTree(repo), [{ file: 'tests/a.test.ts', test: 'grp > one' }]);
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 6;\n');
    expect(await builderTest(deps([{ file: 'tests/a.test.ts', title: 'one' }, { file: 'tests/b.test.ts', title: 'two' }]), 'demo', { wave: '1', related: ['src/a.ts'] })).toBe(1);
    const fails = out.filter((l) => l.startsWith('FAIL'));
    expect(fails).toEqual(['FAIL: tests/b.test.ts > grp two :: boom']);
    expect(out.some((l) => l.startsWith('BASE-RED (not yours): tests/a.test.ts'))).toBe(true);
  });

  it('no record: every failure is a FAIL, as before', async () => {
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 7;\n');
    expect(await builderTest(deps([{ file: 'tests/a.test.ts', title: 'one' }]), 'demo', { wave: '1', related: ['src/a.ts'] })).toBe(1);
    expect(out.join('\n')).not.toContain('BASE-RED');
  });
});

describe('a fresh worktree gets a sibling\'s green build as dist/', () => {
  const wts: string[] = [];
  afterEach(() => { for (const w of wts.splice(0)) rmSync(w, { recursive: true, force: true }); });

  /** A dist/ in `repo` plus a green build receipt for the commit's tree, as `builder heavy` writes one. */
  function buildInRepo(): void {
    mkdirSync(join(repo, 'dist'), { recursive: true });
    writeFileSync(join(repo, 'dist/index.js'), 'console.log(1);\n');
    const tree = headTree(repo);
    const dir = receiptsDir(repo)!;
    mkdirSync(dir, { recursive: true });
    const name = createHash('sha256').update(`build-${tree}`).digest('hex');
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({ v: 1, kind: 'build', exit: 0, outputs: distFingerprint(repo), tree, at: new Date().toISOString(), toplevel: repo }));
  }
  const addWorktree = (branch: string, at = 'HEAD') => {
    const p = `${repo}-wt-${branch}`;
    git(repo, 'worktree', 'add', '-q', '-b', branch, p, at);
    wts.push(p);
    return realpathSync(p);
  };

  it('copies a green build of the same code and the copy passes the dist check', () => {
    writeFileSync(join(repo, '.gitignore'), 'dist/\n');
    commit(repo, 'ignore dist');
    buildInRepo();
    const wt = addWorktree('wt-a');
    const r = seedDist(wt);
    expect(r.from).toBe(repo);
    expect(readFileSync(join(wt, 'dist/index.js'), 'utf-8')).toBe('console.log(1);\n');
    expect(distFingerprint(wt)).toBe(distFingerprint(repo));
  });

  it('never copies a build of other code, and never over an existing dist/', () => {
    writeFileSync(join(repo, '.gitignore'), 'dist/\n');
    commit(repo, 'ignore dist');
    buildInRepo();
    const wt = addWorktree('wt-b');
    writeFileSync(join(wt, 'src/a.ts'), 'export const a = 9;\n');
    expect(seedDist(wt).from).toBeNull();
    expect(existsSync(join(wt, 'dist'))).toBe(false);
    mkdirSync(join(wt, 'dist'));
    writeFileSync(join(wt, 'dist/own.js'), '');
    expect(seedDist(wt).why).toMatch(/already has a dist/);
  });
});
