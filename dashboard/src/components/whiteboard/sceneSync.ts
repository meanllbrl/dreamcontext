/**
 * The scene operation the canvas owns on behalf of the page: folding a remote copy into the
 * live scene (D5).
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
