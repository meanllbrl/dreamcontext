import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { constants } from 'node:os';
import {
  HEAVY_DEFAULT_WAIT_S,
  HEAVY_LOCK_BUSY_EXIT,
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
import { HEAVY_HOT_WAIT_S, acquireHeavyReporting, queueReport } from '../../lib/heavy-acquire.js';
import { describeHit, dropReceipt, findReceipt, logTail, planShellReceipt, receiptState, scratchLog, writeReceipt, type ReceiptPlan } from '../../lib/check-receipt.js';
import { countRelatedTests, jobKey, queueOf, safeLabel } from '../../lib/heavy-queue.js';
import { RouterPlanError, parseRouterPlan, pickEndReview } from '../../lib/review-route.js';
import {
  BUDGET_LIMITS, HEAVY_OVER_BUDGET_EXIT, becauseSpent, budgetPath, currentScope, heavyStep, markPhase, packageScripts, readBudget,
  recordRed, recordStart, refusal, shellQuote, validReason, type BudgetKind, type BudgetScope,
} from '../../lib/run-budget.js';
import { LIGHT_LANE_MAX_LINES, laneFromGit } from '../../lib/run-lane.js';
import { appendLedger, ledgerLine, ledgerPath, readLedger, recordCheck, recordStart as recordLedgerStart, summarize, waitRows, waitWhy, type LedgerMark } from '../../lib/run-ledger.js';
import { DEFAULT_SESSION_DEPS, registerBuilderSessionCommands, type SessionDeps } from './builder-sessions.js';
import { registerReviewLoopCommands } from './review-loop.js';

/**
 * `dreamcontext builder …` — what a headless `claude -p` builder and the orchestrator that
 * spawned it run so builders neither choke one machine nor end their run with a check in
 * flight. Unlike `goal-live` (telemetry, always exit 0), these are GATES: their exit codes
 * mean something and callers branch on them.
 *
 *   load [--reap]   one line: cores, 1-min load, busy|quiet; then any orphaned checker of this
 *                   repo (killed with --reap). Always exits 0: it informs, it never blocks.
 *   heavy -- <cmd>  runs <cmd> in its line (lib/heavy-queue.ts): a short check through a fast
 *                   slot, the rest holding the repo's heavy lock, smaller first. Exits with
 *                   <cmd>'s code, or 75 when the wait ran out, nothing ran and the place is kept.
 *                   A check that passed on this exact code prints its receipt and does not run
 *                   (lib/check-receipt.ts); --fresh runs it anyway, --tail N shows its last lines.
 *   queue           who holds the lock and who waits, in order.
 *   report <file> <TaskId>  did that builder finish? reported (exit 0) | unfinished | stopped |
 *                   missing (exit 3), with the line that decided it.
 *   review-pick <file>  which end review a run gets, from the review-router's plan: one
 *                   reviewer or multi-review (exit 2 = no plan in the file).
 *   open <slug>     a run starts: from here on `heavy` counts repeats on this branch.
 *   lane            light or full, read off the diff itself (lib/run-lane.ts).
 *   budget          what this branch spent of its repeat limit, and every run past it.
 *   mark | ledger   bracket the review; the run's minutes: code, queue, checks, review.
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
  /** Is the machine past its cores (default: the load average)? Fewer fast slots while it is. */
  machineBusy?: () => boolean;
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

/** `lane`: prints `light: <why>` or `full: <why>`, plus what follows from it. Always exits 0. */
export function builderLane(deps: BuilderDeps, opts: { from?: string; to?: string }): void {
  const pick = laneFromGit(deps.cwd(), opts.from, opts.to);
  // Asked with the run's start tree, it is the step before the end review.
  if (opts.from) markPhase(deps.cwd(), 'end', undefined, Date.now());
  deps.print(`${pick.lane}: ${pick.reason}`);
  deps.print(pick.lane === 'light'
    ? `one reviewer (it reads the security too), no router; browser: ${pick.visible ? 'yes, something visible changed' : 'no, nothing visible changed'}; no verify script of its own`
    : 'review-router, then builder review-pick');
}

/** `why`: this repo's last waits, one line each, every run and no run alike. */
export function builderWhy(deps: BuilderDeps, opts: { last?: string }): number {
  const n = opts.last === undefined ? 20 : Number(opts.last);
  if (!Number.isInteger(n) || n <= 0) {
    deps.printErr(`builder why: --last must be a whole number, got "${opts.last}"`);
    return 2;
  }
  const waits = waitRows(readLedger(ledgerPath(deps.cwd())));
  if (waits.length === 0) deps.print('builder why: no wait on record in this repo');
  for (const r of waits.slice(-n)) deps.print(waitWhy(r));
  return 0;
}

export function builderBudget(deps: BuilderDeps): void {
  const cwd = deps.cwd();
  const file = readBudget(budgetPath(cwd));
  const scope = currentScope(cwd);
  deps.print(`limits per phase: ${Object.entries(BUDGET_LIMITS).map(([k, n]) => `${k} ${n}`).join(', ')}; a red earns one more; light lane under ${LIGHT_LANE_MAX_LINES} lines`);
  deps.print(scope ? `now: ${scope.branch} ${scope.run} ${scope.phase}` : 'now: no run open on this branch, nothing is limited');
  for (const [key, b] of Object.entries(file.buckets)) deps.print(`${key}: ${b.runs} run(s), ${b.reds} red`);
  for (const o of file.overruns) deps.print(`over the limit ${o.at} ${o.bucket}: "${o.reason}" (${o.command})`);
  if (scope) printLedger(deps, scope.run);
}

function printLedger(deps: BuilderDeps, run: string): boolean {
  const s = summarize(readLedger(ledgerPath(deps.cwd()), run), Date.now());
  deps.print(s ? ledgerLine(run, s) : `ledger ${run}: no record (the run has no "builder open")`);
  return s !== null;
}

/** `ledger`: the run's minutes. `--close` stops its clock: the last thing a run does. */
export function builderLedger(deps: BuilderDeps, slug: string | undefined, opts: { close?: boolean }): number {
  const run = slug ?? currentScope(deps.cwd())?.run;
  if (!run) {
    deps.printErr('builder ledger: no run open on this branch; name the task slug');
    return 2;
  }
  if (opts.close) appendLedger(ledgerPath(deps.cwd()), { type: 'mark', run, what: 'close', at: Date.now() });
  return printLedger(deps, run) ? 0 : 3;
}

const MARKS: readonly string[] = ['review-start', 'review-end'];

export function builderMark(deps: BuilderDeps, what: string): number {
  const run = currentScope(deps.cwd())?.run;
  if (!MARKS.includes(what)) {
    deps.printErr(`builder mark: ${MARKS.join(' or ')}, got "${what}"`);
    return 2;
  }
  if (!run) {
    deps.printErr('builder mark: no run open on this branch ("builder open <slug>" starts one)');
    return 2;
  }
  appendLedger(ledgerPath(deps.cwd()), { type: 'mark', run, what: what as LedgerMark, at: Date.now() });
  return 0;
}

/** How long the output may keep draining after the check exited (a leftover process holds it). */
const EXIT_DRAIN_MS = 2000;

/** Lines of a receipt's stored log printed on a hit when no --tail was given. */
const RECEIPT_TAIL_LINES = 15;

/** A green receipt for this command on this code, printed; true when it stands in for the run. */
function printReceipt(deps: BuilderDeps, plan: ReceiptPlan, tail: number | undefined): boolean {
  const state = receiptState(plan);
  const hit = state ? findReceipt(plan, state) : null;
  if (!hit) return false;
  deps.printErr(`builder heavy: ${describeHit(hit)}`);
  const lines = logTail(hit.receipt.log, tail ?? RECEIPT_TAIL_LINES);
  if (lines) deps.print(lines);
  return true;
}

export async function builderHeavy(deps: BuilderDeps, argv: string[], opts: { maxWait?: string; because?: string; fresh?: boolean; tail?: string }): Promise<number> {
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
  if (opts.because !== undefined && !validReason(opts.because)) {
    deps.printErr('builder heavy: --because needs a real reason (10 characters or more); it stays in the trail. NOTHING ran.');
    return 2;
  }
  const tail = opts.tail == null ? undefined : Number(opts.tail);
  if (tail !== undefined && (!Number.isInteger(tail) || tail <= 0)) {
    deps.printErr(`builder heavy: --tail must be a whole number of lines, got "${opts.tail}"`);
    return 2;
  }
  const command = argv.join(' ');
  const step = heavyStep(command, packageScripts(deps.cwd()));
  // The receipt comes first: a check that already passed on this code costs no queue and no budget.
  const planned = step && step.kind !== 'browser' ? planShellReceipt(deps.cwd(), command, packageScripts(deps.cwd())) : null;
  const receiptPlan = planned && 'plan' in planned ? planned.plan : null;
  if (planned && 'skip' in planned) deps.printErr(`builder heavy: no receipt for this run (${planned.skip}); it runs every time`);
  if (receiptPlan && !opts.fresh && printReceipt(deps, receiptPlan, tail)) return 0;
  const kind: BudgetKind | null = !step || step.kind === 'check' ? null : step.kind;
  const target = step?.target ?? '';
  const scope: BudgetScope | null = kind ? currentScope(deps.cwd()) : null;
  const pick = queueOf(command, packageScripts(deps.cwd()), (files) => countRelatedTests(deps.cwd(), files));
  const label = safeLabel(command, packageScripts(deps.cwd()));
  const budget = budgetPath(deps.cwd());
  // Asked before the wait for the lock, so a refused run costs no queueing.
  const over = kind && scope
    ? refusal(readBudget(budget), scope, kind, target, Date.now(), kind === 'browser' ? laneFromGit(deps.cwd()) : undefined)
    : null;
  if (over && opts.because === undefined) {
    deps.printErr(`builder heavy: REFUSED, ${over}. NOTHING ran, and running it again will not help.`);
    deps.printErr(`  Is the proof already there? Use it. A fix goes through "builder test --related <files>".`);
    deps.printErr(`  Is this run truly needed? builder heavy --because "<why>" -- ${shellQuote(command)}  (kept in "builder budget")`);
    return HEAVY_OVER_BUDGET_EXIT;
  }
  if (over && kind && scope && becauseSpent(readBudget(budget), scope, target)) {
    deps.printErr(`builder heavy: REFUSED, ${over}, and this run already spent its one --because on ${target}. NOTHING ran.`);
    deps.printErr('  This stops here: use the proof you have, or put it to the owner.');
    return HEAVY_OVER_BUDGET_EXIT;
  }
  const started = Date.now();
  const { held, busy, line, waits } = await acquireHeavyReporting({
    cwd: deps.cwd(), lockPath: heavyLockPath(deps.cwd()), slotDir: deps.heavySlotDir?.() ?? heavySlotDir(),
    maxWaitS, heavyLimit: deps.heavyLimit, ps: deps.ps, machineBusy: deps.machineBusy,
    job: { key: jobKey(deps.cwd(), command), size: pick.size, label, line: pick.line, shared: pick.shared },
    note: (l) => deps.printErr(`builder heavy: ${l}`),
  });
  if (!held) {
    const gaveUp = Date.now();
    recordCheck(deps.cwd(), { label, line: line ?? pick.line, asked: started, ran: gaveUp, ended: gaveUp, exit: null, waits });
    deps.printErr(`builder heavy: ${busy}`);
    return HEAVY_LOCK_BUSY_EXIT;
  }
  // Queued behind the same check from another session: its receipt may be there now.
  if (receiptPlan && !opts.fresh && printReceipt(deps, receiptPlan, tail)) { held.release(); return 0; }
  const before = receiptPlan ? receiptState(receiptPlan) : null;
  const ran = Date.now();
  recordLedgerStart(deps.cwd(), { label, line: line ?? pick.line, asked: started, ran, waits });
  deps.printErr(`builder heavy: ${line} line (${pick.why}), waited ${Math.round((ran - started) / 1000)}s`);
  if (kind && scope) {
    if (over) deps.printErr(`builder heavy: over the limit (${over}), run on purpose: ${opts.because}`);
    recordStart(budget, scope, kind, target, Date.now(), over ? { command, reason: opts.because! } : undefined);
  }
  // The output is kept (it is the receipt's log) and shown as it comes, or its last --tail lines.
  const logPath = before && receiptPlan ? scratchLog(receiptPlan.toplevel) : null;
  let logFd: number | null = null;
  try { logFd = logPath ? openSync(logPath, 'w') : null; } catch { logFd = null; }
  const kept: string[] = [];
  let partial = '';
  const take = (chunk: Buffer, to: NodeJS.WriteStream) => {
    if (logFd !== null) { try { writeSync(logFd, chunk); } catch { /* the log is a nicety */ } }
    if (tail === undefined) { to.write(chunk); return; }
    const parts = (partial + chunk.toString('utf-8')).split('\n');
    partial = parts.pop() ?? '';
    kept.push(...parts);
    if (kept.length > tail) kept.splice(0, kept.length - tail);
  };
  return new Promise<number>((resolveExit) => {
    const child = spawn(plan.file, plan.args, { cwd: deps.cwd(), stdio: ['inherit', 'pipe', 'pipe'], shell: plan.shell, windowsVerbatimArguments: plan.windowsVerbatimArguments });
    child.stdout?.on('data', (c: Buffer) => take(c, process.stdout));
    child.stderr?.on('data', (c: Buffer) => take(c, process.stderr));
    const forward = (sig: NodeJS.Signals) => () => { child.kill(sig); };
    const onTerm = forward('SIGTERM');
    const onInt = forward('SIGINT');
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onInt);
    let finished = false;
    let grace: NodeJS.Timeout | null = null;
    const done = (code: number) => {
      if (finished) return;
      finished = true;
      if (grace) clearTimeout(grace);
      process.off('SIGTERM', onTerm);
      process.off('SIGINT', onInt);
      if (tail !== undefined) {
        if (partial) kept.push(partial);
        const shown = kept.slice(-tail);
        if (shown.length) deps.print(shown.join('\n'));
      }
      if (logFd !== null) { try { closeSync(logFd); } catch { /* closed */ } }
      if (code === 0 && receiptPlan && before) {
        const r = writeReceipt(receiptPlan, before, { exit: code, ms: Date.now() - ran, fresh: opts.fresh, log: logPath ?? undefined });
        deps.printErr(r ? `builder heavy: green, receipt kept: the same check on the same code will not run again${opts.fresh ? ' (--fresh run recorded)' : ''}` : 'builder heavy: green, but no receipt (the code changed while it ran, or the receipt could not be written)');
      }
      if (code !== 0 && receiptPlan && before) dropReceipt(receiptPlan, before);
      if (logPath) rmSync(logPath, { force: true });
      if (code !== 0 && kind && scope) recordRed(budget, scope, target, Date.now());
      recordCheck(deps.cwd(), { label, line: line ?? pick.line, asked: started, ran, ended: Date.now(), exit: code, waits });
      held.release();
      resolveExit(code);
    };
    child.on('error', (err) => {
      deps.printErr(`builder heavy: could not start "${plan.file}": ${err.message}`);
      done(127);
    });
    const codeOf = (code: number | null, signal: NodeJS.Signals | null) => code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1);
    // 'close' drains the output, so the log and the tail are whole. A process the check left
    // running can hold the pipes open forever, so 'exit' gives them a short grace and then ends:
    // the lock must never be held by a check that is over.
    child.on('close', (code, signal) => done(codeOf(code, signal)));
    child.on('exit', (code, signal) => {
      grace = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); done(codeOf(code, signal)); }, EXIT_DRAIN_MS);
    });
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
    .option('--max-wait <seconds>', `How long to stand in line (default ${HEAVY_DEFAULT_WAIT_S}, ${HEAVY_HOT_WAIT_S} while the Mac is very hot)`)
    .option('--because <reason>', 'Run past the repeat limit, once per run and command; the reason stays in `builder budget`')
    .option('--fresh', 'Run it even when a green receipt for the same code exists (the run is recorded)')
    .option('--tail <lines>', 'Show only the last N lines of its output (instead of piping to tail, which hides the exit code)')
    .description(`Run a type-check, build, test run or browser verify script in its line: a short check through a fast slot, anything else holding this checkout's heavy lock (each worktree has its own) and one of the machine's heavy slots (every repo together; read from its cores and memory at each ask, 2 at thermal state serious, 1 at critical heat or memory pressure), smaller first; a check that already passed on the same code prints its receipt instead of running (exit: the command's, ${HEAVY_LOCK_BUSY_EXIT} = the wait ran out, nothing ran, the place is kept, or ${HEAVY_OVER_BUDGET_EXIT} = past the repeat limit, nothing ran)`)
    .action(async (command: string[], opts: { maxWait?: string; because?: string; fresh?: boolean; tail?: string }) => {
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

  cmd
    .command('open')
    .argument('<slug>', 'The task slug')
    .option('--phase <name>', 'The phase this run enters', 'build')
    .description('A run starts on this branch: `heavy` counts repeats from here on, per phase')
    .action((slug: string, opts: { phase: string }) => {
      markPhase(deps.cwd(), opts.phase, slug, Date.now());
      appendLedger(ledgerPath(deps.cwd()), { type: 'mark', run: slug, what: 'open', at: Date.now() });
      deps.print(`${slug}: phase ${opts.phase}, repeat limit on (builder budget)`);
    });

  cmd
    .command('lane')
    .option('--from <tree>', 'The run\'s start tree (default: where this branch left the default branch)')
    .option('--to <tree>', 'The tree to compare (default: the working tree, untracked files included)')
    .description(`Light or full, read off the diff: light is under ${LIGHT_LANE_MAX_LINES} lines and touches no security, money, data migration or permission path`)
    .action((opts: { from?: string; to?: string }) => builderLane(deps, opts));

  cmd
    .command('budget')
    .description('What this branch spent of the repeat limit on browser runs, builds and full test suites, and every run past it')
    .action(() => builderBudget(deps));

  cmd
    .command('queue')
    .description("Who holds this checkout's heavy lock and the machine's slots, and who waits in each line, in the order they will run")
    .action(() => {
      for (const l of queueReport(heavyLockPath(deps.cwd()), deps.heavySlotDir?.() ?? heavySlotDir(), deps.ps)) deps.print(l);
    });

  cmd
    .command('why')
    .description("Why each recent check of this repo waited, one line per wait: this checkout's lock, full slots, or others ahead in the slot line")
    .option('--last <n>', 'how many waits (default 20)')
    .action((opts: { last?: string }) => { process.exitCode = builderWhy(deps, opts); });

  cmd
    .command('mark')
    .argument('<what>', 'review-start or review-end')
    .description('Bracket the end review in the run\'s ledger')
    .action((what: string) => { process.exitCode = builderMark(deps, what); });

  cmd
    .command('ledger')
    .argument('[slug]', 'The task slug (default: the run open on this branch)')
    .option('--close', 'The run is done: stop its clock')
    .description('One line of the run\'s minutes, from records: code, queue, checks, review')
    .action((slug: string | undefined, opts: { close?: boolean }) => { process.exitCode = builderLedger(deps, slug, opts); });

  registerBuilderSessionCommands(cmd, sessionDeps);
  registerReviewLoopCommands(cmd);
}
