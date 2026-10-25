import { lstatSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { updateFrontmatterFields } from '../frontmatter.js';
import { insertToSection } from '../markdown.js';
import { today } from '../id.js';
import { loadStatuses } from '../overrides.js';
import { PARENT_BY_KIND, statusKind } from '../task-status.js';
import { dateUpdatesForStatus } from '../task-dates.js';
import { withTaskFileLock } from '../task-file-lock.js';
import { isSafeTaskSlug, readTaskFile } from '../task-backend/local.js';
import type { TaskData } from '../task-backend/types.js';
import { checkApproval } from '../automations/registry.js';
import { getRunTarget } from '../automations/store.js';
import { appendThreadEntry } from '../automations/threads.js';
import { oneDataLine, TASK_NAME_MAX_CHARS } from '../automations/runner.js';
import type { AutomationManifest, RunStatus } from '../automations/types.js';
import { isSafeAutomationSlug } from './slot.js';
import { ownerLabel } from './owner.js';
import { armStart, recordAssignment } from './assignment-ledger.js';
import { clampReviewCap, forgetTaskJob, REVIEW_CAP_DEFAULT, setResumeNote, writeMeta, type TaskWorkspace } from './task-jobs.js';
import { parseStartAt } from './task-starter.js';
import { resolveLinkedRepos } from '../linked-repos.js';
import { statusChangeEntry } from '../task-history.js';
import { DEFAULT_AGENT_AUTONOMY } from '../automations/types.js';

/**
 * Assigning a task to an agent — the shared steps the dashboard route and the
 * CLI verb both take. The run itself is a task JOB (AI Team v2 C1): one claim
 * path, a detached host per step, the delivery and the reviewer loop
 * (`task-starter.ts`, `task-host.ts`, `task-delivery.ts`).
 *
 *  1. {@link prepareAssignment} — resolve the task, the agent and its call
 *     target, the job (when, where, who reviews), and refuse unless the agent
 *     and the reviewer are this person's and approved to RUN on this Mac.
 *  2. {@link commitAssignment} — the task's agent fields, the machine-local
 *     records a start depends on, the armed first step, the status rule, the
 *     assignment on the agent's thread.
 *  3. the drain (`startDueTaskJobs`, the caller's).
 *
 * Agents are never people: nothing here touches `people/people.json`, a
 * `person:` tag or the `assignee` field, and `agent:` is local-only, so no
 * backend pushes it.
 */

/** The longest note an assignment carries — the same cap the `#agents` channel has. */
export const ASSIGNMENT_NOTE_MAX_CHARS = 2000;

export type AssignmentRefusal =
  | 'unknown_task'
  | 'unknown_agent'
  | 'agent_not_approved_to_run'
  | 'not_owner'
  | 'agent_disabled'
  | 'note_too_long'
  | 'invalid_start'
  | 'invalid_workspace'
  | 'no_repo'
  | 'unknown_reviewer'
  | 'reviewer_is_agent';

/** Where and when the job runs (AI Team v2 C1-2). */
export interface JobOptions {
  /** An instant with its offset; absent or past = now. */
  startAt?: string | null;
  workspace?: TaskWorkspace;
  /** The linked repo a code task works in; absent = the one linked repo present here. */
  repo?: string | null;
  /** The agent that reviews each delivery; absent = the owner reviews. */
  reviewer?: string | null;
  reviewCap?: number | null;
}

export type AssignmentPrep =
  | {
      ok: true;
      /** The agent's call target, from the store (legacyKey and bindings set). */
      target: AutomationManifest;
      task: { slug: string; id: string; name: string };
      /** The note as the OWNER's live words: only a note typed in the dashboard. */
      ownerNote: string | null;
      /** A note that is data, not the owner speaking: the CLI's `--note`. */
      dataNote: string | null;
      /** The job, resolved: when, where, who reviews. */
      job: {
        startAt: string | null;
        workspace: TaskWorkspace;
        repo: string | null;
        reviewer: { slug: string; title: string } | null;
        reviewCap: number;
      };
    }
  | { ok: false; code: AssignmentRefusal; message: string };

export type AssignmentSource = 'dashboard' | 'cli';

function taskPath(contextRoot: string, slug: string): string {
  return join(contextRoot, 'state', `${slug}.md`);
}

/** The task file, read only when the slug is safe and the path is a regular file. */
function readTask(contextRoot: string, slug: string): TaskData | null {
  if (!isSafeTaskSlug(slug)) return null;
  const path = taskPath(contextRoot, slug);
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    return readTaskFile(path, loadStatuses(contextRoot));
  } catch {
    return null;
  }
}

