import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { GIT_SAFE_ARGS } from '../super/worktrees.js';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { today } from '../id.js';
import { PARENT_BY_KIND } from '../task-status.js';
import { readVaultFileSafe, safeVaultPath, safeWriteTarget } from '../vault-read.js';
import { scrubContent, summarizeScrub } from '../git-sync/scrub.js';
import { appLinkForContextRoot } from '../app-link.js';
import { appendThreadEntry } from '../automations/threads.js';
import { defaultNotify, oneDataLine } from '../automations/runner.js';
import { armStart, ledgerRecordFor } from './assignment-ledger.js';
import { getRunTarget } from '../automations/store.js';
import {
  casTask, claimByRun, findTaskHead, hashToken, metaFor, patchMeta, taskJobView, taskWorkspaceSlug, updateTaskJobs,
  type TaskClaim, type TaskJobView, type TaskMeta,
} from './task-jobs.js';
import { openTaskCheck, raiseTaskRow, setTaskStatus } from './task-starter.js';

/**
 * The two verbs a task step's own run calls (AI Team v2 C1-10, C1-12):
 *
 *   dreamcontext tasks deliver <id> --note … [--doc …] [--board …] [--file …]
 *   dreamcontext tasks review  <id> --verdict pass|fail [--finding …]
 *
 * Accepted ONLY from the assigned run: the run's id and a per-run random token ride its env, the
 * token's hash is in this machine's claim (M0), and the claim must match the task, the step and
 * the round. A stale run (its claim closed), a wrong step or round, or another process's call is
 * refused. Agent-written text that lands in synced task files is scanned with the brain sync's
 * own secret rules (M3), and a delivered file is copied into the brain only when it is a regular
 * file inside the run's workspace that git does not ignore and is not an `.env*` file.
 */

export type NotifyFn = (title: string, body: string, link: string | null) => void;

export type DeliveryResult =
  | { ok: true; state: string; round: number; task: string }
  | { ok: false; code: string; message: string };

const no = (code: string, message: string): DeliveryResult => ({ ok: false, code, message });

/** The run calling: its claim, checked against the env it was given. */
function callingClaim(projectRoot: string, env: NodeJS.ProcessEnv, home?: string): TaskClaim | DeliveryResult {
  const runId = env.DREAMCONTEXT_TASK_RUN;
  const token = env.DREAMCONTEXT_TASK_TOKEN;
  if (!runId || !token) return no('not_a_task_run', 'Only the run a task was assigned to can call this.');
  const claim = claimByRun(projectRoot, runId, home);
  if (!claim) return no('stale_run', 'This run no longer holds the task (it was stopped, or a later run took it over).');
  if (!claim.tokenHash || claim.tokenHash !== hashToken(token)) return no('wrong_token', 'This run is not the one the task was assigned to.');
  if (claim.phase !== 'active' && claim.phase !== 'orphaned') return no('stale_run', 'This run no longer holds the task.');
  return claim;
}

