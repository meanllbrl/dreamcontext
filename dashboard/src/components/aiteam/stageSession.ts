import { createChatSession, type ChatSession } from '../sleepy/chatSession';
import { bindChatAgent, bindStageChat } from '../../lib/chatAgentBinding';
import { DEFAULT_CHAT_MODE } from '../../lib/chatModes';
import { ApiClient } from '../../api/client';
import { fetchAgentHistory, type AgentHistoryPage } from '../../hooks/useAgents';
import { readScratch } from '../sleepy/chat/composerScratch';
import type { FeedItem, FeedMeta } from '../sleepy/chat/chatFeed';
import {
  applyDeferred, dividerFor, loadedUnread, mergeFresh, overlaps, prependOlder, readingOrder, toFeedItems,
  type FeedSession,
} from './agentHistory';

/**
 * One live conversation per agent STAGE (vault + agent), kept across re-renders and across the
 * views that unmount the stage without changing the pick (the activity view, the org chart, the
 * phone's list), like a whiteboard card's (`boardAgentScratch.ts`): the stage's chat card is a
 * host the session's container is moved into, never the owner of the process.
 *
 * WHICH CONVERSATION (AI Team history, owner 2026-10-27): every OPEN of the agent — picking it in
 * the roster, Talk to it, a link landing on it — starts a NEW Claude session, unless the entry
 * still holds one (a turn running, a card waiting, a draft typed when the owner looked away), which
 * then CONTINUES. Deselecting an IDLE stage ends its session; its talk becomes history. Every run
 * and every talk stays its own session; the pane shows them all as one flow through the FEED this
 * entry holds beside the session (outside it, so a seed, a replay, a rewind or a respawn never
 * touches it).
 *
 * The FEED belongs to ONE OPEN: every open reads page 1 fresh; a remount within the open keeps it
 * and re-reads only when the roster feed's newest id moved. The unread divider is decided once per
 * open, after that open's first read, and stays where it was pinned.
 */

interface FeedState {
  sessions: FeedSession[];
  items: FeedItem[];
  nextBefore: string | null;
  /** Page 1 of this open has landed. */
  loaded: boolean;
  failed: boolean;
  olderLoading: boolean;
  unreadCount: number;
  /** The roster feed's newest id for this agent when the last read was issued. */
  newestId: string | null;
  /** Late replies whose move to the end waits for the reader to come back to the bottom. */
  deferred: string[];
  /** A replace (a re-read that did not connect) waiting for the reader at the bottom. */
  pendingReplace: { sessions: FeedSession[]; nextBefore: string | null } | null;
  pinned: boolean;
  /** Bumped by a replace: older pages issued against the old feed are ignored. */
  version: number;
  /** Page-1 reads, in issue order; an older response than the last applied is ignored. */
  seq: number;
  appliedSeq: number;
  divider: { key: string; count: number; moreAbove: boolean } | null;
  decided: boolean;
  dividerScrolled: boolean;
  /** The live boundary under the feed. */
  live: { kind: 'new' | 'continuing'; startedAt: number };
  /** Read marks already sent this open, by session key. */
  /** Read marks already sent this open: session key → the newest id sent (a run that posts again
   *  after it was seen sends its new newest id). */
  seen: Map<string, string>;
}

interface Entry {
  session: ChatSession | null;
  /** The autonomy level the session was opened at: the server decided its permission mode from it. */
  level: string | null;
  /** When the held session started (its live boundary says "Continuing · started HH:MM"). */
  startedAt: number;
  feed: FeedState | null;
  listeners: Set<() => void>;
}

const entries = new Map<string, Entry>();
/** Per agent, outliving the entry (an unsubscribe may delete it): every read carries it, and a
 *  response from another generation is ignored. Bumped by an OPEN, a page leave, a delete. */
const generations = new Map<string, number>();
/** The session a deselect just ended, per agent, when it had a turn: the next open's page 1 is
 *  read once more after 2 s if its talk is missing (its socket may still have been closing). */
const justDisposed = new Map<string, string>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

const keyOf = (vault: string, agent: string): string => `${vault}\u0000${agent}`;
const genOf = (key: string): number => generations.get(key) ?? 0;
function bumpGen(key: string): void {
  generations.set(key, genOf(key) + 1);
  const t = retryTimers.get(key);
  if (t) { clearTimeout(t); retryTimers.delete(key); }
}

/** Tests replace the history reader; the app reads the route. */
let readHistory = (vault: string, agent: string, opts: { before?: string | null; exclude?: string | null }): Promise<AgentHistoryPage> =>
  fetchAgentHistory(new ApiClient(vault || null), agent, opts);
