/**
 * The sub-task link (`parent_task`), in ONE place.
 *
 * A task may sit under one parent, and the tree is TWO levels deep at most: a parent cannot
 * itself be a child, and a task that already has children cannot be put under another task.
 * The field is local-only (task-backend/local-only.ts), so nothing here talks to a remote.
 * Pure: callers hand in the task list they already read.
 */

/** The two fields this module reads from a task. */
export interface ParentLinkTask {
  slug: string;
  parent_task: string | null;
}

export type ParentLinkError = 'self' | 'parent_missing' | 'parent_is_child' | 'child_has_children';

export type ParentLinkVerdict = { ok: true } | { ok: false; code: ParentLinkError; message: string };

/** The tasks whose `parent_task` names `slug`, in list order. */
export function childrenOf<T extends ParentLinkTask>(tasks: readonly T[], slug: string): T[] {
  return tasks.filter((t) => t.parent_task === slug);
}

/**
 * May `childSlug` be put under `parentSlug`? `null` (clearing the link) is always fine.
 * The parent must exist, must not be the child itself, must not be a child of another task,
 * and the child must not already have children of its own (two levels max).
 */
export function validateParentLink(
  tasks: readonly ParentLinkTask[],
  childSlug: string,
  parentSlug: string | null,
): ParentLinkVerdict {
  if (parentSlug === null) return { ok: true };
  if (parentSlug === childSlug) {
    return { ok: false, code: 'self', message: 'A task cannot be its own parent.' };
  }
  const parent = tasks.find((t) => t.slug === parentSlug);
  if (!parent) {
    return { ok: false, code: 'parent_missing', message: `Parent task not found: ${parentSlug}` };
  }
  // A parent link naming a task that no longer exists (deleted from the CLI, by hand, or by a
  // teammate) is dangling: that task reads as top-level, so it may take subtasks.
  if (parent.parent_task && parent.parent_task !== parent.slug && tasks.some((t) => t.slug === parent.parent_task)) {
    return {
      ok: false,
      code: 'parent_is_child',
      message: `"${parentSlug}" is itself a subtask of "${parent.parent_task}"; subtasks go two levels deep at most.`,
    };
  }
  if (childrenOf(tasks, childSlug).length > 0) {
    return {
      ok: false,
      code: 'child_has_children',
      message: `"${childSlug}" has subtasks of its own, so it cannot become a subtask; subtasks go two levels deep at most.`,
    };
  }
  return { ok: true };
}
