import { QueryClient } from '@tanstack/react-query';
import { onWindowActivity, pollMs } from './windowActivity';

/**
 * One `QueryClient` per LIVE PROJECT, instead of one per window.
 *
 * The cache is keyed by query key alone, so a single window-wide client would serve project
 * B's `['tasks']` entry to project A the moment both are mounted — same key, different vault,
 * one cache. Giving every `ProjectInstance` its own client is what keeps N projects' page data
 * genuinely separate, and it also makes teardown total: closing a chip drops that project's
 * whole cache with it rather than leaving orphaned entries behind.
 */

/**
 * How often a VISIBLE instance re-pulls its page data, at the focused cadence (`pollMs` slows
 * it while the window is unfocused or in Light mode). Background instances stop polling
 * entirely (see {@link setInstanceActive}) — with six projects mounted, six 15-second polls
 * against one local server is five projects' worth of work nobody is looking at.
 */
const ACTIVE_REFETCH_MS = 15_000;

/** A window unfocused at least this long refetches its active project's stale data on refocus. */
export const REFOCUS_REFETCH_MS = 10_000;

/**
 * Per-client registry state. Set ONCE when the client is created and never deleted by a
 * registration cleanup, so StrictMode's effect replay cannot reset it and unbalance the
 * client's mount count. `subscribed` starts true because the client's `QueryClientProvider`
 * mounts it (subscribing it to `focusManager` / `onlineManager`).
 */
interface ClientState { active: boolean; subscribed: boolean }
const clientState = new WeakMap<QueryClient, ClientState>();
/** The clients a window currently shows or holds, iterable for refocus. */
const registered = new Set<QueryClient>();

function isActive(qc: QueryClient): boolean {
  return clientState.get(qc)?.active ?? true;
}

/**
 * Re-evaluate every observer's (function-form) interval now, without fetching: React Query
 * reads client defaults into each observer at render and only recomputes the interval on its
 * next update, so a flip of the active flag or of the window's focus would otherwise wait a
 * whole stale interval to take effect.
 */
function rearm(qc: QueryClient): void {
  for (const query of qc.getQueryCache().getAll()) {
    for (const observer of query.observers) observer.setOptions(observer.options);
  }
}

let refocusInstalled = false;
/** On every focus/visibility change: re-arm the window client and every ACTIVE instance; after
 *  ≥ 10 s unfocused, also run React Query's own focus refetch on those clients only (honours
 *  each query's `refetchOnWindowFocus`, staleness and in-flight dedupe). Hidden project tabs
 *  are never touched. */
function installRefocus(): void {
  if (refocusInstalled) return;
  refocusInstalled = true;
  onWindowActivity((next, prev, { unfocusedMs }) => {
    const clients = [...registered].filter(isActive);
    for (const qc of clients) rearm(qc);
    if (next.focused && !prev.focused && prev.visible && unfocusedMs >= REFOCUS_REFETCH_MS) {
      for (const qc of clients) qc.getQueryCache().onFocus();
    }
  });
}

/**
 * A fresh client with the defaults the app has always used — this is a MOVE of `App.tsx`'s
 * former module-level `queryClient`, not a new policy. The interval and the focus refetch are
 * FUNCTIONS of this client's active flag, evaluated by React Query at call time, so flipping
 * the flag reaches every mounted query (a `setDefaultOptions` would not: observers copy the
 * defaults once, at render).
 */
export function createInstanceQueryClient(): QueryClient {
  installRefocus();
  const qc: QueryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5000,
        retry: 1,
        refetchOnWindowFocus: () => isActive(qc),
        // Live-update while the app stays open (sleep debt, tasks, knowledge all
        // go stale as the agent works). Polls only when the window is visible, and
        // react-query's structural sharing skips re-renders when nothing changed,
        // so this is cheap against the local server. The Header also exposes a
        // manual refresh button for an immediate pull.
        refetchInterval: () => (isActive(qc) ? pollMs(ACTIVE_REFETCH_MS) : false),
        refetchIntervalInBackground: false,
      },
      mutations: {
        retry: 0,
      },
    },
  });
  clientState.set(qc, { active: true, subscribed: true });
  return qc;
}

/**
 * Hold a client in the window's registry so refocus can reach it. Call from a mount effect
 * (never during render); the returned cleanup removes it, so a closed tab frees its cache.
 * The window client is registered at App boot and stays active for the window's life.
 */
export function registerInstanceClient(qc: QueryClient): () => void {
  if (!clientState.has(qc)) clientState.set(qc, { active: true, subscribed: true });
  registered.add(qc);
  return () => { registered.delete(qc); };
}

/**
 * Follow one instance's visibility with its PAGE-DATA polling — and nothing else.
 *
 * A hidden instance is still mounted and still live: its chats keep streaming, its WebSockets
 * are never touched, its agent surface keeps its own polling. What stops is the react-query
 * work behind the pages the user cannot currently see:
 *   - the default 15 s interval (a function of the active flag, re-armed here at once);
 *   - every focus refetch, including the per-query `refetchOnWindowFocus: true` overrides —
 *     an inactive client is taken off the global focus signal with `qc.unmount()` and put
 *     back with `qc.mount()`, called only when the subscription must CHANGE (idempotent, so
 *     StrictMode's double effects and a tab restored hidden at launch stay balanced).
 * Queries that must keep polling in the background (a goal-skill run badge, say) set their own
 * `refetchInterval` at their call site and keep it.
 *
 * Coming forward (`false → true`), the tab refetches its STALE queries at once and resumes any
 * retry or mutation paused while it was hidden.
 */
export function setInstanceActive(qc: QueryClient, active: boolean): void {
  let s = clientState.get(qc);
  if (!s) { s = { active: true, subscribed: true }; clientState.set(qc, s); }
  const was = s.active;
  s.active = active;
  if (active && !s.subscribed) { qc.mount(); s.subscribed = true; }
  if (!active && s.subscribed) { qc.unmount(); s.subscribed = false; }
  rearm(qc);
  if (!was && active) void qc.resumePausedMutations().then(() => qc.getQueryCache().onFocus());
}

/** Tests only: forget every registered client and re-install the refocus listener on the next
 *  client (`resetWindowActivityForTests` drops every activity listener). */
export function resetInstanceRegistryForTests(): void {
  registered.clear();
  refocusInstalled = false;
}
