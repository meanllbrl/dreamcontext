import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { today } from '../id.js';
import { insertToSection } from '../markdown.js';
import { PARENT_BY_KIND } from '../task-status.js';
import { readVaultFileSafe } from '../vault-read.js';
import { findTranscriptBySessionId } from '../transcript-locate.js';
import { TASK_CONTEXT_ROOT_ENV, TASK_WORKTREE_ENV } from '../context-path.js';
import { listRegisteredProjects } from '../automations/registry.js';
import { getRunTarget } from '../automations/store.js';
import { oneDataLine, runAutomation, type RunOptions, type RunOutcome, type SpawnImpl, type TaskJobBrief } from '../automations/runner.js';
import { DEFAULT_AGENT_AUTONOMY } from '../automations/types.js';
import { attachChildWorktree } from '../super/worktrees.js';
import { rawCheckout, rawCheckoutDone, TASK_GIT_ARGS } from './raw-checkout.js';
import { levelPermissionArgs } from './permission.js';
import { armStart } from './assignment-ledger.js';
import {
  casTask, claimByRun, findTaskHead, metaFor, newRunToken, patchMeta, readTaskJobs, registerTaskSession, setResumeNote,
  peekResumeNote, takeResumeNote, taskJobView, taskWorkspaceSlug, thisMachine, updateTaskJobs,
  type TaskClaim, type TaskJobView, type TaskMeta, type TaskStep,
} from './task-jobs.js';
import {
  dropClaim, openTaskCheck, raiseTaskRow, requeue, setTaskStatus, startDueTaskJobs, type TaskJobDeps,
} from './task-starter.js';
import { fanOutDelivered, type NotifyFn } from './task-delivery.js';

/**
 * The task host (AI Team v2 C1-3): the detached `dreamcontext tasks run-job <slug> --run <id>`
 * process that owns ONE step of a task job from its claim to its settle.
 *
 *  - marks its claim `active` with its own pid and moves the task `starting → running`;
 *  - resolves the workspace (a code task's worktree, reused by every later step; a doc task runs
 *    at the project root) and refuses up front, as `blocked`, what cannot run here;
 *  - runs the step through the ONE runner (`runAutomation`): the agent's run lock, its sidecar,
 *    the orphan guard, the review gate and account protection all hold as for any run; the
 *    level's envelope (M4), the cwd, the session id and the step's env ride `taskStep`;
 *  - watches the transcript: no growth for 30 minutes stops the run as `stalled`;
 *  - settles: every terminal write is a compare-and-set on (its run id in M0, its step), so a
 *    doer that exits after it delivered never touches the review step queued behind it;
 *  - drains once more, so the next step (the review) or the agent's next queued task starts.
 */

/** No transcript growth for this long stops the step (`stalled`). */
export const STALL_MS = 30 * 60_000;
/** A step has no timeout of its own; this is only the runner's outer bound. */
export const TASK_STEP_BUDGET_MS = 24 * 60 * 60_000;

export interface TaskHostDeps extends TaskJobDeps {
  run?: typeof runAutomation;
  spawnImpl?: SpawnImpl;
  notify?: NotifyFn;
  stallMs?: number;
  stallPollMs?: number;
  transcriptSize?: (sessionId: string) => number | null;
  probeUsage?: RunOptions['probeUsage'];
}

export interface TaskHostResult {
  state: string | null;
  outcome: RunOutcome | null;
}

