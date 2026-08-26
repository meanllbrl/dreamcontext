import { useCallback, useEffect, useState } from 'react';
import { emitInstance, useInstanceEvent, useVault } from '../../../context/VaultContext';

/**
 * Multi-page insight routing (A2) — the minimal contract a render kind can
 * adopt to get routed pages instead of a slide-over:
 *
 *   /lab/<slug>                → the insight's page 1 (funnel: overview table; app: entry page)
 *   /lab/<slug>/f/<funnelId>   → funnel's page 2 (detail lane)
 *   /lab/<slug>/p/<pageId>     → an app/v1 insight's routed page
 *
 * The Lab board card is page 1's entry. View state (filters, breakdown,
 * compare, arcs, sort — see funnelModel's view-state codecs) rides the QUERY
 * STRING so `?vault=` and `?page=` survive untouched; back/forward work via
 * real history entries + popstate. `funnel` and `app` are the routed renders
 * today (`chartRegistry`'s `routed: true`) — a future routed render reuses
 * this module's `/lab/<slug>` + a sub-segment of its own, not a new framework.
 * An `app/v1` page's own in-page params ride the query string too, under the
 * `p.` namespace (see `pushLabAppPath`/`readAppParams`) — chosen precisely so
 * they can never collide with `vault`/`page`/`from`/`to`/`range`/`cols`/`fs`.
 *
 * ONE ADDRESS BAR, N LIVE PROJECTS. A window now holds several projects at once (the chip
 * strip), and there is still exactly one URL. So the address bar is an owned resource: the
 * instance the user is looking at holds it, and every other instance PARKS its route in
 * memory instead of stamping it over the visible project's. Parking is not a downgrade —
 * a parked route is restored to the real URL the moment that chip comes forward, which is
 * what makes "switch away and come back" land you where you left.
 */

export interface LabRoute {
  slug: string | null;
  funnelId: string | null;
  /** `/lab/<slug>/p/<pageId>` — an `app/v1` insight's routed page (A2's `/f/`
   *  grammar sibling). Mutually exclusive with `funnelId` — the path grammar
   *  only ever matches one of `f`/`p` per URL. */
  pageId: string | null;
  /** `/lab/reports/<slug>` — the My Reports page. `reports` is a reserved
   *  first segment (the API reserves it identically), never an insight slug. */
  report: string | null;
}

/**
 * Fired after our own pushState/replaceState (popstate only covers back/forward), on the
 * INSTANCE bus rather than `window`: on `window` every mounted project re-reads the one URL
 * whenever ANY project navigates, so opening a funnel in the foreground would yank three
 * background Lab pages onto a slug that does not exist in their vault.
 */
const NAV_EVENT = 'dc-lab-route';

/**
 * The bus of the instance that currently owns the window's address bar, or null when nobody
 * has claimed it (boot before the first Lab page mounts, the launcher, tests). Identity is
 * the bus rather than a bare boolean so a release can be REFUSED: on a chip switch React runs
 * every cleanup before every effect body, but even if that order ever changed, the outgoing
 * instance's `setLabRouteWritable(false)` cannot unseat the incoming one — it is not the
 * owner by then, so it is ignored.
 */
let urlOwner: EventTarget | null = null;

/**
 * Where each non-owning instance would be if it held the address bar, as a `pathname+search`
 * string. Keyed by the instance bus and weak, so a closed chip's route is collected with it.
 */
const parkedRoutes = new WeakMap<EventTarget, string>();

/**
 * May this caller read and write the real URL?
 *
 * An ABSENT bus reads as "yes" on purpose. `pushLabPath` is also called from surfaces this
 * module cannot hand a bus to (`LabBoard`, `FunnelOverviewPage`), and every one of those call
 * sites is a click handler — a background instance is `hidden` + `inert`, so it takes no
 * pointer events and no focus, and a click is therefore proof that the caller IS the
 * foreground instance. See the note on `pushLabPath`.
 */
function ownsUrl(bus: EventTarget | undefined): boolean {
  return bus === undefined || urlOwner === null || urlOwner === bus;
}

/** This instance's location — the live URL when it owns the address bar, its parked route otherwise. */
function currentTarget(bus: EventTarget | undefined): string {
  if (ownsUrl(bus)) return window.location.pathname + window.location.search;
  return parkedRoutes.get(bus as EventTarget) ?? '/';
}

function splitTarget(target: string): { pathname: string; search: string } {
  const i = target.indexOf('?');
  return i === -1
    ? { pathname: target, search: '' }
    : { pathname: target.slice(0, i), search: target.slice(i) };
}

function notify(bus: EventTarget | null | undefined): void {
  if (bus) emitInstance(bus, NAV_EVENT);
}

