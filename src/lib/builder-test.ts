import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

export interface Failure { key: string; file: string; message: string }

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
  testResults?: { name: string; status?: string; message?: string; assertionResults?: { fullName: string; status: string; failureMessages?: string[] }[] }[];
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
      failures.push({ key: `${file} > ${a.fullName} :: ${msg}`, file, message: msg });
    }
    if (failed.length === 0 && suite.status === 'failed') {
      const msg = firstLine(suite.message ?? 'failed to load');
      failures.push({ key: `${file} :: suite failed: ${msg}`, file, message: msg });
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
