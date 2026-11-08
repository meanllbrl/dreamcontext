/**
 * A member's routine runs on its Super page (owner 2026-11-08): the feed is put back on the
 * member's Super chat and drawn BETWEEN its messages by time, a run in flight at the end.
 * The pure halves: chatFeed.ts's interleave helpers and memberRunFeed.ts's state moves.
 *
 * Fictional project and members only.
 */
import { describe, it, expect } from 'vitest';
import {
  chatFilePath, documentHead, feedAnchorMs, feedGroups, firstKnownTs, inlinePlacement, runFootOf, splitFeedAt, type FeedItem, type FeedMeta,
} from '../../dashboard/src/components/sleepy/chat/chatFeed';
import { toFeedItems, type FeedSession } from '../../dashboard/src/components/aiteam/agentHistory';
import {
  EMPTY_RUN_FEED, anyRunning, landFirst, landFresh, landOlder, memberFeedSignature, withPinned, withSeen,
} from '../../dashboard/src/components/sleepy/super/memberRunFeed';
import type { AgentHistoryPage } from '../../dashboard/src/hooks/useAgents';

const T = (hm: string) => `2026-11-08T${hm}:00.000Z`;
const ms = (hm: string) => Date.parse(T(hm));

function session(key: string, startedAt: string, lastAt: string, over: Partial<FeedSession> = {}): FeedSession {
  return {
    key: `daily-ai-news::${key}`, kind: 'run', source: 'daily-ai-news', title: 'Daily AI news',
    startedAt: T(startedAt), lastAt: T(lastAt), status: 'ok', durationMs: 39_000, newestId: `e-${key}`, unread: false,
    rows: [{ id: `r-${key}`, kind: 'agent', text: `post ${key}`, at: T(lastAt) }],
    ...over,
  };
}
const page = (sessions: FeedSession[], nextBefore: string | null = null): AgentHistoryPage => ({ sessions, nextBefore, unreadCount: 0 });

describe('where a run sits against the conversation', () => {
  it('a finished run at its last activity, a run in flight at the very end', () => {
    expect(feedAnchorMs({ sessionKind: 'run', status: 'ok', lastAt: T('10:00') })).toBe(ms('10:00'));
    expect(feedAnchorMs({ sessionKind: 'run', status: 'running', lastAt: T('10:00') })).toBe(Number.POSITIVE_INFINITY);
  });

  it('the conversation starts at its first timed row (0 is "no time")', () => {
    expect(firstKnownTs([{ ts: 0 }, { ts: 5 }], [{ ts: 1 }])).toBe(5);
    expect(firstKnownTs([], [{ ts: 0 }, { ts: 9 }])).toBe(9);
    expect(firstKnownTs([], [])).toBeNull();
    // A tool step carries its time as startedAt.
    expect(firstKnownTs([{ kind: 'tool', startedAt: 7 }])).toBe(7);
  });

  it('runs older than the conversation stay at the head, the rest go inside, a live one too', () => {
    const items = toFeedItems([
      session('a', '08:00', '08:01'),
      session('b', '10:00', '10:01'),
      session('c', '11:00', '11:00', { status: 'running', rows: [] }),
    ]);
    const { head, inline } = splitFeedAt(items, ms('09:00'));
    expect(head.map((i) => i.feed.sessionKey)).toEqual(['daily-ai-news::a']);
    expect([...new Set(inline.map((i) => i.feed.sessionKey))]).toEqual(['daily-ai-news::b', 'daily-ai-news::c']);
    // No conversation yet: everything is the head, as on the old AI Team stage.
    expect(splitFeedAt(items, null).inline).toEqual([]);
  });

  it('a session\'s rows are one group; each goes before the first row after it, a live run last', () => {
    const items: FeedItem[] = toFeedItems([
      session('b', '10:00', '10:01', { rows: [{ id: 'x', kind: 'agent', text: 'one', at: T('10:00') }, { id: 'y', kind: 'agent', text: 'two', at: T('10:01') }] }),
      session('c', '12:00', '12:00', { status: 'running', rows: [] }),
    ]);
    const groups = feedGroups(items);
    expect(groups.map((g) => [g.key, g.from, g.to])).toEqual([['daily-ai-news::b', 0, 2], ['daily-ai-news::c', 2, 3]]);
    // Rows at 09:30, 10:30 (untimed row between them inherits 10:30), 13:00.
    const rows = [ms('09:30'), ms('10:30'), 0, ms('13:00')];
    expect(inlinePlacement(groups, rows)).toEqual([1, 4]);
    // Newer than every row: after the last one.
    expect(inlinePlacement([{ anchor: ms('14:00') }], rows)).toEqual([4]);
    // An untimed row never pulls a run above timed ones.
    expect(inlinePlacement([{ anchor: ms('09:00') }], [0, ms('09:30')])).toEqual([1]);
  });
});

