import type { HandsfreeStatus } from './handsfreeTypes';

/**
 * 0.30.0 ships hands-free unannounced: its window-bar button and Settings card stay hidden
 * unless this machine already ran `dreamcontext handsfree setup` (a CLI-only, unlisted step),
 * or a trip is under way. Flip to true when hands-free is announced.
 */
export const HANDSFREE_PUBLIC = false;

export function handsfreeVisible(status: HandsfreeStatus | null | undefined): boolean {
  if (HANDSFREE_PUBLIC) return true;
  if (!status) return false;
  return status.setUp || (status.phase ?? 'home') !== 'home';
}
