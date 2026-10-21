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
 *  - `gone`   — its process had already gone (its row says so; a child that started again since
 *               has its row cleared, inbox.ts): dormant.
 * Parked and gone hold the owner's own chats (adopted) too: in Tilki eight of his chats, gone since
 * the day before, came back `starting` (2026-10-21 11:03). Every non-child tab resumes as before.
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
  if (!ch.adopted && !state.containers.some((k) => k.kind === 'chat' && k.ref === sessionId)) return 'closed';
  if (parked) return 'parked';
  if (ch.row === 'gone') return 'gone';
  return null;
}