describe('the member feed state', () => {
  it('page 1 lands in reading order; a live re-read merges in place and adds the new run', () => {
    const s1 = landFirst(EMPTY_RUN_FEED, page([session('b', '10:00', '10:01'), session('a', '08:00', '08:01')]));
    expect(s1.sessions.map((s) => s.key)).toEqual(['daily-ai-news::a', 'daily-ai-news::b']);
    const live = session('c', '11:00', '11:00', { status: 'running', rows: [] });
    const s2 = landFresh(s1, page([live, session('b', '10:00', '10:01'), session('a', '08:00', '08:01')]));
    expect(s2.sessions.map((s) => s.key)).toEqual(['daily-ai-news::a', 'daily-ai-news::b', 'daily-ai-news::c']);
    expect(anyRunning(s2)).toBe(true);
    // It ended: the same run updates (and moves to the end, where it already is).
    const done = session('c', '11:00', '11:01', { status: 'ok' });
    const s3 = landFresh(s2, page([done, session('b', '10:00', '10:01'), session('a', '08:00', '08:01')]));
    expect(s3.sessions.at(-1)?.status).toBe('ok');
    expect(anyRunning(s3)).toBe(false);
  });

  it('a re-read that does not connect replaces; an older page prepends', () => {
    const s1 = landFirst(EMPTY_RUN_FEED, page([session('a', '08:00', '08:01')], 'cursor'));
    const s2 = landFresh(s1, page([session('z', '12:00', '12:01')], 'cursor2'));
    expect(s2.sessions.map((s) => s.key)).toEqual(['daily-ai-news::z']);
    const s3 = landOlder({ ...s2, olderLoading: true }, page([session('y', '07:00', '07:01')], null));
    expect(s3.sessions.map((s) => s.key)).toEqual(['daily-ai-news::y', 'daily-ai-news::z']);
    expect(s3.olderLoading).toBe(false);
    expect(s3.nextBefore).toBeNull();
  });

  it('while scrolled up a moved run waits, and moves once back at the bottom', () => {
    const s1 = withPinned(landFirst(EMPTY_RUN_FEED, page([session('b', '10:00', '10:01'), session('a', '08:00', '08:01')])), false);
    const s2 = landFresh(s1, page([session('a', '08:00', '12:00'), session('b', '10:00', '10:01')]));
    expect(s2.sessions.map((s) => s.key)).toEqual(['daily-ai-news::a', 'daily-ai-news::b']);
    expect(s2.deferred).toEqual(['daily-ai-news::a']);
    const s3 = withPinned(s2, true);
    expect(s3.sessions.map((s) => s.key)).toEqual(['daily-ai-news::b', 'daily-ai-news::a']);
    expect(s3.deferred).toEqual([]);
  });

  it('seen marks every run of that routine up to it read, and no other routine', () => {
    const other: FeedSession = { ...session('o', '09:00', '09:01'), key: 'weekly::o', source: 'weekly', unread: true, newestId: 'e-0' };
    const s = landFirst(EMPTY_RUN_FEED, page([session('b', '10:00', '10:01', { unread: true }), session('a', '08:00', '08:01', { unread: true }), other]));
    const meta = { source: 'daily-ai-news', newestId: 'e-b' } as Pick<FeedMeta, 'source' | 'newestId'>;
    const after = withSeen(s, meta);
    expect(after.sessions.filter((x) => x.unread).map((x) => x.key)).toEqual(['weekly::o']);
  });

  it('the channel signature moves only with this member\'s routines', () => {
    const slugs = new Set(['deneme', 'daily-ai-news']);
    const base = [{ slug: 'daily-ai-news', runId: 'r1', status: 'done', newestId: 'e1' }, { slug: 'other', runId: 'r9', status: 'done', newestId: 'e9' }];
    const a = memberFeedSignature(slugs, base, [], 'deneme');
    expect(memberFeedSignature(slugs, [...base, { slug: 'other', runId: 'r10', status: 'running', newestId: null }], ['other'], 'deneme')).toBe(a);
    expect(memberFeedSignature(slugs, base, ['daily-ai-news'], 'deneme')).not.toBe(a);
    expect(memberFeedSignature(slugs, [...base, { slug: 'daily-ai-news', runId: 'r2', status: 'running', newestId: 'e2' }], [], 'deneme')).not.toBe(a);
  });
});

describe('a run\'s document is a tile, never a link or an inline report', () => {
  const doc = { path: 'automations/output/daily-ai-news/2026-11-08.md', name: '2026-11-08.md', head: 'Top story: a model shipped.' };
  it('the foot offers the document the run published, and nothing for a run without one', () => {
    const [withDoc] = toFeedItems([session('a', '08:00', '08:01', { hasDocument: true, document: doc })]);
    const [without] = toFeedItems([session('b', '09:00', '09:01')]);
    expect(runFootOf(withDoc.feed).document).toEqual(doc);
    expect(runFootOf(without.feed)).toEqual({ steps: false, document: null });
  });
  it('steps stay as they were: offered when a session is on this machine', () => {
    const [it] = toFeedItems([session('a', '08:00', '08:01', { claudeId: 'sess-1' })]);
    expect(runFootOf(it.feed).steps).toBe(true);
  });
  it('the pane opens a run\'s document from the brain folder (project-relative, never twice)', () => {
    expect(chatFilePath('automations/output/x/2026-11-08.md')).toBe('_dream_context/automations/output/x/2026-11-08.md');
    expect(chatFilePath('_dream_context/a.md')).toBe('_dream_context/a.md');
  });
  it('the tile\'s lines: two lines, headings lose their marks, marks stripped', () => {
    expect(documentHead('# Daily news\n\n**Top** story: x\nthird')).toBe('Daily news Top story: x');
    expect(documentHead('')).toBeUndefined();
  });
});
