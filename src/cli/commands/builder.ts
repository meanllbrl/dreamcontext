import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { constants } from 'node:os';
import {
  HEAVY_DEFAULT_WAIT_S,
  HEAVY_LOCK_BUSY_EXIT,
  TASK_ID_RE,
  classifyBuilderResult,
  findOrphanChecks,
  formatLoad,
  heavyLockPath,
  heavySpawnPlan,
  listProcesses,
  machineLoad,
  repoToplevel,
  type OrphanCheck,
} from '../../lib/builder-tools.js';
import { acquireFileLockWithin, releaseFileLock } from '../../lib/file-lock.js';

/**
 * `dreamcontext builder …` — what a headless `claude -p` builder and the orchestrator that
 * spawned it run so builders neither choke one machine nor end their run with a check in
 * flight. Unlike `goal-live` (telemetry, always exit 0), these are GATES: their exit codes
 * mean something and callers branch on them.
 *
 *   load [--reap]   one line: cores, 1-min load, busy|quiet; then any orphaned checker of this
 *                   repo (killed with --reap). Always exits 0: it informs, it never blocks.
 *   heavy -- <cmd>  runs <cmd> holding the repo's heavy lock, so builders take turns on the
 *                   type-checker and test runner. Exits with <cmd>'s code, or 75 when the lock
 *                   stayed busy past --max-wait and nothing ran.
 *   report <file> <TaskId>  did that builder finish? reported (exit 0) | unfinished | stopped |
 *                   missing (exit 3), with the line that decided it.
 */

/** `report`'s exit code for anything but `reported`. */
export const BUILDER_REPORT_NOT_DONE_EXIT = 3;

/** Lock age past which a holder whose pid is gone is reclaimed. A live holder never is. */
const HEAVY_LOCK_STALE_MS = 5_000;

export interface BuilderDeps {
  cwd: () => string;
  print: (line: string) => void;
  printErr: (line: string) => void;
  ps: () => string;
  kill: (pid: number) => void;
}

const DEFAULT_DEPS: BuilderDeps = {
  cwd: () => process.cwd(),
  print: (l) => process.stdout.write(`${l}\n`),
  printErr: (l) => process.stderr.write(`${l}\n`),
  ps: listProcesses,
  kill: (pid) => process.kill(pid, 'SIGTERM'),
};

export function builderLoad(deps: BuilderDeps, opts: { reap?: boolean }): void {
  deps.print(formatLoad(machineLoad()));
  let orphans: OrphanCheck[] = [];
  try {
    orphans = findOrphanChecks(deps.ps(), repoToplevel(deps.cwd()));
  } catch (err) {
    deps.printErr(`orphans: not checked (${err instanceof Error ? err.message : String(err)})`);
    return;
  }
  for (const o of orphans) {
    if (!opts.reap) {
      deps.print(`orphan pid ${o.pid} up ${o.etime} ${o.command}`);
      continue;
    }
    try {
      deps.kill(o.pid);
      deps.print(`reaped pid ${o.pid} up ${o.etime} ${o.command}`);
    } catch (err) {
      deps.print(`orphan pid ${o.pid} up ${o.etime} ${o.command} (not reaped: ${(err as NodeJS.ErrnoException).code ?? 'error'})`);
    }
  }
}

export function builderReport(deps: BuilderDeps, file: string, taskId: string): number {
  if (!TASK_ID_RE.test(taskId)) {
    deps.printErr(`builder report: "${taskId}" is not a task id (letters, digits, ".", "_" or "-")`);
    return BUILDER_REPORT_NOT_DONE_EXIT;
  }
  const text = existsSync(file) ? readFileSync(file, 'utf-8') : null;
  const r = classifyBuilderResult(text, taskId);
  deps.print(`${taskId} ${r.verdict}: ${r.detail}`);
  return r.verdict === 'reported' ? 0 : BUILDER_REPORT_NOT_DONE_EXIT;
}

