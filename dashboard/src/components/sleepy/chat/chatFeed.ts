import type { ReactNode } from 'react';
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
  status: 'ok' | 'failed' | 'skipped' | 'running' | 'waiting' | 'stopped' | null;
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
  /** A session with no row (a run still working with nothing to show but its indicator): one
   *  placeholder carries its boundary. */
  empty?: boolean;
  /** This row is a silent run's body, not a post: what it is (`HistoryRow.origin`). */
  origin?: 'answer' | 'failure' | 'note';
  /** The run published a document here. */
  hasDocument?: boolean;
  /** That document as a tile (brain path, name, opening sentence): it opens in the side file panel. */
  document?: { path: string; name: string; head?: string };
  /** The run's session, from this machine's own records: its steps can be opened. */
  claudeId?: string;
  /** A reply can resume that session. */
  resumable?: boolean;
  /** The run started on another machine. */
  elsewhere?: boolean;
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
  /** Under a routine run still in flight: Chat's working indicator says it. */
  working: string;
  /** The pane's own words for a body row that only states the run's status; null keeps the row's. */
  note: (meta: FeedMeta) => string | null;
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
  /** Drawn under a run's last row: its steps, report and Continue. The host owns what is open;
   *  `ctx.openFile` is the pane's own file opener (a report's path chips). */
  runFoot?: (meta: FeedMeta, ctx?: { openFile: (path: string) => void }) => ReactNode;
  /** A card in a routine run's row finished (a command the owner ran): its report goes back
   *  into THAT run — a reply in its thread, which resumes its session. Absent: not drawn. */
  onRunReport?: (meta: FeedMeta, text: string) => void;
  onDividerScrolled: () => void;
  /** The reader is at the bottom (true) or scrolled up (false): deferred moves wait for true. */
  onPinned: (pinned: boolean) => void;
  /** A member's Super page (owner 2026-11-08): its conversation is one long resumed session, so a
   *  run that happened during it is drawn BETWEEN its messages, by time, and a run in flight at its
   *  end; only runs older than the conversation stay at the head (`splitFeedAt`). Absent: every
   *  session at the head, as on the AI Team stage. */
  interleave?: boolean;
}

/** Where a session sits in time against the conversation: when it last moved, and a run still in
 *  flight at the very end (it is live, so it is the newest thing on the page). */
export function feedAnchorMs(meta: Pick<FeedMeta, 'sessionKind' | 'status' | 'lastAt'>): number {
  if (meta.sessionKind === 'run' && meta.status === 'running') return Number.POSITIVE_INFINITY;
  const t = Date.parse(meta.lastAt);
  return Number.isNaN(t) ? 0 : t;
}

/** A chat row's time, epoch ms: its `ts`, a tool step's `startedAt`; 0 means "no time". */
export function itemTimeMs(it: object | null | undefined): number {
  const r = (it ?? {}) as { ts?: unknown; startedAt?: unknown };
  const t = typeof r.ts === 'number' ? r.ts : typeof r.startedAt === 'number' ? r.startedAt : 0;
  return t > 0 ? t : 0;
}

/** The first known time of the conversation, or null with none. */
export function firstKnownTs(...lists: ReadonlyArray<ReadonlyArray<object>>): number | null {
  for (const list of lists) for (const it of list) { const t = itemTimeMs(it); if (t > 0) return t; }
  return null;
}

/**
 * An interleaved feed split at the conversation's start: whole sessions older than it stay at the
 * head (in the window's index space, paged as before); the rest are drawn inside the conversation.
 * No conversation yet (`startMs` null): everything is the head.
 */
export function splitFeedAt(items: readonly FeedItem[], startMs: number | null): { head: FeedItem[]; inline: FeedItem[] } {
  if (startMs === null) return { head: [...items], inline: [] };
  const head: FeedItem[] = [];
  const inline: FeedItem[] = [];
  for (const it of items) (feedAnchorMs(it.feed) <= startMs ? head : inline).push(it);
  return { head, inline };
}