let postRead = (vault: string, slug: string, upToId: string): Promise<unknown> =>
  new ApiClient(vault || null).post('/automations/threads/read', { slug, upToId });
export function __setStageHistoryIo(io: {
  read?: typeof readHistory;
  post?: typeof postRead;
} | null): void {
  readHistory = io?.read ?? ((vault, agent, opts) => fetchAgentHistory(new ApiClient(vault || null), agent, opts));
  postRead = io?.post ?? ((vault, slug, upToId) => new ApiClient(vault || null).post('/automations/threads/read', { slug, upToId }));
}
export function __resetStageSessionsForTests(): void {
  for (const t of retryTimers.values()) clearTimeout(t);
  entries.clear(); generations.clear(); justDisposed.clear(); retryTimers.clear();
}

function entryFor(vault: string, agent: string): Entry {
  const key = keyOf(vault, agent);
  let e = entries.get(key);
  if (!e) {
    e = { session: null, level: null, startedAt: 0, feed: null, listeners: new Set() };
    entries.set(key, e);
  }
  return e;
}

function notify(e: Entry): void { for (const fn of [...e.listeners]) fn(); }

/** The stage's live session, or null before it was opened. */
export function peekStageSession(vault: string, agent: string): ChatSession | null {
  return entries.get(keyOf(vault, agent))?.session ?? null;
}

/** The level the live session was opened at, or null. */
export function stageSessionLevel(vault: string, agent: string): string | null {
  return entries.get(keyOf(vault, agent))?.level ?? null;
}

/** Hear the stage session change (opened, replaced, busy, asking, its feed). Returns the unsubscribe. */
export function subscribeStageSession(vault: string, agent: string, fn: () => void): () => void {
  const e = entryFor(vault, agent);
  e.listeners.add(fn);
  return () => {
    e.listeners.delete(fn);
    if (!e.session && !e.feed && e.listeners.size === 0) entries.delete(keyOf(vault, agent));
  };
}

/**
 * Open the stage's session: `continue` keeps the live one, else starts a NEW conversation (a fresh
 * id, never `--resume`); `resume` respawns the same conversation (a level change, the Session
 * ended banner) — same id, so the feed and the live boundary stay.
 */
export function openStageSession(
  o: { vault: string; agent: string; model: string; effort: string; level: string },
  how: 'continue' | 'resume' = 'continue',
): ChatSession {
  const e = entryFor(o.vault, o.agent);
  if (how === 'continue' && e.session) return e.session;
  const previous = e.session;
  const id = previous?.claudeId ?? crypto.randomUUID();
  const resume = !!previous;
  bindChatAgent(id, o.agent);
  bindStageChat(id);
  previous?.dispose();
  const cs = createChatSession(o.vault, false, () => notify(e), id, resume, o.model, o.effort, '', '', false, DEFAULT_CHAT_MODE, '', '', null, '');
  e.session = cs;
  e.level = o.level;
  if (!previous) e.startedAt = Date.now();
  notify(e);
  return cs;
}

/** Nothing in the session would be lost by ending it: no turn or background work, no card
 *  waiting, nothing typed or staged in the composer. */
export function stageSessionIdle(s: ChatSession): boolean {
  if (s.hasLiveWork()) return false;
  const conv = s.getModel();
  if (conv.pending.length > 0) return false;
  if (conv.draft.trim()) return false;
  const scratch = readScratch(s.scratchId || s.claudeId);
  return scratch.attachments.length === 0 && !scratch.quote;
}

/**
 * The owner picked another teammate: an IDLE stage session ends (its talk becomes history and the
 * next open starts a new one); anything else stays held, exactly as it was, and continues.
 */
export function deselectStage(vault: string, agent: string): void {
  const key = keyOf(vault, agent);
  const e = entries.get(key);
  if (!e?.session || !stageSessionIdle(e.session)) return;
  const hadTurn = e.session.getModel().items.some((it) => it.kind === 'user');
  if (hadTurn) justDisposed.set(key, e.session.claudeId); else justDisposed.delete(key);
  e.session.dispose();
  e.session = null;
  e.level = null;
  // The feed belonged to that open. Without one the stage waits for the next OPEN before it starts
  // a session (React runs the stage's effects before the page's), so the open decides "new".
  e.feed = null;
  notify(e);
}

