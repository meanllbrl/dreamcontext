import type { BrowserFrame } from '../../../lib/chatProtocol';

/**
 * The live browser view's frames, kept OUT of the conversation model.
 *
 * Frames arrive at up to ~6 per second (server: `src/server/browser-mirror.ts`). Through the
 * reducer each one would re-render the whole ChatPane, transcript included; here only the
 * small live window inside the browser step listens. Same shape as `composerScratch.ts`.
 *
 * Keyed by the chat SESSION's id, not the conversation: the browser belongs to one process,
 * and a respawn starts a new one. Every key dies twice over (`every-store-key-needs-a-death`):
 * when the server says the browser closed, and when the session is disposed.
 */

export interface BrowserLiveState {
  frame: BrowserFrame;
  /** The owner tucked the view away. Cleared when the browser closes, so the next run shows. */
  collapsed: boolean;
}

const store = new Map<string, BrowserLiveState>();
const listeners = new Map<string, Set<(s: BrowserLiveState | null) => void>>();

function emit(sessionId: string): void {
  const state = store.get(sessionId) ?? null;
  listeners.get(sessionId)?.forEach((fn) => fn(state));
}

export function readBrowserLive(sessionId: string): BrowserLiveState | null {
  return store.get(sessionId) ?? null;
}

export function pushBrowserFrame(sessionId: string, frame: BrowserFrame): void {
  const cur = store.get(sessionId);
  store.set(sessionId, { frame, collapsed: cur?.collapsed ?? false });
  emit(sessionId);
}

export function setBrowserCollapsed(sessionId: string, collapsed: boolean): void {
  const cur = store.get(sessionId);
  if (!cur || cur.collapsed === collapsed) return;
  store.set(sessionId, { ...cur, collapsed });
  emit(sessionId);
}

/** The browser closed, or the session ended. */
export function dropBrowserLive(sessionId: string): void {
  if (!store.delete(sessionId)) return;
  emit(sessionId);
}

export function subscribeBrowserLive(sessionId: string, fn: (s: BrowserLiveState | null) => void): () => void {
  let set = listeners.get(sessionId);
  if (!set) { set = new Set(); listeners.set(sessionId, set); }
  set.add(fn);
  return () => {
    const live = listeners.get(sessionId);
    if (!live) return;
    live.delete(fn);
    if (live.size === 0) listeners.delete(sessionId);
  };
}

/** Test seam: nothing outlives a test. */
export function __resetBrowserLiveForTests(): void {
  store.clear();
  listeners.clear();
}
