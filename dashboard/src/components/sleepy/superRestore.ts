/**
 * What a relaunch does with a saved tab the server marked `superHold` (src/lib/super/restore.ts):
 * an ENDED super child is dropped from the roster; a card-closed, parked or gone one comes back
 * DORMANT (no process; Resume reopens the same conversation); everything else resumes as before.
 */
export type SuperHold = 'ended' | 'closed' | 'parked' | 'gone';

export function superRestorePlan(hold: unknown): 'drop' | 'dormant' | 'resume' {
  if (hold === 'ended') return 'drop';
  if (hold === 'closed' || hold === 'parked' || hold === 'gone') return 'dormant';
  return 'resume';
}