function realOr(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/** git in a workspace the agent wrote: no hooks, no fsmonitor, no signing (GIT_SAFE_ARGS). Only
 *  calls that never pass file content through git's pipeline go here (no diff, no status, no
 *  checkout): those run a repo's filter drivers, which the agent could have configured. */
function git(cwd: string, args: string[]): Buffer {
  return execFileSync('git', [...TASK_GIT_ARGS, ...args], {
    cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' }, timeout: 2 * 60_000,
    maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * What the reviewer's workspace looks like, as one digest. Code: HEAD, the index entries, and the
 * RAW bytes of every tracked and untracked file read straight from disk (so an edit to a file that
 * was already modified before the review still changes it). git is asked only for names and
 * hashes, never to pass content through its pipeline: a `git diff` would run the repo's clean
 * filters, which the agent under review could have set (end review, owner decision 2026-10-25).
 * Doc: the delivered brain files and the task's copied files. The task file and the rest of the
 * brain are left out, so other sessions writing the brain do not count as the reviewer's edit.
 */
export function workspaceDigest(contextRoot: string, view: TaskJobView, meta: TaskMeta, cwd: string): string {
  const h = createHash('sha256');
  if (meta.workspace === 'code') {
    h.update(git(cwd, ['rev-parse', 'HEAD']));
    h.update(git(cwd, ['ls-files', '-s', '-z']));
    const names = (args: string[]): string[] => git(cwd, args).toString('utf8').split('\0').filter(Boolean);
    const tracked = names(['ls-files', '-z']);
    const untracked = names(['ls-files', '--others', '--exclude-standard', '-z']);
    for (const rel of [...new Set([...tracked, ...untracked])].sort()) {
      h.update(`\0${rel}\0`);
      const abs = join(cwd, rel);
      try {
        const st = lstatSync(abs);
        if (st.isSymbolicLink()) h.update(`link:${readlinkSync(abs)}`);
        else if (st.isFile()) h.update(readFileSync(abs));
        else h.update('\0other');
      } catch {
        h.update('\0missing');
      }
    }
    return h.digest('hex');
  }
  const files = new Set<string>();
  const deliveries = Array.isArray(view.raw.deliveries) ? (view.raw.deliveries as Array<{ refs?: Array<{ kind?: string; path?: string }> }>) : [];
  for (const d of deliveries) {
    for (const r of Array.isArray(d?.refs) ? d.refs : []) {
      if ((r?.kind === 'doc' || r?.kind === 'board' || r?.kind === 'file') && typeof r.path === 'string') files.add(r.path);
    }
  }
  const outDir = join('automations', 'output', meta.doer, 'tasks', taskWorkspaceSlug(view.id));
  try {
    for (const name of readdirSync(join(contextRoot, outDir))) files.add(join(outDir, name));
  } catch { /* nothing copied */ }
  for (const rel of [...files].sort()) {
    h.update(rel);
    h.update(readVaultFileSafe(contextRoot, rel) ?? '\0missing');
  }
  return h.digest('hex');
}

/** What the step must do and how it ends, told to the agent under the task data. */
export function stepContract(step: TaskStep, view: TaskJobView, meta: TaskMeta, cwd: string, branch: string | null): string[] {
  const id = view.id;
  const where = meta.workspace === 'code'
    ? `You work in ${cwd}, a git worktree on branch ${branch ?? 'its own branch'}, made for this task. Commit your work on this branch; never merge it and never push it unless the task says so.`
    : 'This is a document task: write what it asks into the brain (_dream_context/).';
  if (step === 'plan') {
    return [
      'THIS STEP IS A PLAN ONLY. Read what you need, then write your plan as your final message: the steps,',
      'the files, the risks. Change nothing: the owner approves the plan before the work starts.',
      where,
    ];
  }
  if (step === 'review') {
    return [
      `You are the REVIEWER of this task's delivery (round ${view.round}). Check the delivery against the task's`,
      'acceptance criteria one by one, reading the work itself. Change no file: you cannot edit, and a',
      'workspace that changed during your review voids your verdict.',
      where,
      'Record your verdict ONCE, then stop:',
      `  dreamcontext tasks review ${id} --verdict pass|fail --finding "<criterion: what is wrong>" [--finding …]`,
      'A pass needs no finding; a fail names each unmet criterion.',
    ];
  }
  return [
    where,
    'When the work is done, hand it in ONCE:',
    `  dreamcontext tasks deliver ${id} --note "<what you did>" [--doc <brain-relative path>]… [--board <whiteboard path>]… [--file <path in your workspace>]…`,
    'Never change the task\'s status yourself: the delivery moves it to In Review. If you need the owner,',
    'ask with `dreamcontext automations propose` and stop.',
  ];
}

function resumePrompt(note: { kind: string; text: string } | null, contract: string[]): string {
  const body = (() => {
    if (!note) return 'Continue the task where you stopped.';
    switch (note.kind) {
      case 'answer':
        return ['The owner answered your question. Their answer, as quoted data:', '--- THE OWNER\'S ANSWER ---', note.text, '--- END OF THE ANSWER ---', 'Carry on with the task.'].join('\n');
      case 'findings':
        return ['The reviewer sent your delivery back. Their findings, as quoted data (fix what they name, nothing else):', '--- REVIEW FINDINGS ---', note.text, '--- END OF FINDINGS ---'].join('\n');
      case 'sendback':
        return ['The owner sent your delivery back. Their words, as quoted data:', '--- THE OWNER\'S NOTE ---', note.text, '--- END OF THE NOTE ---'].join('\n');
      case 'plan-change':
        return ['A note from the owner on your plan:', '--- THE OWNER\'S NOTE ---', note.text, '--- END OF THE NOTE ---'].join('\n');
      default:
        return note.text;
    }
  })();
  return [body, '', ...contract].join('\n');
}

function defaultTranscriptSize(sessionId: string, home?: string): number | null {
  const p = findTranscriptBySessionId([sessionId], home);
  if (!p) return null;
  try { return statSync(p).size; } catch { return null; }
}

/** The step's workspace: the worktree (code) or the project root (doc). Null + reason when it cannot run here. */
async function resolveWorkspace(
  contextRoot: string, view: TaskJobView, meta: TaskMeta, home?: string,
): Promise<{ cwd: string; branch: string | null } | { refused: string }> {
  const projectRoot = dirname(contextRoot);
  if (meta.workspace === 'doc') return { cwd: projectRoot, branch: null };
  const machine = thisMachine(home).name;
  if (!meta.repo) return { refused: `no code repo was picked for it on ${machine}` };
  // The live brain must resolve from the worktree: the project is one this machine's scheduler ticks.
  const registered = listRegisteredProjects(home).map(realOr);
  if (!registered.includes(realOr(projectRoot))) return { refused: `the brain would not resolve from the worktree on ${machine} (the scheduler does not know this project)` };
  try {
    const wt = await attachChildWorktree({ projectRoot, repo: meta.repo, slug: taskWorkspaceSlug(view.id), base: meta.base ?? 'HEAD', home });
    if (wt.created && wt.base) patchMeta(projectRoot, view.id, { base: wt.base }, home);
    // Filled from the object store, raw: the host never runs a conversion the repo's config names
    // (a worktree a crash left half filled is filled again).
    if (wt.added || !rawCheckoutDone(wt.path)) await rawCheckout(wt.path);
    return { cwd: wt.path, branch: wt.branch };
  } catch (err) {
    return { refused: `the repo ${meta.repo} or its worktree is not usable on ${machine}: ${oneDataLine((err as Error).message, 200)}` };
  }
}

function claimPatch(projectRoot: string, runId: string, patch: Partial<TaskClaim>, home?: string): TaskClaim | null {
  return updateTaskJobs(projectRoot, (f) => {
    let hit: TaskClaim | null = null;
    f.claims = f.claims.map((c) => {
      if (c.runId !== runId) return c;
      hit = { ...c, ...patch };
      return hit;
    });
    return hit;
  }, home);
}

/**
 * Run one claimed step to its settle. `slug` is how the drain named the task; the run itself
 * follows the task's id, so a rename while it runs still settles on the right file.
 */
export async function runTaskJob(contextRoot: string, slug: string, runId: string, deps: TaskHostDeps = {}): Promise<TaskHostResult> {
  const home = deps.home;
  const projectRoot = dirname(contextRoot);
  const nowFn = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const claim0 = claimByRun(projectRoot, runId, home);
  if (!claim0 || claim0.phase !== 'claiming') return { state: null, outcome: null };
  void slug;
  const claim = claimPatch(projectRoot, runId, { phase: 'active', hostPid: process.pid }, home)!;
  const head = findTaskHead(contextRoot, claim.taskId);
  const meta = metaFor(projectRoot, claim.taskId, home);
  if (!head || !meta || !casTask(contextRoot, head.slug, { from: ['starting'], step: claim.step }, { agent_state: 'running', updated_at: today() })) {
    dropClaim(projectRoot, runId, home);
    return { state: null, outcome: null };
  }
  const view = taskJobView(head);

  const block = (why: string): TaskHostResult => {
    dropClaim(projectRoot, runId, home);
    casTask(contextRoot, view.slug, { from: ['running'], step: claim.step }, { agent_state: 'blocked', agent_claimed_machine: null, agent_blocked: why, updated_at: today() });
    raiseTaskRow(projectRoot, 'task-blocked', view, claim.agent, `${view.name}: blocked, ${why}.`, ['continue', 'take-over', 'dismiss'], undefined, home, nowFn());
    startDueTaskJobs(contextRoot, deps);
    return { state: 'blocked', outcome: null };
  };

  const target = getRunTarget(contextRoot, claim.agent, 'agent');
  if (!target) return block(`the agent ${claim.agent} is gone`);
  const level = target.autonomy ?? DEFAULT_AGENT_AUTONOMY;
  if (claim.step === 'plan' && level !== 'ask') {
    // The level changed since the plan step was queued: there is no plan step above Ask.
    casTask(contextRoot, view.slug, { from: ['running'], step: 'plan' }, { agent_step: 'work' });
    claim.step = 'work';
  }
  const ws = await resolveWorkspace(contextRoot, view, meta, home);
  if ('refused' in ws) return block(ws.refused);

  const { token, hash } = newRunToken();
  claimPatch(projectRoot, runId, { tokenHash: hash, cwd: ws.cwd, step: claim.step }, home);
  if (claim.step === 'review') {
    try {
      const digest = workspaceDigest(contextRoot, view, meta, ws.cwd);
      updateTaskJobs(projectRoot, (f) => { f.snapshots = [...f.snapshots.filter((x) => x.runId !== runId), { runId, digest }]; }, home);
    } catch (err) {
      return block(`its workspace could not be read before the review: ${oneDataLine((err as Error).message, 160)}`);
    }
  }

  const contract = stepContract(claim.step, view, meta, ws.cwd, ws.branch);
  const raw = readVaultFileSafe(contextRoot, join('state', `${view.slug}.md`)) ?? '';
  const parentRaw = view.parent ? readVaultFileSafe(contextRoot, join('state', `${view.parent}.md`)) : null;
  const job: TaskJobBrief = { body: raw, parentBody: parentRaw, contract };
  // The note waiting for this step: the assignment's (data in the brief), or what a resume carries.
  // Read, not taken: a start refused before any child ran must find it again next time.
  const note = peekResumeNote(projectRoot, claim.taskId, home);
  const env: Record<string, string> = {
    DREAMCONTEXT_TASK_RUN: runId,
    DREAMCONTEXT_TASK_TOKEN: token,
    DREAMCONTEXT_TASK_ID: claim.taskId,
    ...(meta.workspace === 'code' ? { [TASK_CONTEXT_ROOT_ENV]: contextRoot, [TASK_WORKTREE_ENV]: ws.cwd } : {}),
  };

  // The stall watcher: no transcript growth for STALL_MS stops the run.
  let childPid: number | null = null;
  let stalled = false;
  const stallMs = deps.stallMs ?? STALL_MS;
  const sizeOf = deps.transcriptSize ?? ((sid: string) => defaultTranscriptSize(sid, home));
  let lastSize: number | null = -1;
  let lastChange = Date.now();
  const timer = setInterval(() => {
    const size = sizeOf(claim.sessionId!);
    if (size !== lastSize) { lastSize = size; lastChange = Date.now(); return; }
    if (Date.now() - lastChange >= stallMs && childPid && !stalled) {
      stalled = true;
      // The host's own stall-stop (C1-8): the one kill a task job makes without a human.
      if (deps.killGroup) deps.killGroup(childPid);
      else try { process.kill(-childPid, 'SIGKILL'); } catch { /* gone */ }
    }
  }, deps.stallPollMs ?? 60_000);
  timer.unref?.();

  let outcome: RunOutcome;
  try {
    outcome = await (deps.run ?? runAutomation)(contextRoot, claim.agent, {
      host: 'cli',
      target: 'agent',
      home,
      now: deps.now,
      log,
      unattended: true,
      ...(deps.spawnImpl ? { spawnImpl: deps.spawnImpl } : {}),
      ...(deps.probeUsage ? { probeUsage: deps.probeUsage } : {}),
      task: { slug: view.slug, name: view.name, job, ...(note && !claim.resume ? { note: note.text } : {}) },
      taskStep: {
        taskId: claim.taskId,
        cwd: ws.cwd,
        permissionArgs: levelPermissionArgs(level, claim.step),
        env,
        sessionId: claim.sessionId!,
        resume: claim.resume,
        resumePrompt: claim.resume ? resumePrompt(note, contract) : null,
        timeoutMs: TASK_STEP_BUDGET_MS,
        onChild: (pid) => {
          childPid = pid;
          claimPatch(projectRoot, runId, { childPid: pid }, home);
          // The session exists from this moment (fresh `--session-id`, or the one resumed): only
          // now may a later step resume it, and only now is the note spent.
          registerTaskSession(projectRoot, { sessionId: claim.sessionId!, taskId: claim.taskId, role: claim.role, agent: claim.agent }, home);
          if (note) takeResumeNote(projectRoot, claim.taskId, home);
        },
      },
    });
  } finally {
    clearInterval(timer);
  }
  const state = settleTaskStep(contextRoot, runId, outcome, { stalled, cwd: ws.cwd }, deps);
  startDueTaskJobs(contextRoot, deps);
  return { state, outcome };
}

/**
 * Outcome → state (C1-5, C1-12), every write a compare-and-set on (this run's claim, its step).
 * Returns the state written, or null when nothing was (the claim was closed under it).
 */
export function settleTaskStep(
  contextRoot: string,
  runId: string,
  outcome: RunOutcome,
  flags: { stalled: boolean; cwd: string },
  deps: TaskHostDeps = {},
): string | null {
  const home = deps.home;
  const projectRoot = dirname(contextRoot);
  const now = (deps.now ?? (() => new Date()))();
  const claim = claimByRun(projectRoot, runId, home);
  if (!claim) return null; // a Stop or the reconciler closed it
  const head = findTaskHead(contextRoot, claim.taskId);
  const meta = metaFor(projectRoot, claim.taskId, home);
  if (!head || !meta) { dropClaim(projectRoot, runId, home); return null; }
  const view = taskJobView(head);
  const step = claim.step;
  // Never on a task its owner closed meanwhile (completed or cancelled): nothing reopens it.
  const isOpen = openTaskCheck(contextRoot);
  const set = (to: string, extra: Record<string, unknown> = {}): boolean =>
    !!casTask(contextRoot, view.slug, { from: ['running', 'starting'], step, check: isOpen }, { agent_state: to, agent_claimed_machine: null, updated_at: today(), ...extra });

  // Delivered: the delivery already moved the task on; this exit touches nothing.
  if (claim.phase === 'delivered' || claim.orphanedFrom === 'delivered') {
    dropClaim(projectRoot, runId, home);
    return null;
  }
  if (flags.stalled) {
    claimPatch(projectRoot, runId, { phase: 'stalled' }, home);
    if (!set('stalled')) return null;
    raiseTaskRow(projectRoot, 'task-stalled', view, claim.agent, `${view.name}: the agent went quiet for 30 minutes and was stopped.`, ['continue', 'take-over'], undefined, home, now);
    return 'stalled';
  }
  if (!outcome.spawned) {
    // Refused before a child ran: blocked asks the owner; every other refusal waits its turn again.
    dropClaim(projectRoot, runId, home);
    if (outcome.status === 'blocked') {
      if (!set('blocked', { agent_blocked: oneDataLine(outcome.error ?? 'blocked', 300) })) return null;
      raiseTaskRow(projectRoot, 'task-blocked', view, claim.agent, `${view.name}: blocked, ${outcome.error ?? 'the agent could not start'}.`, ['continue', 'take-over', 'dismiss'], undefined, home, now);
      return 'blocked';
    }
    return requeue(contextRoot, view.slug, view.id, step, claim.round, ['running', 'starting'], home) ? 'queued' : null;
  }
  // The run stopped and asked (its own `propose`, or a gate that asks): the owner owes an answer.
  if (outcome.status === 'awaiting-review' || (outcome.reviewCardId && outcome.status === 'ok')) {
    claimPatch(projectRoot, runId, { phase: 'waiting_owner', sessionId: outcome.sessionId ?? claim.sessionId }, home);
    if (!set('waiting_owner')) return null;
    raiseTaskRow(projectRoot, 'task-question', view, claim.agent, `${view.name}: the agent asked you something.`, ['open-task'], undefined, home, now);
    return 'waiting_owner';
  }
  if (outcome.status === 'blocked' || outcome.status === 'awaiting-approval') {
    dropClaim(projectRoot, runId, home);
    if (!set('blocked', { agent_blocked: oneDataLine(outcome.error ?? outcome.status, 300) })) return null;
    raiseTaskRow(projectRoot, 'task-blocked', view, claim.agent, `${view.name}: blocked, ${outcome.error ?? outcome.status}.`, ['continue', 'take-over', 'dismiss'], undefined, home, now);
    return 'blocked';
  }
  if (step === 'plan' && outcome.status === 'ok') {
    dropClaim(projectRoot, runId, home);
    if (!set('waiting_owner')) return null;
    raiseTaskRow(projectRoot, 'task-plan', view, claim.agent, `${view.name}: the agent's plan is waiting for your approval.`, ['approve-plan', 'change-plan'], outcome.result ?? undefined, home, now);
    return 'waiting_owner';
  }
  if (step === 'review') return settleReview(contextRoot, claim, view, meta, flags.cwd, deps, now);

  // ok without a delivery, failed, timeout: stopped.
  dropClaim(projectRoot, runId, home);
  if (!set('stopped', { agent_stopped: oneDataLine(outcome.error ?? `ended ${outcome.status} without delivering`, 300) })) return null;
  raiseTaskRow(projectRoot, 'task-stopped', view, claim.agent, `${view.name}: the agent ended without delivering (${outcome.status}).`, ['continue', 'take-over', 'dismiss'], undefined, home, now);
  return 'stopped';
}

/** The reviewer's run ended: apply its verdict only if the workspace is as it was before it. */
function settleReview(
  contextRoot: string, claim: TaskClaim, view: TaskJobView, meta: TaskMeta, cwd: string, deps: TaskHostDeps, now: Date,
): string | null {
  const home = deps.home;
  const projectRoot = dirname(contextRoot);
  const jobs = readTaskJobs(projectRoot, home);
  const verdict = jobs.verdicts.find((v) => v.runId === claim.runId) ?? null;
  const before = jobs.snapshots.find((s) => s.runId === claim.runId)?.digest ?? null;
  let after: string | null = null;
  try { after = workspaceDigest(contextRoot, view, meta, cwd); } catch { after = null; }
  updateTaskJobs(projectRoot, (f) => {
    f.verdicts = f.verdicts.filter((v) => v.runId !== claim.runId);
    f.snapshots = f.snapshots.filter((s) => s.runId !== claim.runId);
    f.claims = f.claims.filter((c) => c.runId !== claim.runId);
  }, home);
  const unchanged = before !== null && after !== null && before === after;
  const usable = verdict && verdict.round === claim.round && unchanged ? verdict : null;
  const isOpen = openTaskCheck(contextRoot);
  const set = (fields: Record<string, unknown>): boolean =>
    !!casTask(contextRoot, view.slug, { from: ['running', 'starting'], step: 'review', check: (v) => v.round === claim.round && isOpen(v) }, { agent_claimed_machine: null, updated_at: today(), ...fields });

  if (!usable) {
    if (verdict && !unchanged) {
      noteOnTask(contextRoot, view.slug, `### ${today()} - Review refused\n- Round ${claim.round}: the reviewer's verdict was refused because the workspace changed during the review.`);
    }
    const tries = (meta.noVerdict ?? 0) + 1;
    patchMeta(projectRoot, view.id, { noVerdict: tries }, home);
    if (tries <= 1) {
      // One retry of the review, then stuck.
      return requeue(contextRoot, view.slug, view.id, 'review', claim.round, ['running', 'starting'], home) ? 'queued' : null;
    }
    if (!set({ agent_state: 'stuck' })) return null;
    raiseTaskRow(projectRoot, 'task-stuck', view, meta.reviewer,
      `${view.name}: the reviewer gave no usable verdict${verdict && !unchanged ? ' (it changed the workspace)' : ''}.`,
      ['one-more-round', 'take-over', 'cancel'], undefined, home, now);
    return 'stuck';
  }
  patchMeta(projectRoot, view.id, { noVerdict: 0 }, home);
  const reviewer = meta.reviewer ?? claim.agent;
  const findings = usable.findings.join('\n');
  if (usable.verdict === 'pass') {
    if (!set({ agent_state: 'delivered', review_passed: true })) return null;
    fanOutDelivered(contextRoot, view, meta, { passedBy: reviewer, notify: deps.notify, home, now });
    return 'delivered';
  }
  if (claim.round < meta.reviewCap) {
    if (!set({ agent_state: 'queued', agent_step: 'rework', review_passed: false })) return null;
    setTaskStatus(contextRoot, view.slug, PARENT_BY_KIND.active, { kind: 'reviewer', slug: reviewer }, `Review round ${claim.round}: sent back.`);
    setResumeNote(projectRoot, { taskId: view.id, kind: 'findings', text: findings || 'The reviewer failed the delivery without naming a criterion.' }, home);
    armStart(projectRoot, view.id, 'rework', claim.round, home);
    return 'queued';
  }
  if (!set({ agent_state: 'stuck', review_passed: false })) return null;
  setResumeNote(projectRoot, { taskId: view.id, kind: 'findings', text: findings || 'The reviewer failed the delivery.' }, home);
  const reviewerGone = !getRunTarget(contextRoot, reviewer, 'agent');
  raiseTaskRow(projectRoot, 'task-stuck', view, reviewer,
    `${view.name}: still failing at review round ${claim.round}${reviewerGone ? ` (its reviewer ${reviewer} is gone)` : ''}.`,
    ['one-more-round', 'take-over', 'cancel'], findings || undefined, home, now);
  return 'stuck';
}

/** One line on the task's changelog. Best effort: the state change is the record. */
function noteOnTask(contextRoot: string, slug: string, entry: string): void {
  try {
    insertToSection(join(contextRoot, 'state', `${slug}.md`), 'Changelog', entry, 'top', true);
  } catch {
    // the state on the task already says it
  }
}
