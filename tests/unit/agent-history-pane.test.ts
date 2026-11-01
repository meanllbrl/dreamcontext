/**
 * AI Team history, wave 2: the stage pane draws an agent's whole history (pure parts).
 *
 *  - the window's index space `feed ++ history ++ items` (`splitWindow`), the reveal gate;
 *  - the feed's marks (day rules, one boundary per session, the pinned divider, the session end);
 *  - the head following its row when the feed changes (`feedShift`): prepend, merge, move;
 *  - the merge rules (in place, new at the end, a late reply moves, deferred while scrolled up);
 *  - the stage entry: a feed kept across a respawn, a held feed re-read with 12 new sessions, an
 *    ended long talk arriving while the reader is up, the divider pinned once per open, idle vs
 *    busy deselect.
 *
 * Fictional agents only.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// The stage opens real chat sessions in the app; here a small fake stands in (no socket).
const fakes = vi.hoisted(() => ({ made: [] as Array<Record<string, unknown>> }));
vi.mock('../../dashboard/src/components/sleepy/chatSession', () => ({
  createChatSession: (_vault: string, _bypass: boolean, _notify: () => void, id: string, resume: boolean) => {
    const conv = { pending: [] as unknown[], draft: '', items: [] as Array<{ kind: string }>, queued: [], subAgents: [] };
    const s = {
      claudeId: id, id, resume, busy: false, disposed: false, scratchId: undefined as string | undefined,
      getModel: () => conv, hasLiveWork: () => s.busy,
      dispose: () => { s.disposed = true; },
      conv,
    };
    fakes.made.push(s);
    return s;
  },
}));

import { splitWindow, shouldAutoReveal, nextFirstShown, WINDOW_MAX_ENTRIES } from '../../dashboard/src/components/sleepy/chat/chatEntities';
import { feedHasRunning, feedMarks, feedReportShown, feedRunWorking, feedShift, liveDividerShown, stripActionFences } from '../../dashboard/src/components/sleepy/chat/chatFeed';
import {
  applyDeferred, dividerFor, mergeFresh, overlaps, prependOlder, readingOrder, toFeedItems, type FeedSession,
} from '../../dashboard/src/components/aiteam/agentHistory';
import {
  __resetStageSessionsForTests, __setStageHistoryIo, beginStageOpen, deselectStage, loadOlderStageFeed,
  markStageDividerScrolled, markStageSeen, openStageSession, peekStageSession, refreshStageFeed,
  remountStageFeed, setStageFeedPinned, stageFeed,
} from '../../dashboard/src/components/aiteam/stageSession';
import type { AgentHistoryPage } from '../../dashboard/src/hooks/useAgents';

// ─── fixtures ───────────────────────────────────────────────────────────────────────

const T0 = Date.parse('2026-10-20T09:00:00.000Z');
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();

function run(slug: string, min: number, posts = 1, extra: Partial<FeedSession> = {}): FeedSession {
  const runId = iso(min);
  return {
    key: `${slug}::${runId}`, kind: 'run', source: slug, title: 'Daily', startedAt: runId, lastAt: iso(min + posts),
    status: 'ok', durationMs: 120_000, newestId: `id-${slug}-${min}-z`, unread: false,
    rows: Array.from({ length: posts }, (_, i) => ({ id: `id-${slug}-${min}-${i}`, kind: 'agent' as const, text: `post ${min}.${i}`, at: iso(min + i + 1) })),
    ...extra,
  };
}
function talk(id: string, min: number, rows = 2): FeedSession {
  return {
    key: `talk::${id}`, kind: 'talk', source: 'herodot', title: 'Herodot', startedAt: iso(min), lastAt: iso(min + rows),
    status: null, durationMs: null, newestId: null, unread: false,
    rows: Array.from({ length: rows }, (_, i) => ({ id: `${id}:${i}`, kind: i % 2 ? 'agent' as const : 'user' as const, text: `t${i}`, at: iso(min + i) })),
  };
}
/** A page as the server sends it: newest first. */
function page(sessions: FeedSession[], nextBefore: string | null = null, unreadCount = 0): AgentHistoryPage {
  return { sessions: [...sessions].sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt) || (a.key < b.key ? 1 : -1)), nextBefore, unreadCount };
}
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };

