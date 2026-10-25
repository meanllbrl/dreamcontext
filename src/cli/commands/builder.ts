import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { constants } from 'node:os';
import {
  HEAVY_DEFAULT_WAIT_S,
  HEAVY_LOCK_BUSY_EXIT,
  HEAVY_MACHINE_SLOTS,
  TASK_ID_RE,
  classifyBuilderResult,
  findOrphanChecks,
  formatLoad,
  heavyLockPath,
  heavySlotDir,
  heavySpawnPlan,
  listProcesses,
  machineLoad,
  repoToplevel,
  type OrphanCheck,
} from '../../lib/builder-tools.js';
import { HEAVY_HOT_WAIT_S, acquireHeavyReporting } from '../../lib/heavy-acquire.js';
import { RouterPlanError, parseRouterPlan, pickEndReview } from '../../lib/review-route.js';
import { DEFAULT_SESSION_DEPS, registerBuilderSessionCommands, type SessionDeps } from './builder-sessions.js';

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
 *   review-pick <file>  which end review a run gets, from the review-router's plan: one
 *                   reviewer or multi-review (exit 2 = no plan in the file).
 *   base | spawn | fork | resume | wait | test | status   start and track builder sessions,
 *                   and the lead's wave-end check (./builder-sessions.ts).
 */

/** `report`'s exit code for anything but `reported`. */
export const BUILDER_REPORT_NOT_DONE_EXIT = 3;


export interface BuilderDeps {
  cwd: () => string;
  print: (line: string) => void;
  printErr: (line: string) => void;
  ps: () => string;
  kill: (pid: number) => void;
  /** The machine-wide heavy slots' folder (tests pass a scratch one). */
  heavySlotDir?: () => string;
  /** How many heavy steps the machine runs at once now (default: the heat limit, lib/heat.ts). */
  heavyLimit?: () => Promise<number>;
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

/** `review-pick`'s exit code when the file holds no readable dispatch plan: re-run the router. */
export const REVIEW_PICK_UNREADABLE_EXIT = 2;

/**
 * Which end review the run gets: prints `reviewer: <why>`, or `multi-review: <why>; team: <agents>`
 * (review-edge-cases first, then each named specialist), and exits 0,
 * or exits {@link REVIEW_PICK_UNREADABLE_EXIT} when the router's output holds no plan.
 */
export function builderReviewPick(deps: BuilderDeps, file: string): number {
  const text = existsSync(file) ? readFileSync(file, 'utf-8') : null;
  if (text === null) {
    deps.printErr(`builder review-pick: no file "${file}"; write the review-router's output there first`);
    return REVIEW_PICK_UNREADABLE_EXIT;
  }
  try {
    const pick = pickEndReview(parseRouterPlan(text));
    deps.print(`${pick.kind}: ${pick.reason}${pick.team.length > 0 ? `; team: ${pick.team.join(', ')}` : ''}`);
    return 0;
  } catch (err) {
    if (!(err instanceof RouterPlanError)) throw err;
    deps.printErr(`builder review-pick: ${err.message}; re-run the review-router`);
    return REVIEW_PICK_UNREADABLE_EXIT;
  }
}

export async function builderHeavy(deps: BuilderDeps, argv: string[], opts: { maxWait?: string }): Promise<number> {
  const plan = heavySpawnPlan(argv);
  if (!plan) {
    deps.printErr('builder heavy: give the command after --, e.g. dreamcontext builder heavy -- npx tsc --noEmit');
    return 2;
  }
  const maxWaitS = opts.maxWait == null ? undefined : Number(opts.maxWait);
  if (maxWaitS !== undefined && (!Number.isFinite(maxWaitS) || maxWaitS < 0)) {
    deps.printErr(`builder heavy: --max-wait must be seconds, got "${opts.maxWait}"`);
    return 2;
  }
  const started = Date.now();
  const { held, busy } = await acquireHeavyReporting({
    cwd: deps.cwd(), lockPath: heavyLockPath(deps.cwd()), slotDir: deps.heavySlotDir?.() ?? heavySlotDir(),
    maxWaitS, heavyLimit: deps.heavyLimit, ps: deps.ps,
  });
  if (!held) {
    deps.printErr(`builder heavy: ${busy}`);
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
      held.release();
      resolveExit(code);
    };
    child.on('error', (err) => {
      deps.printErr(`builder heavy: could not start "${plan.file}": ${err.message}`);
      done(127);
    });
    child.on('exit', (code, signal) => done(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1)));
  });
}

export function registerBuilderCommand(program: Command, deps: BuilderDeps = DEFAULT_DEPS, sessionDeps: SessionDeps = DEFAULT_SESSION_DEPS): void {
  const cmd = program
    .command('builder')
    .description('Headless builder sessions: start, fork, resume and wait for them; machine load, the heavy-check lock, and whether a builder reported');

  cmd
    .command('load')
    .option('--reap', 'Kill (SIGTERM) the orphaned type-checkers and test runners of this repo it lists')
    .description('Print cores, the 1-min load average and busy|quiet, plus orphaned checkers of this repo (always exits 0)')
    .action((opts: { reap?: boolean }) => builderLoad(deps, opts));

  cmd
    .command('heavy')
    .argument('<command...>', 'The check to run, after --')
    .option('--max-wait <seconds>', `How long to wait for the lock (default ${HEAVY_DEFAULT_WAIT_S}, ${HEAVY_HOT_WAIT_S} while the Mac is very hot)`)
    .description(`Run a type-check, build, test run or browser verify script holding this repo's heavy lock and one of the machine's ${HEAVY_MACHINE_SLOTS} heavy slots (every repo together; 1 while macOS says the Mac is very hot), one at a time per repo (exit: the command's, or ${HEAVY_LOCK_BUSY_EXIT} = busy, nothing ran)`)
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

  cmd
    .command('review-pick')
    .argument('<file>', 'The review-router\'s output (its ```json dispatch plan)')
    .description(`Which end review the run gets: one reviewer, or multi-review for a Full tier, a hot path, or UI plus another area (exit ${REVIEW_PICK_UNREADABLE_EXIT} = no plan in the file)`)
    .action((file: string) => {
      process.exitCode = builderReviewPick(deps, file);
    });

  registerBuilderSessionCommands(cmd, sessionDeps);
}
