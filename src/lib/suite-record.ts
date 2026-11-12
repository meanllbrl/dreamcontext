import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { contentTree, distFingerprint, receiptsDir } from './check-receipt.js';
import { packageScripts } from './run-budget.js';

/**
 * The suite record: what a whole-suite run proved, kept per worktree, branch and suite target.
 *
 * Owner, 2026-11-08: the 0.41.6 cut and Telegram W3 waited 3+ hours; 81 of those minutes were
 * whole-suite reruns run only to READ the names of the red files, because `--tail` cut the vitest
 * summary and the red log was deleted. So a whole-suite run through `builder heavy` now leaves a
 * record: `running` before it starts, then `red` (with the proven list of red files), `incomplete`
 * or `green`. `builder test --failed` (no task needed) reruns only those files, plus the tests
 * related to what changed since, and closes the record green. While a record is red, a second
 * whole-suite run is refused (`builder heavy`, exit 77).
 *
 * One invariant governs it: NOTHING BECOMES GREEN BY ABSENCE. {@link judgeSuiteRun} is the only
 * code that sets `green`, and only on every proof at once; a missing proof is `incomplete`, never
 * green. Plan: task bir-is-tam-test-takimini-bir-kez-kosar…, plan.md §3 (C1-C3).
 * tests/unit/suite-record.test.ts pins it.
 */

export type SuiteState = 'running' | 'red' | 'incomplete' | 'green';

export interface SuiteRecord {
  v: 1;
  /** The file name's stem; also the ref folder that pins its trees. */
  id: string;
  state: SuiteState;
  /** The process that runs (or ran) the suite. */
  pid: number;
  toplevel: string;
  /** null = a detached HEAD. */
  branch: string | null;
  /** `suite` or `suite <config>`. */
  target: string;
  config?: string;
  /** The content tree the red list was proven on. */
  redTree?: string;
  /** The content tree the record was closed green on. */
  greenTree?: string;
  /** ISO time of the last state change. */
  at: string;
  /** How long the run may take before the ceiling kills it (running only). */
  maxRunMs?: number;
  /** Repo-relative test files still red (red) or last red (green, history). */
  files: string[];
  log?: string;
  greenLog?: string;
  /** Why it is incomplete, or what closed it. */
  reason?: string;
  /** Incomplete runs in a row ended by the ceiling. */
  ceilingStreak?: number;
  /** A `--because` already spent on this red. */
  because?: string;
  /** The detached check (`builder heavy --detach`) running it, for `--wait <id>`. */
  checkId?: string;
  /** A `running` record started over a red one (`--because`): what it falls back to if it dies. */
  overRed?: { redTree: string; because?: string };
}

/** A record older than this, green or incomplete, is pruned (the tree refs go with it). */
export const SUITE_RECORD_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** A `running` record past its ceiling by this much belongs to a reused pid. */
const RUNNING_GRACE_MS = 10 * 60 * 1000;
/** Two ceiling-ended runs in a row: the next whole-suite run goes to the owner. */
export const CEILING_STREAK_LIMIT = 2;

const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).trim();
}

export const suiteTarget = (config?: string): string => (config ? `suite ${config}` : 'suite');

/** The config a `suite <config>` target names, or undefined for the default suite. */
export const configOf = (target: string): string | undefined => (target.startsWith('suite ') ? target.slice(6) : undefined);

export function branchOf(toplevel: string): string | null {
  try { return git(toplevel, ['symbolic-ref', '--quiet', '--short', 'HEAD']) || null; } catch { return null; }
}

/** The record's id: toplevel + branch + target. A detached HEAD keys on the toplevel alone. */
export function suiteRecordId(toplevel: string, branch: string | null, target: string): string {
  // The readable slug can collide (`a/b` and `a_b`, two long task branches): the branch's own
  // hash keeps them apart.
  const slug = branch ? `${branch.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40)}-${sha1(branch).slice(0, 8)}` : 'HEAD';
  return `suite-${sha1(toplevel).slice(0, 16)}-${slug}-${sha1(target).slice(0, 12)}`;
}

export function suiteRecordPath(toplevel: string, branch: string | null, target: string): string | null {
  const dir = receiptsDir(toplevel);
  return dir ? join(dir, `${suiteRecordId(toplevel, branch, target)}.json`) : null;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException)?.code === 'EPERM'; }
}

const STATES: readonly SuiteState[] = ['running', 'red', 'incomplete', 'green'];
const TREE = /^[0-9a-f]{40,64}$/;

/**
 * This worktree's record for the target, as it stands: a `running` record whose runner died, or
 * that outlived its ceiling, reads as `incomplete`. Unknown content reads as no record plus a
 * warning, never green. Another worktree's, branch's or target's record is never read.
 */