// ─── the window ─────────────────────────────────────────────────────────────────────

describe('splitWindow with a feed segment', () => {
  it('no feed is exactly the old split', () => {
    expect(splitWindow(10, 5, 3)).toMatchObject({ feedFrom: 0, showsFeed: false, historyFrom: 3, itemsFrom: 0, hiddenCount: 3 });
  });
  it('the head walks feed, then history, then items', () => {
    expect(splitWindow(10, 5, 4, 20)).toMatchObject({ feedFrom: 4, showsFeed: true, historyFrom: 0, itemsFrom: 0, showsHistory: true });
    expect(splitWindow(10, 5, 25, 20)).toMatchObject({ feedFrom: 20, showsFeed: false, historyFrom: 5, itemsFrom: 0 });
    expect(splitWindow(10, 5, 32, 20)).toMatchObject({ feedFrom: 20, historyFrom: 10, itemsFrom: 2, showsHistory: false });
  });
  it('the reveal gesture also asks when only older PAGES are left', () => {
    const m = { hiddenCount: 0, scrollTop: 0, userDriven: true, dragging: false, settled: true };
    expect(shouldAutoReveal(m)).toBe(false);
    expect(shouldAutoReveal({ ...m, feedHasMore: true })).toBe(true);
    expect(shouldAutoReveal({ ...m, feedHasMore: true, dragging: true })).toBe(false);
  });
  it('AC13: after 50 sessions loaded and a return to the bottom, the window mounts at most WINDOW_MAX_ENTRIES', () => {
    const sessions = Array.from({ length: 50 }, (_, i) => run('daily', i * 10, 12));
    const total = toFeedItems(sessions).length + 3;
    expect(total).toBeGreaterThan(WINDOW_MAX_ENTRIES);
    // Revealed all the way up, then pinned again: the head trims back to the tail.
    const head = nextFirstShown(0, { total, pinned: true, tailHead: total - 40 });
    expect(total - head).toBeLessThanOrEqual(WINDOW_MAX_ENTRIES);
  });
});

// ─── marks ──────────────────────────────────────────────────────────────────────────

describe('feedMarks', () => {
  const sessions = [run('daily', 0, 2), talk('a', 60), run('daily', 1440 * 1, 1), run('weekly', 1440 * 1 + 30, 0)];
  const items = toFeedItems(sessions);
  it('one boundary per session, a day rule when the local day changes, the session end, the divider', () => {
    const marks = items.map((_, i) => feedMarks(items, i, sessions[2].key));
    expect(marks.map((m) => m.boundary)).toEqual([true, false, true, false, true, true]);
    expect(marks.filter((m) => m.day !== null)).toHaveLength(2);
    expect(marks.map((m) => m.last)).toEqual([false, true, false, true, true, true]);
    expect(marks.map((m) => m.divider)).toEqual([false, false, false, false, true, false]);
  });
  it('the first MOUNTED row always carries its heading, even mid-session', () => {
    const m = feedMarks(items, 1, null, 1);
    expect(m.boundary).toBe(true);
    expect(m.day).not.toBeNull();
  });
  it('a post-less run gets one placeholder row that carries its boundary (and status)', () => {
    const empty = items[items.length - 1];
    expect(empty.feed.empty).toBe(true);
    expect(empty.feed.status).toBe('ok');
  });
});