/**
 * The single place a lab route is committed. The owner writes real history; everyone else
 * parks the same string in memory and tells only its own hooks — which is the whole reason a
 * background project can keep coherent React state without touching the visible URL.
 */
function commit(target: string, mode: 'push' | 'replace', bus: EventTarget | undefined): void {
  if (ownsUrl(bus)) {
    if (window.location.pathname + window.location.search === target) return;
    if (mode === 'push') window.history.pushState(null, '', target);
    else window.history.replaceState(null, '', target);
    // With no bus passed, the click came from the foreground instance — notify the owner.
    notify(bus ?? urlOwner);
    return;
  }
  const parked = bus as EventTarget;
  if ((parkedRoutes.get(parked) ?? '/') === target) return;
  parkedRoutes.set(parked, target);
  notify(parked);
}

export function parseLabPath(pathname: string): LabRoute {
  const none: LabRoute = { slug: null, funnelId: null, pageId: null, report: null };
  const report = /^\/lab\/reports\/([^/]+)\/?$/.exec(pathname);
  if (report) {
    try {
      return { ...none, report: decodeURIComponent(report[1]) };
    } catch {
      return none;
    }
  }
  // Group 2 is the segment kind (`f` funnel detail, `p` app page) — mutually
  // exclusive by construction, so at most one of funnelId/pageId is ever set.
  const m = /^\/lab\/([^/]+)(?:\/(f|p)\/([^/]+))?\/?$/.exec(pathname);
  if (!m || m[1] === 'reports') return none;
  try {
    const slug = decodeURIComponent(m[1]);
    const subId = m[3] ? decodeURIComponent(m[3]) : null;
    return {
      ...none,
      slug,
      funnelId: m[2] === 'f' ? subId : null,
      pageId: m[2] === 'p' ? subId : null,
    };
  } catch {
    return none;
  }
}

export function labPath(slug: string | null, funnelId: string | null): string {
  if (!slug) return '/';
  return funnelId
    ? `/lab/${encodeURIComponent(slug)}/f/${encodeURIComponent(funnelId)}`
    : `/lab/${encodeURIComponent(slug)}`;
}

/** The `app/v1` sibling of {@link labPath} — `/lab/<slug>` (no page, or the
 *  entry page) vs `/lab/<slug>/p/<pageId>`. Kept as a separate builder rather
 *  than overloading `labPath`'s `f`/`p` choice implicitly: a caller should
 *  never be able to ask for a funnel URL and an app URL out of one call. */
export function labAppPath(slug: string, pageId: string | null): string {
  return pageId
    ? `/lab/${encodeURIComponent(slug)}/p/${encodeURIComponent(pageId)}`
    : `/lab/${encodeURIComponent(slug)}`;
}

export function labReportPath(slug: string): string {
  return `/lab/reports/${encodeURIComponent(slug)}`;
}

/** Push the My Reports page for one report (same contract as pushLabPath). */
export function pushLabReportPath(slug: string, bus?: EventTarget): void {
  commit(labReportPath(slug) + splitTarget(currentTarget(bus)).search, 'push', bus);
}

/**
 * Push a new lab location (path change = a history entry the Back button pops).
 *
 * `bus` is optional ONLY because two click-driven callers outside this module's reach
 * (`LabBoard`, `FunnelOverviewPage`) cannot pass one; omitting it means "I am the foreground
 * instance", which a click proves. Anything that can fire without a click — an effect, a
 * timer, a message — MUST pass its bus, or it will write over the visible project's URL.
 */
export function pushLabPath(slug: string | null, funnelId: string | null, bus?: EventTarget): void {
  commit(labPath(slug, funnelId) + splitTarget(currentTarget(bus)).search, 'push', bus);
}

// ─── app/v1 navigate params (S2) ────────────────────────────────────────────
//
// A `lab.navigate(pageId, params)` call from inside a script-authored app body
// is untrusted-body input that can reach the REAL, shareable browser URL (via
// pushLabAppPath below and Copy-link reading it back). Every other
// author-controlled surface in this contract has a cap; params gets one too,
// enforced in exactly this one place so nothing downstream can round-trip an
// unsanitized value into history.

const APP_PARAM_MAX_COUNT = 8;
const APP_PARAM_KEY_RE = /^[a-z0-9_-]{1,24}$/;
const APP_PARAM_MAX_VALUE_CHARS = 64;
/** A cheap proxy for "serialized size" — the sum of raw key+value characters,
 *  not `URLSearchParams#toString()`'s percent-encoded length. The cap exists
 *  to bound a covert-channel payload, not to predict the exact URL byte
 *  count, so the simpler measure is the right one. */
