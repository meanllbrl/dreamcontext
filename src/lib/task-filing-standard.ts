/**
 * The ONE task-filing standard (owner, 2026-11-12): the same words everywhere an agent is told
 * about tasks. The Plan, Develop and Super briefings embed this constant; skill/SKILL.md,
 * skill-agent-core/SKILL.md and the other instruction files carry it verbatim, and
 * tests/unit/task-filing-standard.test.ts fails when one of them drifts (whitespace aside).
 *
 * Only its last sentence is mechanical (agent-filing-guard.ts: a Super child is refused). There
 * is no numeric cap: no daily budget, no sub-task refusal.
 */
export const TASK_FILING_STANDARD =
  'Open a task only for big work (more than ~3 files, or several sessions). '
  + 'Small fix: no task, say it in your last reply. '
  + 'Big work: ONE task; log its steps and waves inside it. '
  + 'A sub-task only for a part of big work that is delivered and checked on its own, never one per step or wave. '
  + 'Before opening, recall: if a task for the same work exists, use it. '
  + 'A Super child never opens one: the Super does.';

/** The sub-task sentence alone, for refusal texts and short pointers. */
export const SUB_TASK_RULE =
  'A sub-task only for a part of big work that is delivered and checked on its own, never one per step or wave.';
