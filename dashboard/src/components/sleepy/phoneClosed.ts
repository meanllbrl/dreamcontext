/**
 * Conversations this phone just closed. A closed chat's process takes a moment to exit, and
 * until it does the Mac still lists it as running: without this it would come back as a "Mac"
 * row for a few seconds, and a tap there would adopt a chat on its way out. Kept for
 * {@link CLOSED_TTL_MS}, which outlasts the exit; a conversation reopened in the meantime is a
 * tab again, so nothing is hidden from you.
 */
export const CLOSED_TTL_MS = 20_000;

const closed = new Map<string, number>();

export function markClosed(ids: readonly (string | undefined)[], now = Date.now()): void {
  for (const id of ids) if (id) closed.set(id, now);
}

export function recentlyClosed(now = Date.now()): string[] {
  for (const [id, at] of closed) if (now - at > CLOSED_TTL_MS) closed.delete(id);
  return [...closed.keys()];
}
