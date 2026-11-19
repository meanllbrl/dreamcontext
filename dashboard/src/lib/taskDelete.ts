/**
 * The task page's copy and delete rules (owner, 2026-11-16), pure so a unit test pins them
 * without a DOM:
 *  - copy puts the task's slug on the clipboard and NOTHING else;
 *  - the "Copied" mark stays {@link COPIED_MS};
 *  - deleting a parent deletes its subtasks with it, and the dialog names every one first;
 *  - after a delete the page goes to the parent (a subtask) or back to the list (a task).
 */
import { copyPreservingUnicode } from './clipboard';

/** How long the copy button shows its "Copied" mark. */
export const COPIED_MS = 1500;

/** The longest "why" the delete dialog sends (the server refuses longer). */
export const DELETE_REASON_MAX = 500;

/** Copy exactly the slug: no prefix, no suffix, no whitespace. */
export function copyTaskSlug(slug: string, write: (text: string) => Promise<boolean> = copyPreservingUnicode): Promise<boolean> {
  return write(slug);
}

interface Linked { slug: string; name?: string; parent_task?: string | null }

/** What a delete of `task` takes with it: its subtasks (two levels max, so only children). */
export function deleteScope<T extends Linked>(task: Linked, allTasks: readonly T[]): T[] {
  return allTasks.filter((t) => t.parent_task === task.slug && t.slug !== task.slug);
}

/** Where the page goes once the delete lands: the parent's slug, or null for the list. */
export function afterDeleteTarget(task: Linked): string | null {
  return task.parent_task || null;
}

/** The reason as the server takes it: whitespace folded, trimmed, undefined when empty. */
export function deleteReason(raw: string): string | undefined {
  const v = raw.replace(/\s+/g, ' ').trim();
  return v ? v.slice(0, DELETE_REASON_MAX) : undefined;
}