export function readSuiteRecord(toplevel: string, branch: string | null, target: string, o: { now?: number; alive?: (pid: number) => boolean } = {}): { record: SuiteRecord | null; warning?: string } {
  const path = suiteRecordPath(toplevel, branch, target);
  if (!path || !existsSync(path)) return { record: null };
  try {
    if (!lstatSync(path).isFile()) return { record: null, warning: `${path} is not a file; ignored` };
    const r = JSON.parse(readFileSync(path, 'utf-8')) as SuiteRecord;
    const ok = r?.v === 1 && STATES.includes(r.state) && r.toplevel === toplevel && r.branch === branch && r.target === target
      && Array.isArray(r.files) && r.files.every((f) => typeof f === 'string') && typeof r.at === 'string' && !Number.isNaN(Date.parse(r.at))
      && (r.redTree === undefined || TREE.test(r.redTree)) && (r.greenTree === undefined || TREE.test(r.greenTree));
    if (!ok) return { record: null, warning: `the suite record ${path} is not readable; read as no record` };
    if (r.state === 'red' && r.files.length === 0) return { record: { ...r, state: 'incomplete', reason: 'a red record with no file list' } };
    if (r.state === 'running') {
      const now = o.now ?? Date.now();
      const alive = (o.alive ?? pidAlive)(r.pid);
      const limit = Date.parse(r.at) + (r.maxRunMs ?? 0) + RUNNING_GRACE_MS;
      // A run started over a red that never ended proved nothing: the red list stands.
      const back = (reason: string): SuiteRecord => (r.overRed && TREE.test(r.overRed.redTree) && r.files.length > 0
        ? { ...r, state: 'red', redTree: r.overRed.redTree, because: r.overRed.because, overRed: undefined, reason: `${reason}; the red record stands` }
        : { ...r, state: 'incomplete', files: [], reason });
      if (!alive) return { record: back('the runner died before it ended') };
      if (r.maxRunMs && now > limit) return { record: back('running past its ceiling (a reused pid)') };
    }
    return { record: r };
  } catch {
    return { record: null, warning: `the suite record ${path} is not readable; read as no record` };
  }
}

/**
 * `o.tests`: the red test ids this record stands for, when the caller holds them (a `--failed`
 * rerun's report); otherwise they are read off the record's own log. A red or green record on a
 * clean commit also writes that commit's base-red record ({@link noteBaseRed}).
 */