describe('a routine run in flight (the list says Working, so the stage does too)', () => {
  it('the working row goes under the LAST row of a running run only, never a finished run or a talk', () => {
    const sessions = [run('daily', 0, 1), run('desk', 60, 2, { status: 'running', durationMs: null }), talk('b', 120)];
    const items = toFeedItems(sessions);
    const working = items.map((it, i) => feedRunWorking(it.feed, feedMarks(items, i, null)));
    expect(working).toEqual([false, false, true, false, false]);
    expect(feedHasRunning(items)).toBe(true);
  });
  it('a running run that has posted nothing yet still says it is working (its placeholder row)', () => {
    const items = toFeedItems([run('desk', 0, 0, { status: 'running', durationMs: null })]);
    expect(feedRunWorking(items[0].feed, feedMarks(items, 0, null))).toBe(true);
  });
  it('once the run ends, the working row leaves and the fast re-read stops', () => {
    const items = toFeedItems([run('desk', 0, 2)]);
    expect(items.some((it, i) => feedRunWorking(it.feed, feedMarks(items, i, null)))).toBe(false);
    expect(feedHasRunning(items)).toBe(false);
  });
});

describe('the live line under the history', () => {
  it('waits for the live conversation\'s first turn: an empty one is said by the composer', () => {
    expect(liveDividerShown({ loading: false, failed: false, feedLen: 3, liveEmpty: true })).toBe(false);
    expect(liveDividerShown({ loading: false, failed: false, feedLen: 3, liveEmpty: false })).toBe(true);
  });
  it('never while the history loads, nor with no history at all', () => {
    expect(liveDividerShown({ loading: true, failed: false, feedLen: 3, liveEmpty: false })).toBe(false);
    expect(liveDividerShown({ loading: false, failed: false, feedLen: 0, liveEmpty: false })).toBe(false);
    expect(liveDividerShown({ loading: false, failed: true, feedLen: 0, liveEmpty: false })).toBe(true);
  });
});

// ─── rows ───────────────────────────────────────────────────────────────────────────

describe('feed rows (AC11)', () => {
  it('read-only meta, files as path chips, past buttons dropped, ids from entry ids', () => {
    const s = run('daily', 0, 1);
    s.rows[0].text = 'Draft ready.\n\n```dream-actions\n[{"label":"Go","action":"ask","text":"go"}]\n```\n';
    s.rows[0].files = ['roadmap/acme-q4.md'];
    const [it] = toFeedItems([s]);
    expect(it.feed.readOnly).toBe(true);
    expect(it.text).not.toContain('dream-actions');
    expect(it.text).toContain('`roadmap/acme-q4.md`');
    expect(it.id).toBe(`f:${s.key}:${s.rows[0].id}`);
    expect(stripActionFences('a\n```dream-actions\n[]\n```\nb')).toBe('a\nb');
  });
});

// ─── the head follows its row ───────────────────────────────────────────────────────

describe('feedShift', () => {
  it('a prepend moves the head by the prepended rows: mounted rows do not change', () => {
    expect(feedShift(['a', 'b', 'c'], ['x', 'y', 'a', 'b', 'c'], 1)).toBe(3);
    expect(feedShift(['a', 'b', 'c'], ['x', 'y', 'a', 'b', 'c'], 0)).toBe(2);
  });
  it('a head inside the live conversation moves by the feed\'s net growth (a seed or replay changes nothing)', () => {
    expect(feedShift(['a', 'b'], ['a', 'b', 'c'], 5)).toBe(6);
    expect(feedShift(['a', 'b'], ['a', 'b'], 5)).toBe(5);
  });
  it('a session moved to the end: the head follows the row it pointed at', () => {
    expect(feedShift(['a1', 'a2', 'b1', 'c1'], ['b1', 'c1', 'a1', 'a2'], 2)).toBe(0);
  });
});

// ─── merge ──────────────────────────────────────────────────────────────────────────