function refuse(code: AssignmentRefusal, message: string): AssignmentPrep {
  return { ok: false, code, message };
}

/**
 * Resolve and check an assignment without writing anything. The target comes
 * from the store's `getRunTarget(…, 'agent')` (never composed here) and is
 * checked for the strict `'run'` use: an assignment EXECUTES the agent.
 *
 * The refusal for an agent that is not approved to run names the Agents page and
 * never a command — a session that reads it must not be one shell line away from
 * approving the agent itself.
 */
export function prepareAssignment(
  contextRoot: string,
  taskSlug: string,
  agentSlug: string,
  opts: { note?: string; source: AssignmentSource; home?: string } & JobOptions,
): AssignmentPrep {
  const note = (opts.note ?? '').trim();
  if (note.length > ASSIGNMENT_NOTE_MAX_CHARS) {
    return refuse('note_too_long', `Keep the note under ${ASSIGNMENT_NOTE_MAX_CHARS} characters.`);
  }
  const task = readTask(contextRoot, taskSlug);
  if (!task) return refuse('unknown_task', `There is no task named "${oneDataLine(taskSlug, 80)}" in this project.`);
  // A teammate's agent holding the task keeps it: only that agent's owner takes it off (B1-4).
  const holder = typeof task.raw?.agent === 'string' && task.raw.agent !== agentSlug && isSafeAutomationSlug(task.raw.agent)
    ? getRunTarget(contextRoot, task.raw.agent, 'agent') : null;
  const held = holder ? checkApproval(dirname(contextRoot), holder, opts.home, 'run') : null;
  if (holder && held && !held.approved && held.reason === 'not_owner') {
    return refuse('not_owner', `${oneDataLine(holder.agentTitle || holder.title, 120)} belongs to ${ownerLabel(held.owner)} and has this task: only its owner can hand it on.`);
  }
  const target = isSafeAutomationSlug(agentSlug) ? getRunTarget(contextRoot, agentSlug, 'agent') : null;
  if (!target) return refuse('unknown_agent', `There is no agent named "${oneDataLine(agentSlug, 80)}" in this project.`);
  const title = oneDataLine(target.agentTitle || target.title, 120);
  if (!target.enabled) return refuse('agent_disabled', `${title} is switched off, so it cannot take a task.`);
  const verdict = checkApproval(dirname(contextRoot), target, opts.home, 'run');
  // A person assigns a task only to an agent they own: refused here for the CLI and the server.
  if (!verdict.approved && verdict.reason === 'not_owner') {
    return refuse('not_owner', `${title} belongs to ${ownerLabel(verdict.owner)}, so it is read-only here: only its owner can give it a task.`);
  }
  if (!verdict.approved) {
    return refuse('agent_not_approved_to_run', `${title} is not approved to run on this machine. Approve it on the AI Team page.`);
  }
  const job = resolveJob(contextRoot, target.slug, opts);
  if ('code' in job) return job;
  return {
    ok: true,
    target,
    task: { slug: task.slug, id: task.id || task.slug, name: task.name },
    ownerNote: opts.source === 'dashboard' && note ? note : null,
    dataNote: opts.source === 'cli' && note ? note : null,
    job,
  };
}