const APP_PARAM_MAX_TOTAL_CHARS = 256;

function warnDroppedParam(key: string, reason: string): void {
  console.warn(`[lab-app] navigate params: dropped "${key}" — ${reason}.`);
}

/**
 * Cap an app body's `lab.navigate(pageId, params)` payload before it can ever
 * reach the URL. PURE and browser-free (no `window`/DOM) so it is directly
 * unit-testable; the one side effect is `console.warn`, which the contract
 * requires ("every drop emits one console.warn naming the key") and which
 * does not affect the return value for a given input.
 *
 * Rules, in order: keep only keys matching `[a-z0-9_-]{1,24}`; drop any value
 * over 64 chars (after `String()`) — NEVER truncate, since a truncated value
 * is a silently wrong view, not a safe one; cap the count at 8, keeping the
 * first 8 in key-sorted order for a deterministic result; then, if the total
 * is still over budget, drop from the end of that sorted, count-capped list
 * until it fits.
 */
export function sanitizeAppParams(raw: unknown): { params: Record<string, string>; dropped: string[] } {
  const dropped: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { params: {}, dropped };
  }

  const candidates: { key: string; value: string }[] = [];
  for (const [key, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    if (!APP_PARAM_KEY_RE.test(key)) {
      dropped.push(key);
      warnDroppedParam(key, 'key must match /^[a-z0-9_-]{1,24}$/');
      continue;
    }
    const value = String(rawValue);
    if (value.length > APP_PARAM_MAX_VALUE_CHARS) {
      dropped.push(key);
      warnDroppedParam(key, `value is ${value.length} chars — over the ${APP_PARAM_MAX_VALUE_CHARS}-char cap`);
      continue;
    }
    candidates.push({ key, value });
  }

  // Deterministic count cap: key-sorted, keep the first 8.
  candidates.sort((a, b) => a.key.localeCompare(b.key));
  const kept = candidates.slice(0, APP_PARAM_MAX_COUNT);
  for (const extra of candidates.slice(APP_PARAM_MAX_COUNT)) {
    dropped.push(extra.key);
    warnDroppedParam(extra.key, `over the ${APP_PARAM_MAX_COUNT}-param cap`);
  }

  // Total-size cap: trim from the end of the surviving, sorted list.
  let total = kept.reduce((sum, { key, value }) => sum + key.length + value.length, 0);
  while (total > APP_PARAM_MAX_TOTAL_CHARS && kept.length > 0) {
    const removed = kept.pop()!;
    total -= removed.key.length + removed.value.length;
    dropped.push(removed.key);
    warnDroppedParam(removed.key, `total navigate params exceed the ${APP_PARAM_MAX_TOTAL_CHARS}-char cap`);
  }

  const params: Record<string, string> = {};
  for (const { key, value } of kept) params[key] = value;
  return { params, dropped };
}

/**
 * Push a page/params change for an `app/v1` insight — the SOLE writer of the
 * `p.`-namespaced query params (never colliding with `vault`/`page`/`from`/
 * `to`/`range`/`cols`/`fs`). Params are capped by {@link sanitizeAppParams}
 * before they can reach the URL; a stale page's params are cleared, not
 * merged, so switching pages never leaks the outgoing page's `p.*` keys into
 * the incoming one.
 *
 * `bus` has no click-driven exemption here (contrast `pushLabPath`): a
 * `lab.navigate()` call arrives over `postMessage`, which is exactly the "an
 * effect, a timer, a message" case the module doc above requires a bus for —
 * the caller (`LabAppPage`) always has one via `useVault()`.
 */
export function pushLabAppPath(
  slug: string,
  pageId: string | null,
  params: Record<string, string>,
  bus?: EventTarget,
): void {
  const { params: safeParams } = sanitizeAppParams(params);
  const current = new URLSearchParams(splitTarget(currentTarget(bus)).search);
  for (const key of [...current.keys()]) {
    if (key.startsWith('p.')) current.delete(key);
  }
  for (const [key, value] of Object.entries(safeParams)) current.set(`p.${key}`, value);
  const search = current.toString();
  commit(labAppPath(slug, pageId) + (search ? `?${search}` : ''), 'push', bus);
}

