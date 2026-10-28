/**
 * Sub-tasks on the wire — the rules both remote backends share.
 *
 * A dreamcontext sub-task is a task whose `parent_task` names another task
 * (lib/task-parent.ts). ClickUp and GitHub both have a native form for that —
 * a ClickUp subtask (`parent` on the task) and a GitHub sub-issue — so a synced
 * sub-task rides as one, never as a second top-level item.
 *
 * What the remote says about a parent is tracked per task in the sync ledger as
 * `remote_parent` (the remote id of the parent as last seen or written; null =
 * seen top-level; absent = never observed). That record is what lets the pull
 * tell "the remote moved this" from "the remote still holds what we last saw",
 * so a pull never undoes a local re-parent that is waiting for its push.
 *
 * Pure: the backends hand in what they read.
 */

/**
 * The parent a task pushes under: its `parent_task`, or null when that names
 * itself or a task that no longer exists (a dangling link reads as top-level,
 * the same rule task-parent.ts applies).
 */
export function liveParentOf(
  slug: string,
  raw: Record<string, unknown>,
  exists: (slug: string) => boolean,
): string | null {
  const p = typeof raw.parent_task === 'string' ? raw.parent_task.trim() : '';
  if (!p || p === slug || !exists(p)) return null;
  return p;
}

/**
 * Order a push so every parent goes before its children: a child's create needs
 * the parent's remote id. Stable otherwise (input order kept within each tier).
 */
export function parentsFirst(slugs: readonly string[], parentOf: (slug: string) => string | null): string[] {
  const inSet = new Set(slugs);
  const top: string[] = [];
  const children: string[] = [];
  for (const s of slugs) {
    const p = parentOf(s);
    if (p && inSet.has(p)) children.push(s);
    else top.push(s);
  }
  return [...top, ...children];
}

export interface PulledParentInput {
  /** The task being merged. */
  slug: string;
  /** The parent the local mirror holds now. */
  localParent: string | null;
  /** The parent recorded in the last sync's base snapshot (undefined = no base). */
  baseParent: string | null | undefined;
  /**
   * The remote's parent id for this item: a string, null (top-level), or
   * undefined when this payload says nothing about it.
   */
  remoteParentId: string | null | undefined;
  /** `remote_parent` from the ledger (undefined = never recorded). */
  lastRemoteParent: string | null | undefined;
  /** Remote id → local slug, null when that remote item is not mapped here. */
  slugForRemoteId: (remoteId: string) => string | null;
  /** The local `parent_task` of another task (for the two-levels rule), null when top-level or missing. */
  parentOfLocal: (slug: string) => string | null;
  /** Does this task have sub-tasks of its own here? (It then cannot become a sub-task.) */
  hasLocalChildren: (slug: string) => boolean;
}

export interface PulledParent {
  parent: string | null;
  /** Set when the remote said something this pull could not apply. */
  warning?: string;
}

/**
 * The `parent_task` a pull leaves on a task.
 *
 * The local value stands unless the REMOTE moved since we last looked:
 * - nothing known about the remote parent → keep local;
 * - the local link changed since the last sync → keep local (the push moves the remote);
 * - the remote still holds what the ledger recorded → keep local;
 * - the remote shows no parent: clear the local link only when we had SEEN it
 *   under a parent before (someone took it out there). A top-level remote item
 *   for a local sub-task is a link not pushed yet, never an instruction to drop
 *   the local one;
 * - the remote shows a parent we map → adopt it, unless that would nest three
 *   levels deep (the parent is a sub-task, or this task has sub-tasks) or point
 *   at the task itself.
 */
export function pulledParent(i: PulledParentInput): PulledParent {
  const keep = { parent: i.localParent };
  if (i.remoteParentId === undefined) return keep;
  if (i.baseParent !== undefined && (i.baseParent ?? null) !== i.localParent) return keep;
  if (i.lastRemoteParent !== undefined && i.lastRemoteParent === i.remoteParentId) return keep;
  if (i.remoteParentId === null) {
    return typeof i.lastRemoteParent === 'string' ? { parent: null } : keep;
  }
  const parentSlug = i.slugForRemoteId(i.remoteParentId);
  if (!parentSlug) {
    return { ...keep, warning: `pull ${i.slug}: its remote parent (${i.remoteParentId}) is not synced to this project — the sub-task link was left as it was.` };
  }
  if (parentSlug === i.slug) return keep;
  const grand = i.parentOfLocal(parentSlug);
  if (grand && grand !== parentSlug) {
    return { ...keep, warning: `pull ${i.slug}: its remote parent '${parentSlug}' is itself a sub-task of '${grand}'; sub-tasks go two levels deep at most here, so the link was left as it was.` };
  }
  if (parentSlug !== i.localParent && i.hasLocalChildren(i.slug)) {
    return { ...keep, warning: `pull ${i.slug}: it was put under '${parentSlug}' remotely, but it has sub-tasks of its own here; sub-tasks go two levels deep at most, so the link was left as it was.` };
  }
  return { parent: parentSlug };
}