/** The job options, checked: the start instant, the workspace and its repo, the reviewer. */
function resolveJob(
  contextRoot: string,
  agentSlug: string,
  opts: JobOptions & { home?: string },
): Extract<AssignmentPrep, { ok: true }>['job'] | Extract<AssignmentPrep, { ok: false }> {
  let startAt: string | null = null;
  if (opts.startAt !== undefined && opts.startAt !== null && opts.startAt !== '') {
    startAt = parseStartAt(opts.startAt);
    if (!startAt) return { ok: false, code: 'invalid_start', message: 'Give the start as a date and time with its time zone (for example 2026-11-02T09:00:00+03:00).' };
  }
  const workspace = opts.workspace ?? 'doc';
  if (workspace !== 'code' && workspace !== 'doc') return { ok: false, code: 'invalid_workspace', message: 'The workspace is code or doc.' };
  let repo: string | null = null;
  if (workspace === 'code') {
    const present = resolveLinkedRepos(dirname(contextRoot), opts.home).filter((r) => r.present && r.path);
    const wanted = typeof opts.repo === 'string' && opts.repo.trim() ? opts.repo.trim() : null;
    const hit = wanted ? present.find((r) => r.name === wanted) : present.length === 1 ? present[0] : null;
    if (!hit) {
      return {
        ok: false,
        code: 'no_repo',
        message: wanted
          ? `There is no linked repo "${oneDataLine(wanted, 80)}" on this machine.`
          : present.length === 0 ? 'A code task needs a linked repo on this machine; there is none.' : 'Pick which linked repo the code task works in.',
      };
    }
    repo = hit.name;
  }
  let reviewer: { slug: string; title: string } | null = null;
  if (typeof opts.reviewer === 'string' && opts.reviewer.trim()) {
    const slug = opts.reviewer.trim();
    if (slug === agentSlug) return { ok: false, code: 'reviewer_is_agent', message: 'An agent cannot review its own work; pick another reviewer.' };
    const r = isSafeAutomationSlug(slug) ? getRunTarget(contextRoot, slug, 'agent') : null;
    if (!r) return { ok: false, code: 'unknown_reviewer', message: `There is no agent named "${oneDataLine(slug, 80)}" to review.` };
    const rTitle = oneDataLine(r.agentTitle || r.title, 120);
    if (!r.enabled) return { ok: false, code: 'agent_disabled', message: `${rTitle} is switched off, so it cannot review.` };
    const v = checkApproval(dirname(contextRoot), r, opts.home, 'run');
    if (!v.approved && v.reason === 'not_owner') {
      return { ok: false, code: 'not_owner', message: `${rTitle} belongs to ${ownerLabel(v.owner)}, so it is read-only here: only its owner can make it a reviewer.` };
    }
    if (!v.approved) return { ok: false, code: 'agent_not_approved_to_run', message: `${rTitle} is not approved to run on this machine. Approve it on the AI Team page.` };
    reviewer = { slug: r.slug, title: rTitle };
  }
  return { startAt, workspace, repo, reviewer, reviewCap: clampReviewCap(opts.reviewCap ?? REVIEW_CAP_DEFAULT) };
}

/**
 * Write the assignment (C1-2): the task's agent fields, this machine's ledger records, the M0
 * copies a start depends on (the start instant, the review cap, the workspace), the armed first
 * step, the status rule, and the assignment as the user entry that roots the agent's thread.
 *
 * Nothing runs here. The caller drains (`startDueTaskJobs`): a due step starts in a detached host,
 * a future one waits as `scheduled`, and a busy agent's waits as `queued`.
 */
export function commitAssignment(
  contextRoot: string,
  prep: Extract<AssignmentPrep, { ok: true }>,
  fireAt: Date,
  opts: { source?: AssignmentSource; home?: string } = {},
): { statusMoved: boolean; from: string | null; state: 'scheduled' | 'queued'; step: 'plan' | 'work' } {
  const slug = prep.task.slug;
  const agent = { slug: prep.target.slug, title: prep.target.agentTitle || prep.target.title };
  const projectRoot = dirname(contextRoot);
  const { job } = prep;
  const future = job.startAt !== null && Date.parse(job.startAt) > fireAt.getTime();
  const state = future ? 'scheduled' : 'queued';
  // An Ask agent plans first; the owner approves the plan before the work runs.
  const step = (prep.target.autonomy ?? DEFAULT_AGENT_AUTONOMY) === 'ask' ? 'plan' : 'work';
  // A new assignment ends whatever this machine held for an earlier one.
  forgetTaskJob(projectRoot, prep.task.id, opts.home);
  withTaskFileLock(contextRoot, slug, () => {
    updateFrontmatterFields(taskPath(contextRoot, slug), {
      agent: agent.slug,
      reviewer: job.reviewer?.slug ?? null,
      agent_state: state,
      agent_step: step,
      agent_start_at: job.startAt,
      agent_queued_at: fireAt.toISOString(),
      agent_workspace: job.workspace,
      agent_repo: job.repo,
      agent_claimed_machine: null,
      review_round: 0,
      review_cap: job.reviewCap,
      review_passed: false,
      updated_at: today(),
    });
  });
  // The ledger, the M0 copies and the armed start: this machine assigned it, so this machine may start it.
  recordAssignment(projectRoot, { taskId: prep.task.id, taskSlug: slug, role: 'doer', agent: agent.slug, workspace: job.workspace, repo: job.repo }, opts.home);
  if (job.reviewer) recordAssignment(projectRoot, { taskId: prep.task.id, taskSlug: slug, role: 'reviewer', agent: job.reviewer.slug }, opts.home);
  writeMeta(projectRoot, {
    taskId: prep.task.id, taskSlug: slug, doer: agent.slug, reviewer: job.reviewer?.slug ?? null,
    workspace: job.workspace, repo: job.repo, startAt: job.startAt, queuedAt: fireAt.toISOString(),
    reviewCap: job.reviewCap, base: null, noVerdict: 0,
  }, opts.home);
  if (prep.dataNote || prep.ownerNote) {
    // The note rides the first step's brief as data (the owner's dashboard note included: the
    // step runs unattended, later, in a host that cannot tell who typed it).
    setResumeNote(projectRoot, { taskId: prep.task.id, kind: 'assign', text: prep.ownerNote ?? prep.dataNote ?? '' }, opts.home);
  }
  armStart(projectRoot, prep.task.id, step, 0, opts.home);
  const status = applyAssignmentStatus(contextRoot, slug, agent);
  const name = oneDataLine(prep.task.name, TASK_NAME_MAX_CHARS);
  const note = prep.ownerNote ?? prep.dataNote;
  appendThreadEntry(contextRoot, agent.slug, {
    runId: fireAt.toISOString(),
    kind: 'user',
    text: note ? `Assigned: ${name}\n\n${note}` : `Assigned: ${name}`,
    via: opts.source === 'cli' ? 'cli' : 'dashboard',
    now: fireAt,
  });
  return { statusMoved: status.moved, from: status.from, state, step };
}