function holderOf(lockPath: string, ps: () => string): string {
  try {
    const { pid } = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid?: number };
    if (typeof pid !== 'number') return 'another check';
    const row = ps().split('\n').find((l) => new RegExp(`^\\s*${pid}\\s`).test(l));
    const command = row?.replace(/^\s*\d+\s+\d+\s+\S+\s+/, '').trim();
    return `pid ${pid}${command ? ` (${command.slice(0, 120)})` : ''}`;
  } catch {
    return 'another check';
  }
}

export async function builderHeavy(deps: BuilderDeps, argv: string[], opts: { maxWait?: string }): Promise<number> {
  const plan = heavySpawnPlan(argv);
  if (!plan) {
    deps.printErr('builder heavy: give the command after --, e.g. dreamcontext builder heavy -- npx tsc --noEmit');
    return 2;
  }
  const waitS = opts.maxWait == null ? HEAVY_DEFAULT_WAIT_S : Number(opts.maxWait);
  if (!Number.isFinite(waitS) || waitS < 0) {
    deps.printErr(`builder heavy: --max-wait must be seconds, got "${opts.maxWait}"`);
    return 2;
  }
  const lockPath = heavyLockPath(deps.cwd());
  const started = Date.now();
  const held = await acquireFileLockWithin(lockPath, {
    waitMs: waitS * 1000, staleMs: HEAVY_LOCK_STALE_MS, pollMs: 1000, verifyPidLiveness: true,
  });
  if (!held) {
    deps.printErr(`builder heavy: the heavy lock is held by ${holderOf(lockPath, deps.ps)} and stayed busy for ${waitS}s; NOTHING ran. Run the same command again.`);
    return HEAVY_LOCK_BUSY_EXIT;
  }
  const waited = Math.round((Date.now() - started) / 1000);
  if (waited > 0) deps.printErr(`builder heavy: waited ${waited}s for the heavy lock`);
  return new Promise<number>((resolveExit) => {
    const child = spawn(plan.file, plan.args, { stdio: 'inherit', shell: plan.shell });
    const forward = (sig: NodeJS.Signals) => () => { child.kill(sig); };
    const onTerm = forward('SIGTERM');
    const onInt = forward('SIGINT');
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onInt);
    const done = (code: number) => {
      process.off('SIGTERM', onTerm);
      process.off('SIGINT', onInt);
      releaseFileLock(lockPath);
      resolveExit(code);
    };
    child.on('error', (err) => {
      deps.printErr(`builder heavy: could not start "${plan.file}": ${err.message}`);
      done(127);
    });
    child.on('exit', (code, signal) => done(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1)));
  });
}

export function registerBuilderCommand(program: Command, deps: BuilderDeps = DEFAULT_DEPS): void {
  const cmd = program
    .command('builder')
    .description('Helpers for headless builder sessions: machine load, the heavy-check lock, and whether a builder reported');

  cmd
    .command('load')
    .option('--reap', 'Kill (SIGTERM) the orphaned type-checkers and test runners of this repo it lists')
    .description('Print cores, the 1-min load average and busy|quiet, plus orphaned checkers of this repo (always exits 0)')
    .action((opts: { reap?: boolean }) => builderLoad(deps, opts));

  cmd
    .command('heavy')
    .argument('<command...>', 'The check to run, after --')
    .option('--max-wait <seconds>', `How long to wait for the lock (default ${HEAVY_DEFAULT_WAIT_S})`)
    .description(`Run a type-check or test run holding this repo's heavy lock, one at a time across builders (exit: the command's, or ${HEAVY_LOCK_BUSY_EXIT} = lock busy, nothing ran)`)
    .action(async (command: string[], opts: { maxWait?: string }) => {
      process.exitCode = await builderHeavy(deps, command, opts);
    });

  cmd
    .command('report')
    .argument('<file>', 'The builder\'s claude -p --output-format json output (or a log it appends to)')
    .argument('<taskId>', 'The id its brief named, e.g. T4 or w2-A')
    .description(`Did the builder finish? reported (exit 0) | unfinished | stopped | missing (exit ${BUILDER_REPORT_NOT_DONE_EXIT})`)
    .action((file: string, taskId: string) => {
      process.exitCode = builderReport(deps, file, taskId);
    });
}
