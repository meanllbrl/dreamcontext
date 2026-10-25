import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { updateFrontmatterFields } from '../frontmatter.js';
import { readLocalJson, updateLocalJson } from '../local-store.js';
import { withTaskFileLock } from '../task-file-lock.js';
import { isSafeTaskSlug } from '../task-backend/local.js';
import { readVaultFileSafe } from '../vault-read.js';
import { readMachineIdentity } from '../machine-id.js';

/**
 * Task jobs (AI Team v2 C1): the machine-local records every task-step start, refusal and settle
 * reads, and the compare-and-set writes on the task file.
 *
 * Two layers, deliberately apart:
 *  - The TASK FILE carries display and coordination fields (`agent_state`, `agent_step`,
 *    `review_round`, …). It syncs with the brain, so a teammate can edit it, and nothing starts
 *    or is refused on its word alone.
 *  - M0 (`<localDir>/agent-task-jobs.json`) carries every fact a start or a refusal depends on:
 *    the claim of a running step, the task-session registry, the start instant and review cap
 *    copied at assign time, run tokens, pending verdicts and owner replies.
 *
 * Every key has a death: a claim closes when its host settles or the reconciler retires it; a
 * task's meta, sessions, verdicts and replies die when it is unassigned, completed, cancelled or
 * deleted (`forgetTaskJob`); a session entry is kept while its task is assigned, since a rework
 * or an answer resumes it.
 */

export type TaskStep = 'plan' | 'work' | 'review' | 'rework';
export const TASK_STEPS: readonly TaskStep[] = ['plan', 'work', 'review', 'rework'];

export type AgentTaskState =
  | 'scheduled' | 'queued' | 'starting' | 'running' | 'waiting_owner'
  | 'blocked' | 'delivered' | 'stopped' | 'stalled' | 'stuck';
export const AGENT_TASK_STATES: readonly AgentTaskState[] = [
  'scheduled', 'queued', 'starting', 'running', 'waiting_owner', 'blocked', 'delivered', 'stopped', 'stalled', 'stuck',
];

export type TaskWorkspace = 'code' | 'doc';

export type ClaimPhase = 'claiming' | 'active' | 'waiting_owner' | 'stalled' | 'orphaned' | 'delivered';

export interface TaskClaim {
  runId: string;
  taskId: string;
  taskSlug: string;
  step: TaskStep;
  round: number;
  /** The agent this step runs: the doer for plan/work/rework, the reviewer for review. */
  agent: string;
  role: 'doer' | 'reviewer';
  hostPid: number | null;
  childPid: number | null;
  /** The conversation this step runs in. A fresh step gets its id before the spawn. */
  sessionId: string | null;
  /** Resume the session instead of starting it (a rework, an answer, a continue). */
  resume: boolean;
  phase: ClaimPhase;
  claimedAt: string;
  /** sha256 of the run's token: `tasks deliver` / `tasks review` present the token itself. */
  tokenHash: string | null;
  /** The resolved cwd of the run (a worktree, or the project root for a doc task). */
  cwd: string | null;
  /** The phase an orphaned claim had before its host died (`delivered` keeps its task as it is). */
  orphanedFrom?: ClaimPhase;
}

export interface TaskMeta {
  taskId: string;
  taskSlug: string;
  doer: string;
  reviewer: string | null;
  workspace: TaskWorkspace;
  repo: string | null;
  /** The start instant (ISO with offset), or null for "now". The drain reads THIS copy. */
  startAt: string | null;
  /** FIFO key of the queued step; kept when a step is deferred or re-queued. */
  queuedAt: string;
  /** The binding review cap; the synced `review_cap` is display. */
  reviewCap: number;
  /** The base commit of a code task's branch, recorded when its worktree was made. */
  base: string | null;
  /** How many review runs ended with no verdict this round (one retry, then stuck). */
  noVerdict: number;
  /** The owner pressed "Start now" on a start missed by more than 12 hours. */
  lateOk?: boolean;
  /** Which of its agents were this machine's GLOBAL agents when it was assigned (D1). A project
   *  member of the same name arriving later must never run the job in the global agent's place. */
  globalAgents?: string[];
}

export interface TaskSessionEntry {
  sessionId: string;
  taskId: string;
  role: 'doer' | 'reviewer';
  agent: string;
  at: string;
}

export interface PendingVerdict {
  runId: string;
  taskId: string;
  round: number;
  verdict: 'pass' | 'fail';
  findings: string[];
  at: string;
}

