import { today } from './id.js';
import { loadStatuses } from './overrides.js';
import { isCancelled } from './task-status.js';
import { AGENT_SELF_ENV } from './automations/types.js';
import type { TaskBackend, TaskData } from './task-backend/types.js';

/**
 * "Approve": the owner keeps a task an agent (or a sleep, or a plan) opened, the counterpart of
 * "Object" (task-objection.ts). ONE engine; `POST /api/tasks/:slug/filing-approval` and
 * `dreamcontext tasks approve-filing` both call {@link approveFiling}.
 *
 * It records `filing_approved: {at}` (local-only, no remote has a field for it) and a changelog
 * line; the status is never touched (owner, 2026-10-24: Approve collapses the banner to a chip,
 * nothing else). Idempotent: approving an approved task changes nothing and says so.
 *
 * Refused: a task the owner opened (`filed_by: human`, there is nothing to approve), a cancelled
 * task, and any call from inside an agent run (an agent does not approve its own filing).
 */

export type FilingApprovalResult =
  | { ok: true; task: TaskData; already: boolean }
  | { ok: false; status: number; code: string; message: string };

export { readFilingApproved } from './filing-basis.js';

/** True when this process is an agent run (the same check `tasks assign-agent` makes). */
export function insideAgentRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AGENT_SELF_ENV] !== undefined || env.DREAMCONTEXT_AUTOMATION_RUN !== undefined;
}

export async function approveFiling(
  contextRoot: string,
  backend: TaskBackend,
  slug: string,
  opts: { now?: Date; env?: NodeJS.ProcessEnv } = {},
): Promise<FilingApprovalResult> {
  if (insideAgentRun(opts.env)) {
    return { ok: false, status: 403, code: 'agent_run', message: 'An agent run cannot approve a task. The owner approves it on the task page.' };
  }
  const task = await backend.get(slug);
  if (!task) return { ok: false, status: 404, code: 'not_found', message: `Task not found: ${slug}` };
  if (task.filed_by === 'human') {
    return { ok: false, status: 409, code: 'filed_by_owner', message: 'You opened this task yourself: there is nothing to approve.' };
  }
  if (isCancelled(loadStatuses(contextRoot), task.status)) {
    return { ok: false, status: 409, code: 'cancelled', message: 'This task is cancelled: there is nothing to approve.' };
  }
  if (task.filing_approved) return { ok: true, task, already: true };
  const now = opts.now ?? new Date();
  await backend.updateFields(slug, { filing_approved: { at: now.toISOString() }, updated_at: today() });
  await backend.addChangelog(slug, `### ${today()} - Approved (owner)`, { createIfMissing: true });
  const updated = await backend.get(slug);
  return updated ? { ok: true, task: updated, already: false } : { ok: false, status: 500, code: 'read_back_failed', message: 'The task could not be read back.' };
}
