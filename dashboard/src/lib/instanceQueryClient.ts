import { QueryClient } from '@tanstack/react-query';

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
 * How often a VISIBLE instance re-pulls its page data. Background instances stop polling
 * entirely (see {@link setInstanceActive}) — with six projects mounted, six 15-second polls
 * against one local server is five projects' worth of work nobody is looking at.
 */
const ACTIVE_REFETCH_MS = 15_000;

/**
 * A fresh client with the defaults the app has always used — this is a MOVE of `App.tsx`'s
 * former module-level `queryClient`, not a new policy.
 */
export function createInstanceQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5000,
        retry: 1,
        refetchOnWindowFocus: true,
        // Live-update while the app stays open (sleep debt, tasks, knowledge all
        // go stale as the agent works). Polls only when the tab is visible, and
        // react-query's structural sharing skips re-renders when nothing changed,
        // so this is cheap against the local server. The Header also exposes a
        // manual refresh button for an immediate pull.
        refetchInterval: ACTIVE_REFETCH_MS,
        refetchIntervalInBackground: false,
      },
      mutations: {
        retry: 0,
      },
    },
  });
}

/**
 * Follow one instance's visibility with its PAGE-DATA polling — and nothing else.
 *
 * A hidden instance is still mounted and still live: its chats keep streaming, its WebSockets
 * are never touched, its agent surface keeps its own polling. The only thing that pauses is
 * the react-query refetch loop behind the pages the user cannot currently see, which is pure
 * cost while they are hidden and is re-armed the instant the chip comes forward.
 *
 * Written through `setDefaultOptions` rather than per-query so it covers every existing and
 * future query at once; mounted observers pick the new interval up on their next update.
 * Queries that must keep polling in the background (a goal-skill run badge, say) override
 * `refetchInterval` explicitly at their own call site — the audit for that is Wave 3 (T17).
 *
 * With a single always-active chip this is behaviour-identical to today: the mechanism lands
 * now, the behaviour change arrives when a second chip does.
 */
export function setInstanceActive(qc: QueryClient, active: boolean): void {
  const defaults = qc.getDefaultOptions();
  qc.setDefaultOptions({
    ...defaults,
    queries: {
      ...defaults.queries,
      refetchInterval: active ? ACTIVE_REFETCH_MS : false,
      refetchOnWindowFocus: active,
    },
  });
}
