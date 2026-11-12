import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { heavyRepoDir } from './builder-tools.js';
import type { LanePick } from './run-lane.js';

/**
 * The repeat limit on the slowest proof steps, enforced by `dreamcontext builder heavy`.
 *
 * Measured 2026-10-31 over 20 Develop sessions: 6 browser runs a session where the rule said 1-2,
 * 13 minutes an hour re-running checks after the reviewer, and the proof share of a session up
 * from 40% to 53% after "tests and builds run once" was written down as prose. So the command
 * counts now: per branch, run, CODE TREE and command, a browser run, a full build or a full test
 * suite past its limit is REFUSED before anything starts. A red browser run or build earns one
 * more on the same tree (load, a flaky harness). A red full suite earns none: its red files are
 * kept in its suite record (lib/suite-record.ts) and rerun alone by `builder test --failed`
 * (owner, 2026-11-08).
 *
 * Per tree, not per phase (2026-11-12, audit OR-8): counted per phase, a build after the review's
 * fix was a repeat, so 22% of check commands carried `--because` and 31 build overruns cited code
 * that had changed since. A run on code that changed is new proof and always free; the same check
 * on the same code gives the same answer, and that repeat is what is refused. The tree is the
 * receipt's (check-receipt.ts contentTree): tracked edits plus untracked files that are not ignored.
 *
 * A valid check must not trap an agent: `--because "<reason>"` runs it anyway, ONCE per run and
 * command, and leaves a record in the budget file, shown by `dreamcontext builder budget`. It is
 * off the normal path: only a repeat on unchanged code needs it. A second one is refused like any
 * other run: past that the owner decides. Everything here fails open (no git, no tree, a broken
 * file): the limit saves minutes, and it is not worth a blocked check.
 *
 * Only a run is limited, and it says so itself, because a code worktree holds no brain and so
 * cannot read goal-live: `builder open <slug>` starts counting, `builder test --wave N` opens wave
 * N, and `builder lane --from` or `--wave final` opens `end`, which the review, its fixes and the
 * final check share. A plain chat still takes the lock, and nothing counts.
 *
 * A browser run that never reached the product is not proof spent (2026-11-12, audit OR-5: the
 * first browser check of a run was red in 50% of runs, mostly on the script's own setup). A verify
 * script built on scripts/verify/lib/app.mjs fails fast with {@link VERIFY_HARNESS_EXIT}; that run
 * is given back ({@link recordHarness}), {@link HARNESS_FREE_RUNS} times per bucket, so a harness
 * that stays broken still meets the limit. And a script that drives the built app is refused
 * before the queue while `dist/` is older than the code ({@link staleDistFor}).
 *
 * tests/unit/run-budget.test.ts pins it; tests/unit/verify-preflight.test.ts pins the mirror.
 */

/** Runs of one command on one code tree, before the extra run a red earns. */
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
export interface HeavyStep {
  kind: HeavyKind; target: string; scoped?: number; related?: string[]; /** A `tsc` without --noEmit writes files. */ emits?: boolean;
  /**
   * A suite run whose shape is not provably the whole suite: any argument outside
   * {@link wholeSuiteArgs}' allow-list (`--shard`, `--dir`, `--root`, `--bail`, …, deny by
   * default). Heavy like a suite and gated like one, but it never writes or closes a suite
   * record (lib/suite-record.ts).
   */
  partial?: string;
}

/**
 * A verify script's exit when it stopped in its own setup (servers, build, app shell) and tested
 * nothing of the product. Mirrors HARNESS_EXIT in scripts/verify/lib/preflight.mjs.
 */
export const VERIFY_HARNESS_EXIT = 78;

/** HARNESS runs given back per bucket; past them a HARNESS run counts like any red. */
export const HARNESS_FREE_RUNS = 2;

/**
 * What each built output is made from. Mirrors DIST_INPUTS in scripts/verify/lib/preflight.mjs,
 * and is only applied in a repo that holds that file.
 */
