/**
 * The loopback ports this process listens on, or has a child listen on (jarvis plan r9, T1):
 * the dashboard's main listener, Mac mode's phone listener, each chat's live browser mirror
 * (Chrome's CDP side door) and the warm whisper-server. A web card must never load one of them:
 * the dashboard in a frame with `allow-same-origin` is the dashboard's own DOM, its owner
 * routes and its IPC key; a CDP port is a remote control for a browser.
 *
 * Every listener registers itself when it starts and drops its key when it stops: `claim`
 * returns that death. A port two owners share (never expected) stays owned until both drop it.
 * Ports change on every launch, so the check runs at the moment of asking, never from a copy.
 */

const owned = new Map<number, number>();

const isPort = (n: number): boolean => Number.isInteger(n) && n > 0 && n < 65536;

/** Mark `port` as ours until the returned release runs (once; later calls do nothing). */
export function claimOwnedPort(port: number): () => void {
  if (!isPort(port)) return () => { /* nothing claimed */ };
  owned.set(port, (owned.get(port) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (owned.get(port) ?? 1) - 1;
    if (n > 0) owned.set(port, n); else owned.delete(port);
  };
}

/** The ports owned right now. */
export function ownedLoopbackPorts(): Set<number> {
  return new Set(owned.keys());
}

/** Tests only. */
export function resetOwnedPortsForTests(): void {
  owned.clear();
}