/** The agent was deleted: its kept session ends and its entry (feed included) goes. */
export function forgetStage(vault: string, agent: string): void {
  const key = keyOf(vault, agent);
  bumpGen(key);
  justDisposed.delete(key);
  const e = entries.get(key);
  if (!e) return;
  e.session?.dispose();
  e.session = null;
  e.feed = null;
  notify(e);
  if (e.listeners.size === 0) entries.delete(key);
}

/** End every stage session of `vault` (or of every vault) — leaving the AI Team page. */
export function dropStageSessions(vault?: string): void {
  for (const [key, e] of [...entries]) {
    if (vault !== undefined && !key.startsWith(`${vault}\u0000`)) continue;
    bumpGen(key);
    justDisposed.delete(key);
    e.session?.dispose();
    e.session = null;
    e.level = null;
    e.feed = null;
    notify(e);
    if (e.listeners.size === 0) entries.delete(key);
  }
}

// ─── The feed ───────────────────────────────────────────────────────────────────────

/** The feed as the pane reads it (identity changes only when it changes). */
export interface StageFeedSnapshot {
  items: readonly FeedItem[];
  hasMore: boolean;
  loading: boolean;
  failed: boolean;
  olderLoading: boolean;
  divider: FeedState['divider'];
  scrollToDivider: boolean;
  live: FeedState['live'];
  sessions: readonly FeedSession[];
}

const snapshots = new WeakMap<FeedState, { at: FeedState; snap: StageFeedSnapshot }>();

export function stageFeed(vault: string, agent: string): StageFeedSnapshot | null {
  const f = entries.get(keyOf(vault, agent))?.feed ?? null;
  if (!f) return null;
  const hit = snapshots.get(f);
  if (hit) return hit.snap;
  const snap: StageFeedSnapshot = {
    items: f.items,
    hasMore: f.nextBefore !== null,
    loading: !f.loaded && !f.failed,
    failed: f.failed && !f.loaded,
    olderLoading: f.olderLoading,
    divider: f.divider,
    scrollToDivider: !!f.divider && !f.dividerScrolled,
    live: f.live,
    sessions: f.sessions,
  };
  snapshots.set(f, { at: f, snap });
  return snap;
}

/** Replace the feed state with a changed copy (new identity ⇒ a new snapshot) and tell the pane. */
function setFeed(e: Entry, next: FeedState): void {
  e.feed = next;
  notify(e);
}
function changed(f: FeedState, patch: Partial<FeedState>): FeedState {
  const next = { ...f, ...patch };
  if (patch.sessions) next.items = toFeedItems(patch.sessions);
  return next;
}

/** Drop the live session's own talk, whatever the server knew when it answered. */
function withoutSelf(page: AgentHistoryPage, selfId: string | null): AgentHistoryPage {
  if (!selfId) return page;
  return { ...page, sessions: page.sessions.filter((s) => s.key !== `talk::${selfId}`) };
}

/** How many extra pages an open (or a re-read that does not connect) may walk. */
const EXTRA_PAGES = 3;
const FIRST_READ_RETRIES = [2000, 5000];

/**
 * An OPEN of the agent: the feed this entry held is discarded and page 1 is read fresh; the
 * divider is decided again once it lands. `newestId` = the roster feed's newest id now.
 */
export function beginStageOpen(vault: string, agent: string, newestId: string | null): void {
  const key = keyOf(vault, agent);
  bumpGen(key);
  const e = entryFor(vault, agent);
  const feed: FeedState = {
    sessions: [], items: [], nextBefore: null, loaded: false, failed: false, olderLoading: false,
    unreadCount: 0, newestId, deferred: [], pendingReplace: null, pinned: true, version: 0, seq: 0, appliedSeq: 0,
    divider: null, decided: false, dividerScrolled: false,
    live: e.session ? { kind: 'continuing', startedAt: e.startedAt } : { kind: 'new', startedAt: Date.now() },
    seen: new Map(),
  };
  setFeed(e, feed);
  void readFirst(vault, agent, genOf(key), 0);
}

/**
 * The stage mounted again within the same open (back from the activity view, the phone's list, a
 * respawn): the feed is kept; page 1 is re-read only when the roster's newest id moved.
 */
export function remountStageFeed(vault: string, agent: string, newestId: string | null): void {
  const e = entries.get(keyOf(vault, agent));
  // No feed: the page has not opened this agent yet (its open runs after the stage mounts).
  if (!e?.feed || !e.feed.loaded || e.feed.newestId === newestId) return;
  void refreshStageFeed(vault, agent, newestId);
}

