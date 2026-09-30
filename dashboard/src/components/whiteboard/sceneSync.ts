/**
 * The two scene operations the canvas owns on behalf of the page: folding a remote copy into
 * the live scene (D5) and refusing images before a save (D10).
 *
 * Excalidraw's functions are INJECTED rather than imported, so this file stays free of the
 * heavy bundle (the canvas is lazy-loaded) and root vitest can run it against the real ones.
 */

/** The element fields these helpers read. Everything else rides along untouched. */
export interface SceneElementLike {
  id: string;
  type: string;
  version: number;
  isDeleted?: boolean;
}

export interface ReconcileFns<E, A> {
  restoreElements: (elements: readonly unknown[], local: null) => readonly E[];
  reconcileElements: (local: readonly E[], remote: readonly E[], appState: A) => readonly E[];
}

/**
 * Fold a polled remote scene into the local one.
 *
 * `restoreElements(remote, null)`: NEVER pass the local elements here. Given them,
 * `restoreElements` bumps any remote copy older than its local twin to `local.version + 1`,
 * which then beats the user's unsaved drag in `reconcileElements`. Excalidraw's own collab path
 * passes `null` for the same reason. The reconcile then keeps whichever copy has the higher
 * version (lower `versionNonce` on a tie), so an unsaved local edit survives a poll.
 */
export function reconcileRemoteScene<E, A>(
  fns: ReconcileFns<E, A>,
  local: readonly E[],
  remote: readonly unknown[],
  appState: A,
): readonly E[] {
  const restored = fns.restoreElements(remote, null);
  return fns.reconcileElements(local, restored, appState);
}

/**
 * Remove every `image` element. Phase 1 has no asset pipeline, so an image that arrives as
 * pasted Excalidraw JSON (which bypasses `UIOptions.tools.image=false`) must be removed visibly
 * rather than saved half-formed. Deleted ones go too: the server refuses ANY element of type
 * `image`, tombstone or not, and one left in the scene would fail every later save.
 * `visible` counts the live ones, the ones the user saw and must be told about.
 */
export function stripImageElements<E extends SceneElementLike>(
  elements: readonly E[],
): { elements: readonly E[]; removed: number; visible: number } {
  let removed = 0;
  let visible = 0;
  const kept = elements.filter((el) => {
    if (el.type !== 'image') return true;
    removed += 1;
    if (!el.isDeleted) visible += 1;
    return false;
  });
  return removed ? { elements: kept, removed, visible } : { elements, removed: 0, visible: 0 };
}

export const IMAGES_LATER_MESSAGE = 'Images come in a later version';
