/**
 * "Which chat is the owner focused on in this project?" — published by each project's chat
 * surface (AgentSurface), read by the window's presence report (presence.ts via WindowChrome).
 *
 * Owner, 2026-10-18: a prompt or a finish is on his screen only when it is in the chat he is
 * FOCUSED on. Another chat, even a pane beside it in the project in front, still needs a word
 * from the notch (a short one: he is in the app). So the presence report names the project AND
 * this chat, and the server and the notch decide per session, not per project.
 *
 * Keyed by vault: one window holds several live projects and every one keeps its surface
 * mounted. The id is the chat's conversation id (`ChatSession.claudeId`), which is what the
 * server's chat registry calls `sessionId`. A surface that is closed, or a project with no chat
 * focused, holds no entry: every key dies when its surface unmounts or folds.
 */

const focused = new Map<string, string>();
const listeners = new Set<() => void>();

/** A project's surface says which chat has the focus, or `null` when none is on screen. */
export function setFocusedChat(vault: string, sessionId: string | null): void {
  const was = focused.get(vault) ?? null;
  if (was === sessionId) return;
  if (sessionId) focused.set(vault, sessionId); else focused.delete(vault);
  for (const l of [...listeners]) l();
}

/** The chat focused in `vault`'s surface right now, or null. */
export function focusedChatFor(vault: string | null): string | null {
  return vault ? focused.get(vault) ?? null : null;
}

/** Follow every change. Returns the unsubscribe. */
export function onFocusedChat(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
