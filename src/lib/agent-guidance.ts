/**
 * Guidance lines that must read the same wherever a sub-agent meets them.
 *
 * The SubagentStart briefing and the `dreamcontext-agent-core` skill both
 * teach recall and task creation. Two hand-written copies drifted before (the
 * briefing taught `tasks create --status pending`, a status that does not
 * exist, and no `-w`, which the CLI requires), so the text lives here once and
 * a test pins the skill file to it verbatim.
 */

/** How and when to run recall, over every channel it actually ranks. */
export const RECALL_GUIDANCE =
  'RECALL: before Glob/Grep on any "where / why / what do we know about X" question, run '
  + '`dreamcontext memory recall "<keywords>"`. It ranks knowledge, features, tasks, memory, '
  + 'changelog, objectives, insights, theses and automations, plus connected projects. '
  + 'Narrow with `--types <csv>` or `--level 2|3`.';

/** The one task-creation command a sub-agent should copy. */
export const TASK_CREATE_GUIDANCE =
  'To create a task: `dreamcontext tasks create "<short sentence naming the outcome>" '
  + '-w "<why it matters>" -p <priority>`. The why is mandatory; log progress with '
  + '`dreamcontext tasks log <slug> "<what was done>"`.';

/**
 * The briefing's budget-note recovery sentence. Unlike the snapshot's, it does
 * not claim every demoted item keeps its path: at the floor, features and
 * knowledge are named or counted without one.
 */
export const BRIEFING_RECOVERY_NOTE =
  'Demoted items are named or counted above, not always with a path: '
  + '`dreamcontext memory recall "<keywords>"` and `dreamcontext knowledge index` recover the rest.';
