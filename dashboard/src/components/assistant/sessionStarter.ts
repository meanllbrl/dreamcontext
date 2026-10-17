import { startsFresh } from './notchModel';

/**
 * The notch's conversation starts on FIRST USE, not at launch (owner decision 3, 2026-10-17):
 * a `claude` child per app run that nobody talked to was pure cost. Hover warms it, opening,
 * the hotkey and a file drop start it; everything that sends goes through {@link SessionStarter.ensure}.
 *
 * Pure (no React, no fetch of its own) so the rules are pinned in Node:
 *   - a live session is returned as it is;
 *   - otherwise the assistant's status is read NOW and fresh-vs-resume is decided AT CALL TIME
 *     (`startsFresh`: a conversation idle past the threshold starts a new one);
 *   - callers in the same moment (a hover and an expand) share ONE in-flight start;
 *   - the shared promise is dropped once it settles, a rejection included, so a failed warm-up
 *     never blocks a later start;
 *   - a session started some other way while the read was in flight (a conversation switch)
 *     wins: no second session is created;
 *   - with no assistant configured nothing starts.
 */

/** What the start needs from `GET /api/assistant/status`. */
export interface StarterStatus {
  exists: boolean;
  config: { conversationId: string | null } | null;
  lastActiveAt?: number | null;
}

export interface SessionStarterDeps<S> {
  /** The live session, if any (the notch's `sessionRef`). */
  current: () => S | null;
  readStatus: () => Promise<StarterStatus>;
  /** Start one: `conversationId` null = a fresh conversation. `lastActiveAt` seeds the idle clock. */
  start: (conversationId: string | null, lastActiveAt: number) => S;
  now?: () => number;
}

export interface SessionStarter<S> {
  /** The live session, starting one if none; null when there is no assistant. */
  ensure(): Promise<S | null>;
}

export function createSessionStarter<S>(deps: SessionStarterDeps<S>): SessionStarter<S> {
  const now = deps.now ?? (() => Date.now());
  let inflight: Promise<S | null> | null = null;
  return {
    ensure() {
      const live = deps.current();
      if (live) return Promise.resolve(live);
      if (inflight) return inflight;
      const p = (async () => {
        const st = await deps.readStatus();
        const raced = deps.current();
        if (raced) return raced;
        if (!st?.exists || !st.config) return null;
        const at = now();
        const fresh = startsFresh(st.lastActiveAt, at);
        return deps.start(fresh ? null : st.config.conversationId, fresh ? at : (st.lastActiveAt ?? at));
      })();
      inflight = p;
      const clear = () => { if (inflight === p) inflight = null; };
      p.then(clear, clear);
      return p;
    },
  };
}