export function writeSuiteRecord(r: SuiteRecord, o: { tests?: BaseRedTest[] } = {}): void {
  const path = suiteRecordPath(r.toplevel, r.branch, r.target);
  if (!path) return;
  mkdirSync(resolve(path, '..'), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(r, null, 1)}\n`);
  renameSync(tmp, path);
  if (r.state === 'green' && r.greenTree) noteBaseRed(r.toplevel, r.greenTree, []);
  if (r.state === 'red' && r.redTree) noteBaseRed(r.toplevel, r.redTree, provenOnThisCode(r, o.tests ?? redIdsFromLog(r)));
}

/**
 * A red in a test that runs the built CLI says nothing about the code unless `dist/` was a green
 * build of that very tree: a lead who commits `src/` and runs the suite before rebuilding gets ~13
 * such reds. Those ids are left out of the base-red record then, so they can never hide a job's own.
 */
function provenOnThisCode(r: SuiteRecord, ids: BaseRedTest[]): BaseRedTest[] {
  try {
    if (!r.redTree || !ids.length || distCheck(r.toplevel, r.redTree).ok) return ids;
    const spawn = new Set(cliSpawnTests(r.toplevel, r.config));
    return ids.filter((t) => !spawn.has(t.file));
  } catch { return []; }
}

/** A red record's test ids from its log, mapped onto its repo-relative files; a red file the log
 *  does not name stays as a load failure, which only ever matches a load failure. */
function redIdsFromLog(r: SuiteRecord): BaseRedTest[] {
  let ids: BaseRedTest[] = [];
  try { ids = r.log ? parseVitestFailedIds(readFileSync(r.log, 'utf-8')) : []; } catch { ids = []; }
  // vitest prints paths from the folder it ran in: map each onto the record's own file.
  const toRecord = (f: string) => r.files.find((x) => x === f || x.endsWith(`/${f}`));
  const out: BaseRedTest[] = [];
  for (const t of ids) { const file = toRecord(t.file); if (file) out.push({ file, test: t.test }); }
  for (const f of r.files) if (!out.some((t) => t.file === f)) out.push({ file: f, test: null });
  return out;
}

/** Pin a record's tree under refs/dc-suite/<id>/<which>, so `git gc` keeps it. false on failure. */
export function pinTree(toplevel: string, id: string, which: 'red' | 'green', tree: string): boolean {
  try { git(toplevel, ['update-ref', `refs/dc-suite/${id}/${which}`, tree]); return true; } catch { return false; }
}

function unpinTrees(gitDir: string, id: string): void {
  for (const w of ['red', 'green']) { try { git(gitDir, ['--git-dir', gitDir, 'update-ref', '-d', `refs/dc-suite/${id}/${w}`]); } catch { /* none */ } }
}

/** Where a record's run log is kept: next to it. */
export function suiteLogPath(toplevel: string, branch: string | null, target: string, which: 'run' | 'green' = 'run'): string | null {
  const p = suiteRecordPath(toplevel, branch, target);
  return p ? p.replace(/\.json$/, which === 'run' ? '.log' : '.green.log') : null;
}

/** Every record of this worktree + branch, one per target. */
export function suiteRecordsHere(toplevel: string, branch: string | null, o: { now?: number; alive?: (pid: number) => boolean } = {}): SuiteRecord[] {
  const dir = receiptsDir(toplevel);
  if (!dir || !existsSync(dir)) return [];
  const head = suiteRecordId(toplevel, branch, 'x').replace(/-[0-9a-f]{12}$/, '-');
  const out: SuiteRecord[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(head) || !f.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as SuiteRecord;
      if (typeof raw?.target !== 'string') continue;
      const { record } = readSuiteRecord(toplevel, branch, raw.target, o);
      if (record) out.push(record);
    } catch { /* unreadable: no record */ }
  }
  return out.sort((a, b) => a.target.localeCompare(b.target));
}

/**
 * Prune (called from check-receipt's prune): a red record is never pruned while its worktree
 * exists; green and incomplete go after {@link SUITE_RECORD_MAX_AGE_MS}; any record whose
 * worktree is gone goes. Its logs and tree refs go with it. Never throws.
 */
export function pruneSuiteRecords(dir: string, now: number = Date.now()): void {
  pruneBaseRed(dir, now);
  // The logs of slug-less `--failed` runs: kept 14 days, like a receipt.
  try {
    const runs = join(dir, 'suite-runs');
    for (const f of existsSync(runs) ? readdirSync(runs) : []) {
      try { if (now - statSync(join(runs, f)).mtimeMs > SUITE_RECORD_MAX_AGE_MS) rmSync(join(runs, f), { force: true }); } catch { /* pruned */ }
    }
  } catch { /* nothing to prune */ }
  let files: string[];
  try { files = readdirSync(dir).filter((f) => /^suite-.*\.json$/.test(f)); } catch { return; }
  for (const f of files) {
    try {
      const p = join(dir, f);
      const r = JSON.parse(readFileSync(p, 'utf-8')) as Partial<SuiteRecord>;
      const gone = typeof r.toplevel !== 'string' || !existsSync(r.toplevel);
      const old = now - statSync(p).mtimeMs > SUITE_RECORD_MAX_AGE_MS;
      const keep = !gone && (r.state === 'red' || r.state === 'running' || !old);
      if (keep) continue;
      for (const ext of ['.json', '.log', '.green.log']) rmSync(p.replace(/\.json$/, ext), { force: true });
      // The refs live in the common git dir (this folder's parent), worktree gone or not.
      if (typeof r.id === 'string' && /^suite-[A-Za-z0-9._-]+$/.test(r.id)) unpinTrees(resolve(dir, '..'), r.id);
    } catch { /* another session pruned it */ }
  }
}

// ─── reading a vitest run ────────────────────────────────────────────────────

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
export const stripAnsi = (s: string): string => s.replace(ANSI, '');

/** What a run's output proves, read off vitest's own blocks and summary only. */
export interface RunSummary {
  /** A vitest summary (`Test Files … (N)`) was printed. */
  found: boolean;
  failedFiles: number;
  failedTests: number;
  /** Unhandled errors (`Errors  N error(s)`). */
  errors: number;
  /** A `Failed Suites` block was printed (an import or collect error). */
  failedSuites: boolean;
  /** Files named in the `Failed Tests` and `Failed Suites` blocks, nothing else. */
  listed: string[];
  /** The test file each unhandled error says it originated in. */
  errorOrigins: string[];
}

const BLOCK = /^\s*⎯+\s*(Failed Suites|Failed Tests|Unhandled Errors?|Unhandled Rejection|[A-Z][A-Za-z ]+)\b.*⎯+\s*$/;

/** vitest's default reporter output, ANSI or not. A test's own `FAIL …` output is never listed. */
export function parseVitestLog(raw: string): RunSummary {
  const lines = stripAnsi(raw).split(/\r?\n/);
  const listed = new Set<string>();
  const origins: string[] = [];
  let block: string | null = null;
  let failedSuites = false;
  let summary: Pick<RunSummary, 'failedFiles' | 'failedTests' | 'errors'> & { found: boolean } = { found: false, failedFiles: 0, failedTests: 0, errors: 0 };
  for (const line of lines) {
    const head = BLOCK.exec(line);
    if (head && !/\[\d+\/\d+\]/.test(line)) {
      block = head[1];
      if (block === 'Failed Suites') failedSuites = true;
      continue;
    }
    const files = /^\s*Test Files\s+(.*)\((\d+)\)\s*$/.exec(line);
    if (files) {
      block = null;
      summary = { ...summary, found: true, failedFiles: Number(/(\d+) failed/.exec(files[1])?.[1] ?? 0) };
      continue;
    }
    if (summary.found) {
      const tests = /^\s*Tests\s+(.*)\(\d+\)\s*$/.exec(line);
      if (tests) { summary.failedTests = Number(/(\d+) failed/.exec(tests[1])?.[1] ?? 0); continue; }
      const errs = /^\s*Errors\s+(\d+) errors?\b/.exec(line);
      if (errs) { summary.errors = Number(errs[1]); continue; }
    }
    if (block === 'Failed Tests' || block === 'Failed Suites') {
      // vitest's badge: " FAIL  <file> > test" or " FAIL  <file> [ <file> ]".
      const m = /^ FAIL {2}(\S+?)(?:\s+>|\s+\[|\s*$)/.exec(line);
      if (m) listed.add(m[1]);
    }
    const origin = /This error originated in "([^"]+)" test file/.exec(line);
    if (origin) origins.push(origin[1]);
  }
  return { ...summary, failedSuites, listed: [...listed].sort(), errorOrigins: origins };
}

/** A `builder test` JSON report as a run summary: the report lists every failed file itself. */
export function summaryFromReport(failureFiles: string[], exit: number | null): RunSummary {
  const listed = [...new Set(failureFiles)].sort();
  return {
    found: true, failedFiles: listed.length, failedTests: listed.length, failedSuites: false, listed, errorOrigins: [],
    // A run that exited red with nothing listed hit an error the report does not hold.
    errors: exit !== null && exit !== 0 && listed.length === 0 ? 1 : 0,
  };
}

export interface JudgeInput {
  /** The check's exit, null when it never ended (killed, died). */
  exit: number | null;
  /** Why the exit code is not the check's own (a pipe, `;`, `||`), or null. */
  exitNotOwned: string | null;
  summary: RunSummary;
  /** It was ended from outside (the ceiling, a signal). */
  killed?: string;
  /** The dist check, when the run held CLI-spawn tests: null = it did not apply. */
  dist?: { ok: boolean; why?: string } | null;
  /** `--failed` only: files of the required scope that ran no tests. */
  missing?: string[];
}

export interface Judgement { state: 'red' | 'incomplete' | 'green'; files: string[]; reason: string }

/**
 * THE one place a suite run's state is decided (C1, C3).
 *   green: the check's own exit 0, a clean summary (0 failed files, 0 failed tests, no Errors, no
 *          Failed Suites), a fresh dist when CLI-spawn tests ran, and the whole required scope ran.
 *   red:   a list from the Failed Tests / Failed Suites blocks whose size matches the summary, and
 *          every unhandled error traced to a listed file. A required file that ran no tests stays red.
 *   everything else: incomplete. Never green by absence.
 */
export function judgeSuiteRun(i: JudgeInput): Judgement {
  const s = i.summary;
  const missing = i.missing ?? [];
  if (i.killed) return { state: 'incomplete', files: [], reason: `ended from outside (${i.killed})` };
  if (i.exit === null) return { state: 'incomplete', files: [], reason: 'the run never ended (killed or died)' };
  if (!s.found) return { state: 'incomplete', files: [], reason: 'no vitest summary in the output (killed, crashed, or not a vitest run)' };
  const clean = s.failedFiles === 0 && s.failedTests === 0 && s.errors === 0 && !s.failedSuites && s.listed.length === 0;
  if (clean) {
    if (missing.length > 0) return { state: 'red', files: [...missing].sort(), reason: `${missing.length} required file(s) ran no tests: ${missing.join(', ')}` };
    if (i.exit !== 0) return { state: 'incomplete', files: [], reason: `exit ${i.exit} with a clean summary` };
    if (i.exitNotOwned) return { state: 'incomplete', files: [], reason: `the exit code is not the check's own (${i.exitNotOwned}): run it without | tee` };
    if (i.dist && !i.dist.ok) return { state: 'incomplete', files: [], reason: `CLI-spawn tests ran on a stale build (${i.dist.why ?? 'dist does not match src'})` };
    return { state: 'green', files: [], reason: 'every test passed, the exit is the check\'s own' };
  }
  if (s.listed.length === 0) return { state: 'incomplete', files: [], reason: s.errors > 0 ? `${s.errors} unhandled error(s) and no failed file listed` : 'failures counted but no file listed' };
  if (s.listed.length !== s.failedFiles) return { state: 'incomplete', files: [], reason: `the summary counts ${s.failedFiles} failed file(s) but ${s.listed.length} are listed` };
  if (s.errors > 0) {
    const unlisted = s.errorOrigins.filter((o) => !s.listed.includes(o));
    if (s.errorOrigins.length < s.errors || unlisted.length > 0) return { state: 'incomplete', files: [], reason: `an unhandled error not tied to a listed file${unlisted.length ? ` (${unlisted.join(', ')})` : ''}` };
  }
  const files = [...new Set([...s.listed, ...missing])].sort();
  return { state: 'red', files, reason: `${files.length} red file(s)` };
}

