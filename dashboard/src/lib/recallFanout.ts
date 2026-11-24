/**
 * ⌘K across projects (navigation B, C7): the open project's recall renders at once through its
 * own `useRecall`; every other registered project is asked its own `/api/recall`, at most
 * {@link RECALL_PARALLEL} at once. Each project's group is delivered as it lands, so the palette
 * appends it BELOW what is on screen and ↑/↓ and Enter never shift under the cursor. Each read
 * races {@link RECALL_TIMEOUT_MS}; one that errors or runs out counts as failed (named in the
 * palette's foot) and frees its slot at once. A newer query stops older reads launching and its
 * caller drops their late answers by `current()`.
 */
export const RECALL_PARALLEL = 3;
export const RECALL_TIMEOUT_MS = 8_000;
/** Like History's fan-out: content search builds a per-project index, so it waits for a pause. */
export const RECALL_DEBOUNCE_MS = 300;
/** Hits per other project. */
export const RECALL_PER_VAULT = 5;

export interface FanoutDeps<H> {
  vaults: readonly string[];
  read: (vault: string) => Promise<H[]>;
  /** False once a newer query took over: no more reads start, no more groups are delivered. */
  current: () => boolean;
  onGroup: (vault: string, hits: H[]) => void;
  onFailed: (vault: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  timeoutMs?: number;
}

/** Resolves once every project answered, failed or was skipped. */
export async function fanOutRecall<H>(deps: FanoutDeps<H>): Promise<void> {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const timeoutMs = deps.timeoutMs ?? RECALL_TIMEOUT_MS;
  let next = 0;
  const one = (vault: string): Promise<H[] | null> => new Promise((resolve) => {
    let done = false;
    const timer = setTimer(() => { if (!done) { done = true; resolve(null); } }, timeoutMs);
    deps.read(vault).then(
      (hits) => { if (!done) { done = true; clearTimer(timer); resolve(hits); } },
      () => { if (!done) { done = true; clearTimer(timer); resolve(null); } },
    );
  });
  const worker = async () => {
    while (next < deps.vaults.length && deps.current()) {
      const vault = deps.vaults[next++];
      const hits = await one(vault);
      if (!deps.current()) return;
      if (hits === null) deps.onFailed(vault);
      else deps.onGroup(vault, hits.slice(0, RECALL_PER_VAULT));
    }
  };
  await Promise.all(Array.from({ length: Math.min(RECALL_PARALLEL, deps.vaults.length) }, worker));
}