/** What a reviewer's workspace looked like before its run; the verdict applies only if equal after. */
export interface ReviewSnapshot {
  runId: string;
  digest: string;
}

/** Text the next resume of a task step carries: the owner's reply, the reviewer's findings. */
export interface ResumeNote {
  taskId: string;
  kind: 'assign' | 'answer' | 'findings' | 'continue' | 'sendback' | 'plan-change';
  text: string;
  at: string;
}

interface JobsFile {
  claims: TaskClaim[];
  meta: TaskMeta[];
  sessions: TaskSessionEntry[];
  verdicts: PendingVerdict[];
  snapshots: ReviewSnapshot[];
  notes: ResumeNote[];
}

const FILE = 'agent-task-jobs.json';
const EMPTY: JobsFile = { claims: [], meta: [], sessions: [], verdicts: [], snapshots: [], notes: [] };

/** The review cap's bounds and default (owner decision: 5 rounds). */
export const REVIEW_CAP_DEFAULT = 5;
export const REVIEW_CAP_MIN = 1;
export const REVIEW_CAP_MAX = 10;

export function clampReviewCap(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return REVIEW_CAP_DEFAULT;
  return Math.min(REVIEW_CAP_MAX, Math.max(REVIEW_CAP_MIN, Math.round(n)));
}

const arr = <T>(v: unknown, ok: (x: T) => boolean): T[] => (Array.isArray(v) ? (v as T[]).filter((x) => !!x && typeof x === 'object' && ok(x)) : []);

function clean(f: Partial<JobsFile>): JobsFile {
  return {
    claims: arr<TaskClaim>(f.claims, (c) => typeof c.runId === 'string' && typeof c.taskId === 'string' && typeof c.agent === 'string'),
    meta: arr<TaskMeta>(f.meta, (m) => typeof m.taskId === 'string' && typeof m.doer === 'string'),
    sessions: arr<TaskSessionEntry>(f.sessions, (s) => typeof s.sessionId === 'string' && typeof s.taskId === 'string'),
    verdicts: arr<PendingVerdict>(f.verdicts, (v) => typeof v.runId === 'string' && typeof v.taskId === 'string'),
    snapshots: arr<ReviewSnapshot>(f.snapshots, (s) => typeof s.runId === 'string'),
    notes: arr<ResumeNote>(f.notes, (n) => typeof n.taskId === 'string' && typeof n.text === 'string'),
  };
}

export function readTaskJobs(projectRoot: string, home?: string): JobsFile {
  return clean(readLocalJson<Partial<JobsFile>>(projectRoot, FILE, EMPTY, home));
}

/** Change the jobs file under its lock. `mutate` edits the cleaned copy in place and returns a value. */
export function updateTaskJobs<R>(projectRoot: string, mutate: (f: JobsFile) => R, home?: string): R {
  let out: R | undefined;
  updateLocalJson<Partial<JobsFile>>(projectRoot, FILE, EMPTY, (cur) => {
    const f = clean(cur);
    out = mutate(f);
    return f;
  }, home);
  return out as R;
}

// ─── ids and tokens ───────────────────────────────────────────────────────────

export function newRunId(): string {
  return `tr_${randomBytes(6).toString('hex')}`;
}

export function newSessionId(): string {
  return randomUUID();
}