// ─── the build the CLI-spawn tests run ───────────────────────────────────────

/**
 * Paths whose change cannot make the build stale, deny by default: tests, the root brain, and
 * Markdown, except where the build copies or bundles it into dist (agents, skill-draw,
 * hooks, src, dashboard: tsup.config.ts). check-receipt's harmlessFor reads it for build receipts
 * (one list, no copy).
 */
export const SUITE_DIST_ALLOW: readonly RegExp[] = [
  /^tests\//,
  /^_(?:dream|agent)_context\//,
  /^(?!(?:agents|skill-draw|hooks|src|dashboard)\/).*\.md$/i,
];

export const distAllowed = (path: string): boolean => SUITE_DIST_ALLOW.some((re) => re.test(path));

interface BuildReceipt { tree: string; outputs: string; at: string; toplevel?: string }

/** Green build receipts in the repo's receipts folder (a check-receipt `build` receipt). */
function buildReceipts(toplevel: string): BuildReceipt[] {
  const dir = receiptsDir(toplevel);
  if (!dir || !existsSync(dir)) return [];
  const out: BuildReceipt[] = [];
  for (const f of readdirSync(dir)) {
    if (!/^[0-9a-f]{64}\.json$/.test(f)) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as Record<string, unknown>;
      if (r.v !== 1 || r.kind !== 'build' || r.exit !== 0 || typeof r.outputs !== 'string' || !r.outputs || typeof r.tree !== 'string' || !TREE.test(r.tree) || typeof r.at !== 'string') continue;
      out.push({ tree: r.tree, outputs: r.outputs, at: r.at, ...(typeof r.toplevel === 'string' ? { toplevel: r.toplevel } : {}) });
    } catch { /* a corrupt receipt is no receipt */ }
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** Paths changed between two trees, or null when git cannot tell (then nothing is assumed). */
export function treeDiff(toplevel: string, from: string, to: string): { path: string; status: string }[] | null {
  try {
    const out = execFileSync('git', ['-c', 'core.quotePath=false', 'diff-tree', '-r', '-z', '--name-status', '--no-renames', from, to], { cwd: toplevel, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    const parts = out.split('\0').filter(Boolean);
    const rows: { path: string; status: string }[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) rows.push({ status: parts[i], path: parts[i + 1] });
    return rows;
  } catch {
    return null;
  }
}

export interface DistCheck { ok: boolean; why: string }

/**
 * Does `dist/` hold a green build of the code? It must equal a green build receipt's output,
 * built from a tree that differs from `tree` (default: the code as it is now) only in
 * {@link SUITE_DIST_ALLOW}. A run passes its START tree: an edit made while it runs is not
 * what it tested ({@link distProof}).
 */
export function distCheck(toplevel: string, at?: string | null): DistCheck {
  const now = distFingerprint(toplevel);
  if (now === null) return { ok: false, why: 'dist/ is too big to fingerprint' };
  if (now === '') return { ok: false, why: 'there is no dist/' };
  const tree = at ?? contentTree(toplevel);
  if (!tree) return { ok: false, why: 'the content tree could not be written' };
  const matching = buildReceipts(toplevel).filter((r) => r.outputs === now);
  if (matching.length === 0) return { ok: false, why: 'dist/ matches no green build of `builder heavy` (built outside it, or edited since)' };
  for (const r of matching) {
    const diff = treeDiff(toplevel, r.tree, tree);
    if (diff && diff.every((d) => distAllowed(d.path))) return { ok: true, why: 'dist/ is a green build of this code' };
  }
  const diff = treeDiff(toplevel, matching[0].tree, tree);
  const inputs = diff?.filter((d) => !distAllowed(d.path)).map((d) => d.path) ?? [];
  return { ok: false, why: inputs.length ? `the build inputs changed since dist/ was built (${inputs.slice(0, 3).join(', ')}${inputs.length > 3 ? ` and ${inputs.length - 3} more` : ''})` : 'the build cannot be traced to this code' };
}

/** The dist proof of one run: checked on its start tree, then held to the bytes it started with. */
export interface DistProof { check: DistCheck; fingerprint: string | null }

export function distProof(toplevel: string, startTree: string | null): DistProof {
  return { check: distCheck(toplevel, startTree), fingerprint: distFingerprint(toplevel) };
}

/** The proof at the end of the run: the start check, and `dist/` unchanged since. */
export function distProofHeld(toplevel: string, p: DistProof): DistCheck {
  if (!p.check.ok) return p.check;
  return distFingerprint(toplevel) === p.fingerprint ? p.check : { ok: false, why: 'dist/ changed while the tests ran' };
}

/**
 * A build that would rebuild changed inputs is not a repeat: this worktree's last green build
 * receipt was built from a tree that differs from now outside {@link SUITE_DIST_ALLOW}. With no
 * such receipt nothing can be told, and the phase budget counts as before. Another worktree's
 * build never counts.
 */
export function buildInputsChanged(toplevel: string): boolean {
  const mine = buildReceipts(toplevel).filter((r) => r.toplevel === toplevel);
  if (mine.length === 0) return false;
  const tree = contentTree(toplevel);
  if (!tree) return false;
  const diff = treeDiff(toplevel, mine[0].tree, tree);
  return diff === null ? false : diff.some((d) => !distAllowed(d.path));
}

/** The command that builds this repo, from its own scripts, or null when it has none. */
export function buildCommand(toplevel: string): string | null {
  const s = packageScripts(toplevel);
  return s.build ? 'npm run build' : null;
}

// ─── CLI-spawn tests ─────────────────────────────────────────────────────────

/**
 * A path to the built CLI. Naming it is enough: the run may go through a promisified exec, a
 * helper (`runCliWithStdin(CLI, …)`) or a `src` runner, none of which this can see; a file that
 * only writes a fake `dist/index.js` is counted too, which costs a rerun and never hides one.
 */
const DIST_PATH = /\b(?:join|resolve)\([^)]*['"`]dist['"`]\s*,\s*['"`]index\.js['"`]\s*\)|['"`][^'"`\n]*\bdist\/index\.js['"`]/;

/** A config's `include` globs, read off its text; vitest's default when none is found. */
export function includeGlobs(toplevel: string, config?: string): string[] {
  const candidates = config ? [config] : ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.config.mjs'];
  for (const c of candidates) {
    let text: string;
    try { text = readFileSync(join(toplevel, c), 'utf-8'); } catch { continue; }
    const block = /\binclude\s*:\s*\[([\s\S]*?)\]/.exec(text);
    if (!block) break;
    const globs = [...block[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
    if (globs.length) return globs;
    break;
  }
  return ['**/*.{test,spec}.?(c|m)[jt]s?(x)'];
}

function globRe(glob: string): RegExp {
  let re = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += glob[i + 2] === '/' ? 2 : 1; continue; }
    if (c === '*') { re += '[^/]*'; continue; }
    if (c === '?') { re += glob[i + 1] === '(' ? '' : '[^/]'; continue; }
    if (c === '{') { depth += 1; re += '(?:'; continue; }
    if (c === '}') { depth -= 1; re += ')'; continue; }
    if (c === ',' && depth > 0) { re += '|'; continue; }
    if (c === '|' && depth > 0) { re += '|'; continue; }
    if (c === '(') { depth += 1; re += '(?:'; continue; }
    if (c === ')') { depth -= 1; re += ')?'; continue; }
    if (c === '[') { const end = glob.indexOf(']', i); re += glob.slice(i, end + 1); i = end; continue; }
    re += c.replace(/[.+^$|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function walk(toplevel: string, rel: string, out: string[]): void {
  let entries;
  try { entries = readdirSync(join(toplevel, rel), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(toplevel, r, out);
    else if (e.isFile() && /\.[cm]?[jt]sx?$/.test(e.name)) out.push(r);
  }
}

/**
 * Test files (inside the target's include set) that run the built CLI: a path to `dist/index.js`
 * in the test, or in a test helper it imports. These read
 * whatever `dist/` was last built, and `vitest related` rarely reaches them from a `src/` change.
 */
export function cliSpawnTests(toplevel: string, config?: string): string[] {
  const raw = includeGlobs(toplevel, config);
  const globs = raw.map(globRe);
  // Walk only each glob's literal head: `tests/**/*.test.ts` walks tests/, a bare `**` the repo.
  const bases = new Set(raw.map((g) => {
    const parts = g.split('/');
    const stop = parts.findIndex((p) => /[*?{[(]/.test(p));
    return (stop < 0 ? parts.slice(0, -1) : parts.slice(0, stop)).join('/');
  }));
  const files: string[] = [];
  for (const b of bases) walk(toplevel, b, files);
  const unique = [...new Set(files)];
  const isTest = (f: string) => globs.some((re) => re.test(f));
  const spawnsCli = (text: string) => DIST_PATH.test(text);
  const read = (f: string): string => { try { return readFileSync(join(toplevel, f), 'utf-8'); } catch { return ''; } };
  const helpers = unique.filter((f) => !isTest(f) && spawnsCli(read(f))).map((f) => f.replace(/\.[cm]?[jt]sx?$/, ''));
  const out: string[] = [];
  for (const f of unique.filter(isTest)) {
    const text = read(f);
    if (spawnsCli(text)) { out.push(f); continue; }
    const dir = f.split('/').slice(0, -1).join('/');
    const imports = [...text.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => relative(toplevel, resolve(toplevel, dir, m[1])).split(sep).join('/').replace(/\.[cm]?[jt]sx?$/, ''));
    if (imports.some((p) => helpers.includes(p))) out.push(f);
  }
  return out.sort();
}

/** The dist start gate applies: the target's include set holds CLI-spawn tests and the repo builds. */
export function distGateApplies(toplevel: string, config?: string): boolean {
  return buildCommand(toplevel) !== null && cliSpawnTests(toplevel, config).length > 0;
}

/** Is a whole-suite record of this worktree + branch red (any target)? false on any doubt. */
export function suiteRedOpen(cwd: string): boolean {
  try {
    const t = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!t) return false;
    const top = recordToplevel(t);
    return suiteRecordsHere(top, branchOf(top)).some((r) => r.state === 'red');
  } catch {
    return false;
  }
}

/** The toplevel as records key it (real path). */
export function recordToplevel(toplevel: string): string {
  try { return realpathSync(toplevel); } catch { return toplevel; }
}

// ─── base reds: what was already red on a commit (audit OR-2) ────────────────

/**
 * The full suite is red on most cuts, so every job forked from one sees the same reds in its own
 * checks and proves "red on base" again (79 task files carry such a proof). A whole-suite record
 * written on a CLEAN checkout (its tree is HEAD's) also leaves a base-red record keyed by HEAD's
 * commit: the failing test ids, nothing else. `builder test` reads the nearest such record among
 * HEAD's ancestors and prints a failure it lists as `BASE-RED (not yours)`, outside the FAIL list.
 *
 * A real regression must not hide behind it, so a failure counts as base-red only when ALL hold:
 * the same test id (file + describe path + name; a load failure only matches a load failure), the
 * record's commit is an ancestor of HEAD, and the test FILE is unchanged since that commit. A newer
 * record (a green cut writes an empty one) supersedes an older one: that is how a red expires.
 */
export interface BaseRedTest { file: string; /** `describe > … > it`; null = the file failed to load. */ test: string | null }
export interface BaseRedRecord { v: 1; sha: string; tree: string; at: string; tests: BaseRedTest[] }

/** One test's id as both vitest reporters can give it: the describe path and title, ` > ` joined. */
export const testIdOf = (ancestors: readonly string[], title: string): string => [...ancestors, title].filter(Boolean).join(' > ');

const SHA = /^[0-9a-f]{40,64}$/;

function baseRedDir(toplevel: string): string | null {
  const d = receiptsDir(toplevel);
  return d ? join(d, 'base-red') : null;
}

/** The failed test ids in a vitest default-reporter log (Failed Tests / Failed Suites blocks). */
export function parseVitestFailedIds(raw: string): BaseRedTest[] {
  const out = new Map<string, BaseRedTest>();
  let block: string | null = null;
  for (const line of stripAnsi(raw).split(/\r?\n/)) {
    const head = BLOCK.exec(line);
    if (head && !/\[\d+\/\d+\]/.test(line)) { block = head[1]; continue; }
    if (/^\s*Test Files\s/.test(line)) { block = null; continue; }
    if (block !== 'Failed Tests' && block !== 'Failed Suites') continue;
    const m = /^ FAIL {2}(\S+)(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[2].trim();
    const t: BaseRedTest = block === 'Failed Suites' || !rest.startsWith('>') ? { file: m[1], test: null } : { file: m[1], test: rest.slice(1).trim() };
    out.set(`${t.file}\0${t.test ?? ''}`, t);
  }
  return [...out.values()];
}

/** HEAD's commit when `tree` is exactly HEAD's tree (a clean checkout), else null. */
function cleanHead(toplevel: string, tree: string): string | null {
  try {
    const sha = git(toplevel, ['rev-parse', '--verify', 'HEAD^{commit}']);
    return SHA.test(sha) && git(toplevel, ['rev-parse', `${sha}^{tree}`]) === tree ? sha : null;
  } catch { return null; }
}

/**
 * Write what a suite run proved on a clean commit: its red test ids, or none on a green. A run on
 * uncommitted code proves nothing about a commit and writes nothing. Never throws.
 */
export function noteBaseRed(toplevel: string, tree: string, tests: readonly BaseRedTest[], now: number = Date.now()): string | null {
  try {
    const sha = cleanHead(toplevel, tree);
    const dir = baseRedDir(toplevel);
    if (!sha || !dir) return null;
    mkdirSync(dir, { recursive: true });
    const rec: BaseRedRecord = { v: 1, sha, tree, at: new Date(now).toISOString(), tests: [...tests].sort((a, b) => `${a.file}\0${a.test ?? ''}`.localeCompare(`${b.file}\0${b.test ?? ''}`)) };
    const path = join(dir, `${sha}.json`);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(rec, null, 1)}\n`);
    renameSync(tmp, path);
    return path;
  } catch { return null; }
}