describe('merge rules (AC15)', () => {
  it('a run that posts again updates in place; a new session joins the end', () => {
    const a = run('daily', 0, 1);
    const b = run('daily', 100, 1);
    const b2 = { ...b, rows: [...b.rows, { id: 'id-daily-100-1', kind: 'agent' as const, text: 'second', at: b.lastAt }] };
    const c = talk('c', 200);
    const out = mergeFresh([a, b], [b2, c], { defer: false });
    expect(out.sessions.map((s) => s.key)).toEqual([a.key, b.key, c.key]);
    expect(out.sessions[1].rows).toHaveLength(2);
  });
  it('a late reply moves its run to the end, or waits while the reader is up', () => {
    const a = run('daily', 0, 1);
    const b = run('daily', 100, 1);
    const a2 = { ...a, lastAt: iso(500) };
    expect(mergeFresh([a, b], [a2], { defer: false }).sessions.map((s) => s.key)).toEqual([b.key, a.key]);
    const held = mergeFresh([a, b], [a2], { defer: true });
    expect(held.sessions.map((s) => s.key)).toEqual([a.key, b.key]);
    expect(held.deferred).toEqual([a.key]);
    expect(applyDeferred(held.sessions, held.deferred).map((s) => s.key)).toEqual([b.key, a.key]);
  });
  it('overlap: the whole history, or a held session whose lastAt is unchanged', () => {
    const a = run('daily', 0);
    expect(overlaps([a], page([run('daily', 50)], null))).toBe(true);
    expect(overlaps([a], page([a, run('daily', 50)], 'x|y'))).toBe(true);
    expect(overlaps([a], page([{ ...a, lastAt: iso(900) }], 'x|y'))).toBe(false);
  });
  it('an older page prepends and skips what the feed holds', () => {
    const a = run('daily', 0);
    const b = run('daily', 50);
    expect(prependOlder([b], page([a, b])).map((s) => s.key)).toEqual([a.key, b.key]);
    expect(readingOrder(page([b, a])).map((s) => s.key)).toEqual([a.key, b.key]);
  });
  it('the divider: before the oldest unread loaded session, or "more above" at the top', () => {
    const a = run('daily', 0);
    const b = run('daily', 50, 1, { unread: true });
    const c = run('daily', 100, 2, { unread: true });
    expect(dividerFor([a, b, c], 3, false)).toEqual({ key: b.key, count: 3, moreAbove: false });
    expect(dividerFor([b, c], 9, true)).toEqual({ key: b.key, count: 9, moreAbove: true });
    expect(dividerFor([a], 0, false)).toBeNull();
  });
});

// ─── the stage entry ────────────────────────────────────────────────────────────────