async function readFirst(vault: string, agent: string, gen: number, attempt: number): Promise<void> {
  const key = keyOf(vault, agent);
  const e0 = entries.get(key);
  if (!e0?.feed) return;
  const selfId = e0.session?.claudeId ?? null;
  const seq = e0.feed.seq + 1;
  e0.feed = { ...e0.feed, seq };
  let page: AgentHistoryPage;
  const pages: AgentHistoryPage[] = [];
  try {
    page = withoutSelf(await readHistory(vault, agent, { exclude: selfId }), entries.get(key)?.session?.claudeId ?? selfId);
    pages.push(page);
    // The divider waits for the unread it names: up to 3 more pages until the loaded sessions
    // hold every unread message the badge counts.
    let all = readingOrder(page);
    let next = page.nextBefore;
    for (let i = 0; i < EXTRA_PAGES && next && loadedUnread(all) < page.unreadCount; i++) {
      const older = await readHistory(vault, agent, { before: next, exclude: selfId });
      if (genOf(key) !== gen) return;
      all = prependOlder(all, older);
      next = older.nextBefore;
    }
    const e = entries.get(key);
    if (!e?.feed || genOf(key) !== gen || seq <= e.feed.appliedSeq) return;
    const divider = e.feed.decided ? e.feed.divider : dividerFor(all, page.unreadCount, next !== null);
    setFeed(e, changed(e.feed, {
      sessions: all, nextBefore: next, loaded: true, failed: false, unreadCount: page.unreadCount,
      appliedSeq: seq, divider, decided: true,
    }));
    // A stage the owner just left, that had a turn: its talk joins on the next read if this one
    // was too early to see it (its socket may still have been closing).
    const gone = justDisposed.get(key);
    justDisposed.delete(key);
    if (gone && !all.some((s) => s.key === `talk::${gone}`)) {
      const t = setTimeout(() => {
        retryTimers.delete(key);
        if (genOf(key) === gen) void refreshStageFeed(vault, agent, entries.get(key)?.feed?.newestId ?? null);
      }, 2000);
      retryTimers.set(key, t);
    }
  } catch {
    if (genOf(key) !== gen) return;
    const delay = FIRST_READ_RETRIES[attempt];
    const e = entries.get(key);
    if (!e?.feed) return;
    if (delay === undefined) { setFeed(e, changed(e.feed, { failed: true })); return; }
    const t = setTimeout(() => {
      retryTimers.delete(key);
      if (genOf(key) === gen) void readFirst(vault, agent, gen, attempt + 1);
    }, delay);
    retryTimers.set(key, t);
  }
}

/** The error row's Retry. */
export function retryStageFeed(vault: string, agent: string): void {
  const key = keyOf(vault, agent);
  const e = entries.get(key);
  if (!e?.feed) return;
  setFeed(e, changed(e.feed, { failed: false }));
  void readFirst(vault, agent, genOf(key), 0);
}

/**
 * A live re-read of page 1 (the roster's newest id moved, the minute poll): merged by session key
 * and entry id when it connects to the held feed, walking up to 3 older pages to connect; only a
 * walk that fails REPLACES the feed — and while the reader is scrolled up, the replace waits.
 */
export async function refreshStageFeed(vault: string, agent: string, newestId: string | null): Promise<void> {
  const key = keyOf(vault, agent);
  const gen = genOf(key);
  const e0 = entries.get(key);
  if (!e0?.feed || !e0.feed.loaded) return;
  const selfId = e0.session?.claudeId ?? null;
  const seq = e0.feed.seq + 1;
  e0.feed = { ...e0.feed, seq, newestId };
  try {
    const first = withoutSelf(await readHistory(vault, agent, { exclude: selfId }), selfId);
    let fresh = readingOrder(first);
    let next = first.nextBefore;
    const held = entries.get(key)?.feed?.sessions ?? [];
    let connected = overlaps(held, first);
    for (let i = 0; i < EXTRA_PAGES && !connected && next; i++) {
      const older = await readHistory(vault, agent, { before: next, exclude: selfId });
      if (genOf(key) !== gen) return;
      fresh = prependOlder(fresh, older);
      next = older.nextBefore;
      connected = overlaps(held, { sessions: older.sessions, nextBefore: older.nextBefore });
    }
    const e = entries.get(key);
    if (!e?.feed || genOf(key) !== gen || seq <= e.feed.appliedSeq) return;
    const f = e.feed;
    if (connected) {
      const merged = mergeFresh(f.sessions, fresh, { defer: !f.pinned });
      setFeed(e, changed(f, {
        sessions: merged.sessions, unreadCount: first.unreadCount, appliedSeq: seq,
        deferred: [...new Set([...f.deferred, ...merged.deferred])],
      }));
      return;
    }
    const replace = { sessions: fresh, nextBefore: next };
    if (!f.pinned) { setFeed(e, changed(f, { pendingReplace: replace, appliedSeq: seq })); return; }
    setFeed(e, replaced(f, replace, first.unreadCount, seq));
  } catch {
    // A failed live re-read changes nothing; the next one tries again.
  }
}

