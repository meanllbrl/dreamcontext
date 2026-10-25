import { execFileSync, spawn } from 'node:child_process';
import { openSync, closeSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { insertToSection } from '../markdown.js';
import { today } from '../id.js';
import { loadStatuses } from '../overrides.js';
import { statusKind, PARENT_BY_KIND } from '../task-status.js';
import { withTaskFileLock } from '../task-file-lock.js';
import { updateFrontmatterFields } from '../frontmatter.js';
import { localDir } from '../local-store.js';
import { lockHolderPid, reclaimDeadHolderLock } from '../file-lock.js';
import { inspectSleepLock } from '../sleep-consolidation.js';
import { readSleepState } from '../../cli/commands/sleep.js';
import { closeInboxRows, listInboxRows, raiseInboxRow, type InboxRow } from '../owner-inbox.js';
import { readAccountWait } from '../automations/account.js';
import { clearRunSidecar, getRunTarget, lockPathFor, readRunSidecar } from '../automations/store.js';
import { allPendingQuestions, writeQuestion } from '../automations/hitl.js';
import { appendThreadEntry } from '../automations/threads.js';
import { oneDataLine } from '../automations/runner.js';
import { taskBindingOf } from '../automations/session-registry.js';
import { statusChangeEntry, type StatusAuthor } from '../task-history.js';
import { placement } from './active.js';
import { armStart, consumeArmedStart, disarmTask, forgetTaskAssignments, forgetTaskRole, ledgerRecordFor, readAssignmentLedger } from './assignment-ledger.js';
import { scanOutsideAssignments } from './outside-assignments.js';
import {
  casTask, claimsForTask, clampReviewCap, findTaskHead, forgetTaskJob, listTaskHeads, metaFor, newRunId, newSessionId,
  patchMeta, peekResumeNote, readTaskJobs, renameOrForgetAgentTaskJobs, setResumeNote, taskFilePath, taskJobView, taskOfSession, taskSessionFor, thisMachine, updateTaskJobs,
  type AgentTaskState, type TaskClaim, type TaskJobView, type TaskStep,
} from './task-jobs.js';

/**
 * Starting and reconciling task jobs (AI Team v2 C1-3, C1-4). ONE claim path for every step:
 *
 *   drain (tick, server settle, server start, a host that just settled)
 *     → filters (a ledger record and an armed entry written by a local action on THIS machine,
 *       due by the M0 start instant, the agent here, no sleep, no open question, its run lock free)
 *     → the M0 claim, FIRST (an atomic check-and-write: one claim per task)
 *     → the task's compare-and-set `scheduled|queued → starting`, consuming the armed entry
 *     → a DETACHED host `dreamcontext tasks run-job <slug> --run <id>` (never awaited: the tick
 *       returns at once, and quitting the app does not kill it)
 *
 * The reconciler runs on every tick and server start, ONLY over this machine's M0 claims and the
 * tasks this machine claimed; it never probes a pid another machine recorded. It never kills: a
 * host that died while its claude child lives is "running without its host" until a human
 * presses Stop.
 */

/** A claim younger than this is never judged: its host may still be starting. */
export const CLAIM_GRACE_MS = 2 * 60_000;
/** A scheduled start missed by more than this asks the owner instead of starting. */
export const LATE_START_MS = 12 * 60 * 60_000;

export interface TaskJobDeps {
  home?: string;
  now?: () => Date;
  /** Start the detached host; returns its pid, or null when it could not be spawned. */
  spawnHost?: (contextRoot: string, slug: string, runId: string) => number | null;
  /** `kill(pid, 0)` semantics: true for a live pid. Injectable for tests. */
  isAlive?: (pid: number) => boolean;
  /** Kill a process group (a human Stop). */
  killGroup?: (pgid: number) => void;
  /** The CLI entry the default host spawn runs (default: the running CLI, `process.argv[1]`). */
  cliEntry?: string;
  /** Whether `pid` is the task host of `runId` (its command line). Injectable for tests. */
  isOurHost?: (pid: number, runId: string) => boolean;
  log?: (line: string) => void;
}

function alive(pid: number | null | undefined, deps: TaskJobDeps): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 1) return false;
  if (deps.isAlive) return deps.isAlive(pid);
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** The lock-reclaim probe matching `isAlive` (a test's fake pids), else the real `kill(pid, 0)`. */
function lockProbe(deps: TaskJobDeps): ((pid: number) => void) | undefined {
  if (!deps.isAlive) return undefined;
  return (pid) => {
    if (deps.isAlive!(pid)) return;
    const e = new Error('ESRCH') as NodeJS.ErrnoException;
    e.code = 'ESRCH';
    throw e;
  };
}

/** Is `pid` the detached `tasks run-job … --run <runId>` host? Read from its command line. */
export function isTaskHostOf(pid: number, runId: string): boolean {
  try {
    const args = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return args.includes('run-job') && args.includes(runId);
  } catch {
    return false;
  }
}

/** The real host spawn: the running CLI, detached, its output to a machine-local log. */
export function defaultSpawnHost(contextRoot: string, slug: string, runId: string, home?: string, cliEntry?: string): number | null {
  // Under a test runner `process.argv[1]` is the runner itself, never this CLI: a test must name it.
  const cli = cliEntry ?? (process.env.VITEST ? null : process.argv[1]);
  if (!cli) return null;
  const projectRoot = dirname(contextRoot);
  const dir = localDir(projectRoot, home);
  let fd: number | 'ignore' = 'ignore';
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    fd = openSync(join(dir, 'task-host.log'), 'a', 0o600);
  } catch {
    fd = 'ignore';
  }
  try {
    const child = spawn(process.execPath, [cli, 'tasks', 'run-job', slug, '--run', runId], {
      cwd: projectRoot,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: process.env,
    });
    child.on('error', () => { /* the claim's grace + the reconciler settle it */ });
    child.unref();
    return child.pid ?? null;
  } catch {
    return null;
  } finally {
    if (typeof fd === 'number') try { closeSync(fd); } catch { /* closed */ }
  }
}