/** One session's rows in `items`: `[from, to)`. */
export interface FeedGroup { key: string; from: number; to: number; anchor: number }

/** The sessions of a feed list, in order (a session's rows are contiguous). */
export function feedGroups(items: readonly FeedItem[]): FeedGroup[] {
  const out: FeedGroup[] = [];
  for (let i = 0; i < items.length; i++) {
    const key = items[i].feed.sessionKey;
    const last = out[out.length - 1];
    if (last && last.key === key) { last.to = i + 1; continue; }
    out.push({ key, from: i, to: i + 1, anchor: feedAnchorMs(items[i].feed) });
  }
  return out;
}

/**
 * Where each inline session goes among the conversation's rows: the index of the first row that
 * came after it, or `rowTimes.length` (after the last row). A row with no time (0) takes the
 * time of the row before it, so an untimed row never pulls a session above timed ones.
 */
export function inlinePlacement(groups: readonly Pick<FeedGroup, 'anchor'>[], rowTimes: readonly number[]): number[] {
  const times: number[] = [];
  let prev = 0;
  for (const t of rowTimes) { prev = t > 0 ? t : prev; times.push(prev); }
  return groups.map((g) => {
    if (g.anchor === Number.POSITIVE_INFINITY) return times.length;
    const at = times.findIndex((t) => t > g.anchor);
    return at < 0 ? times.length : at;
  });
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

/**
 * A routine run still in flight: its session's end carries Chat's working indicator, so the
 * stage says what the team list says ("Working · 1m 30s") instead of ending on a still prompt
 * above the live "New conversation" line.
 */
export function feedRunWorking(meta: FeedMeta, marks: Pick<FeedMarks, 'last'>): boolean {
  return marks.last && meta.sessionKind === 'run' && meta.status === 'running';
}

/** A run's document path (brain-relative, as the feeds carry it) as the chat pane opens files:
 *  project-relative, so the side file panel reads it from the brain folder. */
export function chatFilePath(brainPath: string): string {
  return brainPath.startsWith('_dream_context/') ? brainPath : `_dream_context/${brainPath}`;
}

/** The first two lines of a document worth showing on its tile: headings lose their marks. */
export function documentHead(text: string | null | undefined): string | undefined {
  const lines = (text ?? '').split('\n').map((l) => l.replace(/^#{1,6}\s+/, '').replace(/[*_`>]/g, '').trim()).filter(Boolean);
  const head = lines.slice(0, 2).join(' ').slice(0, 180);
  return head || undefined;
}

/**
 * What stands under one run: its steps (a session on this machine) and, when the run published a
 * document, that document as a tile that opens in the side file panel. A run with no document
 * shows nothing extra (owner 2026-11-08: no "Full report" link, no inline expand).
 */
export function runFootOf(meta: FeedMeta): { steps: boolean; document: { path: string; name: string; head?: string } | null } {
  return { steps: !!meta.claudeId, document: meta.document ?? null };
}

/** A running run shows its steps by itself, until the owner closes them. */
export function stepsOpen(meta: FeedMeta, opened: ReadonlySet<string>, closed: ReadonlySet<string>): boolean {
  if (!meta.claudeId) return false;
  return opened.has(meta.sessionKey) || (meta.status === 'running' && !closed.has(meta.sessionKey));
}

/** Any run in the feed still in flight: the host re-reads the history often until it ends. */
export function feedHasRunning(items: readonly FeedItem[]): boolean {
  return items.some((it) => it.feed.sessionKind === 'run' && it.feed.status === 'running');
}

/**
 * Is the live conversation's line drawn under the feed? Only once that conversation HAS
 * something: an empty one is said by the composer's placeholder ("New conversation with …"),
 * so a finished run is never followed by a line that reads as if something just happened.
 */
export function liveDividerShown(o: { loading: boolean; failed: boolean; feedLen: number; liveEmpty: boolean }): boolean {
  return !o.loading && (o.feedLen > 0 || o.failed) && !o.liveEmpty;
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
