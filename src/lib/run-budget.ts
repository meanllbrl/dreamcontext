import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { heavyRepoDir } from './builder-tools.js';
import type { LanePick } from './run-lane.js';

/**
 * The repeat limit on the slowest proof steps, enforced by `dreamcontext builder heavy`.
 *
 * Measured 2026-10-31 over 20 Develop sessions: 6 browser runs a session where the rule said 1-2,
 * 13 minutes an hour re-running checks after the reviewer, and the proof share of a session up
 * from 40% to 53% after "tests and builds run once" was written down as prose. So the command
 * counts now: per branch, phase and command, a browser run, a full build or a full test suite
 * past its limit is REFUSED before anything starts. A red run earns one more, to see the fix go green.
 *
 * A valid check must not trap an agent: `--because "<reason>"` runs it anyway, ONCE per run and
 * command, and leaves a record in the budget file, shown by `dreamcontext builder budget`. A
 * second one is refused like any other run: past that the owner decides. Everything here fails
 * open (no git, a broken file): the limit saves minutes, and it is not worth a blocked check.
 *
 * Only a run is limited, and it says so itself, because a code worktree holds no brain and so
 * cannot read goal-live: `builder open <slug>` starts counting, `builder test --wave N` opens wave
 * N, and `builder lane --from` or `--wave final` opens `end`, which the review, its fixes and the
 * final check share. A plain chat still takes the lock, and nothing counts.
 *
 * tests/unit/run-budget.test.ts pins it.
 */

/** Runs of one command in one phase, before the extra run a red earns. */
export const BUDGET_LIMITS = { browser: 2, build: 1, suite: 1 } as const;

export type BudgetKind = keyof typeof BUDGET_LIMITS;
/** `check`: a type-check or a scoped test run, which takes the lock but no budget. */
export type HeavyKind = BudgetKind | 'check';
/**
 * `target` is what repeats: two different builds or browser scripts are two limits. `scoped` is
 * how many things it provably touches: named test files, 0 for a related run (its `related` source
 * files decide, heavy-queue.ts counts the tests that reach them),
 * 1 for a `look.mjs` glance. Absent = unknown, and heavy-queue.ts reads unknown as long.
 */
export interface HeavyStep { kind: HeavyKind; target: string; scoped?: number; related?: string[]; /** A `tsc` without --noEmit writes files. */ emits?: boolean }

/** `builder heavy`'s exit code for a refusal. Not 75: running it again will not help. */
export const HEAVY_OVER_BUDGET_EXIT = 77;

/** A bucket untouched this long belongs to finished work: long enough for a usage-limit pause. */
export const BUDGET_BUCKET_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const MAX_OVERRUNS = 200;

const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+)+/;
const WRAPPER = /^(?:(?:sudo|time|command|exec|nice|npx\s+--yes)\s+)+/;
const REDIRECT = /\s+(?:(?:\d|&)?>>?&?\s*\S+|<\s*\S+)/g;

/** `-t foo` is a filter and names tests; these take a value that names none. */
const VALUE_FLAG = /^(?:-c|--[A-Za-z][\w-]*)$/;
const FILTER_FLAG = /^(?:-t|--testNamePattern)$/;

/** A test run names files or a filter, or it is the whole suite. `--bail 1` names nothing. */
function namesTests(args: string): boolean {
  const words = args.trim().split(/\s+/).filter((w) => w && w !== '&');
  return words.some((w, i) => {
    if (FILTER_FLAG.test(w)) return true;
    if (w.startsWith('-') || w === 'run') return false;
    // After a flag a word is its value, unless it reads as a path: `--runInBand tests/a.test.ts`.
    return !VALUE_FLAG.test(words[i - 1] ?? '') || (/[/.]/.test(w) && !/^(?:-c|--config|--outputFile|--root|--dir|--shard)$/.test(words[i - 1]));
  });
}

/**
 * The files a test run names; nothing when it names anything that is not a plain file: a
 * directory, a filter, a substring all match an unknown number of tests.
 */