function terminalKind(contextRoot: string, status: string | null): boolean {
  const kind = statusKind(loadStatuses(contextRoot), status ?? undefined);
  return kind === 'done' || kind === 'cancelled';
}

/** The agent this step runs and its role. */
export function stepAgent(step: TaskStep, meta: { doer: string; reviewer: string | null }): { agent: string | null; role: 'doer' | 'reviewer' } {
  return step === 'review' ? { agent: meta.reviewer, role: 'reviewer' } : { agent: meta.doer, role: 'doer' };
}

function hasArmed(projectRoot: string, taskId: string, step: TaskStep, round: number, home?: string): boolean {
  return readAssignmentLedger(projectRoot, home).armed.some((a) => a.taskId === taskId && a.step === step && a.round === round);
}

/** The step's run lock: free, or reclaimed from a dead holder with no live child behind it. */
function runLockFree(contextRoot: string, agent: string, deps: TaskJobDeps): boolean {
  const lock = lockPathFor(contextRoot, agent);
  const holder = lockHolderPid(lock);
  const side = readRunSidecar(contextRoot, agent);
  const childAlive = !!side && alive(side.childPgid, deps);
  if (side && childAlive && !alive(side.runnerPid, deps)) return false; // a live orphan
  if (holder === null) return true;
  if (alive(holder, deps)) return false;
  if (childAlive) return false;
  return reclaimDeadHolderLock(lock, lockProbe(deps));
}

function changelog(contextRoot: string, slug: string, entry: string): void {
  try {
    insertToSection(taskFilePath(contextRoot, slug), 'Changelog', entry, 'top', true);
  } catch {
    // the state change stands; its line is best effort
  }
}

/** Move a task's status (the local mirror) with its provenance line. */
export function setTaskStatus(contextRoot: string, slug: string, to: string, who: StatusAuthor, reason?: string | null): void {
  const defs = loadStatuses(contextRoot);
  withTaskFileLock(contextRoot, slug, () => {
    updateFrontmatterFields(taskFilePath(contextRoot, slug), { status: to, updated_at: today() });
    insertToSection(taskFilePath(contextRoot, slug), 'Changelog', statusChangeEntry(to, who, defs, reason), 'top', true);
  });
}

function threadNote(contextRoot: string, agent: string, text: string, now: Date): void {
  try {
    appendThreadEntry(contextRoot, agent, { runId: now.toISOString(), kind: 'system', event: 'skipped', text, via: 'runner', now });
  } catch {
    // a thread that cannot be written changes nothing about the task
  }
}

// ─── the owner inbox rows of task jobs ──────────────────────────────────────

export type TaskRowKind =
  | 'task-start-missed' | 'task-orphaned' | 'task-stopped' | 'task-blocked' | 'task-plan'
  | 'task-question' | 'task-stalled' | 'task-review' | 'task-stuck';

export function taskRowKey(kind: TaskRowKind, taskId: string): string {
  return `${kind}:${taskId}`;
}

export function raiseTaskRow(
  projectRoot: string,
  kind: TaskRowKind,
  task: { slug: string; id: string; name: string },
  agent: string | null,
  title: string,
  actions: InboxRow['actions'],
  detail: string | undefined,
  home?: string,
  now?: Date,
): void {
  try {
    raiseInboxRow(projectRoot, {
      kind, ref: task.slug, agent, title: oneDataLine(title, 300),
      ...(detail ? { detail: detail.slice(0, 4000) } : {}),
      actions, dedupeKey: taskRowKey(kind, task.id),
    }, home, now);
  } catch {
    // the state on the task is the record; the row is how the owner hears of it
  }
}

/** Whether the row's subject still holds, per kind (the M1 reconciler's table). */
export function taskRowAlive(contextRoot: string, row: InboxRow, claims: TaskClaim[]): boolean {
  if (!row.kind.startsWith('task-')) return true;
  const taskId = row.dedupeKey.slice(row.kind.length + 1);
  const head = findTaskHead(contextRoot, row.ref);
  // Deleted, or renamed (the slug now names another task): the row dies.
  if (!head || head.id !== taskId) return false;
  const v = taskJobView(head);
  if (!v.agent) return false;
  if (terminalKind(contextRoot, v.status)) return false;
  switch (row.kind as TaskRowKind) {
    case 'task-start-missed': return v.state === 'scheduled';
    case 'task-orphaned': return claims.some((c) => c.taskId === taskId && c.phase === 'orphaned');
    case 'task-stopped': return v.state === 'stopped';
    case 'task-blocked': return v.state === 'blocked';
    case 'task-plan': return v.state === 'waiting_owner' && v.step === 'plan';
    case 'task-question': return v.state === 'waiting_owner';
    case 'task-stalled': return v.state === 'stalled';
    case 'task-review': return statusKind(loadStatuses(contextRoot), v.status ?? undefined) === 'review';
    case 'task-stuck': return v.state === 'stuck';
    default: return true;
  }
}

/** Close every task row whose subject moved on. Called on every read and every tick. Never throws. */
export function reconcileTaskRows(contextRoot: string, home?: string): number {
  try {
    const projectRoot = dirname(contextRoot);
    const rows = listInboxRows(projectRoot, home).filter((r) => r.kind.startsWith('task-'));
    if (rows.length === 0) return 0;
    const claims = readTaskJobs(projectRoot, home).claims;
    const dead = new Set(rows.filter((r) => !taskRowAlive(contextRoot, r, claims)).map((r) => r.id));
    return dead.size ? closeInboxRows(projectRoot, (r) => dead.has(r.id), home) : 0;
  } catch {
    return 0;
  }
}

// ─── the drain ────────────────────────────────────────────────────────────────

