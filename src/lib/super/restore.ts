import type { SuperState } from './types.js';

/**
 * Which of a vault's super children a relaunch brings back RUNNING (field 2026-10-21: every tab,
 * ended and card-closed children included, came back through `--resume`; in Tilki the sessions of
 * closed cards kept running in the background).
 *
 * The roster GET marks a child's saved tab with why it must NOT resume:
 *  - `ended`  — `super end` (or the owner's card close) ended it: the tab is dropped;
 *  - `closed` — its card was closed (`super close`): it comes back as a dormant tab;
 *  - `parked` — it was parked: dormant, labelled parked;
 *  - `gone`   — its process had already gone (the newest queue item about it says so): dormant.
 * The owner's own chats (adopted) and every non-child tab resume as before.
 */
export type SuperRestoreHold = 'ended' | 'closed' | 'parked' | 'gone';

export function superRestoreHold(
  state: Pick<SuperState, 'session' | 'children' | 'containers' | 'queue'>,
  sessionId: string,
  parked: boolean,
): SuperRestoreHold | null {
  if (sessionId === state.session) return null;
  const ch = state.children[sessionId];
  if (!ch) return null;
  if (ch.endedAt !== undefined) return 'ended';
  if (ch.adopted) return null;
  if (!state.containers.some((k) => k.kind === 'chat' && k.ref === sessionId)) return 'closed';
  if (parked) return 'parked';
  const newest = [...state.queue].filter((q) => q.sessionId === sessionId).sort((a, b) => b.createdAt - a.createdAt)[0];
  if (newest?.kind === 'gone') return 'gone';
  return null;
}
