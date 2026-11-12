import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * `dreamcontext builder test`: the lead's wave-end check, run once after every lane of the
 * wave returned (builders never run tests: 40% of a builder's active time went to checks).
 *
 *   --related <files>  type-check every package the files belong to, then the tests that import
 *                      them (`vitest related`, `jest --findRelatedTests`) per test package.
 *   --failed           only what failed last time, plus --related when given (a fix can break
 *                      something it imports). With no task: the red files a whole-suite run left
 *                      in its record (lib/suite-record.ts), with their own config, plus the tests
 *                      related to what changed since (builder-sessions.ts builderTestRecords).
 *   --also <tests>     test files `related` cannot see (they read files by path, not import).
 *
 * Every failure gets a KEY (test file + name + first message line, or tsc code + file + line)
 * and the lane that owns its file, so the lead resumes the right builder with exactly that
 * output. The same key failing again after a fix is the owner's call.
 */

export type TestRunner = 'vitest' | 'jest';

export interface TestPlan {
  /** Directories holding a tsconfig.json, type-checked with `tsc --noEmit -p`. */
  tsc: string[];
  /** Per test package: the changed files to resolve `related` from and explicit test files. */
  tests: { pkg: string; runner: TestRunner; related: string[]; explicit: string[] }[];
}

/** `test`: the test's id (`describe > … > it`), null for a file that failed to load, absent for a
 *  type-check or run error. A base-red record matches on it (suite-record.ts splitBaseRed). */
export interface Failure { key: string; file: string; message: string; test?: string | null }

/** A wave number, or 'final' for the run-end check after the last wave. */
export type TestWave = number | 'final';

export interface TestState {
  version: 1;
  wave: TestWave;
  runs: number;
  /** Test files with a failure, per test package (repo-relative). */
  failedTests: Record<string, string[]>;
  /** Packages whose type-check failed (repo-relative dirs, '.' for the root). */
  tscFailed: string[];
  /** How many runs each failure key has failed in. */
  seen: Record<string, number>;
}

const rel = (root: string, p: string) => relative(root, p).split('\\').join('/') || '.';

function findUp(root: string, fromFile: string, test: (dir: string) => boolean): string | null {
  let dir = dirname(resolve(root, fromFile));
  const top = resolve(root);
  for (;;) {
    if (test(dir)) return dir;
    if (dir === top || !dir.startsWith(top)) return null;
    dir = dirname(dir);
  }
}

export function detectRunner(pkgDir: string): TestRunner | null {
  const p = join(pkgDir, 'package.json');
  if (!existsSync(p)) return null;
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };
  try { pkg = JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const script = pkg.scripts?.test ?? '';
  if ('vitest' in deps || /\bvitest\b/.test(script)) return 'vitest';
  if ('jest' in deps || /\bjest\b/.test(script)) return 'jest';
  return null;
}

/** Which type-checks and test runs a set of changed files needs. */
export function planChecks(root: string, changed: string[], also: string[] = []): TestPlan {
  const tsc = new Set<string>();
  const tests = new Map<string, TestPlan['tests'][number]>();
  const testPkg = (file: string) => findUp(root, file, (d) => detectRunner(d) != null);
  const add = (file: string, kind: 'related' | 'explicit') => {
    const pkg = testPkg(file);
    if (!pkg) return;
    const key = rel(root, pkg);
    const entry = tests.get(key) ?? { pkg: key, runner: detectRunner(pkg)!, related: [], explicit: [] };
    entry[kind].push(rel(pkg, resolve(root, file)));
    tests.set(key, entry);
  };
  for (const f of changed) {
    const ts = findUp(root, f, (d) => existsSync(join(d, 'tsconfig.json')));
    if (ts && /\.(?:[cm]?tsx?)$/.test(f)) tsc.add(rel(root, ts));
    add(f, 'related');
  }
  for (const f of also) add(f, 'explicit');
  return { tsc: [...tsc].sort(), tests: [...tests.values()] };
}

/**
 * argv (after `npx`) for one test package's run; `files` are relative to the package.
 * `--passWithNoTests`: "nothing matched" must still write a report, so it reads as no
 * coverage (related) or a vanished file (explicit), never as a crash.
 */
export function testArgv(runner: TestRunner, mode: 'related' | 'explicit', files: string[], outFile: string, config?: string): string[] {
  const common = ['--maxWorkers=2', '--passWithNoTests', ...(config && runner === 'vitest' ? ['-c', config] : [])];
  if (runner === 'vitest') {
    return mode === 'related'
      ? ['vitest', 'related', '--run', ...common, '--reporter=json', `--outputFile=${outFile}`, ...files]
      : ['vitest', 'run', ...common, '--reporter=json', `--outputFile=${outFile}`, ...files];
  }
  return mode === 'related'
    ? ['jest', '--findRelatedTests', ...files, ...common, '--json', `--outputFile=${outFile}`]
    : ['jest', ...common, '--json', `--outputFile=${outFile}`, ...files];
}

const firstLine = (s: string) => (s.split('\n').map((l) => l.trim()).find(Boolean) ?? '').slice(0, 200);

/** `file(line,col): error TSxxxx: message` -> failures keyed by code + file + line. */
export function parseTscErrors(output: string, pkgDir: string, root: string): Failure[] {
  const out: Failure[] = [];
  for (const line of output.split('\n')) {
    const m = /^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/.exec(line.trim());
    if (!m) continue;
    const file = rel(root, isAbsolute(m[1]) ? m[1] : resolve(root, pkgDir, m[1]));
    out.push({ key: `tsc ${m[3]} ${file}:${m[2]}`, file, message: m[4] });
  }
  return out;
}

interface JsonReport {
  numTotalTests?: number;
  testResults?: { name: string; status?: string; message?: string; assertionResults?: { fullName: string; title?: string; ancestorTitles?: string[]; status: string; failureMessages?: string[] }[] }[];
}

/** vitest `--reporter=json` and jest `--json` share this shape. */
export function parseTestReport(json: string, root: string): { total: number; files: string[]; failures: Failure[] } {
  const r = JSON.parse(json) as JsonReport;
  const failures: Failure[] = [];
  const files: string[] = [];
  for (const suite of r.testResults ?? []) {
    const file = rel(root, suite.name);
    files.push(file);
    const failed = (suite.assertionResults ?? []).filter((a) => a.status === 'failed');
    for (const a of failed) {
      const msg = firstLine((a.failureMessages ?? []).join('\n'));
      const test = typeof a.title === 'string' ? [...(a.ancestorTitles ?? []), a.title].filter(Boolean).join(' > ') : a.fullName;
      failures.push({ key: `${file} > ${a.fullName} :: ${msg}`, file, message: msg, test });
    }
    if (failed.length === 0 && suite.status === 'failed') {
      const msg = firstLine(suite.message ?? 'failed to load');
      failures.push({ key: `${file} :: suite failed: ${msg}`, file, message: msg, test: null });
    }
  }
  return { total: r.numTotalTests ?? 0, files, failures };
}

export function statePath(dir: string, wave: TestWave): string {
  return join(dir, `test-w${wave}.json`);
}

export function readTestState(path: string, wave: TestWave): TestState {
  if (!existsSync(path)) return { version: 1, wave, runs: 0, failedTests: {}, tscFailed: [], seen: {} };
  return JSON.parse(readFileSync(path, 'utf-8')) as TestState;
}

export function writeTestState(path: string, state: TestState): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1) + '\n');
  renameSync(tmp, path);
}

