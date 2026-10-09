import type { Selection } from '../../../generated/frameOps';
import { EMPTY_VIEW, MAX_LANES, type CardView, type CardViews } from './cardViewState';

/**
 * A card's view in the URL: the picked funnel, the breakdown selection, the
 * pinned lanes and the open tabs travel as `v.<cardId>=<compact JSON>`, so a
 * reload, a fullscreen reload or a shared link opens the card exactly as the
 * reader left it. Filters and the open v1 app page stay in memory (the app
 * page has its own route).
 *
 * The JSON is `{f, s, l, t}`: funnel per insight, selection per insight, lanes
 * per insight, open tab per tabs-block path. Only non-empty parts are written;
 * a card with nothing chosen writes no param at all.
 *
 * Reading is LENIENT: a hand-edited or truncated param never throws, it keeps
 * what is valid (safe keys, values of at most 128 chars, at most 4 lanes, tab
 * indexes 0-63) and drops the rest. PURE: no window, no DOM.
 */

export const VIEW_PARAM_PREFIX = 'v.';
/** A param longer than this is not written (lanes are dropped first, then the param). */
export const MAX_VIEW_PARAM_CHARS = 1500;
/** At most this many cards carry a view in the URL (board order). */
export const MAX_VIEW_PARAMS = 8;

const MAX_VALUE_CHARS = 128;
const MAX_TAB_INDEX = 63;
/** An insight slug, card id or dimension key. */
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** A tabs block path: `1`, `0.2`. */
const TAB_PATH = /^\d{1,3}(\.\d{1,3}){0,3}$/;

interface UrlView {
  f?: Record<string, string>;
  s?: Record<string, Selection>;
  l?: Record<string, Selection[]>;
  t?: Record<string, number>;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function cleanValue(v: unknown): string | null {
  return typeof v === 'string' && v !== '' && v.length <= MAX_VALUE_CHARS ? v : null;
}

function cleanSelection(v: unknown): Selection | null {
  const r = asRecord(v);
  if (!r) return null;
  const out: Selection = {};
  for (const [k, value] of Object.entries(r)) {
    const clean = cleanValue(value);
    if (SAFE_KEY.test(k) && clean !== null) out[k] = clean;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function nonEmpty<T>(r: Record<string, T>): Record<string, T> | undefined {
  return Object.keys(r).length > 0 ? r : undefined;
}

function urlViewOf(view: CardView, withLanes: boolean): UrlView {
  const out: UrlView = {};
  const f = nonEmpty(Object.fromEntries(Object.entries(view.funnel ?? {}).filter(([, id]) => typeof id === 'string' && id !== '')));
  if (f) out.f = f;
  const s = nonEmpty(Object.fromEntries(Object.entries(view.selection ?? {}).filter(([, sel]) => Object.keys(sel).length > 0)));
  if (s) out.s = s;
  if (withLanes) {
    const l = nonEmpty(Object.fromEntries(Object.entries(view.lanes ?? {}).filter(([, list]) => list.length > 0)));
    if (l) out.l = l;
  }
  // Tab 0 is the default: it needs no param.
  const t = nonEmpty(Object.fromEntries(Object.entries(view.tabs ?? {}).filter(([, i]) => i > 0)));
  if (t) out.t = t;
  return out;
}

/** The view as a URL param value, or null when the card has nothing to restore (or it cannot fit). */
export function encodeCardView(view: CardView | undefined): string | null {
  if (!view) return null;
  for (const withLanes of [true, false]) {
    const u = urlViewOf(view, withLanes);
    if (Object.keys(u).length === 0) return null;
    const json = JSON.stringify(u);
    if (json.length <= MAX_VIEW_PARAM_CHARS) return json;
  }
  return null;
}

/** A param value back to a view (filters and app pages empty), or null when nothing in it is usable. */
export function decodeCardView(raw: string | null | undefined): CardView | null {
  if (typeof raw !== 'string' || raw === '' || raw.length > MAX_VIEW_PARAM_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const r = asRecord(parsed);
  if (!r) return null;
  const view: CardView = { ...EMPTY_VIEW, filters: [], selection: {}, lanes: {}, tabs: {}, appPage: {}, funnel: {} };
  for (const [insight, id] of Object.entries(asRecord(r.f) ?? {})) {
    const clean = cleanValue(id);
    if (SAFE_KEY.test(insight) && clean !== null) view.funnel[insight] = clean;
  }
  for (const [insight, sel] of Object.entries(asRecord(r.s) ?? {})) {
    const clean = cleanSelection(sel);
    if (SAFE_KEY.test(insight) && clean) view.selection[insight] = clean;
  }
  for (const [insight, list] of Object.entries(asRecord(r.l) ?? {})) {
    if (!SAFE_KEY.test(insight) || !Array.isArray(list)) continue;
    const lanes = list.map(cleanSelection).filter((s): s is Selection => s !== null).slice(0, MAX_LANES);
    if (lanes.length > 0) view.lanes[insight] = lanes;
  }
  for (const [path, index] of Object.entries(asRecord(r.t) ?? {})) {
    if (TAB_PATH.test(path) && typeof index === 'number' && Number.isInteger(index) && index > 0 && index <= MAX_TAB_INDEX) {
      view.tabs[path] = index;
    }
  }
  return encodeCardView(view) === null ? null : view;
}

/** The views the URL carries for the cards of this board (unknown card ids are ignored). */
export function readViewParams(params: URLSearchParams, cardIds: readonly string[]): CardViews {
  const out: CardViews = {};
  for (const id of cardIds) {
    const view = decodeCardView(params.get(`${VIEW_PARAM_PREFIX}${id}`));
    if (view) out[id] = view;
  }
  return out;
}

/**
 * Make the URL's `v.*` params say exactly what `views` say for `cardIds` (board
 * order, the first MAX_VIEW_PARAMS with something to restore). Params of cards
 * not on the board, and of cards whose view is empty, are removed. Mutates
 * `params`; true when anything changed.
 */
export function writeViewParams(params: URLSearchParams, views: CardViews, cardIds: readonly string[]): boolean {
  const want = new Map<string, string>();
  for (const id of cardIds) {
    if (want.size >= MAX_VIEW_PARAMS) break;
    if (!SAFE_KEY.test(id)) continue;
    const value = encodeCardView(views[id]);
    if (value !== null) want.set(`${VIEW_PARAM_PREFIX}${id}`, value);
  }
  let changed = false;
  for (const key of [...params.keys()]) {
    if (key.startsWith(VIEW_PARAM_PREFIX) && !want.has(key)) {
      params.delete(key);
      changed = true;
    }
  }
  for (const [key, value] of want) {
    if (params.get(key) !== value) {
      params.set(key, value);
      changed = true;
    }
  }
  return changed;
}

/** True when the URL already says what `views` say for these cards (nothing to write). */
export function viewParamsMatch(params: URLSearchParams, views: CardViews, cardIds: readonly string[]): boolean {
  return !writeViewParams(new URLSearchParams(params), views, cardIds);
}
