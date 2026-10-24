import { AutomationError, type AgentAutonomy } from '../automations/types.js';
import { QUESTION_DISALLOWED_TOOLS } from '../automations/runner.js';

/**
 * M4: an agent's autonomy level → the claude permission envelope of every session it runs in.
 *
 * ONE pure function, used by the stage chat (`prepareAgentChat`) and by every task-job spawn, so
 * the level means the same thing everywhere. Before it, every headless run was
 * `bypassPermissions` whatever the agent was trusted with.
 *
 *   step            ask                         balanced          free
 *   chat            default                     auto              bypassPermissions
 *   plan (ask only) plan + no orchestration     —                 —
 *   work / rework   auto (after the approved    auto              bypassPermissions
 *                   plan)
 *   review          auto, no edit tools         auto, no edit     bypassPermissions, no edit
 *
 * `default` surfaces every prompt to the owner (the chat's permission cards); `auto` lets the
 * classifier decide; headless `-p` plan mode blocks Bash as well as edits, so the plan step can
 * only read. A reviewer never edits: the edit tools are removed outright, and its verdict is
 * applied only after the host's unchanged-workspace check.
 */

export type AgentStep = 'chat' | 'plan' | 'work' | 'rework' | 'review';

export const AGENT_STEPS: readonly AgentStep[] = ['chat', 'plan', 'work', 'rework', 'review'];

/** The tools a reviewer never has. */
export const REVIEW_DISALLOWED_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;

/** The permission argv for `level` at `step`. Throws for a `plan` step below the Ask level: only
 *  an Ask agent plans first, so a plan step anywhere else is a caller bug. */
export function levelPermissionArgs(level: AgentAutonomy, step: AgentStep): string[] {
  switch (step) {
    case 'chat':
      return ['--permission-mode', level === 'ask' ? 'default' : level === 'free' ? 'bypassPermissions' : 'auto'];
    case 'plan':
      if (level !== 'ask') throw new AutomationError(`A plan step runs only at the Ask level, not "${level}".`);
      return ['--permission-mode', 'plan', '--disallowedTools', QUESTION_DISALLOWED_TOOLS];
    case 'work':
    case 'rework':
      return ['--permission-mode', level === 'free' ? 'bypassPermissions' : 'auto'];
    case 'review':
      return [
        '--permission-mode', level === 'free' ? 'bypassPermissions' : 'auto',
        '--disallowedTools', REVIEW_DISALLOWED_TOOLS.join(' '),
      ];
  }
}

/**
 * The level's rules, told to the agent in its identity briefing and its task-job prompts. A level
 * is an envelope AND a habit: the envelope stops what it can, the brief says when to stop and ask.
 * `headless` = no one is watching (a task job): a denied step is posted as a question and the run
 * stops, since there is nobody to approve it live.
 */
export function levelBrief(level: AgentAutonomy, headless = false): string {
  const when =
    level === 'ask'
      ? 'Ask the owner before you act: before you change files, run a command that changes anything, push, publish, send or delete. Reading and looking around need no question.'
      : level === 'free'
        ? 'Decide for yourself, pushes and other hard-to-reverse steps included. Ask only when the owner\'s intent is genuinely unclear.'
        : 'Act on your own for ordinary work. Ask the owner first when you are unsure, and before a push or another hard-to-reverse step (publishing, sending, deleting, force-anything).';
  const label = level === 'ask' ? 'Ask' : level === 'free' ? 'Free' : 'Balanced';
  return [
    `--- YOUR AUTONOMY: ${label} ---`,
    when,
    ...(headless
      ? ['Nobody is watching this run: when a step you need is denied or needs the owner, post your question and stop; do not work around it.']
      : []),
    '--- END AUTONOMY ---',
  ].join('\n');
}