interface Candidate {
  view: TaskJobView;
  step: TaskStep;
  round: number;
  agent: string;
  role: 'doer' | 'reviewer';
  queuedAt: string;
  late: boolean;
}

/**
 * Start every due task step this machine may start. Returns the run ids it handed to a host.
 * Never awaits a run; never throws for an operational reason.
 */
export function startDueTaskJobs(contextRoot: string, deps: TaskJobDeps = {}): string[] {
  const home = deps.home;
  const now = (deps.now ?? (() => new Date()))();
  const projectRoot = dirname(contextRoot);
  const log = deps.log ?? (() => {});
  const started: string[] = [];
  try {
    // A sleep holds the brain: nothing starts until it ends (its next settle drains again).
    const sleep = inspectSleepLock(readSleepState(contextRoot), now.getTime());
    if (sleep.locked && !sleep.stale) return started;
    if (readAccountWait(home, now.getTime()) !== null) return started;
    scanOutsideAssignments(contextRoot, home);

    const jobs = readTaskJobs(projectRoot, home);
    const open = allPendingQuestions(contextRoot);
    const candidates: Candidate[] = [];
    for (const head of listTaskHeads(contextRoot)) {
      const v = taskJobView(head);
      if (v.state !== 'scheduled' && v.state !== 'queued') continue;
      if (terminalKind(contextRoot, v.status)) continue;
      const meta = jobs.meta.find((m) => m.taskId === v.id);
      if (!meta) continue;
      const step = v.step ?? 'work';
      const round = v.round;
      const { agent, role } = stepAgent(step, meta);
      if (!agent) continue;
      // The synced fields must still say what this machine assigned; a teammate's edit starts nothing.
      if (v.agent !== meta.doer || (role === 'reviewer' && v.reviewer !== meta.reviewer)) continue;
      if (!ledgerRecordFor(projectRoot, v.id, role, agent, home)) continue;
      if (!hasArmed(projectRoot, v.id, step, round, home)) continue;
      let late = false;
      if (v.state === 'scheduled') {
        const at = meta.startAt ? Date.parse(meta.startAt) : now.getTime();
        if (!Number.isFinite(at) || at > now.getTime()) continue;
        if (now.getTime() - at > LATE_START_MS && !meta.lateOk) {
          raiseTaskRow(projectRoot, 'task-start-missed', v, meta.doer,
            `${v.name} was due at ${meta.startAt} and did not start: more than 12 hours have passed.`,
            ['start-now', 'reschedule'], undefined, home, now);
          continue;
        }
        late = now.getTime() - at > 60_000;
      }
      candidates.push({ view: v, step, round, agent, role, queuedAt: meta.queuedAt, late });
    }
    candidates.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));

    const busy = new Set<string>();
    for (const c of candidates) {
      if (busy.has(c.agent)) continue;
      const target = getRunTarget(contextRoot, c.agent, 'agent');
      if (!target) continue;
      if (!placement(contextRoot, c.agent, target.owner ?? null, home, now).here) continue;
      if (open.some((q) => q.slug === c.agent && q.state === 'pending')) { busy.add(c.agent); continue; }
      if (!runLockFree(contextRoot, c.agent, deps)) { busy.add(c.agent); continue; }
      const live = readTaskJobs(projectRoot, home).claims;
      // A review waits for the doer's host and child to be gone.
      if (c.step === 'review') {
        const doerClaim = live.find((x) => x.taskId === c.view.id && x.role === 'doer');
        if (doerClaim && alive(doerClaim.hostPid, deps)) continue;
        const meta = metaFor(projectRoot, c.view.id, home);
        const side = meta ? readRunSidecar(contextRoot, meta.doer) : null;
        if (side && alive(side.childPgid, deps)) continue;
      }
      const runId = claimAndSpawn(contextRoot, c, deps, now);
      // Claimed or not, the agent is spoken for in this pass.
      busy.add(c.agent);
      if (runId) {
        started.push(runId);
        busy.add(c.agent);
        if (c.late) threadNote(contextRoot, c.agent, `Started ${c.view.name} late: it was scheduled earlier.`, now);
      }
    }
  } catch (err) {
    log(`[tasks] the task drain stopped: ${(err as Error).message}`);
  }
  return started;
}

/** The M0 claim, then the task's compare-and-set, then the detached host. Returns the run id. */
function claimAndSpawn(contextRoot: string, c: Candidate, deps: TaskJobDeps, now: Date): string | null {
  const home = deps.home;
  const projectRoot = dirname(contextRoot);
  const runId = newRunId();
  const prior = taskSessionFor(projectRoot, c.view.id, c.role, home);
  const claim: TaskClaim = {
    runId, taskId: c.view.id, taskSlug: c.view.slug, step: c.step, round: c.round, agent: c.agent, role: c.role,
    hostPid: null, childPid: null, sessionId: prior ?? newSessionId(), resume: !!prior, phase: 'claiming',
    claimedAt: now.toISOString(), tokenHash: null, cwd: null,
  };
  // One claim per task and one live step per agent, checked and written under the M0 lock: two
  // drains (the tick, the server's loop, a host that just settled) never both get here. A step of
  // this agent that is claimed or running (its host may not hold the run lock yet) makes it busy.
  const won = updateTaskJobs(projectRoot, (f) => {
    if (f.claims.some((x) => x.taskId === c.view.id && x.phase !== 'waiting_owner')) return false;
    if (f.claims.some((x) => x.agent === c.agent && x.phase !== 'waiting_owner' && x.phase !== 'stalled')) return false;
    f.claims = [...f.claims.filter((x) => x.taskId !== c.view.id), claim];
    return true;
  }, home);
  if (!won) return null;
  const machine = thisMachine(home);
  const cas = casTask(contextRoot, c.view.slug, { from: ['scheduled', 'queued'], step: c.step, check: (v) => v.id === c.view.id && v.round === c.round }, {
    agent_state: 'starting', agent_claimed_machine: machine.id, agent_claimed_at: now.toISOString(), updated_at: today(),
  });
  if (!cas) {
    dropClaim(projectRoot, runId, home);
    return null;
  }
  consumeArmedStart(projectRoot, c.view.id, c.step, c.round, home);
  const pid = (deps.spawnHost ?? ((r, s, id) => defaultSpawnHost(r, s, id, home, deps.cliEntry)))(contextRoot, c.view.slug, runId);
  if (!pid) {
    // Nothing started: back in the queue at its place, armed again.
    requeue(contextRoot, c.view.slug, c.view.id, c.step, c.round, ['starting'], home);
    dropClaim(projectRoot, runId, home);
    return null;
  }
  updateTaskJobs(projectRoot, (f) => {
    f.claims = f.claims.map((x) => (x.runId === runId && x.hostPid === null ? { ...x, hostPid: pid } : x));
  }, home);
  return runId;
}

