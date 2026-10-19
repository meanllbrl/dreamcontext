/**
 * The web containers' iframe budget (plan-r7 D10): at most TWO live iframes on the hand-over
 * screen. The least recently focused web container beyond that drops to its title and a Load
 * placeholder; one that is collapsed or not on screen (the overlay folded, the window hidden)
 * holds none at all. Loading an unapproved host stays the owner's click inside the widget.
 *
 * Pure: the surface keeps the recency list in state and asks which ids may hold a frame.
 */

export const MAX_LIVE_IFRAMES = 2;

/** `id` became the most recently focused (moved to the front). */
export function touchLru(lru: readonly string[], id: string): string[] {
  return [id, ...lru.filter((x) => x !== id)];
}

/** A container that closed leaves the list. */
export function dropFromLru(lru: readonly string[], id: string): string[] {
  return lru.filter((x) => x !== id);
}

/**
 * The web containers allowed a live iframe right now: of the ones on screen, the most recently
 * focused first; a never-focused one counts as least recent (on-screen order breaks ties);
 * no more than `max`.
 */
export function liveWebIds(lru: readonly string[], onScreen: readonly string[], max: number = MAX_LIVE_IFRAMES): Set<string> {
  const rank = (id: string) => { const i = lru.indexOf(id); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  const sorted = onScreen
    .map((id, order) => ({ id, order }))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.order - b.order)
    .map((x) => x.id);
  return new Set(sorted.slice(0, Math.max(0, max)));
}
