import type { TaskData } from './task-backend/types.js';

/**
 * The LIGHT task list (`GET /api/tasks?view=summary`): what every surface that LISTS tasks reads
 * (the Tasks page's board and its search, the Super screen, a member's tasks, board widgets and
 * pickers, the thesis link pickers). Task: opening a project is slow; the full list carried every
 * task's whole text (19.9 MB for 867 tasks) to screens that read a name and a status. A task's
 * own page reads its full text itself (`GET /api/tasks/:slug`).
 *
 * Kept: every frontmatter field (cheap, and what the cards read), the route's additions (the agent
 * job, the objection, the card's clip), and the two body sections a card draws from:
 *   - `acceptance_criteria`: its CHECKBOX lines (bullet or numbered), each capped, plus the
 *     lines that open/close a fenced block or an HTML comment, so a counter that skips boxes
 *     inside those (the board's) and one that does not (the Super tile's) both count exactly
 *     what they counted on the full text. The cap only trims text past what a one-line row shows.
 *   - `why`: capped, a card's fallback line when the task has no description.
 * Dropped: the other sections, the section list and `body`.
 */
export const SUMMARY_WHY_MAX = 600;
export const SUMMARY_CRITERION_MAX = 400;
const CHECKBOX_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/;
/** A fence line, or a line that opens or closes an HTML comment: kept whole (never capped). */
const STRUCTURE_LINE = /^\s*(?:```|~~~)|^\s*<!--|-->/;

/** The body fields the light view drops (the client's `TaskListItem` omits exactly these). */
export const SUMMARY_DROPPED = ['user_stories', 'constraints', 'technical_details', 'notes', 'changelog', 'sections', 'body'] as const;

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The checkbox lines of an Acceptance Criteria section, each capped; nothing else. */
export function criteriaLines(md: string): string {
  const out: string[] = [];
  for (const line of md.split('\n')) {
    if (STRUCTURE_LINE.test(line)) out.push(line);
    else if (CHECKBOX_LINE.test(line)) out.push(cap(line, SUMMARY_CRITERION_MAX));
  }
  return out.join('\n');
}

type Light = Omit<TaskData, 'raw' | 'rawBody' | (typeof SUMMARY_DROPPED)[number]>;

/** One task's light view. `extra` carries the route's per-task additions (its agent job). */
export function taskListSummary<E extends object>(task: TaskData, extra: E): Light & E {
  const {
    raw: _raw, rawBody: _rawBody,
    user_stories: _us, constraints: _c, technical_details: _td, notes: _n, changelog: _cl, sections: _s, body: _b,
    why, acceptance_criteria,
    ...rest
  } = task;
  return { ...rest, why: cap(why, SUMMARY_WHY_MAX), acceptance_criteria: criteriaLines(acceptance_criteria), ...extra };
}