export function dropClaim(projectRoot: string, runId: string, home?: string): void {
  updateTaskJobs(projectRoot, (f) => { f.claims = f.claims.filter((x) => x.runId !== runId); }, home);
}

/** Back to `queued` at its original place (`agent_queued_at` untouched), armed again, no row. */
export function requeue(
  contextRoot: string, slug: string, taskId: string, step: TaskStep, round: number,
  from: readonly AgentTaskState[], home?: string,
): boolean {
  const ok = !!casTask(contextRoot, slug, { from, step }, { agent_state: 'queued', agent_claimed_machine: null, agent_blocked: null, agent_stopped: null, updated_at: today() });
  if (ok) armStart(dirname(contextRoot), taskId, step, round, home);
  return ok;
}

// ─── the reconciler ───────────────────────────────────────────────────────────

/**
 * Settle what died. ONLY this machine's M0 claims and the tasks it claimed. Returns the number of
 * claims it changed. Never throws.
 */
export function reconcileTaskJobs(contextRoot: string, deps: TaskJobDeps = {}): number {
  const home = deps.home;
  const now = (deps.now ?? (() => new Date()))();
  const projectRoot = dirname(contextRoot);
  let changed = 0;
  try {
    const me = thisMachine(home).id;
    const jobs = readTaskJobs(projectRoot, home);
    for (const claim of jobs.claims) {
      const head = findTaskHead(contextRoot, claim.taskId);
      const v = head ? taskJobView(head) : null;
      const age = now.getTime() - Date.parse(claim.claimedAt);
      const hostAlive = alive(claim.hostPid, deps);
      // The claim's death: its task is gone, unassigned or closed, and no host still runs it.
      if ((!v || !v.agent || terminalKind(contextRoot, v.status)) && !hostAlive) {
        retireClaimQuestion(contextRoot, claim);
        dropClaim(projectRoot, claim.runId, home);
        changed++;
        continue;
      }
      if (!v) continue;
      if (claim.phase === 'claiming') {
        if (age < CLAIM_GRACE_MS || hostAlive) continue;
        if (v.state === 'starting' && v.claimedMachine === me) {
          requeue(contextRoot, v.slug, v.id, claim.step, claim.round, ['starting'], home);
        }
        dropClaim(projectRoot, claim.runId, home);
        changed++;
        continue;
      }
      if (claim.phase === 'waiting_owner' || claim.phase === 'stalled') continue;
      // active, delivered, orphaned: only a dead host is the reconciler's business.
      if (hostAlive) continue;
      const side = readRunSidecar(contextRoot, claim.agent);
      const ours = !!side && (side.runnerPid === claim.hostPid || (claim.childPid !== null && side.childPid === claim.childPid));
      const childAlive = ours && alive(side!.childPgid, deps);
      if (childAlive) {
        if (claim.phase === 'orphaned') continue;
        updateTaskJobs(projectRoot, (f) => {
          f.claims = f.claims.map((x) => (x.runId === claim.runId ? { ...x, phase: 'orphaned' as const, orphanedFrom: claim.phase } : x));
        }, home);
        if (claim.phase === 'active') {
          casTask(contextRoot, v.slug, { from: ['starting', 'running'], step: claim.step }, { agent_state: 'stalled', updated_at: today() });
        }
        raiseTaskRow(projectRoot, 'task-orphaned', v, claim.agent,
          `${v.name}: the agent is running without its host. Stop it, or let it finish.`,
          ['stop', 'let-finish'], undefined, home, now);
        changed++;
        continue;
      }
      // The child is gone too: free the lock whatever its age, then settle the task.
      reclaimDeadHolderLock(lockPathFor(contextRoot, claim.agent), lockProbe(deps));
      if (ours) clearRunSidecar(contextRoot, claim.agent);
      const delivered = claim.phase === 'delivered' || claim.orphanedFrom === 'delivered';
      const verdict = jobs.verdicts.find((x) => x.runId === claim.runId);
      dropClaim(projectRoot, claim.runId, home);
      if (!delivered) {
        if (claim.step === 'review' && verdict) {
          // A review host that died with a verdict pending: the review runs again (the verdict is discarded).
          updateTaskJobs(projectRoot, (f) => { f.verdicts = f.verdicts.filter((x) => x.runId !== claim.runId); }, home);
          requeue(contextRoot, v.slug, v.id, 'review', claim.round, ['starting', 'running', 'stalled'], home);
        } else if (casTask(contextRoot, v.slug, { from: ['starting', 'running', 'stalled'], step: claim.step }, { agent_state: 'stopped', agent_claimed_machine: null, updated_at: today() })) {
          changelog(contextRoot, v.slug, `### ${today()} - Agent stopped\n- The run ended without its host and delivered nothing.`);
          raiseTaskRow(projectRoot, 'task-stopped', v, claim.agent, `${v.name}: the agent stopped without delivering.`,
            ['continue', 'take-over', 'dismiss'], undefined, home, now);
        }
      }
      changed++;
    }

    // Tasks this machine claimed with no claim behind them (a crash between the CAS and the claim's
    // survival): back to the queue after the grace.
    const claimed = new Set(readTaskJobs(projectRoot, home).claims.map((x) => x.taskId));
    for (const head of listTaskHeads(contextRoot)) {
      const v = taskJobView(head);
      if (v.state !== 'starting' || v.claimedMachine !== me || claimed.has(v.id)) continue;
      const at = Date.parse(String(v.raw.agent_claimed_at ?? ''));
      if (Number.isFinite(at) && now.getTime() - at < CLAIM_GRACE_MS) continue;
      if (requeue(contextRoot, v.slug, v.id, v.step ?? 'work', v.round, ['starting'], home)) changed++;
    }

    // The death of this machine's records for tasks that moved on.
    for (const meta of readTaskJobs(projectRoot, home).meta) {
      const head = findTaskHead(contextRoot, meta.taskId);
      const v = head ? taskJobView(head) : null;
      if (!v || v.agent !== meta.doer || terminalKind(contextRoot, v.status)) {
        if (claimsForTask(projectRoot, meta.taskId, home).some((x) => alive(x.hostPid, deps))) continue;
        forgetTaskJob(projectRoot, meta.taskId, home);
      }
    }
    reconcileTaskRows(contextRoot, home);
  } catch (err) {
    (deps.log ?? (() => {}))(`[tasks] the task reconciler stopped: ${(err as Error).message}`);
  }
  return changed;
}

