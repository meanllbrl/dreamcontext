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

/** The element fields a scene's signature reads. */
export interface SignedElementLike {
  id: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
}

/**
 * What a save would write, as one number: a 53-bit hash over every element's id, version,
 * versionNonce and tombstone flag (tombstones included, as a save sends them). Two scenes with
 * the same signature save the same elements, so the save loop compares this, not the version
 * sum, against what is on disk: a sum can tie while the scene differs, and a board that only
 * opened (nothing touched) signs exactly like the file it was loaded from.
 *
 * Order-free (per-element hashes are summed): Excalidraw sorts the loaded elements by their
 * fractional index, so the file's order and the scene's may differ, and a z-order change moves
 * an element's `index`, which bumps its version anyway.
 *
 * Only elements: a save sends no appState, and a picture's bytes go up by their own route.
 */
export function sceneSignature(elements: readonly unknown[]): number {
  let lo = elements.length >>> 0;
  let hi = 0;
  for (const raw of elements) {
    const el = raw as Partial<SignedElementLike> | null;
    // cyrb53 of one element: two 32-bit lanes, no allocation.
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    const mix = (n: number) => {
      h1 = Math.imul(h1 ^ n, 2654435761);
      h2 = Math.imul(h2 ^ n, 1597334677);
    };
    const id = typeof el?.id === 'string' ? el.id : '';
    for (let i = 0; i < id.length; i++) mix(id.charCodeAt(i));
    mix(0x2f);
    mix(typeof el?.version === 'number' ? el.version | 0 : -1);
    mix(typeof el?.versionNonce === 'number' ? el.versionNonce | 0 : -1);
    mix(el?.isDeleted === true ? 1 : 0);
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    // Summed lane by lane (with the carry), so the element order does not matter.
    const sum = (lo >>> 0) + (h1 >>> 0);
    lo = sum >>> 0;
    hi = (hi + (2097151 & h2) + (sum > 0xffffffff ? 1 : 0)) & 2097151;
  }
  return 4294967296 * hi + lo;
}
