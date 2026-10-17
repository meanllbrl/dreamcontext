import { lstatSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { updateFrontmatterFields } from '../frontmatter.js';
import { appendJournalEntry } from '../task-journal.js';
import { foldCardChangelog } from '../task-card.js';
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

/**
 * Assigning a task to an agent — the shared steps the dashboard route and the
 * CLI verb both take. There is no third run engine here: the run itself is the
 * existing ask run (`startAutomationJob` / `runAutomation`) on the agent's call
 * target with `target: 'agent'` and the task as data.
 *
 *  1. {@link prepareAssignment} — resolve the task, the agent and its call
 *     target, and refuse unless that target is approved to RUN on this Mac.
 *  2. {@link commitAssignment} — set `agent:` on the task, apply the status rule,
 *     append the assignment to the agent's thread.
 *  3. the run (the caller's).
 *  4. {@link logAssignmentResult} — one sanitized line on the task.
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
  | 'agent_disabled'
  | 'note_too_long';

export type AssignmentPrep =
  | {
      ok: true;
      /** The agent's call target, from the store (legacyKey and bindings set). */
      target: AutomationManifest;
      task: { slug: string; name: string };
      /** The note as the OWNER's live words: only a note typed in the dashboard. */
      ownerNote: string | null;
      /** A note that is data, not the owner speaking: the CLI's `--note`. */
      dataNote: string | null;
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
  opts: { note?: string; source: AssignmentSource; home?: string },
): AssignmentPrep {
  const note = (opts.note ?? '').trim();
  if (note.length > ASSIGNMENT_NOTE_MAX_CHARS) {
    return refuse('note_too_long', `Keep the note under ${ASSIGNMENT_NOTE_MAX_CHARS} characters.`);
  }
  const task = readTask(contextRoot, taskSlug);
  if (!task) return refuse('unknown_task', `There is no task named "${oneDataLine(taskSlug, 80)}" in this project.`);
  const target = isSafeAutomationSlug(agentSlug) ? getRunTarget(contextRoot, agentSlug, 'agent') : null;
  if (!target) return refuse('unknown_agent', `There is no agent named "${oneDataLine(agentSlug, 80)}" in this project.`);
  const title = oneDataLine(target.agentTitle || target.title, 120);
  if (!target.enabled) return refuse('agent_disabled', `${title} is switched off, so it cannot take a task.`);
  if (!checkApproval(dirname(contextRoot), target, opts.home, 'run').approved) {
    return refuse('agent_not_approved_to_run', `${title} is not approved to run on this machine. Approve it on the Agents page.`);
  }
  return {
    ok: true,
    target,
    task: { slug: task.slug, name: task.name },
    ownerNote: opts.source === 'dashboard' && note ? note : null,
    dataNote: opts.source === 'cli' && note ? note : null,
  };
}

/**
 * Write the assignment: `agent:` on the task, the status rule, and the
 * assignment as the user entry that roots the run's thread (`runId` = `fireAt`).
 */
export function commitAssignment(
  contextRoot: string,
  prep: Extract<AssignmentPrep, { ok: true }>,
  fireAt: Date,
  opts: { source?: AssignmentSource } = {},
): { statusMoved: boolean; from: string | null } {
  const slug = prep.task.slug;
  const agent = { slug: prep.target.slug, title: prep.target.agentTitle || prep.target.title };
  withTaskFileLock(contextRoot, slug, () => {
    updateFrontmatterFields(taskPath(contextRoot, slug), { agent: agent.slug, updated_at: today() });
  });
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
  return { statusMoved: status.moved, from: status.from };
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
    foldCardChangelog(path);
    appendJournalEntry(join(contextRoot, 'state'), taskSlug, {
      kind: 'status',
      label: next,
      body: `- Assigned to the agent ${oneDataLine(agent.title, 120)} (\`${agent.slug}\`).`,
    });
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
  const path = taskPath(contextRoot, taskSlug);
  withTaskFileLock(contextRoot, taskSlug, () => {
    foldCardChangelog(path);
    appendJournalEntry(join(contextRoot, 'state'), taskSlug, {
      kind: 'log',
      label: `Agent ${oneDataLine(agent.title, 120)} (\`${slug}\`)`,
      actor: `agent:${slug}`,
      body: `- Run ${oneDataLine(outcome.runId, 64)}: ${oneDataLine(String(outcome.status), 32)}. Document: ${documentLabel(contextRoot, outcome.outputPath)}.`,
    });
    updateFrontmatterFields(path, { updated_at: now });
  });
}
