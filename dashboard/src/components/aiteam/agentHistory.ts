import type { AgentHistoryPage, AgentHistorySession } from '../../hooks/useAgents';
import { stripActionFences, type FeedItem, type FeedMeta } from '../sleepy/chat/chatFeed';

/**
 * An agent's history, as the stage pane holds it: the sessions the server paged
 * (`GET /api/agents/:slug/history`), oldest first (reading order), and the pure moves the stage
 * makes on them — a page landing, an older page prepended, a live re-read merged in, a late reply
 * moving its run to the end. Rows are keyed by entry id, so a merge never remounts a row.
 */

export type FeedSession = AgentHistorySession;

const cmp = (a: FeedSession, b: FeedSession): number =>
  (Date.parse(a.lastAt) - Date.parse(b.lastAt)) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** A page's sessions (newest first on the wire) in reading order. */
export function readingOrder(page: Pick<AgentHistoryPage, 'sessions'>): FeedSession[] {
  return [...page.sessions].reverse();
}

/** An older page above what is loaded: sessions the feed already holds are skipped. */
export function prependOlder(held: readonly FeedSession[], older: Pick<AgentHistoryPage, 'sessions'>): FeedSession[] {
  const have = new Set(held.map((s) => s.key));
  return [...readingOrder(older).filter((s) => !have.has(s.key)), ...held];
}

/**
 * Does a fresh page 1 connect to the held feed? It does when it is the whole history
 * (`nextBefore` null) or it returns a held session whose `lastAt` is UNCHANGED — a held session
 * whose `lastAt` moved proves nothing about where the page ends.
 */
export function overlaps(held: readonly FeedSession[], fresh: Pick<AgentHistoryPage, 'sessions' | 'nextBefore'>): boolean {
  if (fresh.nextBefore === null) return true;
  const byKey = new Map(held.map((s) => [s.key, s.lastAt]));
  return fresh.sessions.some((s) => byKey.get(s.key) === s.lastAt);
}

/**
 * Merge freshly read sessions (any order) into the held feed. Held sessions update IN PLACE; new
 * ones join the end (above the live conversation) in their own order; a session whose `lastAt`
 * moved (a late reply) moves to the end — unless `defer` (the reader is scrolled up), when it is
 * updated in place and listed in `deferred`, to move on their return to the bottom.
 */
export function mergeFresh(
  held: readonly FeedSession[],
  fresh: readonly FeedSession[],
  opts: { defer: boolean },
): { sessions: FeedSession[]; deferred: string[] } {
  const freshByKey = new Map(fresh.map((s) => [s.key, s]));
  const moved: FeedSession[] = [];
  const deferred: string[] = [];
  const out: FeedSession[] = [];
  for (const h of held) {
    const f = freshByKey.get(h.key);
    if (!f) { out.push(h); continue; }
    freshByKey.delete(h.key);
    if (f.lastAt === h.lastAt || Date.parse(f.lastAt) < Date.parse(h.lastAt)) { out.push(f); continue; }
    if (opts.defer) { out.push(f); deferred.push(f.key); continue; }
    moved.push(f);
  }
  const added = [...freshByKey.values(), ...moved].sort(cmp);
  return { sessions: [...out, ...added], deferred };
}

/** The deferred moves, applied (the reader came back to the bottom). */
export function applyDeferred(sessions: readonly FeedSession[], keys: readonly string[]): FeedSession[] {
  if (keys.length === 0) return [...sessions];
  const move = new Set(keys);
  const stay = sessions.filter((s) => !move.has(s.key));
  const go = sessions.filter((s) => move.has(s.key)).sort(cmp);
  return [...stay, ...go];
}

/** How many unread MESSAGES the loaded sessions hold (the feed's counting: each unread run counts
 *  its posts, at least one). */
export function loadedUnread(sessions: readonly FeedSession[]): number {
  let n = 0;
  for (const s of sessions) {
    if (!s.unread) continue;
    n += Math.max(1, s.rows.filter((r) => r.kind === 'agent').length);
  }
  return n;
}

/**
 * The unread divider for one open: before the OLDEST unread session loaded, counting the badge's
 * number. When the loaded pages do not reach every unread message (`hasMore`), it sits at the top
 * of what is loaded and says "more above".
 */
export function dividerFor(
  sessions: readonly FeedSession[],
  unreadCount: number,
  hasMore: boolean,
): { key: string; count: number; moreAbove: boolean } | null {
  if (unreadCount <= 0 || sessions.length === 0) return null;
  const first = sessions.find((s) => s.unread);
  const moreAbove = hasMore && loadedUnread(sessions) < unreadCount;
  if (moreAbove) return { key: sessions[0].key, count: unreadCount, moreAbove: true };
  if (!first) return null;
  return { key: first.key, count: unreadCount, moreAbove: false };
}

/** A posted file list, as path chips (Chat draws a backticked path as one). */
function withFiles(text: string, files: readonly string[] | undefined): string {
  if (!files || files.length === 0) return text;
  return [text, files.map((f) => `- \`${f}\``).join('\n')].filter(Boolean).join('\n\n');
}

function metaOf(s: FeedSession): FeedMeta {
  const sep = s.key.indexOf('::');
  return {
    sessionKey: s.key,
    sessionKind: s.kind,
    title: s.title,
    status: s.status,
    source: s.source,
    newestId: s.newestId,
    runId: s.kind === 'run' && sep > 0 ? s.key.slice(sep + 2) : null,
    startedAt: s.startedAt,
    lastAt: s.lastAt,
    durationMs: s.durationMs,
    unread: s.unread,
    ...(s.missing ? { missing: true } : {}),
    ...(s.truncated ? { truncated: true } : {}),
    readOnly: true,
  };
}

/** Rows the pane draws. Item ids are derived from entry ids (`f:<id>`), so merges keep rows. */
export function toFeedItems(sessions: readonly FeedSession[]): FeedItem[] {
  const out: FeedItem[] = [];
  for (const s of sessions) {
    const meta = metaOf(s);
    if (s.rows.length === 0) {
      out.push({ kind: 'text', id: `f:${s.key}#none`, index: 0, text: '', done: true, ts: Date.parse(s.lastAt) || 0, feed: { ...meta, empty: true } });
      continue;
    }
    for (const r of s.rows) {
      const ts = Date.parse(r.at) || 0;
      const id = `f:${s.key}:${r.id}`;
      if (r.kind === 'user') out.push({ kind: 'user', id, text: r.text, ts, feed: meta });
      else out.push({ kind: 'text', id, index: 0, text: withFiles(stripActionFences(r.text), r.files), done: true, ts, feed: meta });
    }
  }
  return out;
}
