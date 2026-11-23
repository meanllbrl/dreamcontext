import { AutomationError, memberLevel, type AgentAutonomy } from '../automations/types.js';

/**
 * M4: an agent's autonomy level → the claude permission envelope of every session it runs in.
 *
 * ONE pure function, used by the stage chat (`prepareAgentChat`) and by every task-job spawn, so
 * the level means the same thing everywhere. Before it, every headless run was
 * `bypassPermissions` whatever the agent was trusted with.
 *
 *   step            balanced (and a stored ask)   free
 *   chat            auto                          bypassPermissions
 *   work / rework   auto                          bypassPermissions
 *   review          auto, no edit tools           bypassPermissions, no edit
 *
 * No member runs in Ask (owner 2026-11-18): a stored `ask` resolves through `memberLevel` to
 * Balanced, so no level ever yields `default` or a plan step. A step Balanced's classifier stops
 * still reaches the owner as a permission card or a posted question. A reviewer never edits: the
 * edit tools are removed outright, and its verdict is applied only after the host's
 * unchanged-workspace check.
 */

export type AgentStep = 'chat' | 'plan' | 'work' | 'rework' | 'review';

export const AGENT_STEPS: readonly AgentStep[] = ['chat', 'plan', 'work', 'rework', 'review'];

/** The tools a reviewer never has. */
export const REVIEW_DISALLOWED_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;

/**
 * Under `auto`, a task step's OWN verbs are pre-approved so they never pay the classifier: the
 * doer's delivery, the reviewer's verdict, and asking the owner. The Assistant's precedent
 * (agent-chat.ts `assistantAllowedTools`): the matcher refuses compound commands, and the verbs
 * themselves check the run's token. One comma-joined value (the flag is variadic).
 */
export const TASK_DOER_ALLOWED = ['Bash(dreamcontext tasks deliver:*)', 'Bash(dreamcontext automations propose:*)'].join(',');
export const TASK_REVIEWER_ALLOWED = ['Bash(dreamcontext tasks review:*)', 'Bash(dreamcontext automations propose:*)'].join(',');

/** The permission argv for `stored` at `step`, floored at Balanced (`memberLevel`). Throws for a
 *  `plan` step: only an Ask agent planned first, and no member runs at Ask any more, so a plan
 *  step reaching here is a caller bug (the host turns a queued one into work). */
export function levelPermissionArgs(stored: AgentAutonomy, step: AgentStep): string[] {
  const level = memberLevel(stored);
  switch (step) {
    case 'chat':
      return ['--permission-mode', level === 'free' ? 'bypassPermissions' : 'auto'];
    case 'plan':
      throw new AutomationError('There is no plan step: a member runs at least Balanced.');
    case 'work':
    case 'rework':
      return level === 'free'
        ? ['--permission-mode', 'bypassPermissions']
        : ['--permission-mode', 'auto', '--allowedTools', TASK_DOER_ALLOWED];
    case 'review':
      return [
        '--permission-mode', level === 'free' ? 'bypassPermissions' : 'auto',
        ...(level === 'free' ? [] : ['--allowedTools', TASK_REVIEWER_ALLOWED]),
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
export function levelBrief(stored: AgentAutonomy, headless = false): string {
  const level = memberLevel(stored);
  const when =
    level === 'free'
        ? 'Decide for yourself, pushes and other hard-to-reverse steps included. Ask only when the owner\'s intent is genuinely unclear.'
        : 'Act on your own for ordinary work. Ask the owner first when you are unsure, and before a push or another hard-to-reverse step (publishing, sending, deleting, force-anything).';
  const label = level === 'free' ? 'Free' : 'Balanced';
  return [
    `--- YOUR AUTONOMY: ${label} ---`,
    when,
    ...(headless
      ? ['Nobody is watching this run: when a step you need is denied or needs the owner, post your question and stop; do not work around it.']
      : []),
    '--- END AUTONOMY ---',
  ].join('\n');
}

/** Claude permission modes, narrowest first (the same order `super/member-crew.ts` ranks by). */
const MODE_ORDER: Record<string, number> = { dontAsk: 0, plan: 0, default: 1, auto: 2, bypassPermissions: 3 };

/** The narrower of two Claude permission modes; an unknown mode counts as the widest, so it never
 *  wins over a known one. */
export function narrowerMode(a: string, b: string): string {
  return (MODE_ORDER[a] ?? 3) <= (MODE_ORDER[b] ?? 3) ? a : b;
}

/** The chat mode of `level` (`levelPermissionArgs(level, 'chat')`), as a mode name. */
export function levelChatMode(level: AgentAutonomy): string {
  return levelPermissionArgs(level, 'chat')[1];
}

/**
 * The mode an agent's CARD conversation runs in (owner 2026-11-07, item 4): the owner's own pane
 * mode, never wider than the agent's autonomy level. A mid-session switch is allowed only to a
 * mode this would also give (`cardModeAllowed`).
 */
export function cardSessionMode(paneMode: string, level: AgentAutonomy): string {
  return narrowerMode(paneMode, levelChatMode(level));
}

/** Whether a card session may switch to `mode`: never past the agent's autonomy level. */
export function cardModeAllowed(mode: string, level: AgentAutonomy): boolean {
  return narrowerMode(mode, levelChatMode(level)) === mode;
}

