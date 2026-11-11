import { Command, Option } from 'commander';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { constants, homedir } from 'node:os';
import {
  HEAVY_DEFAULT_WAIT_S,
  HEAVY_LOCK_BUSY_EXIT,
  TASK_ID_RE,
  classifyBuilderResult,
  findOrphanChecks,
  formatLoad,
  heavyLockPath,
  heavyRepoDir,
  heavySlotDir,
  heavySpawnPlan,
  listProcesses,
  machineLoad,
  repoToplevel,
  type OrphanCheck,
} from '../../lib/builder-tools.js';
import { HEAVY_HOT_WAIT_S, acquireHeavyReporting, queueReport } from '../../lib/heavy-acquire.js';
import { contentTree, describeHit, dropReceipt, exitNotOwned, findReceipt, gitToplevel, logTail, planShellReceipt, receiptState, scratchLog, writeReceipt, type ReceiptPlan } from '../../lib/check-receipt.js';
import {
  CEILING_STREAK_LIMIT, branchOf, buildCommand, buildInputsChanged, configOf, distCheck, distGateApplies, distProof, distProofHeld, judgeSuiteRun, parseVitestLog, pinTree,
  readSuiteRecord, recordToplevel, suiteLogPath, suiteRecordId, suiteRecordPath, writeSuiteRecord, type DistProof, type SuiteRecord,
} from '../../lib/suite-record.js';
import { countRelatedTests, jobKey, queueOf, safeLabel } from '../../lib/heavy-queue.js';
import { RouterPlanError, parseRouterPlan, pickEndReview } from '../../lib/review-route.js';
import {
  BUDGET_LIMITS, HEAVY_OVER_BUDGET_EXIT, becauseSpent, budgetPath, currentScope, heavyStep, markPhase, packageScripts, readBudget,
  recordRed, recordStart, refusal, shellQuote, shellSegments, suiteInCommand, suiteScriptUnread, validReason, type BudgetKind, type BudgetScope,
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
  /** How `--detach` starts this CLI again (default: this node, this entry file). */
  selfArgv?: () => string[];
  /** Is a detached runner alive (default: signal 0)? */
  alive?: (pid: number) => boolean;
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

export interface HeavyOptions {
  maxWait?: string; because?: string; fresh?: boolean; tail?: string;
  /** Start the check as its own process and return its id at once. */
  detach?: boolean;
  /** Block on a detached check (≤ 9 min a call) and return its exit. */
  wait?: string;
  /** Minutes the check may run, from the moment it runs (default {@link HEAVY_MAX_RUN_MIN}). */
  maxRun?: string;
  /** Internal: the id a detached runner was started under. */
  runId?: string;
}

/** A check that runs past this many minutes is killed, process group and all (plan C5, F8: one ran 504 min). */
/**
 * The way past a refused heavy step (sahip-karti-yerinde K8, D4): the limit stays; the owner's
 * terminal has no hook, so one tap on his bar runs it once. The SAME line hook.ts Gate 1d ends
 * with (`OWNER_RUN_CARD_LINE` there, pinned equal by test).
 */
export const HEAVY_OWNER_RUN_CARD_LINE = 'Still needed? Ask the owner with a run card: post a dream-view run card whose command is the bare command (put any cd inside the command, e.g. cd <folder> && <command>; no absolute cwd). His one tap runs it once in your working folder, and its result comes back to you.';

export const HEAVY_MAX_RUN_MIN = 60;
/** `builder heavy`'s exit when a whole-suite run needs a fresh build first: nothing ran. */
export const HEAVY_BUILD_FIRST_EXIT = 5;
/** `builder heavy --wait`'s exit when the detached runner died with no result. */
export const HEAVY_DIED_EXIT = 4;
/** How long one `--wait` call blocks before it hands back (exit 75, call again). */
export const HEAVY_WAIT_SLICE_S = 540;

/** Where detached checks keep their state and log: the repo's common git dir. */
export const checksDir = (cwd: string): string => join(heavyRepoDir(cwd), 'dc-checks');
const CHECK_ID = /^h[0-9a-z]{6,24}$/;

interface CheckState { id: string; pid: number; state: 'started' | 'done'; command: string; log: string; at: string; exit?: number }

function writeCheckState(cwd: string, s: CheckState): void {
  try {
    mkdirSync(checksDir(cwd), { recursive: true });
    const p = join(checksDir(cwd), `${s.id}.json`);
    writeFileSync(`${p}.${process.pid}.tmp`, `${JSON.stringify(s)}\n`);
    renameSync(`${p}.${process.pid}.tmp`, p);
  } catch { /* the caller reads a missing state as "not started" */ }
}

function readCheckState(cwd: string, id: string): CheckState | null {
  try {
    const s = JSON.parse(readFileSync(join(checksDir(cwd), `${id}.json`), 'utf-8')) as CheckState;
    return s?.id === id && Number.isInteger(s.pid) ? s : null;
  } catch { return null; }
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException)?.code === 'EPERM'; } };

