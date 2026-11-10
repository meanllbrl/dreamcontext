import type { TaskData } from './task-backend/types.js';

/**
 * The LIGHT task list (`GET /api/tasks?view=summary`): what every surface that shows a task as a
 * name, a status and a progress bar reads (the Super screen's tiles and titles, a member's task
 * list, board widgets and pickers, the thesis link pickers). Task: opening a project is slow;
 * the full list carried every task's whole text (19.9 MB for 867 tasks) to screens that read a
 * name and a status.
 *
 * Kept: every frontmatter field (cheap, and what the cards read), plus the two body sections a
 * card draws from:
 *   - `acceptance_criteria`: only its CHECKBOX lines, each capped. A card counts done/total and
 *     shows the first open ones on one line; any line the card's checkbox pattern can match
 *     (`^\s*[-*+]\s+\[( |x|X)\]\s+.+$`) also matches {@link CHECKBOX_LINE}, so the counts are
 *     exact and the cap only trims text past what a one-line row can show.
 *   - `why`: capped, the card's fallback line when the task has no description.
 * Dropped: the other sections, the section list and `body` (the Tasks page and a task's own
 * page read the full list or the single task, never this view).
 */
export const SUMMARY_WHY_MAX = 600;
export const SUMMARY_CRITERION_MAX = 400;
const CHECKBOX_LINE = /^\s*[-*+]\s+\[[ xX]\]/;

/** The body fields the light view drops (the client's `TaskListItem` omits exactly these). */
export const SUMMARY_DROPPED = ['user_stories', 'constraints', 'technical_details', 'notes', 'changelog', 'sections', 'body'] as const;

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The checkbox lines of an Acceptance Criteria section, each capped; nothing else. */
export function criteriaLines(md: string): string {
  const out: string[] = [];
  for (const line of md.split('\n')) if (CHECKBOX_LINE.test(line)) out.push(cap(line, SUMMARY_CRITERION_MAX));
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
