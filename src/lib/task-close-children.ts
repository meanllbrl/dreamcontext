/**
 * A parent closed to a done- or cancelled-kind status takes its still-open sub-tasks with it
 * (owner, 2026-11-12): each gets the SAME status and a log line "closed with its parent".
 * One function for the CLI verbs, the board PATCH and the owner's delivery sign-off.
 */

import type { TaskBackend } from './task-backend/types.js';
import { openChildren, type ParentLinkTask } from './task-parent.js';
import { isCancelled, isDone, type StatusDef } from './task-status.js';
import { dateUpdatesForStatus } from './task-dates.js';
import { statusChangeEntry, type StatusAuthor } from './task-history.js';
import { today } from './id.js';

export const CLOSED_WITH_PARENT = 'closed with its parent';

/** Does moving a parent to `status` close its open sub-tasks with it? */
export function closesChildren(defs: readonly StatusDef[], status: unknown): boolean {
  return isDone(defs, status) || isCancelled(defs, status);
}

/** Close every open child of `slug` to `status`; returns the slugs it closed. */
export async function closeOpenChildren(
  backend: TaskBackend,
  slug: string,
  status: string,
  defs: readonly StatusDef[],
  who: StatusAuthor,
): Promise<string[]> {
  const all: ParentLinkTask[] = (await backend.list()).map((t) => ({ slug: t.name, parent_task: t.parent_task, status: t.status }));
  const closed: string[] = [];
  for (const child of openChildren(all, slug, defs)) {
    const before = await backend.get(child.slug);
    await backend.addChangelog(child.slug, statusChangeEntry(status, who, defs, CLOSED_WITH_PARENT), { createIfMissing: true });
    const now = today();
    const dates = dateUpdatesForStatus(status, before, now, defs);
    await backend.updateFields(child.slug, { status, updated_at: now, ...dates });
    closed.push(child.slug);
  }
  return closed;
}