/**
 * The folder a command's suite runs in: the cwd, moved by each `cd`/`pushd` in it. Agents prefix
 * `cd <root> &&` because the shell's folder resets, and the hook offers that line back, so it
 * must key the same record as a run from the root. null = a cd that cannot be resolved here.
 */
function suiteRunDir(command: string, cwd: string): string | null {
  let dir = recordToplevel(cwd);
  for (const raw of shellSegments(command)) {
    const seg = raw.trim().replace(/^[({]\s*/, '').trim();
    const cd = /^(?:cd|pushd)(?:\s+(.+))?$/.exec(seg);
    if (!cd) continue;
    let target = (cd[1] ?? '~').trim().replace(/^(['"])(.*)\1$/, '$2');
    if (target === '~' || target.startsWith('~/')) target = join(homedir(), target.slice(1));
    if (/[$*?`]/.test(target) || /^[-+]/.test(target)) return null;
    dir = recordToplevel(resolve(dir, target));
  }
  return dir;
}

/** The package.json scripts of the folder a command runs in: its cds followed from `cwd`. */
function runScripts(command: string, cwd: string): Record<string, string> {
  return packageScripts(suiteRunDir(command, cwd) ?? cwd);
}

/** A suite run's record context: the worktree, branch and target its record is keyed by. */
interface SuiteCtx { top: string; branch: string | null; target: string; config?: string; /** Where the suite runs (vitest prints paths from here). */ runDir: string }

function suiteCtxOf(cwd: string, target: string): SuiteCtx | null {
  const t = gitToplevel(cwd);
  if (!t) return null;
  const top = recordToplevel(t);
  return { top, branch: branchOf(top), target, config: configOf(target), runDir: recordToplevel(cwd) };
}

/**
 * The whole-suite gate (plan C2): state, not count. A red record refuses (77) with the line that
 * reruns only its files; a live run refuses (75); two ceiling-ended runs in a row refuse (77, the
 * owner's); `--because` overrides a red once. A repo whose suite runs the built CLI must have a
 * fresh build first (5). Null = the run may start.
 */
function suiteGate(deps: BuilderDeps, ctx: SuiteCtx, opts: HeavyOptions, command: string): number | null {
  const { record, warning } = readSuiteRecord(ctx.top, ctx.branch, ctx.target);
  if (warning) deps.printErr(`builder heavy: ${warning}`);
  if (record?.state === 'running') {
    deps.printErr(`builder heavy: a full run of ${ctx.target} is already going on this worktree (pid ${record.pid}). NOTHING ran.`);
    deps.printErr(record.checkId ? `  Follow it: dreamcontext builder heavy --wait ${record.checkId}` : '  Wait for it to end, then read its record.');
    return HEAVY_LOCK_BUSY_EXIT;
  }
  if (record?.state === 'red') {
    if (opts.because === undefined || record.because) {
      deps.printErr(`builder heavy: REFUSED, ${ctx.target} is RED on this worktree and branch (${record.files.length} file(s): ${record.files.slice(0, 5).join(', ')}${record.files.length > 5 ? ', …' : ''}).${record.because ? ' This red already spent its one --because.' : ''} NOTHING ran.`);
      deps.printErr('  Fix those files, then rerun only them plus what your fix touched (the tool reads the diff):');
      deps.printErr('  dreamcontext builder test --failed');
      if (!record.because) deps.printErr(`  A second full run is truly needed? builder heavy --because "<why>" -- ${shellQuote(command)} (shown to the Super and the owner)`);
      return HEAVY_OVER_BUDGET_EXIT;
    }
  }
  if (record?.state === 'incomplete' && (record.ceilingStreak ?? 0) >= CEILING_STREAK_LIMIT && opts.because === undefined) {
    deps.printErr(`builder heavy: REFUSED, the last ${record.ceilingStreak} full runs of ${ctx.target} hit the ${HEAVY_MAX_RUN_MIN}-min ceiling. NOTHING ran. This goes to the owner (or --because "<why>").`);
    return HEAVY_OVER_BUDGET_EXIT;
  }
  if (distGateApplies(ctx.top, ctx.config)) {
    const dc = distCheck(ctx.top);
    if (!dc.ok) {
      deps.printErr(`builder heavy: build first: ${dc.why}. The suite runs the built CLI, and a stale build makes a 35-min run worthless. NOTHING ran.`);
      deps.printErr(`  dreamcontext builder heavy -- ${buildCommand(ctx.top)}`);
      return HEAVY_BUILD_FIRST_EXIT;
    }
  }
  return null;
}

/** Write the suite record from a finished run, and print its verdict last (the red list ends the output). */
function settleSuite(deps: BuilderDeps, ctx: SuiteCtx, o: { exit: number | null; killed?: string; command: string; log: string | null; startTree: string | null; prev: SuiteRecord | null; because?: string; dist: DistProof | null }): void {
  let text = '';
  try { text = o.log ? readFileSync(o.log, 'utf-8') : ''; } catch { text = ''; }
  // The build is judged on the tree the run started from, held to the bytes it started with:
  // an edit made while a detached suite runs is not what it tested.
  const dist = o.dist ? distProofHeld(ctx.top, o.dist) : null;
  const j = judgeSuiteRun({ exit: o.exit, exitNotOwned: exitNotOwned(o.command), summary: parseVitestLog(text), killed: o.killed, dist });
  // vitest prints paths from its own root, the folder it ran in: the record keeps them repo-relative.
  j.files = j.files.map((f) => relative(ctx.top, resolve(ctx.runDir, f)).split(sep).join('/'));
  const id = suiteRecordId(ctx.top, ctx.branch, ctx.target);
  const base = { v: 1 as const, id, pid: process.pid, toplevel: ctx.top, branch: ctx.branch, target: ctx.target, ...(ctx.config ? { config: ctx.config } : {}), at: new Date().toISOString(), log: o.log ?? undefined };
  let rec: SuiteRecord;
  if (j.state === 'red' && o.startTree && pinTree(ctx.top, id, 'red', o.startTree)) {
    rec = { ...base, state: 'red', files: j.files, redTree: o.startTree, reason: j.reason, ...(o.because ? { because: o.because } : {}) };
  } else if (j.state === 'green' && o.startTree && pinTree(ctx.top, id, 'green', o.startTree)) {
    const greenLog = suiteLogPath(ctx.top, ctx.branch, ctx.target, 'green');
    try { if (o.log && greenLog) copyFileSync(o.log, greenLog); } catch { /* the log is a nicety */ }
    rec = { ...base, state: 'green', files: [], greenTree: o.startTree, greenLog: greenLog ?? undefined, reason: j.reason };
  } else if (o.prev?.state === 'red') {
    // A run past a red (--because) that proved nothing leaves the red list as it was.
    rec = { ...o.prev, because: o.because ?? o.prev.because, at: new Date().toISOString() };
    writeSuiteRecord(rec);
    deps.print(`builder heavy: INCOMPLETE, ${j.reason}. The red record stays as it was (${rec.files.length} file(s)): dreamcontext builder test --failed`);
    for (const f of rec.files) deps.print(`  red: ${f}`);
    return;
  } else {
    const why = j.state === 'incomplete' ? j.reason : `${j.reason}, but its tree could not be pinned`;
    const streak = o.killed === 'ceiling' ? (o.prev?.state === 'incomplete' ? (o.prev.ceilingStreak ?? 0) : 0) + 1 : 0;
    rec = { ...base, state: 'incomplete', files: [], reason: why, ...(streak ? { ceilingStreak: streak } : {}) };
  }
  writeSuiteRecord(rec);
  if (rec.state === 'red') {
    deps.print(`builder heavy: RED, ${rec.files.length} file(s), kept in the suite record (log ${o.log}). Fix them, then rerun only them: dreamcontext builder test --failed`);
    for (const f of rec.files) deps.print(`  red: ${f}`);
  } else if (rec.state === 'green') {
    deps.print(`builder heavy: GREEN, the suite record is closed and kept (log ${rec.greenLog ?? o.log})`);
  } else {
    deps.print(`builder heavy: INCOMPLETE, ${rec.reason}. No red list was proven, so nothing is green either (log ${o.log}).`);
  }
}

/** `--detach`: start the check as its own process, print its id once it exists, return. */
async function heavyDetach(deps: BuilderDeps, argv: string[], opts: HeavyOptions): Promise<number> {
  const id = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const dir = checksDir(deps.cwd());
  mkdirSync(dir, { recursive: true });
  const log = join(dir, `${id}.log`);
  const pass = [
    ...(opts.maxWait != null ? ['--max-wait', opts.maxWait] : []), ...(opts.because != null ? ['--because', opts.because] : []),
    ...(opts.fresh ? ['--fresh'] : []), ...(opts.maxRun != null ? ['--max-run', opts.maxRun] : []),
  ];
  const self = deps.selfArgv?.() ?? [process.execPath, process.argv[1]];
  const fd = openSync(log, 'a');
  let pid: number | undefined;
  try {
    const child = spawn(self[0], [...self.slice(1), 'builder', 'heavy', '--run-id', id, ...pass, '--', ...argv], { cwd: deps.cwd(), detached: true, stdio: ['ignore', fd, fd], env: process.env });
    pid = child.pid;
    child.unref();
  } finally {
    closeSync(fd);
  }
  if (pid == null) { deps.printErr('builder heavy: could not start the detached check'); return 1; }
  // The runner writes its state before it stands in line, so a queued check can be followed too.
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    if (readCheckState(deps.cwd(), id)) {
      deps.print(`builder heavy: detached as ${id} (pid ${pid}, log ${log})`);
      deps.print(`  follow it: dreamcontext builder heavy --wait ${id}`);
      return 0;
    }
    if (!alive(pid)) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  deps.printErr(`builder heavy: the detached check did not start (log ${log})`);
  return 1;
}

/** `--wait <id>`: block ≤ {@link HEAVY_WAIT_SLICE_S}, return the check's exit, 75 while it runs, 4 when it died. */
async function heavyWait(deps: BuilderDeps, id: string, opts: HeavyOptions): Promise<number> {
  if (!CHECK_ID.test(id)) { deps.printErr(`builder heavy --wait: "${id}" is not a check id`); return 2; }
  const slice = Math.min(HEAVY_WAIT_SLICE_S, opts.maxWait != null && Number.isFinite(Number(opts.maxWait)) ? Number(opts.maxWait) : HEAVY_WAIT_SLICE_S);
  const until = Date.now() + slice * 1000;
  const tail = opts.tail == null ? 15 : Number(opts.tail);
  for (;;) {
    const s = readCheckState(deps.cwd(), id);
    if (!s) { deps.printErr(`builder heavy --wait: no check ${id} in this repo`); return 2; }
    if (s.state === 'done') {
      const lines = logTail(s.log, Number.isInteger(tail) && tail > 0 ? tail : 15);
      if (lines) deps.print(lines);
      deps.printErr(`builder heavy --wait: ${id} ended, exit ${s.exit}`);
      return s.exit ?? 1;
    }
    // Read again before calling it dead: the runner may have written its end and exited in between.
    if (!(deps.alive ?? alive)(s.pid) && readCheckState(deps.cwd(), id)?.state !== 'done') {
      // Nothing will write its end: a running suite record of that runner is incomplete now.
      const ctxStep = heavyStep(s.command, runScripts(s.command, deps.cwd()));
      const ctx = ctxStep?.kind === 'suite' ? suiteCtxOf(suiteRunDir(s.command, deps.cwd()) ?? deps.cwd(), ctxStep.target) : null;
      if (ctx) {
        const path = suiteRecordPath(ctx.top, ctx.branch, ctx.target);
        try {
          const raw = path ? JSON.parse(readFileSync(path, 'utf-8')) as SuiteRecord : null;
          // The dead runner's record as readSuiteRecord sees it (a red it ran over stays red), written down.
          const view = raw && raw.state === 'running' && raw.pid === s.pid ? readSuiteRecord(ctx.top, ctx.branch, ctx.target).record : null;
          if (view && view.state !== 'running') writeSuiteRecord({ ...view, reason: view.state === 'red' ? view.reason : 'the detached runner died with no result', at: new Date().toISOString() });
        } catch { /* no record to settle */ }
      }
      writeCheckState(deps.cwd(), { ...s, state: 'done', exit: HEAVY_DIED_EXIT });
      deps.printErr(`builder heavy --wait: ${id} died, no result (log ${s.log})`);
      return HEAVY_DIED_EXIT;
    }
    if (Date.now() >= until) {
      deps.printErr(`builder heavy --wait: ${id} still running after ${Math.round(slice)}s; call the same command again`);
      return HEAVY_LOCK_BUSY_EXIT;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * A full suite chained behind a heavier step (`npm run build && npm test`) would run with no
 * record and no gate: it runs on its own line, after the build, or not at all. True = refused.
 */
function chainRefused(deps: BuilderDeps, command: string): boolean {
  const scripts = runScripts(command, deps.cwd());
  if (heavyStep(command, scripts)?.kind === 'suite' || !suiteInCommand(command, scripts)) return false;
  deps.printErr('builder heavy: a full test suite inside a chain runs with no record of its red files. NOTHING ran. Run the parts on their own lines:');
  deps.printErr('  dreamcontext builder heavy -- <the build or check>, then dreamcontext builder heavy --detach -- <the suite alone>, then --wait <id>');
  return true;
}

export async function builderHeavy(deps: BuilderDeps, argv: string[], opts: HeavyOptions): Promise<number> {
  if (opts.wait !== undefined) return heavyWait(deps, opts.wait, opts);
  if (opts.runId !== undefined) {
    if (!CHECK_ID.test(opts.runId)) { deps.printErr('builder heavy: --run-id is internal'); return 2; }
    const log = join(checksDir(deps.cwd()), `${opts.runId}.log`);
    const command = argv.join(' ');
    writeCheckState(deps.cwd(), { id: opts.runId, pid: process.pid, state: 'started', command, log, at: new Date().toISOString() });
    let code = 1;
    try { code = await heavyRun(deps, argv, opts); } finally { writeCheckState(deps.cwd(), { id: opts.runId, pid: process.pid, state: 'done', command, log, at: new Date().toISOString(), exit: code }); }
    return code;
  }
  if (opts.detach) {
    if (!heavySpawnPlan(argv)) { deps.printErr('builder heavy: give the command after --'); return 2; }
    if (chainRefused(deps, argv.join(' '))) return 2;
    return heavyDetach(deps, argv, opts);
  }
  return heavyRun(deps, argv, opts);
}

async function heavyRun(deps: BuilderDeps, argv: string[], opts: HeavyOptions): Promise<number> {
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
  const maxRunMin = opts.maxRun == null ? HEAVY_MAX_RUN_MIN : Number(opts.maxRun);
  if (!Number.isFinite(maxRunMin) || maxRunMin <= 0 || maxRunMin > 24 * 60) {
    deps.printErr(`builder heavy: --max-run must be minutes, at most ${24 * 60}, got "${opts.maxRun}"`);
    return 2;
  }
  const maxRunMs = Math.round(maxRunMin * 60_000);
  const command = argv.join(' ');
  // The scripts of the folder the command runs in (its own cds followed), never the caller's.
  const scripts = runScripts(command, deps.cwd());
  const step = heavyStep(command, scripts);
  if (chainRefused(deps, command)) return 2;
  // The receipt comes first: a check that already passed on this code costs no queue and no budget.
  const planned = step && step.kind !== 'browser' ? planShellReceipt(deps.cwd(), command, scripts) : null;
  const receiptPlan = planned && 'plan' in planned ? planned.plan : null;
  if (planned && 'skip' in planned) deps.printErr(`builder heavy: no receipt for this run (${planned.skip}); it runs every time`);
  if (receiptPlan && !opts.fresh && printReceipt(deps, receiptPlan, tail)) return 0;
  // A whole-suite run is gated on its record's state, and leaves a record (lib/suite-record.ts).
  // A partial one (`--shard`, `--changed`, `--bail`, …) is gated too, but proves no whole suite:
  // it never writes or closes a record.
  const runDir = step?.kind === 'suite' ? suiteRunDir(command, deps.cwd()) : null;
  const suite = step?.kind === 'suite' ? suiteCtxOf(runDir ?? deps.cwd(), step.target) : null;
  // Only a provably whole run keeps a record: the toplevel's own suite, from the toplevel, with
  // nothing but allow-listed flags (run-budget.ts wholeSuiteArgs). Anything else is partial.
  const notWhole = !suite ? null : step?.partial
    ?? (runDir === null ? 'a cd that cannot be resolved here' : null)
    ?? (suite.runDir !== suite.top ? `run in ${relative(suite.top, suite.runDir)}, not the repo root` : null)
    ?? (suiteScriptUnread(command, scripts) ? `its "${suiteScriptUnread(command, scripts)}" script cannot be read in ${suite.runDir}` : null);
  const recordable = suite !== null && !notWhole;
  if (suite && notWhole) deps.printErr(`builder heavy: not provably the whole suite (${notWhole}): it keeps no suite record, and cannot close one`);
  if (suite) {
    const refused = suiteGate(deps, suite, opts, command);
    if (refused !== null) return refused;
  }
  const kind: BudgetKind | null = !step || step.kind === 'check' ? null : step.kind;
  const target = step?.target ?? '';
  const scope: BudgetScope | null = kind ? currentScope(deps.cwd()) : null;
  const pick = queueOf(command, scripts, (files) => countRelatedTests(deps.cwd(), files));
  const label = safeLabel(command, scripts);
  const budget = budgetPath(deps.cwd());
  // A build of changed inputs is not a repeat: the exit-5 hint "build first" must never be refused.
  const top = kind === 'build' ? gitToplevel(deps.cwd()) : null;
  const newBuild = kind === 'build' && top !== null && buildInputsChanged(recordToplevel(top));
  // Asked before the wait for the lock, so a refused run costs no queueing.
  const over = kind && scope && !newBuild
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
    deps.printErr(`  ${HEAVY_OWNER_RUN_CARD_LINE}`);
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
  // Queued: another session may have started (or turned red) the same suite meanwhile.
  if (suite) {
    const refused = suiteGate(deps, suite, opts, command);
    if (refused !== null) { held.release(); return refused; }
  }
  const before = receiptPlan ? receiptState(receiptPlan) : null;
  const ran = Date.now();
  const red = recordable ? readSuiteRecord(suite.top, suite.branch, suite.target).record : null;
  const because = suite && red?.state === 'red' ? opts.because : undefined;
  recordLedgerStart(deps.cwd(), { label, line: line ?? pick.line, asked: started, ran, waits, ...(because ? { because } : {}) });
  deps.printErr(`builder heavy: ${line} line (${pick.why}), waited ${Math.round((ran - started) / 1000)}s`);
  if (kind && scope) {
    if (over) deps.printErr(`builder heavy: over the limit (${over}), run on purpose: ${opts.because}`);
    recordStart(budget, scope, kind, target, Date.now(), over || because ? { command, reason: opts.because! } : undefined);
  }
  if (because) deps.printErr(`builder heavy: a second full run on a RED record, run on purpose: ${because}`);
  // The suite's tree and its `running` record go down before it starts.
  const startTree = recordable ? contentTree(suite.top) : null;
  const proof = recordable && distGateApplies(suite.top, suite.config) ? distProof(suite.top, startTree) : null;
  if (recordable) {
    writeSuiteRecord({
      v: 1, id: suiteRecordId(suite.top, suite.branch, suite.target), state: 'running', pid: process.pid, toplevel: suite.top, branch: suite.branch,
      target: suite.target, ...(suite.config ? { config: suite.config } : {}), at: new Date(ran).toISOString(), maxRunMs, files: red?.files ?? [],
      ...(red?.state === 'red' && red.redTree ? { overRed: { redTree: red.redTree, because: red.because ?? because } } : {}),
      ...(red?.ceilingStreak ? { ceilingStreak: red.ceilingStreak } : {}), ...(opts.runId ? { checkId: opts.runId } : {}),
    });
  }
  // The output is kept (it is the receipt's log, and a suite's record log) and shown as it comes, or its last --tail lines.
  const suiteLog = recordable ? suiteLogPath(suite.top, suite.branch, suite.target) : null;
  const logPath = suiteLog ?? (before && receiptPlan ? scratchLog(receiptPlan.toplevel) : null);
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
  // Its own process group (POSIX), so the ceiling and a signal end the check and every worker it started.
  const ownGroup = process.platform !== 'win32';
  return new Promise<number>((resolveExit) => {
    const child = spawn(plan.file, plan.args, { cwd: deps.cwd(), stdio: ['ignore', 'pipe', 'pipe'], shell: plan.shell, windowsVerbatimArguments: plan.windowsVerbatimArguments, detached: ownGroup });
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (ownGroup && child.pid) process.kill(-child.pid, sig);
        // Windows has no process groups: the tree goes with taskkill, or the workers outlive the shell.
        else if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else child.kill(sig);
      } catch { /* already gone */ }
    };
    child.stdout?.on('data', (c: Buffer) => take(c, process.stdout));
    child.stderr?.on('data', (c: Buffer) => take(c, process.stderr));
    let killed: string | undefined;
    const forward = (sig: NodeJS.Signals) => () => { killed = killed ?? `signal ${sig}`; killGroup(sig); };
    const onTerm = forward('SIGTERM');
    const onInt = forward('SIGINT');
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onInt);
    const ceiling = setTimeout(() => {
      killed = 'ceiling';
      deps.printErr(`builder heavy: the check ran past its ${maxRunMin}-min ceiling; its process group is killed`);
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 3000).unref();
    }, maxRunMs);
    let finished = false;
    let grace: NodeJS.Timeout | null = null;
    const done = (code: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(ceiling);
      if (grace) clearTimeout(grace);
      process.off('SIGTERM', onTerm);
      process.off('SIGINT', onInt);
      // A worker the check left behind holds no slot after it: the group goes with the check.
      if (killed) killGroup('SIGKILL');
      if (tail !== undefined) {
        if (partial) kept.push(partial);
        const shown = kept.slice(-tail);
        if (shown.length) deps.print(shown.join('\n'));
      }
      if (logFd !== null) { try { closeSync(logFd); } catch { /* closed */ } }
      if (code === 0 && !killed && receiptPlan && before) {
        const r = writeReceipt(receiptPlan, before, { exit: code, ms: Date.now() - ran, fresh: opts.fresh, log: logPath ?? undefined });
        deps.printErr(r ? `builder heavy: green, receipt kept: the same check on the same code will not run again${opts.fresh ? ' (--fresh run recorded)' : ''}` : 'builder heavy: green, but no receipt (the code changed while it ran, or the receipt could not be written)');
      }
      if ((code !== 0 || killed) && receiptPlan && before) dropReceipt(receiptPlan, before);
      if (recordable) settleSuite(deps, suite, { exit: killed ? null : code, killed, command, log: logPath, startTree, prev: red, because, dist: proof });
      else if (logPath) rmSync(logPath, { force: true });
      if (code !== 0 && kind && scope) recordRed(budget, scope, target, Date.now());
      recordCheck(deps.cwd(), { label, line: line ?? pick.line, asked: started, ran, ended: Date.now(), exit: killed === 'ceiling' ? null : code, waits, ...(killed === 'ceiling' ? { reason: 'ceiling' } : {}) });
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
    .argument('[command...]', 'The check to run, after -- (none with --wait)')
    .option('--max-wait <seconds>', `How long to stand in line (default ${HEAVY_DEFAULT_WAIT_S}, ${HEAVY_HOT_WAIT_S} while the Mac is very hot)`)
    .option('--because <reason>', 'Run past the repeat limit, once per run and command; the reason stays in `builder budget`')
    .option('--fresh', 'Run it even when a green receipt for the same code exists (the run is recorded)')
    .option('--tail <lines>', 'Show only the last N lines of its output (instead of piping to tail, which hides the exit code)')
    .option('--detach', 'Start the check as its own process (it outlives this session) and print its id at once; follow it with --wait <id>. A full test suite starts this way')
    .option('--wait <id>', `Block on a detached check (at most ${HEAVY_WAIT_SLICE_S / 60} min a call; call again) and exit with its exit (${HEAVY_DIED_EXIT} = it died with no result)`)
    .option('--max-run <minutes>', `Kill the check and its whole process group after this many minutes of running (default ${HEAVY_MAX_RUN_MIN})`)
    .addOption(new Option('--run-id <id>').hideHelp())
    .description(`Run a type-check, build, test run or browser verify script in its line: a short check through a fast slot, anything else holding this checkout's heavy lock (each worktree has its own) and one of the machine's heavy slots (every repo together; read from its cores and memory at each ask, 2 at thermal state serious, 1 at critical heat or memory pressure), smaller first; a check that already passed on the same code prints its receipt instead of running (exit: the command's, ${HEAVY_LOCK_BUSY_EXIT} = the wait ran out, nothing ran, the place is kept, or ${HEAVY_OVER_BUDGET_EXIT} = past the repeat limit or a RED full-suite record (rerun its files: builder test --failed), nothing ran, ${HEAVY_BUILD_FIRST_EXIT} = a full suite needs a fresh build first). A whole-suite run keeps a record of its red files`)
    .action(async (command: string[], opts: HeavyOptions) => {
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