function replaced(f: FeedState, r: { sessions: FeedSession[]; nextBefore: string | null }, unreadCount: number, seq: number): FeedState {
  // The divider keeps its place when its session is still held, else goes before the first unread.
  const keep = f.divider && r.sessions.some((s) => s.key === f.divider!.key);
  return changed(f, {
    sessions: r.sessions, nextBefore: r.nextBefore, version: f.version + 1, appliedSeq: Math.max(seq, f.appliedSeq),
    unreadCount, deferred: [], pendingReplace: null,
    divider: keep ? f.divider : dividerFor(r.sessions, unreadCount, r.nextBefore !== null),
  });
}

/** Scrolling up past the oldest loaded session: the next page, one request at a time. */
export async function loadOlderStageFeed(vault: string, agent: string): Promise<void> {
  const key = keyOf(vault, agent);
  const gen = genOf(key);
  const e0 = entries.get(key);
  const f0 = e0?.feed;
  if (!e0 || !f0 || !f0.loaded || f0.olderLoading || !f0.nextBefore) return;
  const version = f0.version;
  const selfId = e0.session?.claudeId ?? null;
  setFeed(e0, changed(f0, { olderLoading: true }));
  let older: AgentHistoryPage | null = null;
  try { older = withoutSelf(await readHistory(vault, agent, { before: f0.nextBefore, exclude: selfId }), selfId); } catch { older = null; }
  const e = entries.get(key);
  if (!e?.feed) return;
  if (!older || genOf(key) !== gen || e.feed.version !== version) {
    setFeed(e, changed(e.feed, { olderLoading: false }));
    return;
  }
  setFeed(e, changed(e.feed, { sessions: prependOlder(e.feed.sessions, older), nextBefore: older.nextBefore, olderLoading: false }));
}

/** A run session's last row has been on screen: its slug's read mark moves to its newest entry. */
export function markStageSeen(vault: string, agent: string, meta: FeedMeta): void {
  const e = entries.get(keyOf(vault, agent));
  const f = e?.feed;
  if (!e || !f || meta.sessionKind !== 'run' || !meta.unread || !meta.newestId) return;
  const sent = f.seen.get(meta.sessionKey);
  if (sent !== undefined && sent >= meta.newestId) return;
  f.seen.set(meta.sessionKey, meta.newestId);
  const upToId = meta.newestId;
  void postRead(vault, meta.source, upToId).catch(() => {
    if (f.seen.get(meta.sessionKey) === upToId) {
      if (sent === undefined) f.seen.delete(meta.sessionKey); else f.seen.set(meta.sessionKey, sent);
    }
  });
  // The read mark is one monotonic id per slug: every older run of that slug is read with it.
  const upTo = meta.newestId;
  const sessions = f.sessions.map((s) => (s.unread && s.source === meta.source && (s.newestId ?? '') <= upTo ? { ...s, unread: false } : s));
  setFeed(e, changed(f, { sessions }));
}

/** The reader is at the bottom again: deferred moves and a waiting replace apply now. */
export function setStageFeedPinned(vault: string, agent: string, pinned: boolean): void {
  const e = entries.get(keyOf(vault, agent));
  const f = e?.feed;
  if (!e || !f || f.pinned === pinned) return;
  if (!pinned) { e.feed = { ...f, pinned }; return; }
  let next: FeedState = { ...f, pinned };
  if (f.pendingReplace) next = replaced(next, f.pendingReplace, f.unreadCount, f.appliedSeq);
  else if (f.deferred.length) next = changed(next, { sessions: applyDeferred(f.sessions, f.deferred), deferred: [] });
  else { e.feed = next; return; }
  setFeed(e, next);
}

/** The divider was scrolled to the top once this open: a remount opens pinned to the bottom. */
export function markStageDividerScrolled(vault: string, agent: string): void {
  const e = entries.get(keyOf(vault, agent));
  if (e?.feed && !e.feed.dividerScrolled) setFeed(e, { ...e.feed, dividerScrolled: true });
}
