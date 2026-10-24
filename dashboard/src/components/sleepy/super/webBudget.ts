/**
 * The web containers' iframe budget (plan-r7 D10): at most TWO live iframes on the hand-over
 * screen. The least recently focused web container beyond that drops to its title and a Load
 * placeholder; one that is collapsed or not on screen (the overlay folded, the window hidden)
 * holds none at all. Loading an unapproved host stays the owner's click inside the widget.
 *
 * Pure: the surface keeps the recency list in state and asks which ids may hold a frame.
 */

export const MAX_LIVE_IFRAMES = 2;
/** Pages kept ALIVE at once (owner 2026-10-22: a reload loses his work): on screen or parked off
 *  the stage (Others, a group, the stage folded), so moving a card never reloads its page. */
export const MAX_KEPT_FRAMES = 4;
/** Live browser cards that re-render on new frames at once (jarvis AC7); the rest stay frozen. */
export const MAX_LIVE_BROWSERS = 2;

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

/**
 * The web cards that hold a frame now (owner 2026-10-22). First the ones on screen that load on
 * their own (`liveWebIds`, at most `maxAuto`), then the most recently focused or loaded ones
 * wherever they are, at most `maxKept` in all. A card in the set keeps its page: drawn when on
 * screen, parked hidden when not. One outside it shows its title and Load (on screen) or
 * nothing (off the stage), and loads afresh when it comes back.
 */
export function keptWebIds(
  lru: readonly string[], onScreen: readonly string[], all: readonly string[],
  maxAuto: number = MAX_LIVE_IFRAMES, maxKept: number = MAX_KEPT_FRAMES,
): Set<string> {
  const exists = new Set(all);
  const auto = [...liveWebIds(lru, onScreen.filter((id) => exists.has(id)), maxAuto)];
  const order = [...auto, ...lru.filter((id) => exists.has(id) && !auto.includes(id))];
  return new Set(order.slice(0, Math.max(0, maxKept)));
}