function readBaseRed(path: string): BaseRedRecord | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    const r = JSON.parse(readFileSync(path, 'utf-8')) as BaseRedRecord;
    const ok = r?.v === 1 && SHA.test(r.sha) && SHA.test(r.tree) && typeof r.at === 'string' && !Number.isNaN(Date.parse(r.at))
      && Array.isArray(r.tests) && r.tests.every((t) => typeof t?.file === 'string' && (t.test === null || typeof t.test === 'string'));
    return ok ? r : null;
  } catch { return null; }
}

/**
 * The commit this branch grew from, or null when that cannot be told for sure. Read off the
 * branch's reflog: its oldest entry must be `branch: Created from …`, and every later entry only
 * the branch's own commits (`commit:`, `commit (amend):`). A rebase, merge, reset, pull or
 * fast-forward took in other code (perhaps a later fix of a base red), and an expired or missing
 * creation entry may leave one of the branch's own commits as the oldest: any of these, a detached
 * HEAD, or no reflog = unknown, and nothing counts as base-red. Any doubt is the job's.
 */
export function forkPoint(toplevel: string): string | null {
  try {
    const branch = branchOf(toplevel);
    if (!branch) return null;
    const rows = git(toplevel, ['reflog', 'show', '--format=%H %gs', `refs/heads/${branch}`, '--']).split('\n').filter(Boolean);
    if (rows.length === 0) return null;
    const oldest = rows[rows.length - 1];
    const sha = oldest.slice(0, oldest.indexOf(' '));
    if (!SHA.test(sha) || !oldest.slice(sha.length + 1).startsWith('branch: Created from')) return null;
    const ownOnly = rows.slice(0, -1).every((row) => /^[0-9a-f]+ commit(?: \(amend\))?: /.test(row));
    return ownOnly ? sha : null;
  } catch { return null; }
}