function namedFiles(args: string): { scoped?: number; related?: string[] } {
  const words = args.trim().split(/\s+/).filter((w) => w && w !== '&');
  if (words.some((w) => FILTER_FLAG.test(w))) return {};
  const related = words.includes('related') || words.includes('--findRelatedTests');
  const named = words.filter((w) => !w.startsWith('-') && w !== 'run' && w !== 'related');
  const file = related ? /\.[cm]?[jt]sx?$/ : /\.(?:test|spec)\.[cm]?[jt]sx?$/;
  // An unexpanded glob reads as one file and can be the whole suite.
  if (!named.every((w) => file.test(w) && !/[*?{}[\]]/.test(w))) return {};
  return related ? { scoped: 0, related: named } : { scoped: named.length };
}

/** One shell command's kind and identity, or null when it is not a heavy step at all. */
function stepOfSegment(raw: string, scripts: Record<string, string>): HeavyStep | null {
  const s = raw.trim().replace(ENV_PREFIX, '').replace(WRAPPER, '').replace(REDIRECT, ' ').trim();
  const npm = /^(?:npm|pnpm|yarn)\s+(?:run\s+)?(\S+)(.*)$/.exec(s);
  // What the script really runs decides: `verify:sleep-debt` here is vitest, not a browser.
  if (npm && scripts[npm[1]] && !/\bnpm\b|&&/.test(scripts[npm[1]])) {
    const inner = stepOfSegment(`${scripts[npm[1]]}${npm[2]}`, {});
    // What repeats is the thing run, however it was spelled; a build keeps its own name, so
    // build:cli and build:dashboard stay two limits.
    if (inner) return { ...inner, target: inner.kind === 'build' ? npm[1] : inner.target };
  }
  // `tsup && vitest run` builds, whatever else it does.
  if (npm && /&&/.test(scripts[npm[1]] ?? '') && scripts[npm[1]].split('&&').some((part) => stepOfSegment(part, {})?.kind === 'build')) return { kind: 'build', target: npm[1] };
  if (npm && /^verify[:-]/.test(npm[1])) return { kind: 'browser', target: npm[1] };
  const verify = /^node\s+(?:\.\/)?(scripts\/verify\/\S+\.m?js)\b/.exec(s);
  // `--build` is a whole dashboard build before the glance: that is no glance.
  if (verify) return { kind: 'browser', target: verify[1], ...(verify[1] === 'scripts/verify/look.mjs' && !/\s--build\b/.test(s) ? { scoped: 1 } : {}) };
  if (/^(?:npx\s+)?playwright\s+test\b/.test(s)) return { kind: 'browser', target: 'playwright' };
  if (npm && /^build(?::\S+)?$/.test(npm[1])) return { kind: 'build', target: npm[1] };
  const bundler = /^(?:npx\s+)?(tsup|vite\s+build)\b/.exec(s);
  if (bundler) return { kind: 'build', target: bundler[1] };
  const testScript = /^(?:npm|pnpm|yarn)\s+(?:run\s+)?t(?:est)?(?:\s+--)?(\s.*)?$/.exec(s);
  const runner = /^(?:npx\s+)?(?:vitest|jest)(\s.*)?$/.exec(s);
  if (testScript || runner) {
    const config = /(?:--config|\s-c)[ =](\S+)/.exec(s)?.[1];
    const args = (testScript ?? runner)![1] ?? '';
    return namesTests(args) ? { kind: 'check', target: 'tests', ...namedFiles(args) } : { kind: 'suite', target: config ? `suite ${config}` : 'suite' };
  }
  if (/^(?:npx\s+)?tsc\b/.test(s) && !/\b--version\b/.test(s)) return { kind: 'check', target: 'tsc', ...(/\s--noEmit\b/.test(s) ? {} : { emits: true }) };
  return null;
}

/**
 * Text that is never run: heredoc bodies and comment lines. A commit message that mentions
 * `npm run build` must not read as a build.
 */
function withoutInertText(command: string): string {
  const kept: string[] = [];
  let until: string | null = null;
  for (const line of command.split('\n')) {
    if (until !== null) {
      if (line.trim() === until) until = null;
      continue;
    }
    if (line.trimStart().startsWith('#')) continue;
    until = /(?<!<)<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(line)?.[1] ?? null;
    kept.push(line);
  }
  return kept.join('\n');
}