/**
 * The status rule: an assignment moves the task to the shipped active status
 * (`in_progress`) ONLY when its status is open-kind or missing. Active, review,
 * done, cancelled and an unknown status (one `statusKind` cannot place, such as
 * a teammate's custom status) never move.
 */
export function applyAssignmentStatus(
  contextRoot: string,
  taskSlug: string,
  agent: { slug: string; title: string },
): { moved: boolean; from: string | null } {
  const task = readTask(contextRoot, taskSlug);
  if (!task) return { moved: false, from: null };
  const raw = task.raw?.status;
  const current = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  const defs = loadStatuses(contextRoot);
  if (current !== null && statusKind(defs, current) !== 'open') return { moved: false, from: current };

  const next = PARENT_BY_KIND.active;
  const now = today();
  const path = taskPath(contextRoot, taskSlug);
  withTaskFileLock(contextRoot, taskSlug, () => {
    updateFrontmatterFields(path, { status: next, updated_at: now, ...dateUpdatesForStatus(next, task, now, defs) });
    insertToSection(
      path,
      'Changelog',
      statusChangeEntry(next, { kind: 'owner' }, defs, `Assigned to the agent ${oneDataLine(agent.title, 120)} (${agent.slug}).`, now),
      'top',
      true,
    );
  });
  return { moved: true, from: current };
}

/** The document path as it appears on the task: brain-relative when it is inside
 *  the brain, else nothing (a path outside the brain is not shown on a synced task). */
function documentLabel(contextRoot: string, outputPath: string | null): string {
  if (!outputPath) return 'none';
  const rel = relative(contextRoot, outputPath);
  if (!rel || rel.startsWith('..') || rel.startsWith(sep)) return 'none';
  return oneDataLine(rel.split(sep).join('/'), 300);
}

/**
 * The ONE line the run's result leaves on the task: the agent, the run, its
 * status and where the document is — never the document's body. The task's
 * changelog may sync to ClickUp or GitHub as a comment, and a private agent's
 * output must not travel there. Every value is flattened to one line: the title
 * is a teammate-editable string.
 */
export function logAssignmentResult(
  contextRoot: string,
  taskSlug: string,
  agent: { slug: string; title: string },
  outcome: { status: RunStatus; outputPath: string | null; runId: string },
): void {
  if (!readTask(contextRoot, taskSlug)) return;
  const slug = isSafeAutomationSlug(agent.slug) ? agent.slug : 'unknown-agent';
  const now = today();
  const entry = [
    `### ${now} - Agent ${oneDataLine(agent.title, 120)} (\`${slug}\`)`,
    `- Run ${oneDataLine(outcome.runId, 64)}: ${oneDataLine(String(outcome.status), 32)}. Document: ${documentLabel(contextRoot, outcome.outputPath)}.`,
  ].join('\n');
  const path = taskPath(contextRoot, taskSlug);
  withTaskFileLock(contextRoot, taskSlug, () => {
    insertToSection(path, 'Changelog', entry, 'top', true);
    updateFrontmatterFields(path, { updated_at: now });
  });
}