/**
 * The inverse of {@link pushLabAppPath}'s write: strip the `p.` namespace
 * back off the live query string into the plain params an `app/v1` page
 * hands `<LabAppFrame>` — run back through {@link sanitizeAppParams} first.
 *
 * This is NOT redundant with `pushLabAppPath`'s own sanitizing. That call
 * only caps params THIS instance wrote via `lab.navigate()`; a URL can also
 * arrive hand-typed, bookmarked, or shared by someone else, never touching
 * `pushLabAppPath` at all. Without sanitizing here too, an over-cap `p.*`
 * query string would reach `window.__LAB_APP__` verbatim (and, via
 * `currentDeepLink`, get echoed straight back out through Copy-link) — the
 * cap held for exactly one arrival path and no others. The cap is a property
 * of what reaches the app, not of one code path, so both directions enforce
 * it. Returns `dropped` too, so a caller can tell an over-cap URL apart from
 * a clean one and rewrite the address bar to match what the app actually
 * received (see `LabAppPage`'s normalize effect — `readAppParams` itself
 * stays pure/browser-free, same as `sanitizeAppParams`).
 */
export function readAppParams(params: URLSearchParams): { params: Record<string, string>; dropped: string[] } {
  const raw: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    if (key.startsWith('p.')) raw[key.slice(2)] = value;
  }
  return sanitizeAppParams(raw);
}

/** Replace the current query string (view-state edits don't spam history). */
export function replaceSearch(params: URLSearchParams, bus?: EventTarget): void {
  const search = params.toString();
  commit(splitTarget(currentTarget(bus)).pathname + (search ? `?${search}` : ''), 'replace', bus);
}

/** Reset the path to `/` (keeps the query) — used when leaving the Lab page. */
export function clearLabPath(bus?: EventTarget): void {
  commit('/' + splitTarget(currentTarget(bus)).search, 'replace', bus);
}

/** The absolute deep link for THIS instance's current location (copy-link actions). */
export function currentDeepLink(bus?: EventTarget): string {
  return window.location.origin + currentTarget(bus);
}

/**
 * Claim or release the window's address bar for one instance.
 *
 * Releasing parks where this instance was (so coming back restores it) and hands the path
 * back to `/`, keeping the query string — the same reset `clearLabPath` does when you leave
 * the Lab page, and for the same reason: a reload must not resurrect this project's funnel
 * page underneath whichever project is showing.
 */
export function setLabRouteWritable(on: boolean, bus: EventTarget): void {
  if (on) {
    urlOwner = bus;
    return;
  }
  if (urlOwner !== bus) return; // already superseded — a stale release must not unseat the new owner
  parkedRoutes.set(bus, window.location.pathname + window.location.search);
  urlOwner = null;
  if (window.location.pathname !== '/') {
    window.history.replaceState(null, '', '/' + window.location.search);
  }
}

/**
 * Restore the owning instance's parked route to the real URL — called when a chip comes
 * forward. `replaceState`, not `pushState`: bringing a project back into view is not a
 * navigation the Back button should have to step through.
 */
export function flushBufferedRoute(): void {
  const bus = urlOwner;
  if (!bus) return;
  const parked = parkedRoutes.get(bus);
  if (parked === undefined) return;
  parkedRoutes.delete(bus);
  if (window.location.pathname + window.location.search === parked) return;
  window.history.replaceState(null, '', parked);
  notify(bus);
}

/**
 * Back/forward is genuinely a WINDOW gesture — the browser owns it, so the listener stays on
 * `window`. Only the instance holding the address bar reacts, because a popstate describes
 * that instance's history and nobody else's. Checked at event time rather than in the
 * dependency array so a change of owner never needs a resubscribe.
 */
function usePopstate(bus: EventTarget, reread: () => void): void {
  useEffect(() => {
    const onPop = () => {
      if (ownsUrl(bus)) reread();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [bus, reread]);
}

/** Live view of the lab route (path segments). Re-renders on push/pop. */
export function useLabRoute(): LabRoute {
  const { bus } = useVault();
  const [route, setRoute] = useState<LabRoute>(() => parseLabPath(splitTarget(currentTarget(bus)).pathname));
  const reread = useCallback(
    () => setRoute(parseLabPath(splitTarget(currentTarget(bus)).pathname)),
    [bus],
  );
  useInstanceEvent(NAV_EVENT, reread);
  usePopstate(bus, reread);
  return route;
}

/** Live view of the query string + an updater that preserves foreign params. */
export function useLabSearchParams(): [URLSearchParams, (mutate: (params: URLSearchParams) => void) => void] {
  const { bus } = useVault();
  const [params, setParams] = useState(() => new URLSearchParams(splitTarget(currentTarget(bus)).search));
  const reread = useCallback(
    () => setParams(new URLSearchParams(splitTarget(currentTarget(bus)).search)),
    [bus],
  );
  useInstanceEvent(NAV_EVENT, reread);
  usePopstate(bus, reread);
  const update = useCallback((mutate: (params: URLSearchParams) => void) => {
    const next = new URLSearchParams(splitTarget(currentTarget(bus)).search);
    mutate(next);
    replaceSearch(next, bus);
  }, [bus]);
  return [params, update];
}