/** The chain's shell segments, quotes kept whole so a separator inside one does not split it. */
export function shellSegments(raw: string): string[] {
  const command = withoutInertText(raw);
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === '\\' && quote === '"') { cur += c + (command[++i] ?? ''); continue; }
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') { out.push(cur); cur = ''; i += 1; continue; }
    // A lone `&` backgrounds and moves on; `2>&1` and `&>` are redirects.
    if (c === '&' && command[i - 1] !== '>' && command[i + 1] !== '>') { out.push(cur); cur = ''; continue; }
    if (c === ';' || c === '|' || c === '\n') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

const RANK: readonly HeavyKind[] = ['browser', 'build', 'suite', 'check'];

/** A command line's heaviest step, or null when it holds none. */
export function heavyStep(command: string, scripts: Record<string, string> = {}): HeavyStep | null {
  return heaviest(shellSegments(command), scripts);
}

function heaviest(segments: string[], scripts: Record<string, string>): HeavyStep | null {
  const steps = segments.map((s) => stepOfSegment(s, scripts)).filter((k): k is HeavyStep => k !== null);
  for (const kind of RANK) {
    const step = steps.find((x) => x.kind === kind);
    if (step) return step;
  }
  return null;
}

export const classifyHeavy = (command: string): HeavyKind | null => heavyStep(command)?.kind ?? null;

/** A command the agent ran straight past the lock: a heavy step outside `builder heavy`. */
export function directHeavy(command: string): HeavyKind | null {
  const direct = shellSegments(command).filter((s) => !/^(?:\S+=\S*\s+)*(?:npx\s+)?dreamcontext\s+builder\s/.test(s));
  return heaviest(direct, {})?.kind ?? null;
}