export function newRunToken(): { token: string; hash: string } {
  const token = randomBytes(24).toString('hex');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** The short, stable folder id of a task's worktree and branch: `task-<8hex>`. Task ids carry
 *  characters a branch name or the worktree slug alphabet does not, and slugs can be 200 long. */
export function taskWorkspaceSlug(taskId: string): string {
  return `task-${createHash('sha256').update(taskId, 'utf8').digest('hex').slice(0, 8)}`;
}

export function thisMachine(home?: string): { id: string; name: string } {
  const m = readMachineIdentity(home);
  return { id: m.id, name: m.name };
}

// ─── records ──────────────────────────────────────────────────────────────────

export function claimByRun(projectRoot: string, runId: string, home?: string): TaskClaim | null {
  return readTaskJobs(projectRoot, home).claims.find((c) => c.runId === runId) ?? null;
}

export function claimsForTask(projectRoot: string, taskId: string, home?: string): TaskClaim[] {
  return readTaskJobs(projectRoot, home).claims.filter((c) => c.taskId === taskId);
}

export function metaFor(projectRoot: string, taskId: string, home?: string): TaskMeta | null {
  return readTaskJobs(projectRoot, home).meta.find((m) => m.taskId === taskId) ?? null;
}

export function writeMeta(projectRoot: string, meta: TaskMeta, home?: string): void {
  updateTaskJobs(projectRoot, (f) => {
    f.meta = [...f.meta.filter((m) => m.taskId !== meta.taskId), meta];
  }, home);
}

export function patchMeta(projectRoot: string, taskId: string, patch: Partial<TaskMeta>, home?: string): void {
  updateTaskJobs(projectRoot, (f) => {
    f.meta = f.meta.map((m) => (m.taskId === taskId ? { ...m, ...patch, taskId } : m));
  }, home);
}

/** The session a task's role runs in (the doer's for every rework and answer), or null. */
export function taskSessionFor(projectRoot: string, taskId: string, role: 'doer' | 'reviewer', home?: string): string | null {
  const hits = readTaskJobs(projectRoot, home).sessions.filter((s) => s.taskId === taskId && s.role === role);
  return hits.length ? hits[hits.length - 1].sessionId : null;
}

/** Which task a session belongs to on this machine, or null (the M0 half of the session gate). */
export function taskOfSession(projectRoot: string, sessionId: string, home?: string): TaskSessionEntry | null {
  return readTaskJobs(projectRoot, home).sessions.find((s) => s.sessionId === sessionId) ?? null;
}

export function registerTaskSession(projectRoot: string, entry: Omit<TaskSessionEntry, 'at'>, home?: string, now: Date = new Date()): void {
  updateTaskJobs(projectRoot, (f) => {
    f.sessions = [...f.sessions.filter((s) => s.sessionId !== entry.sessionId), { ...entry, at: now.toISOString() }];
  }, home);
}

/** Keep one resume note per task (the newest replaces it): a resume carries one message. */
export function setResumeNote(projectRoot: string, note: Omit<ResumeNote, 'at'>, home?: string, now: Date = new Date()): void {
  updateTaskJobs(projectRoot, (f) => {
    f.notes = [...f.notes.filter((n) => n.taskId !== note.taskId), { ...note, at: now.toISOString() }];
  }, home);
}

/** The note waiting for a task's next step, left in place (it is taken once a child ran). */
export function peekResumeNote(projectRoot: string, taskId: string, home?: string): ResumeNote | null {
  return readTaskJobs(projectRoot, home).notes.find((n) => n.taskId === taskId) ?? null;
}

export function takeResumeNote(projectRoot: string, taskId: string, home?: string): ResumeNote | null {
  return updateTaskJobs(projectRoot, (f) => {
    const hit = f.notes.find((n) => n.taskId === taskId) ?? null;
    f.notes = f.notes.filter((n) => n.taskId !== taskId);
    return hit;
  }, home);
}

/** The death of everything this machine holds for a task (unassigned, completed, cancelled,
 *  deleted). Claims are left to their host and the reconciler: a live run is not forgotten. */
export function forgetTaskJob(projectRoot: string, taskId: string, home?: string): void {
  try {
    const f = readTaskJobs(projectRoot, home);
    const has = f.meta.some((m) => m.taskId === taskId) || f.sessions.some((s) => s.taskId === taskId)
      || f.verdicts.some((v) => v.taskId === taskId) || f.notes.some((n) => n.taskId === taskId);
    if (!has) return;
    updateTaskJobs(projectRoot, (j) => {
      j.meta = j.meta.filter((m) => m.taskId !== taskId);
      j.sessions = j.sessions.filter((s) => s.taskId !== taskId);
      j.verdicts = j.verdicts.filter((v) => v.taskId !== taskId);
      j.notes = j.notes.filter((n) => n.taskId !== taskId);
    }, home);
  } catch {
    // a stale entry names a task that no longer runs here
  }
}

/** An agent renamed or deleted: its meta and sessions follow it (or go). Never throws. */
export function renameOrForgetAgentTaskJobs(projectRoot: string, agent: string, to: string | null, home?: string): void {
  try {
    updateTaskJobs(projectRoot, (f) => {
      if (to === null) {
        f.sessions = f.sessions.filter((s) => s.agent !== agent);
        return;
      }
      f.meta = f.meta.map((m) => ({ ...m, doer: m.doer === agent ? to : m.doer, reviewer: m.reviewer === agent ? to : m.reviewer }));
      f.sessions = f.sessions.map((s) => (s.agent === agent ? { ...s, agent: to } : s));
      f.claims = f.claims.map((c) => (c.agent === agent ? { ...c, agent: to } : c));
    }, home);
  } catch {
    // see forgetTaskJob
  }
}

// ─── the task file ────────────────────────────────────────────────────────────

export function taskFilePath(contextRoot: string, slug: string): string {
  return join(contextRoot, 'state', `${slug}.md`);
}

/** One task file's head (frontmatter), read through the safe reader: a symlinked or non-regular
 *  file is not a task. Null when the slug is unsafe or the file is missing or unparseable. */
export function readTaskHead(contextRoot: string, slug: string): TaskHead | null {
  if (!isSafeTaskSlug(slug)) return null;
  const raw = readVaultFileSafe(contextRoot, join('state', `${slug}.md`));
  if (raw === null) return null;
  try {
    const data = (matter(raw, {}).data ?? {}) as Record<string, unknown>;
    return { slug, id: str(data.id) ?? slug, name: typeof data.name === 'string' ? data.name : slug, data };
  } catch {
    return null;
  }
}

/** Every task file's head in the brain. Never throws. */
export function listTaskHeads(contextRoot: string): TaskHead[] {
  let names: string[] = [];
  try { names = readdirSync(join(contextRoot, 'state')).filter((n) => /^[a-z0-9][a-z0-9-]*\.md$/.test(n)); } catch { return []; }
  const out: TaskHead[] = [];
  for (const name of names) {
    const head = readTaskHead(contextRoot, name.slice(0, -3));
    if (head) out.push(head);
  }
  return out;
}

/** The task whose `id` (or slug) is `idOrSlug`: a run resolves its task by id, so a rename mid-run still finds it. */
export function findTaskHead(contextRoot: string, idOrSlug: string): TaskHead | null {
  const direct = readTaskHead(contextRoot, idOrSlug);
  if (direct) return direct;
  return listTaskHeads(contextRoot).find((t) => t.id === idOrSlug) ?? null;
}

export interface TaskHead {
  slug: string;
  id: string;
  name: string;
  data: Record<string, unknown>;
}

export interface TaskJobView {
  slug: string;
  id: string;
  name: string;
  status: string | null;
  agent: string | null;
  reviewer: string | null;
  state: AgentTaskState | null;
  step: TaskStep | null;
  round: number;
  claimedMachine: string | null;
  queuedAt: string | null;
  parent: string | null;
  raw: Record<string, unknown>;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function taskJobView(t: TaskHead): TaskJobView {
  const raw = t.data;
  const state = str(raw.agent_state);
  const step = str(raw.agent_step);
  const round = Number(raw.review_round);
  return {
    slug: t.slug,
    id: t.id,
    name: t.name,
    status: str(raw.status),
    agent: str(raw.agent),
    reviewer: str(raw.reviewer),
    state: state && (AGENT_TASK_STATES as readonly string[]).includes(state) ? (state as AgentTaskState) : null,
    step: step && (TASK_STEPS as readonly string[]).includes(step) ? (step as TaskStep) : null,
    round: Number.isFinite(round) && round >= 0 ? Math.floor(round) : 0,
    claimedMachine: str(raw.agent_claimed_machine),
    queuedAt: str(raw.agent_queued_at),
    parent: str(raw.parent_task),
    raw,
  };
}

/**
 * Compare-and-set on the task file, under its lock: apply `fields` only when the task's
 * `agent_state` is one of `from` (and, when given, its `agent_step` is `step`). Returns the view
 * before the write, or null when the predicate failed or the task is gone.
 */
export function casTask(
  contextRoot: string,
  slug: string,
  pred: { from?: readonly AgentTaskState[]; step?: TaskStep | readonly TaskStep[]; check?: (v: TaskJobView) => boolean },
  fields: Record<string, unknown> | ((v: TaskJobView) => Record<string, unknown>),
): TaskJobView | null {
  if (!isSafeTaskSlug(slug)) return null;
  let before: TaskJobView | null = null;
  withTaskFileLock(contextRoot, slug, () => {
    const t = readTaskHead(contextRoot, slug);
    if (!t) return;
    const v = taskJobView(t);
    if (pred.from && !(v.state && pred.from.includes(v.state))) return;
    if (pred.step !== undefined) {
      const steps = typeof pred.step === 'string' ? [pred.step] : pred.step;
      if (!(v.step && steps.includes(v.step))) return;
    }
    if (pred.check && !pred.check(v)) return;
    updateFrontmatterFields(taskFilePath(contextRoot, slug), typeof fields === 'function' ? fields(v) : fields);
    before = v;
  });
  return before;
}