/**
 * The base-red record of the nearest recorded commit at or before this branch's fork point
 * ({@link forkPoint}), or null. Records on the branch's own commits never count.
 */
export function nearestBaseRed(toplevel: string, o: { fork?: string | null } = {}): BaseRedRecord | null {
  const dir = baseRedDir(toplevel);
  if (!dir || !existsSync(dir)) return null;
  const fork = o.fork === undefined ? forkPoint(toplevel) : o.fork;
  if (!fork) return null;
  let best: { rec: BaseRedRecord; distance: number } | null = null;
  for (const f of readdirSync(dir)) {
    if (!/^[0-9a-f]{40,64}\.json$/.test(f)) continue;
    const rec = readBaseRed(join(dir, f));
    if (!rec || `${rec.sha}.json` !== f) continue;
    let distance: number;
    try {
      // Not an ancestor of the fork point (or gone): the range of commits the fork lacks must be empty.
      if (git(toplevel, ['rev-list', '--count', `${fork}..${rec.sha}`]) !== '0') continue;
      distance = Number(git(toplevel, ['rev-list', '--count', `${rec.sha}..${fork}`]));
    } catch { continue; }
    if (!Number.isFinite(distance)) continue;
    if (!best || distance < best.distance || (distance === best.distance && Date.parse(rec.at) > Date.parse(best.rec.at))) best = { rec, distance };
  }
  return best?.rec ?? null;
}