/** A claim that dies retires the question its session asked (nobody can answer it anymore). */
function retireClaimQuestion(contextRoot: string, claim: TaskClaim): void {
  if (!claim.sessionId) return;
  try {
    for (const q of allPendingQuestions(contextRoot)) {
      if (q.slug === claim.agent && q.sessionId === claim.sessionId && q.state === 'pending') {
        writeQuestion(contextRoot, { ...q, state: 'expired', resolutionNote: 'the task this question belonged to moved on' });
      }
    }
  } catch {
    // an orphaned question is refused by the answer gate anyway (no live claim)
  }
}

// ─── the owner's actions ──────────────────────────────────────────────────────

export type ActionResult = { ok: true } | { ok: false; code: string; message: string };
const refused = (code: string, message: string): ActionResult => ({ ok: false, code, message });

function viewOf(contextRoot: string, idOrSlug: string): TaskJobView | null {
  const head = findTaskHead(contextRoot, idOrSlug);
  return head ? taskJobView(head) : null;
}

function closeRowsFor(projectRoot: string, taskId: string, kinds: TaskRowKind[] | null, home?: string): void {
  closeInboxRows(projectRoot, (r) => r.kind.startsWith('task-') && r.dedupeKey.endsWith(`:${taskId}`) && (!kinds || kinds.includes(r.kind as TaskRowKind)), home);
}

/** Start a missed scheduled start now (the "Start now" of `task-start-missed`). */
export function startNowAction(contextRoot: string, idOrSlug: string, deps: TaskJobDeps = {}): ActionResult {
  const v = viewOf(contextRoot, idOrSlug);
  if (!v || !metaFor(dirname(contextRoot), v.id, deps.home)) return refused('not_assigned_here', 'That task is not assigned on this machine.');
  const now = (deps.now ?? (() => new Date()))();
  patchMeta(dirname(contextRoot), v.id, { startAt: now.toISOString(), lateOk: true }, deps.home);
  casTask(contextRoot, v.slug, { from: ['scheduled'] }, { agent_start_at: now.toISOString(), updated_at: today() });
  closeRowsFor(dirname(contextRoot), v.id, ['task-start-missed'], deps.home);
  startDueTaskJobs(contextRoot, deps);
  return { ok: true };
}

/** Move a scheduled (or missed) start to `at` (an instant with an offset). */
export function rescheduleAction(contextRoot: string, idOrSlug: string, at: string, deps: TaskJobDeps = {}): ActionResult {
  const v = viewOf(contextRoot, idOrSlug);
  if (!v || !metaFor(dirname(contextRoot), v.id, deps.home)) return refused('not_assigned_here', 'That task is not assigned on this machine.');
  const instant = parseStartAt(at);
  if (!instant) return refused('invalid_start', 'Give the start as a date and time with its time zone.');
  if (!casTask(contextRoot, v.slug, { from: ['scheduled', 'queued'] }, { agent_state: 'scheduled', agent_start_at: instant, updated_at: today() })) {
    return refused('not_waiting', 'That task is no longer waiting to start.');
  }
  patchMeta(dirname(contextRoot), v.id, { startAt: instant, lateOk: false }, deps.home);
  armStart(dirname(contextRoot), v.id, v.step ?? 'work', v.round, deps.home);
  closeRowsFor(dirname(contextRoot), v.id, ['task-start-missed'], deps.home);
  return { ok: true };
}

/**
 * A human Stop: kill the step's process group (the human-invoked kill, never the runner's), free
 * the lock once its holder is gone, close the claim. An orphan that had already delivered keeps
 * its task as it is.
 */
