import type { ChatTextItem, ChatUserItem } from '../chatSession';

/**
 * THE FEED SEGMENT of a chat pane: an agent's PAST sessions (its routines' runs, its earlier
 * talks with the owner) drawn above its live conversation, in the same pane, through the same
 * rows and the same window (AI Team history, owner 2026-10-27: "one WhatsApp-like flow").
 *
 * Every past session stays its own Claude session; the feed only READS them. It lives outside
 * the ChatSession (the AI Team's stage entry holds it), so nothing a session does — a seed, a
 * reconnect replay, a rewind, a respawn — touches it. The pane takes it as a prop and puts it at
 * the head of its window's index space: `feed ++ history ++ items`. No prop = a Chat tab exactly
 * as before.
 *
 * Pure: types and the small decisions the pane makes about the feed, unit-tested without a DOM.
 */

export interface FeedMeta {
  /** `<slug>::<runId>` for a run, `talk::<claudeId>` for a talk. */
  sessionKey: string;
  sessionKind: 'run' | 'talk';
  /** A run's routine title; a talk's agent name. */
  title: string;
  status: 'ok' | 'failed' | 'skipped' | 'running' | null;
  /** The thread slug a run was posted in (its read mark is per slug). */
  source: string;
  /** The run's newest entry id (what its read mark advances to); null for a talk. */
  newestId: string | null;
  runId: string | null;
  startedAt: string;
  lastAt: string;
  durationMs: number | null;
  unread: boolean;
  /** A talk whose transcript is no longer on this machine. */
  missing?: boolean;
  /** A talk longer than the pane shows: its earlier part is in Chat. */
  truncated?: boolean;
  /** A session with no row (a run that posted nothing): one placeholder carries its boundary. */
  empty?: boolean;
  readOnly: true;
}

export type FeedItem = (ChatUserItem | ChatTextItem) & { feed: FeedMeta };

/** The words the feed draws, decided by the host (it owns the language). */
export interface FeedLabels {
  day: (iso: string) => string;
  boundary: (meta: FeedMeta) => string;
  divider: (count: number, moreAbove: boolean) => string;
  /** "New conversation · now" / "Continuing · started 12:30". */
  live: string;
  end: string;
  loading: string;
  error: string;
  retry: string;
  missing: string;
  truncated: string;
  loadingOlder: string;
}

export interface ChatFeed {
  items: readonly FeedItem[];
  /** More pages exist below the oldest loaded one. */
  hasMore: boolean;
  /** Page 1 of this open has not landed yet (a loading row, never the empty state). */
  loading: boolean;
  /** Page 1 failed after its retries: an error row with Retry. */
  failed: boolean;
  olderLoading: boolean;
  /** The pinned unread divider: before this session's boundary, decided once per open. */
  divider: { key: string; count: number; moreAbove: boolean } | null;
  /** Scroll the divider to the top once, on this open (a remount within the open does not). */
  scrollToDivider: boolean;
  labels: FeedLabels;
  onLoadOlder: () => void;
  onRetry: () => void;
  /** A run session's last row (or its boundary) has been on screen. */
  onSeen: (meta: FeedMeta) => void;
  onBoundary: (meta: FeedMeta) => void;
  onDividerScrolled: () => void;
  /** The reader is at the bottom (true) or scrolled up (false): deferred moves wait for true. */
  onPinned: (pinned: boolean) => void;
}

/** One row's marks: what the pane draws ABOVE row `i` of the feed. */
export interface FeedMarks {
  /** A day rule (local day start, epoch ms) — the session's day differs from the previous one's. */
  day: number | null;
  /** The session changed here: its boundary row. */
  boundary: boolean;
  /** The pinned unread divider sits here. */
  divider: boolean;
  /** The last row of its session (what the read observer watches). */
  last: boolean;
}

/** Local day start of an instant. */
export function localDay(iso: string): number {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 0;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * The marks above row `i`. A session's place (and so its day) is its LAST activity — the order the
 * feed is sorted in — so the day groups never run backwards. `from` is the first MOUNTED row: the
 * row there always carries its session's boundary and day, even mid-session, so a window edge
 * never leaves a row without its heading.
 */
export function feedMarks(items: readonly FeedItem[], i: number, dividerKey: string | null, from = 0): FeedMarks {
  const it = items[i];
  const prev = i > from ? items[i - 1] : null;
  const next = items[i + 1] ?? null;
  const key = it.feed.sessionKey;
  const boundary = !prev || prev.feed.sessionKey !== key;
  const day = localDay(it.feed.lastAt);
  return {
    day: !prev || (boundary && localDay(prev.feed.lastAt) !== day) ? day : null,
    boundary,
    divider: boundary && dividerKey === key,
    last: !next || next.feed.sessionKey !== key,
  };
}

/**
 * Where the window's head goes when the feed changes under it: by ROW ID, so a prepend, a merge
 * that inserts or removes rows above the reader, or a session moving to the end all keep the
 * same rows mounted (`firstShown` follows the row it pointed at). A head past the feed (inside the
 * live conversation) moves by the feed's net growth.
 */
export function feedShift(
  prevIds: readonly string[],
  nextIds: readonly string[],
  firstShown: number,
): number {
  if (firstShown >= prevIds.length) return Math.max(0, firstShown + nextIds.length - prevIds.length);
  // The first shown row, or the nearest later one that survived.
  for (let k = firstShown; k < prevIds.length; k++) {
    const at = nextIds.indexOf(prevIds[k]);
    if (at >= 0) return Math.max(0, at - (k - firstShown));
  }
  return nextIds.length;
}

/** A past post's `dream-actions` fences: buttons that answered a moment long gone are dropped from
 *  the read-only row (no "buttons not offered" notice either). */
export function stripActionFences(text: string): string {
  return text.replace(/```dream-actions[^\n]*\n[\s\S]*?```\n?/g, '').trim();
}
