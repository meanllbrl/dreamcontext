/**
 * When a dropped connection is worth SAYING. Pure, and on its own so plain Node tests can
 * read it (Banners.tsx pulls in browser-only modules).
 */

/** How long a connection must have been down before it is said: a drop that heals within a
 *  second or so is invisible, so it must not flash a pill (or a card's waiting line). */
export const RECONNECT_CHIP_DELAY_MS = 1500;

/** Is it time to show "Reconnecting…" for a session `connecting` since `sinceMs`? */
export function reconnectChipDue(sinceMs: number, nowMs: number): boolean {
  return nowMs - sinceMs >= RECONNECT_CHIP_DELAY_MS;
}