export function stopTaskAction(contextRoot: string, idOrSlug: string, deps: TaskJobDeps = {}): ActionResult {
  const home = deps.home;
  const projectRoot = dirname(contextRoot);
  const v = viewOf(contextRoot, idOrSlug);
  if (!v) return refused('unknown_task', 'There is no such task.');
  const claims = claimsForTask(projectRoot, v.id, home);
  const killGroup = deps.killGroup ?? ((pgid: number) => { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } });
  let delivered = false;
  for (const claim of claims) {
    const side = readRunSidecar(contextRoot, claim.agent);
    const ours = !!side && (side.runnerPid === claim.hostPid || (claim.childPid !== null && side.childPid === claim.childPid));
    if (ours && alive(side!.childPgid, deps)) killGroup(side!.childPgid);
    // Only a pid that is still THIS run's host: a recorded pid may since belong to another process.
    if (claim.hostPid && alive(claim.hostPid, deps) && (deps.isOurHost ?? isTaskHostOf)(claim.hostPid, claim.runId)) {
      try { process.kill(claim.hostPid, 'SIGTERM'); } catch { /* gone */ }
    }
    if (ours && !alive(side!.runnerPid, deps)) clearRunSidecar(contextRoot, claim.agent);
    reclaimDeadHolderLock(lockPathFor(contextRoot, claim.agent), lockProbe(deps));
    delivered = delivered || claim.phase === 'delivered' || claim.orphanedFrom === 'delivered';
    retireClaimQuestion(contextRoot, claim);
    dropClaim(projectRoot, claim.runId, home);
  }
  if (!delivered) {
    casTask(contextRoot, v.slug, { from: ['starting', 'running', 'stalled', 'waiting_owner', 'queued', 'scheduled', 'blocked'] }, {
      agent_state: 'stopped', agent_claimed_machine: null, updated_at: today(),
    });
    // The start ticket goes too: only the owner's Continue (which re-arms) may start it again.
    disarmTask(projectRoot, v.id, home);
  }
  closeRowsFor(projectRoot, v.id, ['task-orphaned', 'task-stalled', 'task-question'], home);
  startDueTaskJobs(contextRoot, deps);
  return { ok: true };
}

/** Let an orphaned run finish: only the row goes; its delivery is still accepted (same run id). */
export function letFinishAction(contextRoot: string, idOrSlug: string, deps: TaskJobDeps = {}): ActionResult {
  const v = viewOf(contextRoot, idOrSlug);
  if (!v) return refused('unknown_task', 'There is no such task.');
  closeRowsFor(dirname(contextRoot), v.id, ['task-orphaned'], deps.home);
  return { ok: true };
}

/** Continue a stalled or stopped step: re-queued, same step, its session resumed by the host. */
export function continueTaskAction(contextRoot: string, idOrSlug: string, deps: TaskJobDeps = {}): ActionResult {
  const home = deps.home;
  const projectRoot = dirname(contextRoot);
  const v = viewOf(contextRoot, idOrSlug);
  if (!v || !metaFor(projectRoot, v.id, home)) return refused('not_assigned_here', 'That task is not assigned on this machine.');
  const step = v.step ?? 'work';
  const stalled = claimsForTask(projectRoot, v.id, home).find((c) => c.phase === 'stalled');
  if (claimsForTask(projectRoot, v.id, home).some((c) => c.phase !== 'stalled' && c.phase !== 'waiting_owner')) {
    return refused('already_running', 'That task is already running.');
  }
  if (!requeue(contextRoot, v.slug, v.id, step, v.round, ['stalled', 'stopped', 'blocked'], home)) {
    return refused('not_stopped', 'That task is not stalled, stopped or blocked.');
  }
  // A note still waiting (findings, an answer, the assignment's: the step stopped before its child
  // ran) is what the next run must read; "continue" only fills an empty slot.
  if (!peekResumeNote(projectRoot, v.id, home)) {
    setResumeNote(projectRoot, { taskId: v.id, kind: 'continue', text: 'Continue the task where you stopped.' }, home);
  }
  if (stalled) dropClaim(projectRoot, stalled.runId, home);
  closeRowsFor(projectRoot, v.id, ['task-stalled', 'task-stopped', 'task-blocked'], home);
  startDueTaskJobs(contextRoot, deps);
  return { ok: true };
}

/** "I'll take it": the agent comes off the task, which goes on in progress by the owner. */
export function takeOverAction(contextRoot: string, idOrSlug: string, deps: TaskJobDeps = {}): ActionResult {
  const v = viewOf(contextRoot, idOrSlug);
  if (!v) return refused('unknown_task', 'There is no such task.');
  const stop = stopTaskAction(contextRoot, v.id, deps);
  if (!stop.ok) return stop;
  unassignTaskJob(contextRoot, v.slug, deps.home);
  setTaskStatus(contextRoot, v.slug, PARENT_BY_KIND.active, { kind: 'owner' }, 'The owner took the task over from the agent.');
  return { ok: true };
}

/** Cancel the task (the third action of a stuck task). */
export function cancelTaskAction(contextRoot: string, idOrSlug: string, deps: TaskJobDeps = {}): ActionResult {
  const v = viewOf(contextRoot, idOrSlug);
  if (!v) return refused('unknown_task', 'There is no such task.');
  const cancelled = loadStatuses(contextRoot).find((d) => d.kind === 'cancelled')?.key;
  if (!cancelled) return refused('no_cancelled_status', 'This project declares no cancelled status.');
  stopTaskAction(contextRoot, v.id, deps);
  unassignTaskJob(contextRoot, v.slug, deps.home);
  setTaskStatus(contextRoot, v.slug, cancelled, { kind: 'owner' });
  return { ok: true };
}

/** The Ask level's plan, approved: the work step queues and resumes the plan's session. */
export function approvePlanAction(contextRoot: string, idOrSlug: string, deps: TaskJobDeps = {}): ActionResult {
  const projectRoot = dirname(contextRoot);
  const v = viewOf(contextRoot, idOrSlug);
  if (!v || !metaFor(projectRoot, v.id, deps.home)) return refused('not_assigned_here', 'That task is not assigned on this machine.');
  if (!casTask(contextRoot, v.slug, { from: ['waiting_owner'], step: 'plan' }, { agent_state: 'queued', agent_step: 'work', updated_at: today() })) {
    return refused('no_plan_waiting', 'No plan is waiting for your approval on that task.');
  }
  armStart(projectRoot, v.id, 'work', v.round, deps.home);
  setResumeNote(projectRoot, { taskId: v.id, kind: 'plan-change', text: 'The owner approved your plan. Carry it out now.' }, deps.home);
  closeRowsFor(projectRoot, v.id, ['task-plan'], deps.home);
  startDueTaskJobs(contextRoot, deps);
  return { ok: true };
}