describe('the stage entry (AC11, AC14, AC16)', () => {
  const V = 'acme';
  const A = 'herodot';
  let reads: Array<{ before?: string | null; exclude?: string | null }>;
  let respond: (opts: { before?: string | null }) => AgentHistoryPage;
  let posted: Array<[string, string]>;
  beforeEach(() => {
    __resetStageSessionsForTests();
    fakes.made.length = 0;
    reads = [];
    posted = [];
    respond = () => page([]);
    __setStageHistoryIo({
      read: async (_v, _a, opts) => { reads.push(opts); return respond(opts); },
      post: async (_v, slug, upTo) => { posted.push([slug, upTo]); },
    });
  });
  const open = () => openStageSession({ vault: V, agent: A, model: 'm', effort: 'e', level: 'balanced' });

  it('an OPEN reads page 1 fresh; a respawn of the same session keeps the feed with no refetch', async () => {
    respond = () => page([run('daily', 0), talk('t1', 30)]);
    beginStageOpen(V, A, 'n1');
    open();
    await flush();
    const snap = stageFeed(V, A)!;
    expect(snap.items.length).toBe(3);
    expect(snap.live.kind).toBe('new');
    const before = reads.length;
    const first = peekStageSession(V, A)!;
    openStageSession({ vault: V, agent: A, model: 'm', effort: 'e', level: 'ask' }, 'resume');
    expect(peekStageSession(V, A)!.claudeId).toBe(first.claudeId);
    remountStageFeed(V, A, 'n1');
    await flush();
    expect(reads.length).toBe(before);
    expect(stageFeed(V, A)!.items.length).toBe(3);
  });

  it('a new session per open: an IDLE deselect ends it, a BUSY or drafted one continues', async () => {
    beginStageOpen(V, A, null);
    const s1 = open();
    await flush();
    deselectStage(V, A);
    expect(peekStageSession(V, A)).toBeNull();
    // React runs the stage's effects BEFORE the page's open: with no feed left, the stage waits.
    expect(stageFeed(V, A)).toBeNull();
    beginStageOpen(V, A, null);
    const s2 = open();
    expect(s2.claudeId).not.toBe(s1.claudeId);
    expect(stageFeed(V, A)!.live.kind).toBe('new');
    (s2 as unknown as { busy: boolean }).busy = true;
    deselectStage(V, A);
    expect(peekStageSession(V, A)).toBe(s2);
    beginStageOpen(V, A, null);
    expect(stageFeed(V, A)!.live.kind).toBe('continuing');
    expect(open()).toBe(s2);
    (s2 as unknown as { busy: boolean }).busy = false;
    (s2 as unknown as { conv: { draft: string } }).conv.draft = 'half a thought';
    deselectStage(V, A);
    expect(peekStageSession(V, A)).toBe(s2);
    (s2 as unknown as { conv: { draft: string; pending: unknown[] } }).conv.draft = '';
    (s2 as unknown as { conv: { pending: unknown[] } }).conv.pending.push({ kind: 'permission' });
    deselectStage(V, A);
    expect(peekStageSession(V, A)).toBe(s2);
  });

  it('the live session is never in its own feed', async () => {
    beginStageOpen(V, A, null);
    const s = open();
    respond = () => page([talk(s.claudeId, 0), run('daily', 10)]);
    await refreshStageFeed(V, A, null);
    beginStageOpen(V, A, null);
    await flush();
    expect(stageFeed(V, A)!.sessions.map((x) => x.key)).toEqual([run('daily', 10).key]);
  });

  it('AC14: the divider is decided once per open (after its read, preloading for unread) and pinned; seen runs post read marks', async () => {
    const older = run('daily', 0, 1, { unread: true });
    const newer = run('daily', 100, 2, { unread: true });
    respond = (o) => (o.before ? page([older], null, 3) : page([newer], 'cursor|x', 3));
    beginStageOpen(V, A, null);
    open();
    await flush();
    let snap = stageFeed(V, A)!;
    expect(reads.map((r) => r.before ?? null)).toEqual([null, 'cursor|x']);
    expect(snap.divider).toEqual({ key: older.key, count: 3, moreAbove: false });
    expect(snap.scrollToDivider).toBe(true);
    markStageDividerScrolled(V, A);
    expect(stageFeed(V, A)!.scrollToDivider).toBe(false);
    const meta = snap.items.find((it) => it.feed.sessionKey === newer.key)!.feed;
    markStageSeen(V, A, meta);
    markStageSeen(V, A, meta);
    expect(posted).toEqual([['daily', newer.newestId]]);
    // The same run posting again after it was seen: its new newest id is sent too.
    markStageSeen(V, A, { ...meta, newestId: 'id-daily-100-zz' });
    expect(posted).toEqual([['daily', newer.newestId], ['daily', 'id-daily-100-zz']]);
    posted.length = 0;
    posted.push(['daily', newer.newestId]);
    snap = stageFeed(V, A)!;
    // One monotonic mark per slug: the older run is read with it. The divider stays put.
    expect(snap.sessions.every((s) => !s.unread)).toBe(true);
    expect(snap.divider?.key).toBe(older.key);
    // A call-mode thread (the agent's own slug) and a post-less failed run post their marks too.
    const failed = run('herodot', 300, 0, { unread: true, status: 'failed', newestId: 'id-fail' });
    respond = () => page([failed, newer], null, 1);
    await refreshStageFeed(V, A, 'n2');
    const fm = stageFeed(V, A)!.items.find((it) => it.feed.sessionKey === failed.key)!.feed;
    expect(fm.empty).toBe(true);
    markStageSeen(V, A, fm);
    expect(posted).toContainEqual(['herodot', 'id-fail']);
  });

  it('AC16(i): a held feed whose newest run moved into page 1 plus 12 new sessions → every session once, in order, no gap', async () => {
    const held = Array.from({ length: 6 }, (_, i) => run('daily', i * 10));
    respond = () => page(held, null);
    beginStageOpen(V, A, null);
    open();
    await flush();
    const moved = { ...held[5], lastAt: iso(5000), rows: [...held[5].rows, { id: 'late', kind: 'agent' as const, text: 'late', at: iso(5000) }] };
    const fresh = Array.from({ length: 12 }, (_, i) => run('weekly', 1000 + i * 10));
    const all = [...held.slice(0, 5), ...fresh, moved];
    // Page 1 now holds the 8 newest; the moved run's old lastAt cannot connect, the older page can.
    const desc = page(all).sessions;
    respond = (o) => {
      if (!o.before) return { sessions: desc.slice(0, 8), nextBefore: 'c1|k', unreadCount: 0 };
      if (o.before === 'c1|k') return { sessions: desc.slice(8, 16), nextBefore: 'c2|k', unreadCount: 0 };
      return { sessions: desc.slice(16), nextBefore: null, unreadCount: 0 };
    };
    await refreshStageFeed(V, A, 'n2');
    const keys = stageFeed(V, A)!.sessions.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(all.map((s) => s.key));
  });

  it('AC16(ii): an ended 350-row talk arriving while the reader is up: divider unchanged, a replace waits for the bottom', async () => {
    const unread = run('daily', 0, 1, { unread: true });
    const held = [unread, run('daily', 50)];
    respond = () => page(held, null, 1);
    beginStageOpen(V, A, null);
    open();
    await flush();
    const divider = stageFeed(V, A)!.divider;
    setStageFeedPinned(V, A, false);
    const long = talk('long', 400, 350);
    // A page that does not connect (no held session with an unchanged lastAt), and nothing older.
    respond = (o) => (o.before ? { sessions: [], nextBefore: 'c2|k', unreadCount: 1 } : { sessions: [long], nextBefore: 'c|k', unreadCount: 1 });
    await refreshStageFeed(V, A, 'n3');
    expect(reads.filter((r) => r.before).length).toBe(3);
    expect(stageFeed(V, A)!.sessions.map((s) => s.key)).toEqual(held.map((s) => s.key));
    expect(stageFeed(V, A)!.divider).toEqual(divider);
    setStageFeedPinned(V, A, true);
    expect(stageFeed(V, A)!.sessions.map((s) => s.key)).toEqual([long.key]);
    // Its session gone, the divider goes to the top of what is loaded ("more above").
    expect(stageFeed(V, A)!.divider).toEqual({ key: long.key, count: 1, moreAbove: true });

    // The connected case while the reader is up: the talk joins at the END (below the reader).
    beginStageOpen(V, A, null);
    respond = () => page(held, null, 1);
    await flush();
    setStageFeedPinned(V, A, false);
    respond = () => page([...held, long], null, 1);
    await refreshStageFeed(V, A, 'n4');
    expect(stageFeed(V, A)!.sessions.map((s) => s.key)).toEqual([...held.map((s) => s.key), long.key]);
    expect(stageFeed(V, A)!.divider?.key).toBe(unread.key);
  });

  it('AC12: one older-page request in flight; an older page prepends', async () => {
    respond = (o) => (o.before ? page([run('daily', 0)], null) : page([run('daily', 100)], 'c|k'));
    beginStageOpen(V, A, null);
    open();
    await flush();
    const before = reads.length;
    void loadOlderStageFeed(V, A);
    void loadOlderStageFeed(V, A);
    expect(stageFeed(V, A)!.olderLoading).toBe(true);
    await flush();
    expect(reads.length).toBe(before + 1);
    expect(stageFeed(V, A)!.sessions.map((s) => s.key)).toEqual([run('daily', 0).key, run('daily', 100).key]);
    expect(stageFeed(V, A)!.hasMore).toBe(false);
  });

  it('a late response of an earlier open is ignored', async () => {
    let release: (p: AgentHistoryPage) => void = () => {};
    __setStageHistoryIo({ read: () => new Promise((r) => { release = r; }), post: async () => {} });
    beginStageOpen(V, A, null);
    const stale = release;
    __setStageHistoryIo({ read: async () => page([run('daily', 7)]), post: async () => {} });
    beginStageOpen(V, A, null);
    await flush();
    stale(page([run('daily', 1)]));
    await flush();
    expect(stageFeed(V, A)!.sessions.map((s) => s.key)).toEqual([run('daily', 7).key]);
  });
});