export const VERIFY_DIST_INPUTS: readonly { output: string; inputs: readonly string[]; build: string }[] = [
  { output: 'dashboard/dist/index.html', inputs: ['dashboard/src/', 'dashboard/public/', 'dashboard/index.html', 'dashboard/vite.config.ts', 'dashboard/excalidraw-widget-link-icon.ts', 'dashboard/devProxyOrigin.ts', 'dashboard/package.json', 'package.json', 'src/lib/'], build: 'npm run build' },
  { output: 'dist/index.js', inputs: ['src/', 'package.json', 'tsup.config.ts', 'tsconfig.json'], build: 'npm run build:cli' },
  { output: 'dist/dashboard/index.html', inputs: ['dashboard/dist/index.html'], build: 'npm run build:cli' },
];

export const VERIFY_PREFLIGHT_FILE = 'scripts/verify/lib/preflight.mjs';

/** The one way out for an older build on purpose; both sides honor it. Mirrors OLD_BUILD_ON_PURPOSE. */
export const VERIFY_OLD_BUILD_ON_PURPOSE = 'DC_VERIFY_DIST=dist/index.js';

/** A verify script that runs the BUILT app: `--build`, `openApp({ build: true })`, or a path to dist. */
const DRIVES_DIST = /\bbuild:\s*true\b|\bdistIndex\(|(?<![\w/@.-])dist\/(?:index\.js|dashboard)\b|['"]dist['"]\s*,\s*['"](?:index\.js|dashboard)['"]/;

/**
 * Does this browser command run the built app? `--build` on the line, or its script's text says
 * so. `DC_VERIFY_DIST=` on the line points at another build on purpose (a before run): no.
 */
export function drivesDist(command: string, script: string, toplevel: string): boolean {
  if (/(?:^|\s)DC_VERIFY_DIST=/.test(command)) return false;
  if (/\s--build(?=\s|$)/.test(command)) return true;
  try { return DRIVES_DIST.test(readFileSync(join(toplevel, script), 'utf-8')); } catch { return false; }
}

/**
 * Why the built app is older than its code, with the build that fixes it, or null when it is
 * current or cannot be told (no preflight file here, no git). Mtime-based, like the script's own
 * preflight: a source newer than its output.
 */
export function staleDistFor(toplevel: string): { why: string; build: string } | null {
  if (!existsSync(join(toplevel, VERIFY_PREFLIGHT_FILE))) return null;
  const mtime = (p: string): number | null => { try { return statSync(p).mtimeMs; } catch { return null; } };
  for (const { output, inputs, build } of VERIFY_DIST_INPUTS) {
    const built = mtime(join(toplevel, output));
    if (built === null) return { why: `there is no ${output}`, build };
    let listed: string[];
    try {
      const folders = inputs.filter((p) => p.endsWith('/'));
      listed = folders.length === 0 ? [] : execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...folders], { cwd: toplevel, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
    } catch {
      return null;
    }
    const files = [...new Set([...listed, ...inputs.filter((p) => !p.endsWith('/'))])];
    const newer = files.filter((f) => (mtime(join(toplevel, f)) ?? 0) > built);
    if (newer.length) return { why: `${output} is older than ${newer.slice(0, 3).join(', ')}${newer.length > 3 ? ` and ${newer.length - 3} more` : ''}`, build };
  }
  return null;
}

/** `builder heavy`'s exit code for a refusal. Not 75: running it again will not help. */
export const HEAVY_OVER_BUDGET_EXIT = 77;

/** A bucket untouched this long belongs to finished work: long enough for a usage-limit pause. */
export const BUDGET_BUCKET_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const MAX_OVERRUNS = 200;

const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+)+/;
/** `timeout 120 node …` (or `timeout -k 5 120 node …`) is still the node run (measured 2026-11-08: one of the shapes that slipped past). */
const WRAPPER = /^(?:(?:sudo|time|command|exec|nice|npx\s+--yes|timeout(?:\s+(?:-[ks]\s+\S+|-\S+|[A-Z]+))*\s+\d+(?:\.\d+)?[smhd]?)\s+)+/;
/**
 * A verify script run however it is spelled: `npx tsx`, `pnpm exec tsx`, `bunx tsx`, `bun`, a `../../` or absolute path, a
 * node flag first. Measured over the Develop runs after the hook gate landed (2026-10-31 to
 * 11-08): every direct run the strict `node scripts/verify/x.mjs` shape missed was one of these.
 * `node --check` only parses the file, so it runs nothing.
 */
const VERIFY_RUN = /^(?:npx\s+(?:--yes\s+)?|(?:pnpm|yarn)\s+(?:exec\s+|dlx\s+)?|bunx\s+)?(?:node|tsx|ts-node|bun)\s+((?:-\S+(?:\s+[^-\s'"/.]\S*)?\s+)*)(\S*?)(scripts\/verify\/\S+?\.(?:m?[jt]s|c[jt]s))(?=$|[\s)'"])/;
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

/** Flags that change how a whole suite runs, never which files it runs; the value-taking ones. */
const WHOLE_SUITE_FLAG = /^--(?:reporter|maxWorkers|minWorkers|testTimeout|hookTimeout|teardownTimeout|outputFile|pool|retry|config|silent|passWithNoTests|no-file-parallelism|fileParallelism|color|no-color|logHeapUsage|clearScreen|no-watch|isolate|no-isolate|run)(?:=\S*)?$/;
const WHOLE_SUITE_VALUE = /^(?:-c|--(?:reporter|maxWorkers|minWorkers|testTimeout|hookTimeout|teardownTimeout|outputFile|pool|retry|config))$/;

/**
 * Why a suite's arguments may not be the whole suite (the first one outside the allow-list), or
 * null when every argument provably keeps it whole. Deny by default: a narrowing flag nobody
 * listed (`--dir`, `--root`, `--shard`, `--project`, `--bail`) must never close a record green.
 * A config outside the repo is not this repo's suite either.
 */
export function wholeSuiteArgs(args: string): string | null {
  const words = args.trim().split(/\s+/).filter((w) => w && w !== '&' && w !== '--');
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === 'run') continue;
    if (WHOLE_SUITE_VALUE.test(w) && !w.includes('=')) {
      const v = words[i + 1];
      if (v === undefined || v.startsWith('-')) return w;
      if (/^(?:-c|--config)$/.test(w) && (v.startsWith('/') || /(?:^|\/)\.\.(?:\/|$)/.test(v))) return `${w} ${v}`;
      i += 1;
      continue;
    }
    if (WHOLE_SUITE_FLAG.test(w)) {
      if (/^--config=/.test(w) && /=(?:\/|.*(?:^|\/)\.\.(?:\/|$))/.test(w)) return w;
      continue;
    }
    return w;
  }
  return null;
}

/** One shell command's kind and identity, or null when it is not a heavy step at all. */
function stepOfSegment(raw: string, scripts: Record<string, string>): HeavyStep | null {
  const s = raw.trim().replace(/^[({]\s*/, '').replace(ENV_PREFIX, '').replace(WRAPPER, '').replace(REDIRECT, ' ').trim();
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
  const verify = VERIFY_RUN.exec(s);
  // `--build` is a whole dashboard build before the glance: that is no glance. The target is the
  // repo-relative path, so `../../scripts/verify/a.mjs` and `scripts/verify/a.mjs` are one limit.
  if (verify && !/(?:^|\s)(?:--check|-c)(?:\s|$)/.test(verify[1])) {
    const target = verify[3];
    return { kind: 'browser', target, ...(target === 'scripts/verify/look.mjs' && !/\s--build\b/.test(s) ? { scoped: 1 } : {}) };
  }
  if (/^(?:npx\s+)?playwright\s+test\b/.test(s)) return { kind: 'browser', target: 'playwright' };
  if (npm && /^build(?::\S+)?$/.test(npm[1])) return { kind: 'build', target: npm[1] };
  const bundler = /^(?:npx\s+)?(tsup|vite\s+build)\b/.exec(s);
  if (bundler) return { kind: 'build', target: bundler[1] };
  const testScript = /^(?:npm|pnpm|yarn)\s+(?:run\s+)?t(?:est)?(?:\s+--)?(\s.*)?$/.exec(s);
  const runner = /^(?:npx\s+)?(?:vitest|jest)(\s.*)?$/.exec(s);
  if (testScript || runner) {
    const config = /(?:--config|\s-c)[ =](\S+)/.exec(s)?.[1];
    const args = (testScript ?? runner)![1] ?? '';
    if (namesTests(args)) return { kind: 'check', target: 'tests', ...namedFiles(args) };
    // `npm test` whose script chains (`npm run test:unit`, `tsc && vitest --dir x`) was not read
    // through above: what it runs cannot be told, so it is no provable whole suite.
    const chainedScript = testScript && npm && scripts[npm[1]] && /\bnpm\b|&&/.test(scripts[npm[1]]) ? `a test script that chains (${scripts[npm[1]].slice(0, 60)})` : null;
    const partial = chainedScript ?? wholeSuiteArgs(args);
    return { kind: 'suite', target: config ? `suite ${config}` : 'suite', ...(partial ? { partial } : {}) };
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

/**
 * The npm script a command's suite runs (`npm test`, `pnpm run test:unit`) when that script is
 * not in `scripts`: what it runs cannot be read, so it is no provable whole suite. null when the
 * suite is not an npm script, or its script is there.
 */
export function suiteScriptUnread(command: string, scripts: Record<string, string>): string | null {
  for (const seg of shellSegments(command)) {
    if (stepOfSegment(seg, scripts)?.kind !== 'suite') continue;
    const npm = /^(?:npm|pnpm|yarn)\s+(?:run\s+)?(\S+)/.exec(seg.trim().replace(/^[({]\s*/, '').replace(ENV_PREFIX, '').replace(WRAPPER, ''));
    const name = npm?.[1] === 't' ? 'test' : npm?.[1];
    if (name && scripts[name] === undefined) return name;
  }
  return null;
}

/**
 * The whole-suite step anywhere in a command line, also inside an npm script that chains it
 * (`"test:all": "npm run build && vitest"`), whatever the line's heaviest step is. A suite in a
 * chain must not slip past its record because a build ranks heavier.
 */
export function suiteInCommand(command: string, scripts: Record<string, string> = {}, depth = 0): HeavyStep | null {
  for (const seg of shellSegments(command)) {
    const step = stepOfSegment(seg, scripts);
    if (step?.kind === 'suite') return step;
    // Into every script a segment names (`npm run test:unit` inside "ci"), a few levels deep.
    const npm = /^(?:npm|pnpm|yarn)\s+(?:run\s+)?(\S+)/.exec(seg.trim());
    const script = npm && depth < 4 ? scripts[npm[1]] : undefined;
    if (script) {
      const inner = suiteInCommand(script, scripts, depth + 1);
      if (inner) return inner;
    }
  }
  return null;
}

/** A command the agent ran straight past the lock: a heavy step outside `builder heavy`. */
export function directHeavy(command: string): HeavyKind | null {
  const direct = shellSegments(command).filter((s) => !/^(?:\S+=\S*\s+)*(?:npx\s+)?dreamcontext\s+builder\s/.test(s));
  return heaviest(direct, {})?.kind ?? null;
}

/** POSIX single quotes, the only form that keeps text inert when pasted back into a shell. */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The `builder heavy` line the hook offers for a check run straight. A trailing `| tail -N`
 * hides the check's exit code, so that run could never keep a receipt (lib/check-receipt.ts):
 * it becomes `--tail N` on the check alone. A full suite starts detached, the suite command
 * alone (so its exit is its own and its record can be red), and is followed with `--wait`;
 * while a red suite record is open, the suggestion is to rerun only its files.
 */
export function heavySuggestion(command: string, ctx: { redOpen?: boolean } = {}): string {
  const segments = shellSegments(command);
  const suite = segments.find((seg) => stepOfSegment(seg, {})?.kind === 'suite' && !stepOfSegment(seg, {})?.partial);
  if (suite) {
    if (ctx.redOpen) return 'dreamcontext builder test --failed';
    // A leading `cd <dir> &&` is where the suite runs: kept. A build in the chain runs first, alone.
    const cd = /^\s*(cd\s+\S+)\s*&&/.exec(command)?.[1];
    const alone = `${cd ? `${cd} && ` : ''}${suite.replace(/\s+2>&1\s*$/, '').replace(/^\(+|\)+$/g, '').trim()}`;
    const build = segments.map((seg) => seg.trim()).find((seg) => stepOfSegment(seg, {})?.kind === 'build');
    const first = build ? `dreamcontext builder heavy -- ${shellQuote(`${cd ? `${cd} && ` : ''}${build}`)}, then ` : '';
    return `${first}dreamcontext builder heavy --detach -- ${shellQuote(alone)}, then dreamcontext builder heavy --wait <id> (it prints the id)`;
  }
  const tailed = /^([\s\S]*?)\s*\|\s*tail\s+(?:-n\s*)?-?(\d+)\s*$/.exec(command.trim());
  if (tailed && !/[|;\n]|&&|\|\|/.test(tailed[1].replace(/\s+2>&1$/, '').replace(/^cd\s+\S+\s+&&\s+/, ''))) {
    return `dreamcontext builder heavy --tail ${tailed[2]} -- ${shellQuote(tailed[1].replace(/\s+2>&1$/, ''))}`;
  }
  return `dreamcontext builder heavy -- ${shellQuote(command)}`;
}

/** This repo's package.json scripts; none when it cannot be read. */
export function packageScripts(cwd: string): Record<string, string> {
  try {
    return (JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8')) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return {};
  }
}

export interface BudgetBucket {
  runs: number; reds: number; last: string; /** The log of its last red run, kept so a repeat is answered by reading it. */ log?: string;
  /** HARNESS runs given back on this bucket (at most {@link HARNESS_FREE_RUNS}). */ harness?: number;
}

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

/**
 * Runs this bucket may still start: the limit, plus one once a browser run or build came back
 * red. A suite gets no extra run: its reds are rerun by `builder test --failed`.
 */
export function allowedRuns(kind: BudgetKind, bucket: BudgetBucket | undefined): number {
  return BUDGET_LIMITS[kind] + (kind !== 'suite' && (bucket?.reds ?? 0) > 0 ? 1 : 0);
}

function fresh(bucket: BudgetBucket | undefined, nowMs: number): BudgetBucket | undefined {
  return bucket && nowMs - Date.parse(bucket.last) <= BUDGET_BUCKET_MAX_AGE_MS ? bucket : undefined;
}

/** `tree`: the code the check runs on (null or absent = unknown, and the phase counts instead). */
export interface BudgetScope { branch: string; run: string; phase: string; tree?: string | null }

/** Short enough to read in `builder budget`, long enough never to collide inside one run. */
const treeTag = (tree: string): string => `tree:${tree.slice(0, 12)}`;

export const scopeKey = (s: BudgetScope, target: string): string => `${s.branch} ${s.run} ${s.tree ? treeTag(s.tree) : s.phase} ${target}`;

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
  const where = scope.tree ? `on this exact code (${treeTag(scope.tree)})` : `in phase "${scope.phase}"`;
  return `${bucket!.runs} run(s) of ${target} already ${where} of ${scope.branch} (limit ${allowed}${bucket!.reds > 0 ? ', the extra run after a red included' : ''})${bucket!.log ? `; its last red log: ${bucket!.log}` : ''}`;
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
    file.buckets[key] = { runs: (prev?.runs ?? 0) + 1, reds: prev?.reds ?? 0, last: at, ...(prev?.log ? { log: prev.log } : {}), ...(prev?.harness ? { harness: prev.harness } : {}) };
    if (overrun) file.overruns.push({ at, bucket: key, kind, command: overrun.command.slice(0, 300), reason: overrun.reason.slice(0, 500) });
    writeBudget(path, file, nowMs);
  } catch { /* the budget never fails a check */ }
}

export function recordRed(path: string, scope: BudgetScope, target: string, nowMs: number, log?: string | null): void {
  try {
    const file = readBudget(path);
    const b = file.buckets[scopeKey(scope, target)];
    if (!b) return;
    b.reds += 1;
    b.last = new Date(nowMs).toISOString();
    if (log) b.log = log;
    writeBudget(path, file, nowMs);
  } catch { /* the budget never fails a check */ }
}

/**
 * A run that ended as HARNESS: given back (its run uncounted) while the bucket has free HARNESS
 * runs left, and answers how many it has used; null when none was left (count it as a red).
 */
export function recordHarness(path: string, scope: BudgetScope, target: string, nowMs: number): number | null {
  try {
    const file = readBudget(path);
    const b = file.buckets[scopeKey(scope, target)];
    if (!b || (b.harness ?? 0) >= HARNESS_FREE_RUNS) return null;
    b.runs = Math.max(0, b.runs - 1);
    b.harness = (b.harness ?? 0) + 1;
    b.last = new Date(nowMs).toISOString();
    writeBudget(path, file, nowMs);
    return b.harness;
  } catch {
    return null;
  }
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
