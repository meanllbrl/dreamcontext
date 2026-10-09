import { spawn } from 'node:child_process';
import { homedir, arch } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import { accountEnvFor, resolveConfigDir } from '../lib/claude-accounts.js';
import { claudeAwarePath } from '../lib/claude-path.js';
import { gitAvailable, initRepo } from '../lib/git-sync/git.js';
import { CHECK_COPY, CLI_COPY, FIX_COPY, REASON_COPY } from '../lib/onboarding/copy.js';
import { CLI_INTERACTIVE, runFix, type FixOutcome, type RunSink } from '../lib/onboarding/fixes.js';
import { recordPendingGitInit, runPendingGitInits } from '../lib/onboarding/pending-git.js';
import { markFixActive, markFixDone, probeReadiness } from '../lib/onboarding/readiness.js';
import { defaultProbeRunner, resolveProbeUrl } from '../lib/onboarding/runner.js';
import type { CheckScope, FixId, ProbeContext, ReadinessCheck, ReadinessReport } from '../lib/onboarding/types.js';
import { addVault, listVaults } from '../lib/vaults.js';

/**
 * The terminal face of the machine-readiness model: `dreamcontext setup` (its machine
 * phase, the git-init wait and the hand-off to Claude) and `dreamcontext doctor --machine`.
 *
 * Detection and fixes live in `src/lib/onboarding/`; this file only renders, asks, and
 * runs. Every effect goes through {@link TtyDeps}, so the flows are testable without a
 * terminal, a network or a real machine.
 */

const GIT_POLL_MS = 5_000;
const GIT_WAIT_MS = 30 * 60_000;
/** Off macOS a Git install is never a background dialog, but the wait must still read true. */
const GIT_WAITING_GENERIC = 'Waiting for Git to finish installing (press Enter to skip)';

/** The probe context of the CLI surface. */
export function cliProbeContext(home: string = homedir()): ProbeContext {
  return {
    surface: 'cli',
    platform: process.platform,
    arch: arch(),
    home,
    execPath: process.execPath,
    runner: defaultProbeRunner,
    probeUrl: resolveProbeUrl(),
  };
}

// ─── Rendering ─────────────────────────────────────────────────────────────────

function blockedLine(c: ReadinessCheck, report?: ReadinessReport): string {
  if (c.reason) return REASON_COPY[c.reason];
  const titles = (c.blockedBy ?? [])
    .map((id) => report?.checks.find((x) => x.id === id))
    .filter((x): x is ReadinessCheck => !!x)
    .map((x) => CHECK_COPY[x.id].title);
  return titles.length ? `Waiting on ${titles.join(', ')}` : 'Waiting on another step';
}

/** One check as a terminal line: ✓ ✗ ℹ or a dim – (no emoji). */
export function renderCheck(c: ReadinessCheck, report?: ReadinessReport): string {
  const { title, why } = CHECK_COPY[c.id];
  if (c.status === 'ok') {
    const detail = c.version ? ` ${c.version}` : c.account ? ` (${c.account})` : '';
    return `  ${chalk.green('✓')} ${title}${chalk.dim(detail)}`;
  }
  if (c.status === 'unknown') {
    return `  ${chalk.cyan('ℹ')} ${title} ${chalk.dim(REASON_COPY[c.reason ?? 'unverifiable'])}`;
  }
  if (c.status === 'blocked' || c.status === 'unsupported') {
    return `  ${chalk.dim('–')} ${chalk.dim(`${title}: ${blockedLine(c, report)}`)}`;
  }
  const icon = c.tier === 'required' ? chalk.red('✗') : chalk.cyan('ℹ');
  return `  ${icon} ${title} ${chalk.dim(c.reason ? REASON_COPY[c.reason] : why)}`;
}

/**
 * The report as terminal lines, for one scope. The network row shows only when it fails,
 * and the package-manager row only when it is missing (it is part of Node.js otherwise).
 */
export function renderReadiness(report: ReadinessReport, scope: CheckScope = 'machine'): string[] {
  const lines: string[] = [];
  for (const c of report.checks) {
    if (!c.scopes.includes(scope)) continue;
    if ((c.id === 'network' || c.id === 'npm') && c.status === 'ok') continue;
    lines.push(renderCheck(c, report));
    if (c.status !== 'ok' && c.fix && !c.fix.runnable && c.fix.manual) {
      lines.push(`      ${chalk.dim(`Run: ${c.fix.manual}`)}`);
    }
  }
  return lines;
}

// ─── Effects ───────────────────────────────────────────────────────────────────