/** The lane whose owned paths cover `file`, if any. */
export function ownerOf(file: string, lanes: { lane: string; owns: string[] }[]): string | null {
  for (const l of lanes) {
    if (l.owns.some((o) => file === o || file.startsWith(`${o}/`))) return l.lane;
  }
  return null;
}

// ─── the related set is sized before it runs (audit OR-1) ───────────────────

/**
 * Past this many test FILES, `--related` was a central file's whole import graph, not "the tests
 * it touched" (163 files import `src/lib/super/types.ts`). About 1,500 tests, the old after-the-fact
 * warning's line. The count follows relative imports only, so it is a floor, never a proof.
 */
export const RELATED_FILE_CEILING = 200;

/** The refusal: why, which file did it, and the two ways out. */
export function wideRelatedMessage(pkg: string, total: number, hubs: { file: string; tests: number }[]): string {
  const label = pkg === '.' ? 'the root package' : pkg;
  const named = hubs.length > 0
    ? hubs.map((h) => `${h.file} (${h.tests > RELATED_FILE_CEILING ? `over ${RELATED_FILE_CEILING}` : h.tests} test files)`).join(', ')
    : 'one of the files you gave';
  return [
    `--related would run about ${total > RELATED_FILE_CEILING ? `more than ${RELATED_FILE_CEILING}` : total} test files in ${label}, nearly the whole suite. Nothing was run.`,
    `  The file pulling them in: ${named}.`,
    '  Leave it out of --related and name its own tests with --also <test files>; the full suite runs once at the cut.',
    '  If you really want the wide run, repeat the command with --wide-related.',
  ].join('\n');
}

// ─── an incremental type-check (audit OR-10) ────────────────────────────────

/**
 * Where one package's incremental build-info lives: under the worktree's own git dir (never
 * tracked, never shared with another worktree), named by the package and a hash of its tsconfig,
 * so a changed config starts from a clean file instead of a stale one.
 */
export function tscBuildInfoFile(gitDir: string, pkgRel: string, tsconfigText: string): string {
  const h = createHash('sha256').update(pkgRel).update('\0').update(tsconfigText).digest('hex').slice(0, 16);
  return join(gitDir, 'dc-tsc', `${h}.tsbuildinfo`);
}

/**
 * `tsc --noEmit -p <tsconfig>` becomes incremental with a per-worktree build-info file. Used only
 * at spawn time: the receipt keeps the plain argv, so it stays valid across worktrees. Anything
 * else, or any trouble finding the git dir, runs exactly as given.
 */
export function incrementalTscArgv(argv: string[], cwd: string): string[] {
  if (argv[0] !== 'tsc' || !argv.includes('--noEmit') || argv.some((a) => a === '--incremental' || a.startsWith('--tsBuildInfoFile') || a === '-b' || a === '--build')) return argv;
  const p = argv.indexOf('-p');
  const project = p >= 0 ? argv[p + 1] : undefined;
  if (!project) return argv;
  try {
    const text = readFileSync(resolve(cwd, project), 'utf-8');
    const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!gitDir) return argv;
    const file = tscBuildInfoFile(gitDir, `${relative(top, cwd).split('\\').join('/') || '.'}:${project}`, text);
    mkdirSync(dirname(file), { recursive: true });
    return [...argv, '--incremental', '--tsBuildInfoFile', file];
  } catch {
    return argv;
  }
}
