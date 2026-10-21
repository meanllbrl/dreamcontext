/**
 * What a task slug may be, in ONE place (field 2026-10-21: `super delegate --task` refused
 * valid task names past 100 characters, because the Super record carried its own `{0,99}`).
 *
 * A task is `state/<slug>.md`, and `tasks create` writes the slug `slugify` makes of the name
 * with no cap of its own, so the only limit is the file system's: a file name is at most 255
 * bytes. A slug is ASCII, so 252 characters is every slug that can name a real task file. That
 * is the same number the chat gates already derive (`MAX_SLUG_CHARS`, dashboard/src/lib/
 * chatViewSpec.ts, owner report 2026-09-19); anything that validates a task slug takes every
 * length up to it.
 *
 * The dashboard cannot import this file (its own bundle): its copies are pinned to it by
 * tests/unit/task-slug-limit.test.ts.
 */
export const FILE_NAME_MAX = 255;
export const MAX_TASK_SLUG_LENGTH = FILE_NAME_MAX - '.md'.length;

/** A task slug as `slugify` makes it: lowercase letters, digits and single dashes. */
export const TASK_SLUG_RE = new RegExp(`^[a-z0-9][a-z0-9-]{0,${MAX_TASK_SLUG_LENGTH - 1}}$`);
