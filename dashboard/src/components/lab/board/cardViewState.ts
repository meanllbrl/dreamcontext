import type { Selection } from '../../../generated/frameOps';
import type { ActiveFilter } from '../blocks/frameShape';

/**
 * A card's VIEW STATE: what the reader chose on it, never what the board file says.
 *
 * Held by BoardPage per card id (not inside BoardCard), so the same card drawn
 * in the grid and then fullscreen is one view: the filter, the breakdown
 * selection, the pinned lanes, the open tab and the open app page all survive
 * the switch. Nothing here is saved or synced; a reload starts empty.
 *
 * - `filters`: the card's `filter` block choices (frameShape's ActiveFilter list).
 * - `selection`: the breakdown selection per insight slug (one value per dim).
 * - `lanes`: selections pinned side by side per insight slug, at most MAX_LANES.
 * - `tabs`: the open tab per tabs block, keyed by the block path (`0`, `1.2.0`).
 * - `appPage`: the open v1 app page per insight block, keyed by the block path.
 * - `funnel`: the funnel the reader picked per insight slug (a funnel-picker card only).
 *
 * The funnel, selection, lanes and open tabs also travel in the URL (`cardViewUrl.ts`),
 * so a reload or a shared link restores them.
 *
 * Every reducer is pure and returns a new view; a no-op returns the SAME view,
 * so React skips the render.
 */

export interface CardView {
  filters: ActiveFilter[];
  selection: Record<string, Selection>;
  lanes: Record<string, Selection[]>;
  tabs: Record<string, number>;
  appPage: Record<string, string>;
  funnel: Record<string, string>;
}

/** Views by card id. */
export type CardViews = Record<string, CardView>;

export const EMPTY_VIEW: CardView = Object.freeze({
  filters: [],
  selection: {},
  lanes: {},
  tabs: {},
  appPage: {},
  funnel: {},
}) as CardView;

/** The most selections a card compares side by side. */
export const MAX_LANES = 4;

/** A block path as a view key: `[1, 0, 2]` -> `1.0.2`. */
export function pathKey(path: readonly number[]): string {
  return path.join('.');
}

/** A selection's identity: its entries sorted by dim, so `{a,b}` and `{b,a}` are one lane. */
function laneId(sel: Selection): string {
  return Object.keys(sel).sort().map((k) => `${k}=${sel[k]}`).join('&');
}

/** Drop empty-string values: an empty value is "no choice on that dim". */
function cleanSelection(sel: Selection): Selection {
  const out: Selection = {};
  for (const [k, v] of Object.entries(sel)) if (typeof v === 'string' && v !== '') out[k] = v;
  return out;
}

export function setFilters(view: CardView, filters: ActiveFilter[]): CardView {
  return filters === view.filters ? view : { ...view, filters };
}

/** The selection for one insight; an empty selection removes the entry (the funnel level). */
export function setSelection(view: CardView, insight: string, selection: Selection): CardView {
  const next = cleanSelection(selection);
  const rest = { ...view.selection };
  if (Object.keys(next).length === 0) {
    if (!(insight in rest)) return view;
    delete rest[insight];
    return { ...view, selection: rest };
  }
  if (view.selection[insight] && laneId(view.selection[insight]) === laneId(next)) return view;
  return { ...view, selection: { ...rest, [insight]: next } };
}

/** Pin a selection as a lane. Refused (same view back) when it is empty, a duplicate, or the lanes are full. */
export function pinLane(view: CardView, insight: string, selection: Selection): CardView {
  const lane = cleanSelection(selection);
  const current = view.lanes[insight] ?? [];
  if (current.length >= MAX_LANES) return view;
  const id = laneId(lane);
  if (current.some((l) => laneId(l) === id)) return view;
  return { ...view, lanes: { ...view.lanes, [insight]: [...current, lane] } };
}

/** Remove the lane at `index`; the last lane gone removes the insight's entry. */
export function unpinLane(view: CardView, insight: string, index: number): CardView {
  const current = view.lanes[insight] ?? [];
  if (index < 0 || index >= current.length) return view;
  const next = current.filter((_, i) => i !== index);
  const lanes = { ...view.lanes };
  if (next.length === 0) delete lanes[insight];
  else lanes[insight] = next;
  return { ...view, lanes };
}

/** Replace the whole lane list (a block's `onLanes`): deduplicated, capped at MAX_LANES. */
export function setLanes(view: CardView, insight: string, list: readonly Selection[]): CardView {
  let next: CardView = { ...view, lanes: { ...view.lanes } };
  delete next.lanes[insight];
  for (const lane of list) next = pinLane(next, insight, lane);
  const before = view.lanes[insight] ?? [];
  const after = next.lanes[insight] ?? [];
  if (before.length === after.length && before.every((l, i) => laneId(l) === laneId(after[i]))) return view;
  return next;
}

export function setTab(view: CardView, blockPath: string, index: number): CardView {
  const i = Number.isInteger(index) && index > 0 ? index : 0;
  if ((view.tabs[blockPath] ?? 0) === i) return view;
  return { ...view, tabs: { ...view.tabs, [blockPath]: i } };
}

export function setAppPage(view: CardView, blockPath: string, pageId: string): CardView {
  if (view.appPage[blockPath] === pageId) return view;
  return { ...view, appPage: { ...view.appPage, [blockPath]: pageId } };
}

/** The funnel picked for one insight; null or '' clears it (the card falls back to the first funnel). */
export function setFunnel(view: CardView, insight: string, id: string | null): CardView {
  const current = (view.funnel ?? {})[insight];
  if (id === null || id === '') {
    if (current === undefined) return view;
    const rest = { ...view.funnel };
    delete rest[insight];
    return { ...view, funnel: rest };
  }
  if (current === id) return view;
  return { ...view, funnel: { ...(view.funnel ?? {}), [insight]: id } };
}

/** Keep only the views of cards still on the board (a key dies with its card). Same object when nothing died. */
export function pruneViews(views: CardViews, cardIds: Iterable<string>): CardViews {
  const keep = new Set(cardIds);
  const ids = Object.keys(views);
  if (ids.every((id) => keep.has(id))) return views;
  const out: CardViews = {};
  for (const id of ids) if (keep.has(id)) out[id] = views[id];
  return out;
}

/** Apply one view update to a card's view in the map. Same map when the view did not change. */
export function updateView(views: CardViews, cardId: string, fn: (view: CardView) => CardView): CardViews {
  const prev = views[cardId] ?? EMPTY_VIEW;
  const next = fn(prev);
  return next === prev ? views : { ...views, [cardId]: next };
}