/** The plan sent back with the owner's words: the plan step runs again in the same session. */
export function changePlanAction(contextRoot: string, idOrSlug: string, text: string, deps: TaskJobDeps = {}): ActionResult {
  const projectRoot = dirname(contextRoot);
  const v = viewOf(contextRoot, idOrSlug);
  if (!v || !metaFor(projectRoot, v.id, deps.home)) return refused('not_assigned_here', 'That task is not assigned on this machine.');
  if (!text.trim()) return refused('empty', 'Say what to change in the plan.');
  if (!casTask(contextRoot, v.slug, { from: ['waiting_owner'], step: 'plan' }, { agent_state: 'queued', updated_at: today() })) {
    return refused('no_plan_waiting', 'No plan is waiting for your approval on that task.');
  }
  armStart(projectRoot, v.id, 'plan', v.round, deps.home);
  setResumeNote(projectRoot, { taskId: v.id, kind: 'plan-change', text }, deps.home);
  closeRowsFor(projectRoot, v.id, ['task-plan'], deps.home);
  startDueTaskJobs(contextRoot, deps);
  return { ok: true };
}

/** One more review round past the cap: the binding cap (M0) and its display copy go up by one. */
export function oneMoreRoundAction(contextRoot: string, idOrSlug: string, deps: TaskJobDeps = {}): ActionResult {
  const projectRoot = dirname(contextRoot);
  const v = viewOf(contextRoot, idOrSlug);
  const meta = v ? metaFor(projectRoot, v.id, deps.home) : null;
  if (!v || !meta) return refused('not_assigned_here', 'That task is not assigned on this machine.');
  const cap = clampReviewCap(meta.reviewCap + 1);
  if (!casTask(contextRoot, v.slug, { from: ['stuck'] }, { agent_state: 'queued', agent_step: 'rework', review_cap: cap, updated_at: today() })) {
    return refused('not_stuck', 'That task is not stuck.');
  }
  patchMeta(projectRoot, v.id, { reviewCap: cap, noVerdict: 0 }, deps.home);
  armStart(projectRoot, v.id, 'rework', v.round, deps.home);
  setTaskStatus(contextRoot, v.slug, PARENT_BY_KIND.active, { kind: 'owner' }, 'One more review round.');
  closeRowsFor(projectRoot, v.id, ['task-stuck'], deps.home);
  startDueTaskJobs(contextRoot, deps);
  return { ok: true };
}

/** The owner sends a delivery back after review: the doer's session resumes; the round is not counted. */
export function sendBackAction(contextRoot: string, idOrSlug: string, text: string, deps: TaskJobDeps = {}): ActionResult {
  const projectRoot = dirname(contextRoot);
  const v = viewOf(contextRoot, idOrSlug);
  if (!v || !metaFor(projectRoot, v.id, deps.home)) return refused('not_assigned_here', 'That task is not assigned on this machine.');
  if (!text.trim()) return refused('empty', 'Say what to change.');
  if (claimsForTask(projectRoot, v.id, deps.home).some((c) => c.role === 'doer' && c.phase !== 'waiting_owner')) {
    return refused('already_running', 'The agent is still on it.');
  }
  if (!casTask(contextRoot, v.slug, { from: ['delivered'] }, { agent_state: 'queued', agent_step: 'rework', review_passed: false, updated_at: today() })) {
    return refused('not_delivered', 'That task has no delivery to send back.');
  }
  armStart(projectRoot, v.id, 'rework', v.round, deps.home);
  setResumeNote(projectRoot, { taskId: v.id, kind: 'sendback', text }, deps.home);
  setTaskStatus(contextRoot, v.slug, PARENT_BY_KIND.active, { kind: 'owner' }, 'Sent back to the agent.');
  closeRowsFor(projectRoot, v.id, ['task-review'], deps.home);
  startDueTaskJobs(contextRoot, deps);
  return { ok: true };
}

/** Clear every agent field on the task and the machine-local records behind them. */
export function unassignTaskJob(contextRoot: string, slug: string, home?: string): void {
  const head = findTaskHead(contextRoot, slug);
  if (!head) return;
  withTaskFileLock(contextRoot, head.slug, () => {
    updateFrontmatterFields(taskFilePath(contextRoot, head.slug), {
      agent: null, reviewer: null, agent_state: null, agent_step: null, agent_claimed_machine: null, agent_claimed_at: null, updated_at: today(),
    });
  });
  const projectRoot = dirname(contextRoot);
  for (const claim of claimsForTask(projectRoot, head.id, home)) {
    if (claim.phase === 'waiting_owner' || claim.phase === 'stalled') {
      retireClaimQuestion(contextRoot, claim);
      dropClaim(projectRoot, claim.runId, home);
    }
  }
  forgetTaskAssignments(projectRoot, head.id, home);
  forgetTaskJob(projectRoot, head.id, home);
  closeRowsFor(projectRoot, head.id, null, home);
}

// ─── start instants ──────────────────────────────────────────────────────────

/**
 * A start instant as typed: an ISO date-time WITH its offset (`Z` or `±hh:mm`). A local wall time
 * without one is refused: the instant is what is stored, so a DST change or another machine's
 * time zone never moves it. Returns the canonical ISO (UTC), or null.
 */
export function parseStartAt(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(s)) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// ─── the session gate (C1-14) ────────────────────────────────────────────────

/**
 * Which task a session belongs to on this machine: the M0 task-session registry, or the binding
 * tag the runner wrote (it outlives the registry entry). Null for every other session.
 */
export function taskOfAnySession(contextRoot: string, sessionId: string, home?: string): { taskId: string; agent: string | null } | null {
  const entry = taskOfSession(dirname(contextRoot), sessionId, home);
  if (entry) return { taskId: entry.taskId, agent: entry.agent };
  const tag = taskBindingOf(sessionId, home ?? homedir());
  return tag ? { taskId: tag.taskId, agent: tag.slug } : null;
}

