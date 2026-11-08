import type { AgentHistoryPage } from '../../../hooks/useAgents';
import { applyDeferred, mergeFresh, overlaps, prependOlder, readingOrder, type FeedSession } from '../../aiteam/agentHistory';
import type { FeedMeta } from '../chat/chatFeed';

/**
 * A MEMBER'S ROUTINE RUNS on its Super page (owner 2026-11-08: "Deneme Rutin's routine ran ... it
 * showed on this page neither live nor after it finished").
 *
 * Root cause: since each member opens as its own Super stage (9546b69e), its page draws the
 * member's Super chat only; the AI Team stage, whose feed drew the runs, was retired with it, and a
 * routine run still writes only to its routine's thread. This puts the same feed back: the runs
 * the server pages from those threads (`GET /api/agents/:slug/history?kind=run`), drawn by the Chat
 * pane's own feed rows. Every runner (Claude, Codex, Antigravity) writes the same thread, so a run
 * shows whichever tool ran it.
 *
 * Pure: the state moves the hook makes, unit-tested without a DOM or a server.
 */

export interface RunFeedState {
  /** Reading order (oldest first). */
  sessions: FeedSession[];
  nextBefore: string | null;
  loaded: boolean;
  failed: boolean;
  olderLoading: boolean;
  /** The reader is at the bottom: a run that moved (a late post) moves now, else on return. */
  pinned: boolean;
  deferred: string[];
}

export const EMPTY_RUN_FEED: RunFeedState = {
  sessions: [], nextBefore: null, loaded: false, failed: false, olderLoading: false, pinned: true, deferred: [],
};

/** Page 1 of an open landed. */
export function landFirst(s: RunFeedState, page: AgentHistoryPage): RunFeedState {
  return { ...s, sessions: readingOrder(page), nextBefore: page.nextBefore, loaded: true, failed: false, deferred: [] };
}

/**
 * A live re-read of page 1, merged by session key when it connects to what is held (rows keep
 * their ids, so nothing remounts); a page that does not connect (more new runs than a page holds)
 * replaces the feed.
 */
export function landFresh(s: RunFeedState, page: AgentHistoryPage): RunFeedState {
  if (!s.loaded) return landFirst(s, page);
  if (!overlaps(s.sessions, page)) return landFirst(s, page);
  const merged = mergeFresh(s.sessions, readingOrder(page), { defer: !s.pinned });
  return { ...s, sessions: merged.sessions, deferred: [...new Set([...s.deferred, ...merged.deferred])] };
}

/** An older page, prepended above what is loaded. */
export function landOlder(s: RunFeedState, page: AgentHistoryPage): RunFeedState {
  return { ...s, sessions: prependOlder(s.sessions, page), nextBefore: page.nextBefore, olderLoading: false };
}

export function withPinned(s: RunFeedState, pinned: boolean): RunFeedState {
  if (s.pinned === pinned) return s;
  if (!pinned || s.deferred.length === 0) return { ...s, pinned };
  return { ...s, pinned, sessions: applyDeferred(s.sessions, s.deferred), deferred: [] };
}

/** A run's end was on screen: its slug's read mark covers it and every older run of that slug. */
export function withSeen(s: RunFeedState, meta: Pick<FeedMeta, 'source' | 'newestId'>): RunFeedState {
  const upTo = meta.newestId;
  if (!upTo) return s;
  let changed = false;
  const sessions = s.sessions.map((x) => {
    if (!x.unread || x.source !== meta.source || (x.newestId ?? '') > upTo) return x;
    changed = true;
    return { ...x, unread: false };
  });
  return changed ? { ...s, sessions } : s;
}

export function anyRunning(s: RunFeedState): boolean {
  return s.sessions.some((x) => x.kind === 'run' && x.status === 'running');
}

/**
 * What, in the Agents channel's own poll, says this member's routines moved: a run started, posted
 * or ended, or one holds a slot. A change re-reads the history at once instead of on the slow poll.
 */
export function memberFeedSignature(
  slugs: ReadonlySet<string>,
  messages: readonly { slug: string; agent?: string; runId: string; status: string; newestId: string | null }[],
  busy: readonly string[],
  member: string,
): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (!slugs.has(m.slug) && m.agent !== member) continue;
    parts.push(`${m.slug}:${m.runId}:${m.status}:${m.newestId ?? ''}`);
  }
  for (const b of busy) if (slugs.has(b)) parts.push(`busy:${b}`);
  return parts.sort().join('|');
}

/** Slow re-read while nothing runs (the channel's poll triggers the rest), fast while one does. */
export const RUN_FEED_POLL_MS = 60_000;
export const RUN_FEED_POLL_RUNNING_MS = 5_000;