export interface FailureLike { file: string; test?: string | null; key: string }

/**
 * Split failures into the job's own and those already red on its base. `tree` is the code as it is
 * now (default: the content tree); a failure in a test file changed since the base stays the job's.
 * A tsc failure, or a failure with no test id, is always the job's. Any doubt: the job's.
 */
export function splitBaseRed<F extends FailureLike>(toplevel: string, failures: readonly F[], o: { tree?: string | null; record?: BaseRedRecord | null } = {}): { mine: F[]; baseRed: F[]; record: BaseRedRecord | null } {
  const candidates = failures.filter((f) => f.test !== undefined && !f.key.startsWith('tsc '));
  if (candidates.length === 0) return { mine: [...failures], baseRed: [], record: null };
  const record = o.record === undefined ? nearestBaseRed(toplevel) : o.record;
  if (!record || record.tests.length === 0) return { mine: [...failures], baseRed: [], record };
  const now = o.tree === undefined ? contentTree(toplevel) : o.tree;
  const diff = now ? treeDiff(toplevel, record.tree, now) : null;
  if (!diff) return { mine: [...failures], baseRed: [], record };
  const changed = new Set(diff.map((d) => d.path));
  const known = new Set(record.tests.map((t) => `${t.file}\0${t.test ?? ''}`));
  const mine: F[] = [];
  const baseRed: F[] = [];
  for (const f of failures) {
    const hit = f.test !== undefined && !f.key.startsWith('tsc ') && !changed.has(f.file) && known.has(`${f.file}\0${f.test ?? ''}`);
    (hit ? baseRed : mine).push(f);
  }
  return { mine, baseRed, record };
}