/** POSIX single quotes, the only form that keeps text inert when pasted back into a shell. */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** This repo's package.json scripts; none when it cannot be read. */
export function packageScripts(cwd: string): Record<string, string> {
  try {
    return (JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8')) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return {};
  }
}

export interface BudgetBucket { runs: number; reds: number; last: string }

export interface BudgetOverrun { at: string; bucket: string; kind: BudgetKind; command: string; reason: string }

export interface BudgetFile {
  version: 1;
  buckets: Record<string, BudgetBucket>;
  /** The phase each branch stands in, moved by `builder test` and `builder lane`. */
  phases: Record<string, { run: string; phase: string; at: string }>;
  /** Every run that took the way out, the trail the owner can read. */
  overruns: BudgetOverrun[];
}

const empty = (): BudgetFile => ({ version: 1, buckets: {}, phases: {}, overruns: [] });

export function budgetPath(cwd: string): string {
  return join(heavyRepoDir(cwd), 'dc-run-budget.json');
}

export function readBudget(path: string): BudgetFile {
  try {
    if (!existsSync(path)) return empty();
    const v = JSON.parse(readFileSync(path, 'utf-8')) as Partial<BudgetFile>;
    return { version: 1, buckets: v.buckets ?? {}, phases: v.phases ?? {}, overruns: v.overruns ?? [] };
  } catch {
    return empty();
  }
}

function writeBudget(path: string, file: BudgetFile, nowMs: number): void {
  for (const [key, b] of Object.entries(file.buckets)) {
    if (nowMs - Date.parse(b.last) > BUDGET_BUCKET_MAX_AGE_MS) delete file.buckets[key];
  }
  for (const [branch, p] of Object.entries(file.phases)) {
    if (nowMs - Date.parse(p.at) > BUDGET_BUCKET_MAX_AGE_MS) delete file.phases[branch];
  }
  file.overruns = file.overruns.slice(-MAX_OVERRUNS);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 1)}\n`);
  renameSync(tmp, path);
}

/** Runs this bucket may still start: the limit, plus one once a run came back red. */
export function allowedRuns(kind: BudgetKind, bucket: BudgetBucket | undefined): number {
  return BUDGET_LIMITS[kind] + ((bucket?.reds ?? 0) > 0 ? 1 : 0);
}

function fresh(bucket: BudgetBucket | undefined, nowMs: number): BudgetBucket | undefined {
  return bucket && nowMs - Date.parse(bucket.last) <= BUDGET_BUCKET_MAX_AGE_MS ? bucket : undefined;
}

export interface BudgetScope { branch: string; run: string; phase: string }

export const scopeKey = (s: BudgetScope, target: string): string => `${s.branch} ${s.run} ${s.phase} ${target}`;

/**
 * Why this run may not start, or null. A light change has two refusals of its own: a browser
 * with nothing visible changed, and running a verify script the change wrote for itself.
 */
export function refusal(file: BudgetFile, scope: BudgetScope, kind: BudgetKind, target: string, nowMs: number, lane?: LanePick): string | null {
  if (kind === 'browser' && lane?.lane === 'light') {
    if (!lane.visible) return `this is a light change (${lane.reason}) and nothing visible changed, so it takes no browser run; if a criterion is about what the owner sees, say so with --because`;
    if (lane.customScripts.includes(target)) return `a light change (${lane.reason}) writes no verify script of its own (${target}); use the shared one: node scripts/verify/look.mjs`;
  }
  const bucket = fresh(file.buckets[scopeKey(scope, target)], nowMs);
  const allowed = allowedRuns(kind, bucket);
  if ((bucket?.runs ?? 0) < allowed) return null;
  return `${bucket!.runs} run(s) of ${target} already in phase "${scope.phase}" of ${scope.branch} (limit ${allowed}${bucket!.reds > 0 ? ', the extra run after a red included' : ''})`;
}

/** Has this run already spent its one way out on this command? Any phase counts. */
export function becauseSpent(file: BudgetFile, scope: BudgetScope, target: string): boolean {
  const head = `${scope.branch} ${scope.run} `;
  return file.overruns.some((o) => o.bucket.startsWith(head) && o.bucket.endsWith(` ${target}`));
}

/** Count a run as it starts: one killed half way still spent its minutes. Never throws. */
export function recordStart(path: string, scope: BudgetScope, kind: BudgetKind, target: string, nowMs: number, overrun?: { command: string; reason: string }): void {
  try {
    const file = readBudget(path);
    const key = scopeKey(scope, target);
    const at = new Date(nowMs).toISOString();
    const prev = fresh(file.buckets[key], nowMs);
    file.buckets[key] = { runs: (prev?.runs ?? 0) + 1, reds: prev?.reds ?? 0, last: at };
    if (overrun) file.overruns.push({ at, bucket: key, kind, command: overrun.command.slice(0, 300), reason: overrun.reason.slice(0, 500) });
    writeBudget(path, file, nowMs);
  } catch { /* the budget never fails a check */ }
}

export function recordRed(path: string, scope: BudgetScope, target: string, nowMs: number): void {
  try {
    const file = readBudget(path);
    const b = file.buckets[scopeKey(scope, target)];
    if (!b) return;
    b.reds += 1;
    b.last = new Date(nowMs).toISOString();
    writeBudget(path, file, nowMs);
  } catch { /* the budget never fails a check */ }
}

/** A reason a reader can use: the flag is the way out, so it must say something. */
export const validReason = (reason: string | undefined): reason is string => (reason ?? '').trim().length >= 10;

function branchOf(cwd: string): string | null {
  try {
    return execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/** Move this branch to a phase. `run` empty keeps the run it stands in. Never throws. */
export function markPhase(cwd: string, phase: string, run: string | undefined, nowMs: number): void {
  try {
    const branch = branchOf(cwd);
    if (!branch) return;
    const path = budgetPath(cwd);
    const file = readBudget(path);
    file.phases[branch] = { run: run ?? file.phases[branch]?.run ?? '-', phase, at: new Date(nowMs).toISOString() };
    writeBudget(path, file, nowMs);
  } catch { /* the budget never fails a check */ }
}

/**
 * Where a check stands, or null when nothing is limited: no run opened a phase on this branch
 * (a plain chat, a release), or there is no branch to count on (not a repo, a detached HEAD).
 */
export function currentScope(cwd: string, nowMs: number = Date.now()): BudgetScope | null {
  const branch = branchOf(cwd);
  if (!branch) return null;
  const p = readBudget(budgetPath(cwd)).phases[branch];
  return p && nowMs - Date.parse(p.at) <= BUDGET_BUCKET_MAX_AGE_MS ? { branch, run: p.run, phase: p.phase } : null;
}