describe('a silent run in the pane', () => {
  const run = (over: Partial<FeedSession>): FeedSession => ({
    key: 'watch::2026-10-30T09:00:00.000Z', kind: 'run', source: 'watch', title: 'Watch',
    startedAt: '2026-10-30T09:00:00.000Z', lastAt: '2026-10-30T09:01:00.000Z', status: 'ok', durationMs: 60_000,
    newestId: 'n', unread: false, rows: [], ...over,
  });
  const body = (origin: 'answer' | 'failure' | 'note', text: string) => ({ id: `body:${origin}`, kind: 'agent' as const, text, at: '2026-10-30T09:01:00.000Z', origin });

  it('a body row is a normal text row that knows what it is; the report link follows it', () => {
    const [item] = toFeedItems([run({ rows: [body('answer', 'Acme is healthy.')] })]);
    expect(item).toMatchObject({ kind: 'text', text: 'Acme is healthy.', feed: { origin: 'answer' } });
    expect(feedReportShown(item.feed, { last: true })).toBe(true);
    expect(feedReportShown(item.feed, { last: false })).toBe(false);
  });

  it('a run with a document has the link whatever its rows are; one with neither does not', () => {
    const [posted] = toFeedItems([run({ hasDocument: true, rows: [{ id: 'p', kind: 'agent', text: 'A post.', at: '2026-10-30T09:01:00.000Z' }] })]);
    expect(feedReportShown(posted.feed, { last: true })).toBe(true);
    const [note] = toFeedItems([run({ rows: [body('note', 'Finished.')] })]);
    expect(feedReportShown(note.feed, { last: true })).toBe(false);
  });

  it('a run in flight says Working once: the indicator, not a row as well', () => {
    const items = toFeedItems([run({ status: 'running', rows: [body('note', 'Working')] })]);
    expect(items).toHaveLength(1);
    expect(items[0].feed).toMatchObject({ empty: true, status: 'running' });
    expect(feedRunWorking(items[0].feed, { last: true })).toBe(true);
  });
});

describe('an open whose history never answers', () => {
  it('fails after 15 s with its retries, and shows the Retry row instead of Loading', async () => {
    vi.useFakeTimers();
    try {
      __resetStageSessionsForTests();
      __setStageHistoryIo({ read: () => new Promise(() => {}) });
      beginStageOpen('v', 'scout', null);
      expect(stageFeed('v', 'scout')?.loading).toBe(true);
      await vi.advanceTimersByTimeAsync(15_000 + 2_000 + 15_000 + 5_000 + 15_000 + 10);
      expect(stageFeed('v', 'scout')).toMatchObject({ loading: false, failed: true });
    } finally {
      __setStageHistoryIo(null);
      __resetStageSessionsForTests();
      vi.useRealTimers();
    }
  });
});