function blockHit(rel: string, text: string): string | null {
  const { blocks } = summarizeScrub(scrubContent(rel, text));
  return blocks.length ? blocks[0].rule : null;
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * A `--file` the run hands in: a regular file (no symlink) inside the run's workspace, not
 * ignored by git there (fails closed: no repo, or git errors), not an `.env*` file, and with no
 * secret in it. Returns the absolute path, or the refusal.
 */
function checkDeliveredFile(raw: string, cwd: string, workspace: string): { path: string; bytes: Buffer } | DeliveryResult {
  const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
  let st;
  try { st = lstatSync(abs); } catch { return no('file_missing', `${oneDataLine(raw, 120)} does not exist.`); }
  if (st.isSymbolicLink()) return no('file_symlink', `${oneDataLine(raw, 120)} is a symlink; hand in the file itself.`);
  if (!st.isFile()) return no('file_not_regular', `${oneDataLine(raw, 120)} is not a regular file.`);
  let realFile: string;
  let realWs: string;
  try { realFile = realpathSync(abs); realWs = realpathSync(workspace); } catch { return no('file_outside', `${oneDataLine(raw, 120)} could not be resolved.`); }
  if (!within(realFile, realWs)) return no('file_outside', `${oneDataLine(raw, 120)} is outside your workspace.`);
  if (/^\.env/i.test(basename(realFile))) return no('file_env', 'An .env file is never handed in.');
  const ignored = spawnSync('git', [...GIT_SAFE_ARGS, 'check-ignore', '-q', '--', relative(realWs, realFile)], { cwd: realWs, stdio: 'ignore' });
  if (ignored.status === 0) return no('file_ignored', `${oneDataLine(raw, 120)} is ignored by git in your workspace, so it is not handed in.`);
  if (ignored.status !== 1) return no('file_unchecked', 'Your workspace is not a git repository (or git failed), so no file can be handed in from it.');
  // ONE read, through a handle that refuses a symlink swapped in since the checks above: the
  // bytes scanned are the bytes copied.
  let bytes: Buffer;
  try {
    const fd = openSync(realFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      if (!fstatSync(fd).isFile()) return no('file_not_regular', `${oneDataLine(raw, 120)} is not a regular file.`);
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    return no('file_unreadable', `${oneDataLine(raw, 120)} could not be read.`);
  }
  const hit = blockHit(basename(realFile), bytes.toString('utf8'));
  if (hit) return no('file_secret', `${oneDataLine(raw, 120)} holds a secret (${hit}); it was not handed in.`);
  return { path: realFile, bytes };
}

/** A brain reference (`--doc`, `--board`): a regular file inside the brain, read through the safe reader. */
function checkBrainRef(contextRoot: string, raw: string): string | DeliveryResult {
  const rel = raw.replace(/^_dream_context\//, '').replace(/^\.\//, '');
  if (!safeVaultPath(contextRoot, rel) || readVaultFileSafe(contextRoot, rel) === null) {
    return no('ref_invalid', `${oneDataLine(raw, 120)} is not a file inside the brain.`);
  }
  return rel;
}

export interface DeliverInput {
  note: string;
  docs?: string[];
  boards?: string[];
  files?: string[];
}

export interface DeliveryRef {
  kind: 'doc' | 'board' | 'file' | 'branch';
  path: string;
}

export interface Delivery {
  round: number;
  at: string;
  by: string;
  note: string;
  refs: DeliveryRef[];
  branch?: string;
  commits?: string[];
}

/** The commits a code task's branch carries over its base, newest first (`<sha> <subject>`). */
function branchCommits(cwd: string, base: string | null): { branch: string | null; commits: string[] } {
  try {
    const branch = execFileSync('git', [...GIT_SAFE_ARGS, 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const range = base ? `${base}..HEAD` : 'HEAD~1..HEAD';
    const out = execFileSync('git', [...GIT_SAFE_ARGS, 'log', '--no-show-signature', '--format=%h %s', '-n', '50', range], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return { branch, commits: out.split('\n').map((l) => oneDataLine(l, 200)).filter(Boolean) };
  } catch {
    return { branch: null, commits: [] };
  }
}

/**
 * `tasks deliver`: record the delivery on the task, move it to In Review (by the agent), and
 * queue the review step (or, with no reviewer, tell the owner). Resolves the task by id.
 */
export function deliverTask(
  contextRoot: string,
  idOrSlug: string,
  input: DeliverInput,
  opts: { env?: NodeJS.ProcessEnv; cwd?: string; home?: string; now?: Date; notify?: NotifyFn } = {},
): DeliveryResult {
  const home = opts.home;
  const env = opts.env ?? process.env;
  const projectRoot = dirname(contextRoot);
  const now = opts.now ?? new Date();
  const c = callingClaim(projectRoot, env, home);
  if ('ok' in c) return c;
  const claim = c;
  if (claim.step !== 'work' && claim.step !== 'rework') return no('wrong_step', 'This run is not the one that does the work, so it cannot deliver.');
  const head = findTaskHead(contextRoot, idOrSlug);
  if (!head || head.id !== claim.taskId) return no('wrong_task', 'This run was assigned another task.');
  const view = taskJobView(head);
  if (view.step !== claim.step) return no('wrong_step', 'The task has moved on from this step.');
  const meta = metaFor(projectRoot, claim.taskId, home);
  if (!meta) return no('stale_run', 'This task is no longer assigned on this machine.');

  const note = (input.note ?? '').trim();
  if (!note) return no('note_required', 'Say what you did with --note.');
  const noteHit = blockHit('delivery-note.md', note);
  if (noteHit) return no('note_secret', `The note holds a secret (${noteHit}); take it out and deliver again.`);

  const refs: DeliveryRef[] = [];
  for (const d of input.docs ?? []) {
    const r = checkBrainRef(contextRoot, d);
    if (typeof r !== 'string') return r;
    refs.push({ kind: 'doc', path: r });
  }
  for (const b of input.boards ?? []) {
    const r = checkBrainRef(contextRoot, b);
    if (typeof r !== 'string') return r;
    refs.push({ kind: 'board', path: r });
  }
  const workspace = claim.cwd ?? projectRoot;
  const toCopy: Array<{ path: string; bytes: Buffer }> = [];
  for (const f of input.files ?? []) {
    const r = checkDeliveredFile(f, opts.cwd ?? process.cwd(), workspace);
    if ('ok' in r) return r;
    toCopy.push(r);
  }
  const outRel = join('automations', 'output', meta.doer, 'tasks', taskWorkspaceSlug(claim.taskId));
  for (const file of toCopy) {
    const destRel = join(outRel, basename(file.path));
    const dest = join(contextRoot, destRel);
    mkdirSync(dirname(dest), { recursive: true });
    if (!safeWriteTarget(contextRoot, dest)) return no('file_target', 'The task\'s output folder in the brain is not writable safely.');
    writeFileSync(dest, file.bytes);
    refs.push({ kind: 'file', path: destRel.split(sep).join('/') });
  }
  const code = meta.workspace === 'code' ? branchCommits(workspace, meta.base) : { branch: null, commits: [] };
  if (code.branch) refs.push({ kind: 'branch', path: code.branch });

  const round = claim.step === 'rework' || claim.step === 'work' ? view.round + 1 : view.round;
  const delivery: Delivery = {
    round, at: now.toISOString(), by: claim.agent, note: note.slice(0, 4000), refs,
    ...(code.branch ? { branch: code.branch, commits: code.commits } : {}),
  };
  // A reviewer that no longer exists (or was never recorded here) reviews nothing: the delivery
  // then waits for the owner instead of queueing a step nobody can claim.
  const reviewer = meta.reviewer && getRunTarget(contextRoot, meta.reviewer, 'agent') && ledgerRecordFor(projectRoot, claim.taskId, 'reviewer', meta.reviewer)
    ? meta.reviewer
    : null;
  const isOpen = openTaskCheck(contextRoot);
  // Never on a task its owner already completed or cancelled: a late delivery must not reopen it.
  const moved = casTask(contextRoot, view.slug, { from: ['running', 'starting', 'stalled'], step: claim.step, check: (v) => v.id === claim.taskId && isOpen(v) }, (v) => {
    const prior = Array.isArray(v.raw.deliveries) ? (v.raw.deliveries as unknown[]) : [];
    return {
      deliveries: [...prior, delivery].slice(-20),
      review_round: round,
      review_passed: false,
      agent_state: reviewer ? 'queued' : 'delivered',
      ...(reviewer ? { agent_step: 'review', agent_queued_at: now.toISOString() } : {}),
      updated_at: today(),
    };
  });
  if (!moved) return no('stale_run', 'The task moved on while this run was delivering.');
  // The doer's claim moves to `delivered`: its later exit cannot touch the review step.
  updateTaskJobs(projectRoot, (f) => {
    f.claims = f.claims.map((x) => (x.runId === claim.runId ? { ...x, phase: 'delivered' as const } : x));
  }, home);
  setTaskStatus(contextRoot, view.slug, PARENT_BY_KIND.review, { kind: 'agent', slug: claim.agent }, `Delivered round ${round}.`);
  if (reviewer) {
    patchMeta(projectRoot, claim.taskId, { noVerdict: 0, queuedAt: now.toISOString() }, home);
    armStart(projectRoot, claim.taskId, 'review', round, home);
    return { ok: true, state: 'queued', round, task: view.slug };
  }
  fanOutDelivered(contextRoot, view, meta, { notify: opts.notify, home, now });
  return { ok: true, state: 'delivered', round, task: view.slug };
}

/**
 * `tasks review`: store the reviewer's verdict in M0. The host applies it after the run, and only
 * if the workspace is exactly as it was before the review.
 */
export function reviewTask(
  contextRoot: string,
  idOrSlug: string,
  input: { verdict: string; findings?: string[] },
  opts: { env?: NodeJS.ProcessEnv; home?: string; now?: Date } = {},
): DeliveryResult {
  const home = opts.home;
  const projectRoot = dirname(contextRoot);
  const c = callingClaim(projectRoot, opts.env ?? process.env, home);
  if ('ok' in c) return c;
  const claim = c;
  if (claim.step !== 'review') return no('wrong_step', 'This run is not a review, so it cannot give a verdict.');
  const head = findTaskHead(contextRoot, idOrSlug);
  if (!head || head.id !== claim.taskId) return no('wrong_task', 'This run was assigned another task.');
  const view = taskJobView(head);
  if (view.step !== 'review' || view.round !== claim.round) return no('wrong_round', 'This review is for another round.');
  if (!openTaskCheck(contextRoot)(view)) return no('task_closed', 'The owner closed this task; the review is not needed.');
  if (input.verdict !== 'pass' && input.verdict !== 'fail') return no('bad_verdict', 'The verdict is pass or fail.');
  const findings = (input.findings ?? []).map((f) => f.trim()).filter(Boolean).map((f) => f.slice(0, 2000)).slice(0, 30);
  for (const f of findings) {
    const hit = blockHit('review-finding.md', f);
    if (hit) return no('finding_secret', `A finding holds a secret (${hit}); take it out and record the verdict again.`);
  }
  updateTaskJobs(projectRoot, (j) => {
    j.verdicts = [...j.verdicts.filter((v) => v.runId !== claim.runId), {
      runId: claim.runId, taskId: claim.taskId, round: claim.round, verdict: input.verdict as 'pass' | 'fail', findings,
      at: (opts.now ?? new Date()).toISOString(),
    }];
  }, home);
  return { ok: true, state: 'recorded', round: claim.round, task: view.slug };
}

/**
 * A delivery the owner now owes a look (no reviewer, or the reviewer passed it): a thread line,
 * a desktop banner that opens the task, and the `task-review` row (it dies when the task leaves
 * review on any path).
 */
export function fanOutDelivered(
  contextRoot: string,
  view: TaskJobView,
  meta: TaskMeta,
  opts: { passedBy?: string; notify?: NotifyFn; home?: string; now?: Date } = {},
): void {
  const now = opts.now ?? new Date();
  const projectRoot = dirname(contextRoot);
  const name = oneDataLine(view.name, 120);
  const text = opts.passedBy ? `${name}: the reviewer ${opts.passedBy} passed the delivery. It is In Review, waiting for you.` : `${name}: delivered. It is In Review, waiting for you.`;
  try {
    appendThreadEntry(contextRoot, meta.doer, { runId: now.toISOString(), kind: 'system', event: 'ok', text, via: 'runner', now });
  } catch { /* the row and the task say it too */ }
  const link = appLinkForContextRoot(contextRoot, { kind: 'page', page: 'tasks', id: view.slug }, opts.home);
  try {
    (opts.notify ?? ((t, b, l) => defaultNotify(t, b, opts.home, undefined, null, l)))(`${meta.doer} · ${name}`, text, link);
  } catch { /* a banner is best effort */ }
  raiseTaskRow(projectRoot, 'task-review', view, meta.doer, text, ['complete', 'send-back'], undefined, opts.home, now);
}

/**
 * Is the caller the live task-step run of `agent` (its run id and token match a claim here)? A
 * task step's question has a watcher whatever the agent's review setting: the task waits on the
 * owner, with a row in the inbox and on the task (C1-5), so `propose` is not refused there.
 */
export function isTaskStepRunOf(contextRoot: string, agent: string, env: NodeJS.ProcessEnv = process.env, home?: string): boolean {
  const c = callingClaim(dirname(contextRoot), env, home);
  return !('ok' in c) && c.agent === agent;
}