export interface TtyDeps {
  home: string;
  platform: NodeJS.Platform;
  probe(): Promise<ReadinessReport>;
  runFix(id: FixId, sink: RunSink, signal: AbortSignal): Promise<FixOutcome>;
  /** Run a command with this terminal's stdin/stdout (a sign-in, Claude itself). Resolves the exit code. */
  runInteractive(argv: string[], o?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<number | null>;
  confirm(message: string, def: boolean): Promise<boolean>;
  /** Resolves when the person presses Enter, or when `signal` aborts. */
  waitForEnter(signal: AbortSignal): Promise<void>;
  print(line: string): void;
  runPendingGitInits(): string[];
  recordPendingGitInit(path: string): boolean;
  /** Make sure `path` is a registered project, so a pending `git init` is picked up later. */
  ensureRegistered(path: string): boolean;
  gitUsable(): boolean;
  initRepo(dir: string): void;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  /** The env a sign-in or Claude runs with: Claude's and GitHub's folders on PATH, the account new sessions use. */
  interactiveEnv(): NodeJS.ProcessEnv;
}

/** `base` with `dirs` appended when missing. */
function withDirs(base: string, dirs: string[]): string {
  const entries = base.split(delimiter).filter(Boolean);
  for (const d of dirs) if (!entries.includes(d)) entries.push(d);
  return entries.join(delimiter);
}

function defaultInteractiveEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: withDirs(claudeAwarePath(process.env.PATH ?? ''), [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']),
  };
  let account: Record<string, string | undefined> = {};
  try {
    account = accountEnvFor(resolveConfigDir(null, home), home);
  } catch {
    account = {};
  }
  for (const [k, v] of Object.entries(account)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function defaultEnsureRegistered(path: string, home: string): boolean {
  const target = resolve(path.normalize('NFC'));
  const vaults = listVaults(home);
  if (vaults.some((v) => resolve(v.path.normalize('NFC')) === target)) return true;
  const base = basename(target);
  const names = [base, ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${base}-${n}`)];
  const free = names.find((n) => !vaults.some((v) => v.name === n));
  if (!free) return false;
  try {
    addVault(free, target, home);
    return true;
  } catch {
    return false;
  }
}

function defaultWaitForEnter(signal: AbortSignal): Promise<void> {
  return new Promise((resolveWait) => {
    if (signal.aborted) return resolveWait();
    if (!process.stdin.isTTY) {
      signal.addEventListener('abort', () => resolveWait(), { once: true });
      return;
    }
    const rl = createInterface({ input: process.stdin });
    const done = () => {
      signal.removeEventListener('abort', done);
      rl.close();
      resolveWait();
    };
    rl.once('line', done);
    signal.addEventListener('abort', done, { once: true });
  });
}

export function createTtyDeps(home: string = homedir()): TtyDeps {
  return {
    home,
    platform: process.platform,
    probe: () => probeReadiness(cliProbeContext(home)),
    runFix: (id, sink, signal) => runFix(id, cliProbeContext(home), sink, signal),
    runInteractive: (argv, o = {}) => new Promise((done) => {
      const [file, ...args] = argv;
      if (!file) return done(null);
      const child = spawn(file, args, { stdio: 'inherit', cwd: o.cwd, env: o.env });
      child.on('error', () => done(null));
      child.on('close', (code) => done(code));
    }),
    confirm: (message, def) => confirm({ message, default: def }),
    waitForEnter: defaultWaitForEnter,
    print: (line) => console.log(line),
    runPendingGitInits: () => runPendingGitInits({ home }),
    recordPendingGitInit: (path) => recordPendingGitInit(path, home),
    ensureRegistered: (path) => defaultEnsureRegistered(path, home),
    gitUsable: () => gitAvailable(),
    initRepo,
    sleep: (ms, signal) => new Promise((done) => {
      if (signal.aborted) return done();
      const t = setTimeout(finish, ms);
      function finish() { clearTimeout(t); signal.removeEventListener('abort', finish); done(); }
      signal.addEventListener('abort', finish, { once: true });
    }),
    now: Date.now,
    interactiveEnv: () => defaultInteractiveEnv(home),
  };
}

// ─── Sinks ─────────────────────────────────────────────────────────────────────

/** Prints a fix's progress to the terminal: dim output, the GitHub code in bold. */
function printingSink(deps: TtyDeps): RunSink {
  return {
    output(chunk) {
      for (const line of chunk.split('\n')) if (line.trim()) deps.print(`      ${chalk.dim(line.trimEnd())}`);
    },
    progress() { /* the terminal shows the tool's own output instead */ },
    awaiting(kind) {
      if (kind === 'browser') deps.print(`    ${chalk.dim(FIX_COPY['claude-signin'].waiting ?? '')}`);
    },
    deviceCode(c) {
      deps.print(`    Your GitHub code: ${chalk.bold(c.userCode)}`);
      deps.print(`    Open ${chalk.cyan(c.verificationUri)} and enter it. Waiting for you...`);
    },
    onCancel() { /* Ctrl-C ends the whole command */ },
  };
}

/** A sink for a run that keeps going while the terminal asks other questions: prints nothing. */
const quietSink: RunSink = {
  output() {}, progress() {}, awaiting() {}, deviceCode() {}, onCancel() {},
};

// ─── Background fix (the Git install) ──────────────────────────────────────────

export interface BackgroundFix {
  id: FixId;
  done: Promise<FixOutcome>;
  settled(): boolean;
  abort(): void;
}

/** Start a fix that keeps running while setup continues. Registered active until it ends. */
function startBackgroundFix(id: FixId, deps: TtyDeps): BackgroundFix {
  const ac = new AbortController();
  let isSettled = false;
  markFixActive(id);
  const done = deps.runFix(id, quietSink, ac.signal)
    .catch((err: unknown): FixOutcome => ({ ok: false, reason: 'failed', detail: (err as Error).message }))
    .finally(() => {
      isSettled = true;
      markFixDone(id);
    });
  return { id, done, settled: () => isSettled, abort: () => ac.abort() };
}

// ─── Machine phase ─────────────────────────────────────────────────────────────

export type MachineMode = 'interactive' | 'yes' | 'report';

export interface MachinePhaseResult {
  report: ReadinessReport;
  /** Folders a pending `git init` was run for at the start. */
  pendingInitialized: string[];
  ran: FixId[];
  failed: FixId[];
  /** The Git install, still running in the background, when this run started one. */
  gitInstall: BackgroundFix | null;
}

function checkFor(report: ReadinessReport, id: FixId): ReadinessCheck | undefined {
  return report.checks.find((c) => c.fix?.id === id);
}

function confirmMessage(id: FixId, check: ReadinessCheck | undefined, report: ReadinessReport): string {
  const title = check ? CHECK_COPY[check.id].title : '';
  let msg = `${FIX_COPY[id].action}${title ? ` (${title})` : ''}?`;
  if (check?.fix?.editsShellProfile) msg += ' This adds a line to your Terminal setup.';
  const ghPresent = report.checks.find((c) => c.id === 'gh')?.reason !== 'not-installed';
  if ((id === 'github-signin' || id === 'gh-signin') && ghPresent && FIX_COPY[id].scopesNote) {
    msg += ` ${FIX_COPY[id].scopesNote}`;
  }
  return msg;
}

/** Run one fix in the foreground: auto fixes through the model, sign-ins through this terminal. */
async function runForeground(id: FixId, report: ReadinessReport, deps: TtyDeps): Promise<boolean> {
  const sink = printingSink(deps);
  const ac = new AbortController();
  markFixActive(id);
  try {
    deps.print(`    ${chalk.dim(`${FIX_COPY[id].working}...`)}`);
    if (id === 'claude-signin' || id === 'gh-signin') {
      const code = await deps.runInteractive(CLI_INTERACTIVE[id] ?? [], { env: deps.interactiveEnv() });
      return code === 0;
    }
    if (id === 'github-signin') {
      // The GitHub command line tool installed but signed out: sign it in here first, then
      // the model imports that sign-in (only if its scopes are within what we would ask for)
      // or runs its own device flow, printing the code.
      const gh = report.checks.find((c) => c.id === 'gh');
      if (gh?.fix?.id === 'gh-signin') {
        await deps.runInteractive(CLI_INTERACTIVE['github-signin'] ?? [], { env: deps.interactiveEnv() });
      }
    }
    const outcome = await deps.runFix(id, sink, ac.signal);
    if (!outcome.ok && outcome.detail) deps.print(`    ${chalk.red('✗')} ${outcome.detail}`);
    return outcome.ok;
  } finally {
    markFixDone(id);
  }
}

/**
 * The machine phase of `setup` (plan §4 H):
 *  - first, any `git init` left pending from an earlier run (Git may be usable now);
 *  - the report;
 *  - `report`: stops there; `yes`: runs automatic fixes only, no questions;
 *  - `interactive`: starts the Git install first (it runs in the background while the rest
 *    continues), then each fix in plan order with one confirmation each, re-probing after
 *    every fix so the plan follows what actually changed.
 */
export async function runMachinePhase(
  opts: { mode: MachineMode },
  deps: TtyDeps = createTtyDeps(),
): Promise<MachinePhaseResult> {
  const pendingInitialized = deps.runPendingGitInits();
  for (const p of pendingInitialized) deps.print(`  ${chalk.green('✓')} Set up Git in ${p}`);

  let report = await deps.probe();
  deps.print(chalk.bold('  This machine'));
  for (const line of renderReadiness(report)) deps.print(line);

  const result: MachinePhaseResult = { report, pendingInitialized, ran: [], failed: [], gitInstall: null };
  if (opts.mode === 'report') {
    if (!report.ready) deps.print(`  ${chalk.cyan('ℹ')} Next: run dreamcontext setup in a terminal to fix these.`);
    return result;
  }

  const attempted = new Set<FixId>();
  if (opts.mode === 'interactive' && report.plan[0] === 'git-install') {
    attempted.add('git-install');
    const ok = await deps.confirm(
      `${FIX_COPY['git-install'].action}? A macOS window opens; it keeps installing in the background while setup continues.`,
      true,
    );
    if (ok) {
      result.gitInstall = startBackgroundFix('git-install', deps);
      deps.print(`    ${chalk.dim(FIX_COPY['git-install'].waiting ?? '')}`);
    }
  }

  for (;;) {
    const next = report.plan.find((id) => !attempted.has(id) && id !== 'git-install');
    if (!next) break;
    attempted.add(next);
    const check = checkFor(report, next);
    const kind = check?.fix?.kind ?? 'auto';
    if (opts.mode === 'yes' && kind !== 'auto') continue;
    if (opts.mode === 'interactive' && !(await deps.confirm(confirmMessage(next, check, report), true))) continue;
    const ok = await runForeground(next, report, deps);
    (ok ? result.ran : result.failed).push(next);
    if (ok) deps.print(`    ${chalk.green('✓')} ${FIX_COPY[next].done}`);
    report = await deps.probe();
  }

  result.report = report;
  if (result.ran.length || result.failed.length) {
    deps.print(chalk.bold('  This machine now'));
    for (const line of renderReadiness(report)) deps.print(line);
  }
  return result;
}

// ─── Git init while Git is still installing ────────────────────────────────────

export type GitInitOutcome = 'initialized' | 'pending' | 'failed';

function initHere(target: string, deps: TtyDeps): GitInitOutcome {
  try {
    deps.initRepo(target);
    deps.print(`  ${chalk.green('✓')} Git is tracking changes in this folder.`);
    return 'initialized';
  } catch (err) {
    deps.print(`  ${chalk.red('✗')} Could not set up Git here: ${(err as Error).message}`);
    return 'failed';
  }
}

/**
 * Set up Git in `target` while a Git install THIS run started may still be going.
 * Shows a waiting line, checks every 5 s for up to 30 min, and Enter skips. When Git turns
 * usable, `git init` runs right there. On skip or timeout the folder is recorded (and
 * registered, so the record is honoured) for the next `setup` or `doctor --machine`.
 */
export async function awaitGitForInit(
  target: string,
  gitInstall: BackgroundFix | null,
  deps: TtyDeps = createTtyDeps(),
  o: { timeoutMs?: number; pollMs?: number } = {},
): Promise<GitInitOutcome> {
  if (deps.gitUsable()) return initHere(target, deps);
  const timeoutMs = o.timeoutMs ?? GIT_WAIT_MS;
  const pollMs = o.pollMs ?? GIT_POLL_MS;

  if (gitInstall) {
    deps.print(`  ${chalk.dim(deps.platform === 'darwin' ? CLI_COPY.gitWaiting : GIT_WAITING_GENERIC)}`);
    const ac = new AbortController();
    let skipped = false;
    const enter = deps.waitForEnter(ac.signal).then(() => { if (!ac.signal.aborted) skipped = true; });
    const deadline = deps.now() + timeoutMs;
    try {
      while (!skipped && deps.now() < deadline) {
        if (deps.gitUsable()) return initHere(target, deps);
        if (gitInstall.settled() && !(await gitInstall.done).ok) break;
        await Promise.race([deps.sleep(pollMs, ac.signal), enter]);
      }
      if (!skipped && deps.gitUsable()) return initHere(target, deps);
    } finally {
      ac.abort();
    }
  }

  const registered = deps.ensureRegistered(target);
  const recorded = registered && deps.recordPendingGitInit(target);
  deps.print(`  ${chalk.cyan('ℹ')} ${recorded ? CLI_COPY.gitLater : 'Run git init in this folder once Git is installed.'}`);
  return 'pending';
}

// ─── Hand-off ──────────────────────────────────────────────────────────────────

/** Start Claude in `root` with the initializer kickoff, in this terminal. */
export async function handOffToClaude(root: string, prompt: string, deps: TtyDeps = createTtyDeps()): Promise<boolean> {
  const code = await deps.runInteractive(['claude', prompt], { cwd: root, env: deps.interactiveEnv() });
  return code === 0;
}