/** The claim that waits on the owner for this session (an open question, a stall), or null. */
export function waitingClaimFor(contextRoot: string, taskId: string, sessionId: string, home?: string): TaskClaim | null {
  return claimsForTask(dirname(contextRoot), taskId, home)
    .find((c) => (c.phase === 'waiting_owner' || c.phase === 'stalled') && c.sessionId === sessionId) ?? null;
}

/**
 * The owner's answer to a task step's question: stored in M0 and the step re-queued by
 * compare-and-set `waiting_owner|stalled → queued` on the waiting claim's run id, same step,
 * armed. The host resumes the SAME session with the answer at the next drain. Any other state
 * refuses ("already running"), so a second reply from another surface starts nothing.
 */
export function queueTaskAnswer(contextRoot: string, sessionId: string, text: string, deps: TaskJobDeps = {}): ActionResult & { taskSlug?: string } {
  const home = deps.home;
  const projectRoot = dirname(contextRoot);
  const owner = taskOfAnySession(contextRoot, sessionId, home);
  if (!owner) return refused('not_a_task_session', 'This conversation is not a task step.');
  const claim = waitingClaimFor(contextRoot, owner.taskId, sessionId, home);
  const v = viewOf(contextRoot, owner.taskId);
  if (!claim || !v) return refused('already_running', 'The task was already continued, so this reply was not delivered.');
  if (!casTask(contextRoot, v.slug, { from: ['waiting_owner', 'stalled'], step: claim.step }, { agent_state: 'queued', agent_claimed_machine: null, updated_at: today() })) {
    return refused('already_running', 'The task was already continued, so this reply was not delivered.');
  }
  setResumeNote(projectRoot, { taskId: owner.taskId, kind: 'answer', text }, home);
  armStart(projectRoot, owner.taskId, claim.step, claim.round, home);
  dropClaim(projectRoot, claim.runId, home);
  closeRowsFor(projectRoot, owner.taskId, ['task-question', 'task-stalled'], home);
  return { ok: true, taskSlug: v.slug };
}

/** The refusal every talk path gives a task step's session. */
export function taskSessionRefusal(contextRoot: string, taskId: string): string {
  const v = viewOf(contextRoot, taskId);
  return `This conversation belongs to the task ${v ? oneDataLine(v.name, 120) : taskId}; reply from the task.`;
}

/**
 * An agent deleted. As a task's DOER: the task's queued or scheduled step stops ("agent gone") and
 * every ticket and ledger record of the task dies. As its REVIEWER only: a queued review stops
 * ("reviewer gone"), and only the reviewer's record and the review's tickets die, so the doer's
 * work, rework and Continue still start. Its sessions are forgotten. Never throws.
 */
export function stopAgentTaskJobs(contextRoot: string, agent: string, home?: string): void {
  const projectRoot = dirname(contextRoot);
  try {
    for (const head of listTaskHeads(contextRoot)) {
      const v = taskJobView(head);
      if (v.agent === agent) {
        if (casTask(contextRoot, v.slug, { from: ['scheduled', 'queued'] }, { agent_state: 'stopped', agent_stopped: 'agent gone', updated_at: today() })) {
          changelog(contextRoot, v.slug, `### ${today()} - Agent stopped\n- The agent ${agent} was deleted.`);
        }
        disarmTask(projectRoot, v.id, home);
        forgetTaskAssignments(projectRoot, v.id, home);
      } else if (v.reviewer === agent) {
        // The task has no reviewer from now on (both copies: the drain compares them). A review
        // already queued becomes a delivery that waits for the owner, never a step nobody claims.
        if (casTask(contextRoot, v.slug, { from: ['scheduled', 'queued'], step: 'review' }, { agent_state: 'delivered', reviewer: null, updated_at: today() })) {
          changelog(contextRoot, v.slug, `### ${today()} - Reviewer gone\n- Its reviewer ${agent} was deleted; the delivery waits for the owner.`);
          raiseTaskRow(projectRoot, 'task-review', v, v.agent, `${v.name}: its reviewer was deleted. The delivery is In Review, waiting for you.`, ['complete', 'send-back'], undefined, home);
        } else {
          withTaskFileLock(contextRoot, v.slug, () => {
            updateFrontmatterFields(taskFilePath(contextRoot, v.slug), { reviewer: null, updated_at: today() });
          });
        }
        patchMeta(projectRoot, v.id, { reviewer: null }, home);
        disarmTask(projectRoot, v.id, home, 'review');
        forgetTaskRole(projectRoot, v.id, 'reviewer', home);
      }
    }
    renameOrForgetAgentTaskJobs(dirname(contextRoot), agent, null, home);
  } catch {
    // the reconciler retires what is left
  }
}

/**
 * A task closed by its owner (completed or cancelled) ends its job: a live run is stopped, so its
 * later delivery or verdict can never reopen the task. Called by every path that closes a task
 * (the dashboard PATCH, `tasks status`, `tasks complete`). Never throws.
 */
export function endTaskJobIfClosed(contextRoot: string, slug: string, deps: TaskJobDeps = {}): void {
  try {
    const head = findTaskHead(contextRoot, slug);
    if (!head) return;
    const v = taskJobView(head);
    if (!terminalKind(contextRoot, v.status)) return;
    if (claimsForTask(dirname(contextRoot), v.id, deps.home).length === 0) return;
    stopTaskAction(contextRoot, v.id, deps);
  } catch {
    // the deliver/review/settle checks refuse a closed task anyway
  }
}

/** The predicate every job write on a task shares: never on a completed or cancelled task. */
export function openTaskCheck(contextRoot: string): (v: TaskJobView) => boolean {
  return (v) => !terminalKind(contextRoot, v.status);
}