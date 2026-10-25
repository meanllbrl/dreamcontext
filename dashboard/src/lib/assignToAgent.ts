import type { AgentSummary } from '../hooks/useAgents';
import type { AssignAgentError, AssignAgentResult } from '../hooks/useTasks';
import { toAssignAgentError } from '../hooks/useTasks';

/**
 * "Assign to agent": the pure half of the task composer (`AssignToAgentComposer`), kept out of
 * React so the tests drive it directly. Three questions live here and nowhere else:
 *
 *  1. WHICH agents the picker offers, and which one it starts on.
 *  2. WHAT a refusal says, in plain words, or whether it opens the in-place review instead.
 *  3. HOW "Approve and assign" sequences its two writes: approve, check the fresh verdict, assign.
 *
 * The approval split is the one thing this must never blur: `approvedToRun` (a direct grant on
 * this Mac) decides whether an assignment can execute, never `approvedForChat`.
 */

/** Mirrors `ASSIGNMENT_NOTE_MAX_CHARS` (`src/lib/agents/task-assignment.ts`). The server is the
 *  authority; this only lets the composer say so before a round trip. */
export const ASSIGN_NOTE_MAX_CHARS = 2000;

/** The i18n lookup (`useI18n().t`): a plain key lookup that echoes an unknown key. */
export type Translate = (key: string) => string;

/** A keyed string with a fallback (a key no locale carries yet) and `{name}`-style values. */
export function tr(t: Translate, key: string, fallback: string, vars: Record<string, string> = {}): string {
  const hit = t(key);
  const base = hit === key ? fallback : hit;
  return Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(v), base);
}

/**
 * Every agent, offered: an unapproved one is still offered, because picking it is how the owner
 * reaches its review and "Approve and assign". Runnable agents first, then by name, so the
 * common case (an approved agent) sits at the top.
 */
export function offeredAgents(agents: readonly AgentSummary[] | undefined): AgentSummary[] {
  // A teammate's agent is read-only here: nobody but its owner gives it a task (B1-4).
  return [...(agents ?? [])].filter((a) => !a.readOnly).sort((a, b) => {
    if (a.approvedToRun !== b.approvedToRun) return a.approvedToRun ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}

/** Where the picker starts: the task's current agent when it is still on the roster, else the
 *  first runnable one, else the first one, else nothing. */
export function initialAgentSlug(offered: readonly AgentSummary[], current?: string | null): string | null {
  if (current && offered.some((a) => a.slug === current)) return current;
  return offered.find((a) => a.approvedToRun)?.slug ?? offered[0]?.slug ?? null;
}

/** True when the note is over the limit the server enforces (after the same trim). */
export function noteTooLong(note: string): boolean {
  return note.trim().length > ASSIGN_NOTE_MAX_CHARS;
}

/** What the composer does with a refusal: open the agent's review in place, or say a line. */
export type AssignRefusalView =
  | { kind: 'review' }
  | { kind: 'message'; text: string };

/**
 * One refusal, in plain words. `agent_not_approved_to_run` is the only one that is not a line:
 * the composer answers it with the agent's review and "Approve and assign". A message never
 * carries a code, a status number or a route; `assign_failed` and anything unrecognised fall to
 * one generic line.
 */
export function refusalView(err: AssignAgentError, agentName: string, t: Translate): AssignRefusalView {
  const name = { name: agentName };
  const line = (key: string, fallback: string, vars: Record<string, string> = name): AssignRefusalView =>
    ({ kind: 'message', text: tr(t, key, fallback, vars) });
  switch (err.code) {
    case 'agent_not_approved_to_run':
      return { kind: 'review' };
    case 'agent_disabled':
      return line('tasks.assignDisabled', '{name} is turned off.');
    case 'agent_busy':
      return line('tasks.assignBusy', '{name} is running right now. Assign the task when it finishes.');
    case 'note_too_long':
      return line('tasks.assignNoteTooLong', 'The note is too long.');
    case 'unknown_agent':
      return line('tasks.assignUnknownAgent', '{name} is no longer here. Pick another agent.');
    case 'unknown_task':
      return line('tasks.assignUnknownTask', 'This task is no longer here. It may have been renamed or deleted.');
    case 'missing_agent':
      return line('tasks.assignPickAgent', 'Pick an agent');
    case 'invalid_start':
      return line('tasks.assignWhenPast', 'Pick a time in the future.');
    case 'no_repo':
      return line('tasks.assignNoRepo', 'That repository is not on this Mac. Pick Docs, or link the repository first.');
    case 'unknown_reviewer':
      return line('tasks.assignUnknownReviewer', 'That reviewer is no longer here. Pick another.');
    case 'reviewer_is_agent':
      return line('tasks.assignReviewerIsAgent', 'An agent cannot review its own work. Pick another reviewer.');
    case 'not_owner':
      return line('tasks.assignNotOwner', '{name} belongs to a teammate. Only its owner gives it tasks.');
    default:
      return line('tasks.assignFailed', "Couldn't assign the task. {reason}", {
        reason: tr(t, 'tasks.assignTryAgain', 'Try again in a moment.'),
      });
  }
}

/** The confirmation once the job is placed: started, scheduled for `when`, or waiting its turn. */
export function assignedMessage(result: AssignAgentResult, agentName: string, t: Translate, when = ''): string {
  if (result.state === 'scheduled') return tr(t, 'tasks.assignedScheduled', '{name} starts on this task at {when}.', { name: agentName, when });
  if (result.state === 'queued') return tr(t, 'tasks.assignedQueued', '{name} is busy. The task waits its turn.', { name: agentName });
  return result.statusMoved
    ? tr(t, 'tasks.assignedMoved', '{name} is working on this task. Its status moved to In progress.', { name: agentName })
    : tr(t, 'tasks.assigned', '{name} is working on this task.', { name: agentName });
}

/** What "Approve and assign" ended in. */
export type ApproveAndAssignOutcome =
  | { ok: true; result: AssignAgentResult }
  /** The approve call itself failed. */
  | { ok: false; stage: 'approve'; error: unknown }
  /** The approval landed but the fresh verdict still says it may not run (say why). */
  | { ok: false; stage: 'still-unapproved'; reason: string | null }
  /** Approved, then the assignment was refused. */
  | { ok: false; stage: 'assign'; error: AssignAgentError };

/**
 * "Approve and assign": approve the agent's call target as it stands, then assign ONLY if the
 * fresh summary the approval returns says it may run. Checking that verdict, rather than trusting
 * the approve call's success, keeps the second write from ever firing on a stale belief (an agent
 * edited between the review and the click is approved under its new shape, and that is what the
 * returned summary reports). Never assigns after a failed approve.
 */
export async function approveThenAssign(deps: {
  approve: () => Promise<AgentSummary>;
  assign: () => Promise<AssignAgentResult>;
}): Promise<ApproveAndAssignOutcome> {
  let fresh: AgentSummary;
  try {
    fresh = await deps.approve();
  } catch (error) {
    return { ok: false, stage: 'approve', error };
  }
  if (!fresh.approvedToRun) return { ok: false, stage: 'still-unapproved', reason: fresh.approvalReason };
  try {
    return { ok: true, result: await deps.assign() };
  } catch (err) {
    return { ok: false, stage: 'assign', error: toAssignAgentError(err) };
  }
}

/** The plain-words reason an agent may not run, from the server's reason slug. */
export function approvalReasonText(reason: string | null, t: Translate): string {
  if (!reason) return '';
  return tr(t, `agents.approval.reason.${reason}`, '');
}