/** Base-red records go after {@link SUITE_RECORD_MAX_AGE_MS}: a red that old is the cut's business. */
function pruneBaseRed(dir: string, now: number): void {
  const d = join(dir, 'base-red');
  try {
    for (const f of existsSync(d) ? readdirSync(d) : []) {
      try { if (now - statSync(join(d, f)).mtimeMs > SUITE_RECORD_MAX_AGE_MS) rmSync(join(d, f), { force: true }); } catch { /* pruned */ }
    }
  } catch { /* nothing to prune */ }
}

// ─── a new worktree's dist/ (audit OR-2 b) ──────────────────────────────────

/** The folders {@link distFingerprint} hashes that exist in `toplevel`: `dist` and `<dir>/dist`. */
function distRoots(toplevel: string): string[] {
  const out: string[] = [];
  const isDir = (p: string) => { try { const s = lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } };
  if (isDir(join(toplevel, 'dist'))) out.push('dist');
  try {
    for (const e of readdirSync(toplevel, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist' && isDir(join(toplevel, e.name, 'dist'))) out.push(`${e.name}/dist`);
    }
  } catch { /* none */ }
  return out;
}

function siblingWorktrees(toplevel: string): string[] {
  try {
    const self = recordToplevel(toplevel);
    return git(toplevel, ['worktree', 'list', '--porcelain']).split('\n')
      .filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9))
      .filter((p) => existsSync(p) && recordToplevel(p) !== self);
  } catch { return []; }
}

/**
 * A fresh worktree has no `dist/`, so every test that runs the built CLI goes red there (27 task
 * files note ~13 such reds). Copy the build from a sibling worktree whose `dist/` is a green build
 * of THIS code, and keep it only when the copy hashes like the receipt. Cheap first: only a green
 * build receipt whose tree differs from this one only in {@link SUITE_DIST_ALLOW} names a candidate,
 * and only that sibling's dist is hashed. A worktree with anything at a dist path, or code no
 * sibling built, gets nothing: the caller says "build first". Synchronous: CLI use only (never on
 * the server's request path). Never throws.
 */
export function seedDist(toplevel: string, o: { tree?: string | null; sources?: string[] } = {}): { from: string | null; why: string } {
  try {
    if (distRoots(toplevel).length > 0 || existsSync(join(toplevel, 'dist'))) return { from: null, why: 'this worktree already has a dist/' };
    const tree = o.tree === undefined ? contentTree(toplevel) : o.tree;
    if (!tree) return { from: null, why: 'the content tree could not be written' };
    const siblings = new Set((o.sources ?? siblingWorktrees(toplevel)).map(recordToplevel));
    const tried = new Set<string>();
    for (const r of buildReceipts(toplevel)) {
      const src = r.toplevel ? recordToplevel(r.toplevel) : null;
      if (!src || !siblings.has(src) || tried.has(`${src}\0${r.outputs}`)) continue;
      tried.add(`${src}\0${r.outputs}`);
      const diff = treeDiff(toplevel, r.tree, tree);
      if (!diff || !diff.every((d) => distAllowed(d.path))) continue;
      if (distFingerprint(src) !== r.outputs) continue;
      const roots = distRoots(src);
      // Nothing of ours is ever replaced or removed: every target must be absent before the copy.
      if (roots.length === 0 || roots.some((x) => { try { lstatSync(join(toplevel, x)); return true; } catch { return false; } })) continue;
      // Only a root this call copied whole is ever removed again: a second `builder test` that lost
      // the race to the same empty worktree must not delete the winner's copy.
      const made: string[] = [];
      try {
        for (const x of roots) {
          mkdirSync(resolve(join(toplevel, x), '..'), { recursive: true });
          cpSync(join(src, x), join(toplevel, x), { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
          made.push(x);
        }
        if (distFingerprint(toplevel) === r.outputs) return { from: src, why: `copied from ${src}, a green build of this code` };
      } catch { /* undone below */ }
      for (const x of made) rmSync(join(toplevel, x), { recursive: true, force: true });
    }
    return { from: null, why: 'no other worktree holds a green build of this code' };
  } catch { return { from: null, why: 'the build could not be copied' }; }
}
