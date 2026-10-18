import {
  BACKLOG_AGENT_TASK_ID,
  BACKLOG_MIGRATION_VERSION,
  BACKLOG_STEP_ID,
  backlogDecisionsPending,
  runBacklogStep,
  summarizeBacklogStep,
} from '../lib/backlog-migration.js';
import type { Migration, MigrationStepResult } from './types.js';

/**
 * Migration 0.33.0 (second entry): the open backlog moves onto the new task
 * model — parents and children, Now/Next/Later, no planning versions.
 *
 * Registered AFTER the journal split of the same version, so cards are already
 * short when this runs, and in the same release as cycles and sub-tasks, so it
 * can never run before they exist.
 *
 * The code step does the parts with one right answer (lib/backlog-migration.ts
 * `runBacklogStep`); the agentTask does the judgment (which area each task
 * belongs to, which tasks are one deliverable, which are the same work, which
 * are dead), and is only listed
 * while some task still waits for an outcome — a brain with nothing open never
 * hears of it.
 */

const INSTRUCTION = `The open tasks of this brain were moved onto the new task model by the code step: planning versions are retired, every open task has a place (Next or Later), and exact families (<x>-step-<n> under <x>-epic) are linked. What is left is judgment, and it is yours: give EVERY task that still waits exactly one outcome (keep, merge or cancel), link each kept top-level task to the feature (area) its family belongs to, and put the tasks that are steps of one deliverable under one parent.

This is the second judgment carve-out of sleep-migration (the first is 0.23.0's residue). You change tasks ONLY through the commands below; you never edit a card's text, never delete a task, never create a feature, never put anything in a cycle (cycles are the owner's), and never ask anyone anything: nobody is in this session. A task named in the hands-off list of a background run is in use by a live session: keep it with no other change, reason "in use by a live session".

1. Start by checking: \`dreamcontext migrations backlog show --pending\`. It lists the features (the areas) and every waiting task. "Nothing waits" → skip to step 6. "Change list unreadable" → stop and report it; do NOT record.
2. The model (the owner's, binding): a FEATURE is an area of the product and lasts; a PARENT is a deliverable with an end; a CHILD is one step of that deliverable. Two levels only. An area is NEVER a parent: tasks that only share an area are a FAMILY, and a family is a feature link (\`--feature\`), not a parent. A sub-task takes its parent's feature, so the feature goes on the parent.
3. Read before you decide. Read each waiting task's name and description, and \`dreamcontext tasks show <slug>\` whenever the name alone does not tell you its area, whether it is still alive, or what it delivers. Look for: its area (one of the listed features); deliverables (tasks that together deliver one named outcome: shared slug stems such as faz-2 / round-two / step-n, one task saying it continues another); the same work filed twice; work the brain records as shipped or superseded.
4. Decide each waiting task. Every decision carries its own \`--reason\`: what you saw on THIS task (its area, its deliverable, its evidence). A reason that would fit any task is not a reason; the command refuses a decision without one.
   - keep (the default): \`dreamcontext migrations backlog decide <slug> keep --feature <feature> --reason "<why>"\`. Give every kept top-level task the feature its family belongs to; a task whose area has no feature keeps none and its reason says so. A task that already has a different feature keeps it: you never move it (propose it, step 5). Under an existing open parent: \`--parent <parent-slug>\` without --feature (it takes the parent's). Several waiting tasks are steps of a deliverable that has no card yet: \`dreamcontext migrations backlog parent "<the deliverable, as an outcome, at most 80 chars>" --why "<one or two sentences>" --criterion "<what is observable when it is done>" --children <a>,<b>[,...] --feature <feature>\` (two or more tasks; it creates the parent and keeps each child under it, and children without a feature take the parent's). Parked work that nobody will pick up soon: add \`--queue later\`.
   - merge, only when two tasks describe the SAME work: \`dreamcontext migrations backlog decide <slug> merge --into <the task that stays> --reason "<what makes them one>"\`. The merged task is cancelled with absorbed_by, never deleted.
   - cancel, only with evidence that it is dead: \`dreamcontext migrations backlog decide <slug> cancel --reason "<the evidence>"\` (for example a checklist for a version already published, or work the brain records as shipped or superseded).
   A task with open sub-tasks cannot be merged or cancelled: decide its children first.
5. NOT SURE (a likely duplicate, a possible deliverable, maybe dead, two areas fit, its existing feature looks wrong)? Do NOT apply it. Keep the task and put the change in front of the owner on the Tasks screen: \`dreamcontext migrations backlog propose <slug> <merge|cancel|parent|later|feature> [--into <slug> | --parent <slug> | --feature <feature>] --why "<what you saw>"\`. Uncertain is the normal case for anything you would have to guess; the owner answers these on the Tasks screen, never in a chat.
6. Finish: \`dreamcontext migrations backlog report\` (open, top-level before → after, groups by feature, outcomes, proposals waiting). Then record with the report's numbers in the summary. \`migrations record\` refuses while a task still waits.`;

export const migration0330Backlog: Migration = {
  version: BACKLOG_MIGRATION_VERSION,
  steps: [
    (root: string): MigrationStepResult => {
      const report = runBacklogStep(root);
      return {
        step: BACKLOG_STEP_ID,
        filesTouched: report.filesTouched,
        summary: summarizeBacklogStep(report),
        detected: report.detected,
        // Only a lock held by a live writer is retryable; everything the step
        // cannot interpret is the agent task's, so it returns clean.
        ...(report.failed.length > 0 ? { failedCount: report.failed.length } : {}),
      };
    },
  ],
  agentTask: {
    id: BACKLOG_AGENT_TASK_ID,
    instruction: INSTRUCTION,
    needed: backlogDecisionsPending,
  },
};
