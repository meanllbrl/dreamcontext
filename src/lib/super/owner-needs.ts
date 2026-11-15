/**
 * Does this queue item wait on the OWNER right now? The server's copy of the window's ONE rule
 * (dashboard/src/components/sleepy/super/superHandover.ts `needsOwner`), which the agenda's
 * Waiting on you, its count, the bar and the notch read. The drawer's Super row mark
 * (`rosterSummary().superAsking`) reads this one, so the side menu never says "waits on you"
 * while the agenda has nothing (bekleyen-kapanmaz, owner 2026-11-15). MIRRORED, pinned by
 * tests/unit/owner-card-supersede.test.ts: change both or neither.
 */
import type { SuperQueueItem } from './types.js';

export function needsOwnerItem(item: SuperQueueItem): boolean {
  if (item.state === 'done') return false;
  // An owner card he already acted on: its result is on its way, nothing waits on him.
  if (item.card && item.delivery) return false;
  // The server's nudge to a silent member is the member's turn, never his.
  if (item.kind === 'nudge') return false;
  // A Bypass child's permission is its Super's to decide first.
  if (item.kind === 'permission' && item.toSuper === true) return false;
  return item.kind === 'permission' || item.kind === 'owner' || item.kind === 'member' || item.kind === 'routine'
    || item.own === true || item.state === 'escalated'
    || (item.kind === 'question' && item.direct === true && !item.team);
}
