/**
 * An agenda row's thread in the Super chat (task ajanda-gunluk, plan ajanda-filtre C2,
 * criteria 2 and 3): only explicitly linked messages, never by words or a time window alone.
 * Fictional words throughout.
 */
import { describe, it, expect } from 'vitest';
import type { ChatItem } from '../../dashboard/src/components/sleepy/chatSession.js';
import { lineThread } from '../../dashboard/src/components/sleepy/super/lineThread.js';
import { threadKeyOf, type ThreadKey } from '../../dashboard/src/components/sleepy/super/superHandover.js';
import { msgRef } from '../../dashboard/src/lib/superTypes.js';

const SUPER = 'sup-1';
const C1 = 'child-orbit';
const C2 = 'child-atlas';

const user = (id: string, text: string, ts: number, extra: Partial<ChatItem> = {}): ChatItem => ({ kind: 'user', id, text, ts, ...extra } as ChatItem);
const say = (id: string, text: string, ts: number, replyTo?: string[]): ChatItem => ({ kind: 'text', id, index: 0, text, done: true, ts, ...(replyTo ? { replyTo } : {}) });
const tool = (id: string, ts: number): ChatItem => ({ kind: 'tool', id, toolUseId: `tu-${id}`, name: 'Bash', input: {}, status: 'done', startedAt: ts });
const key = (k: Partial<ThreadKey>): ThreadKey => ({ refs: [], sent: [], label: 'x', ...k });
const ids = (t: { entries: Set<string> }) => [...t.entries].sort();

describe('M1: his messages about the row (About headers)', () => {
  const conv: ChatItem[] = [
    user('u1', '[About agenda line note=n1 section=now]\nline: "Orbit inbox"\n\nis it done?', 1000),
    say('t1', 'Almost: two left.', 1100),
    user('u2', '[About agenda line item=q7 section=waiting]\n\nyes, go', 2000),
    say('t2', 'Sent.', 2100),
    user('u3', '[About agenda line owed=o3 section=unanswered]\n\nand this?', 3000),
    say('t3', 'Here.', 3100),
    user('u4', '[About a closed agenda line note=n9]\nline: "Shipped"\n\nwhy closed?', 4000),
    say('t4', 'It shipped Monday.', 4100),
    user('u5', 'Unrelated: the weekly numbers?', 5000),
    say('t5', 'Here they are.', 5100),
  ];
  it('note, item, owed and the closed-line header each name their row; the answer comes with it; the rest stays out', () => {
    expect(ids(lineThread(conv, key({ note: 'n1' }), [], SUPER))).toEqual(['t1', 'u1']);
    expect(ids(lineThread(conv, key({ item: 'q7' }), [], SUPER))).toEqual(['t2', 'u2']);
    expect(ids(lineThread(conv, key({ owed: 'o3' }), [], SUPER))).toEqual(['t3', 'u3']);
    expect(ids(lineThread(conv, key({ note: 'n9' }), [], SUPER))).toEqual(['t4', 'u4']);
    const t = lineThread(conv, key({ note: 'n1' }), [], SUPER);
    expect(t.count).toBe(2);
    expect(t.empty).toBe(false);
  });

  it('a multi-part message joins when any part names the row', () => {
    const multi = [user('m1', '[About agenda line note=n2 section=now]\nline: "Atlas"\n\nfirst\n\n[About agenda line note=n1 section=now]\nline: "Orbit inbox"\n\nsecond', 10)];
    expect(ids(lineThread(multi, key({ note: 'n1' }), [], SUPER))).toEqual(['m1']);
  });
});

describe('M2: refs resolve to distinct messages by arrival', () => {
  it('two identical "evet": only the one whose arrival the line recorded', () => {
    const conv = [user('a', 'evet', 1000), say('ta', 'Started Orbit.', 1100), user('b', 'evet', 5_000_000), say('tb', 'Atlas approved.', 5_000_100)];
    expect(ids(lineThread(conv, key({ refs: [{ ref: msgRef('evet'), at: 1000 }] }), [], SUPER))).toEqual(['a', 'ta']);
  });

  it('two "devam" to one job in two turns: both in, with their answers', () => {
    const conv = [user('a', 'devam', 10_000), say('ta', 'Going on.', 10_100), user('x', 'other', 20_000), say('tx', 'Other.', 20_100), user('b', 'devam', 500_100), say('tb', 'Going on again.', 500_200)];
    const t = lineThread(conv, key({ refs: [{ ref: msgRef('devam'), at: 10_000 }, { ref: msgRef('devam'), at: 500_000 }] }), [], SUPER);
    expect(ids(t)).toEqual(['a', 'b', 'ta', 'tb']);
    expect(t.count).toBe(4);
  });

  it('two same-ref pairs 30 s apart resolve to two messages, never one twice', () => {
    const conv = [user('a', 'ok', 1500), user('b', 'ok', 31_500)];
    expect(ids(lineThread(conv, key({ refs: [{ ref: msgRef('ok'), at: 1000 }, { ref: msgRef('ok'), at: 31_000 }] }), [], SUPER))).toEqual(['a', 'b']);
    expect(ids(lineThread(conv, key({ refs: [{ ref: msgRef('ok'), at: 1000 }] }), [], SUPER))).toEqual(['a']);
  });

  it('a steered message replayed 3 minutes after its arrival resolves to itself', () => {
    const at = 100_000;
    const conv = [user('s', 'also check the drafts', at + 180_000, { steered: true } as Partial<ChatItem>)];
    expect(ids(lineThread(conv, key({ refs: [{ ref: msgRef('also check the drafts'), at }] }), [], SUPER))).toEqual(['s']);
  });

  it('a replay with no times (hist- twins, ts 0) keeps the same thread, by order', () => {
    const conv = [user('hist-1', 'devam', 0), say('hist-2', 'Going on.', 0), user('hist-3', 'other', 0), say('hist-4', 'Other.', 0), user('hist-5', 'devam', 0), say('hist-6', 'Again.', 0)];
    const t = lineThread(conv, key({ refs: [{ ref: msgRef('devam'), at: 10_000 }, { ref: msgRef('devam'), at: 500_000 }] }), [], SUPER);
    expect(ids(t)).toEqual(['hist-1', 'hist-2', 'hist-5', 'hist-6']);
  });

  it('a send made from the filter resolves to itself, never to an earlier identical message', () => {
    const conv = [user('a', 'thanks', 1000), say('ta', 'x', 1100), user('b', 'thanks', 30_000), say('tb', 'y', 30_100)];
    expect(ids(lineThread(conv, key({ sent: [{ ref: msgRef('thanks'), at: 30_000 }] }), [], SUPER))).toEqual(['b', 'tb']);
    // The very first message after the press counts (no position bound to be off by one).
    const first = [user('a', 'thanks', 1000), user('b', 'thanks', 2000)];
    expect(ids(lineThread(first, key({ sent: [{ ref: msgRef('thanks'), at: 2000 }] }), [], SUPER))).toEqual(['b']);
    // Its own message not drawn yet: an identical one 25 s earlier is not taken instead.
    expect(ids(lineThread([user('a', 'thanks', 1000)], key({ sent: [{ ref: msgRef('thanks'), at: 26_000 }] }), [], SUPER))).toEqual([]);
  });

  it('one pair 30 s after an identical message takes its own, the nearer one', () => {
    const conv = [user('a', 'ok', 1500), say('ta', 'Orbit started.', 1600), user('b', 'ok', 31_000), say('tb', 'Atlas started.', 31_100)];
    expect(ids(lineThread(conv, key({ refs: [{ ref: msgRef('ok'), at: 31_000 }] }), [], SUPER))).toEqual(['b', 'tb']);
  });

  it('a replay with no times: a line holding only some of a ref\'s pairs matches none', () => {
    const conv = [user('hist-1', 'devam', 0), say('hist-2', 'Going on.', 0), user('hist-5', 'devam', 0), say('hist-6', 'Again.', 0)];
    expect(ids(lineThread(conv, key({ refs: [{ ref: msgRef('devam'), at: 500_000 }] }), [], SUPER))).toEqual([]);
  });
});

describe('M3, M4, M5: the Super\'s turns about the job', () => {
  it('an event turn with two children joins each job\'s thread, with its text and step rows', () => {
    const ev = '[super events] batch=b1 items=2\n- item=q1 child=child-orbit event=done\n- item=q2 child=child-atlas event=done';
    const conv = [user('e1', ev, 100, { superEvent: 'batch' } as Partial<ChatItem>), tool('k1', 110), say('t1', 'Both finished.', 120), user('u9', 'unrelated', 200), say('t9', 'ok', 210)];
    expect(ids(lineThread(conv, key({ child: C1 }), [], SUPER))).toEqual(['e1', 'k1', 't1']);
    expect(ids(lineThread(conv, key({ child: C2 }), [], SUPER))).toEqual(['e1', 'k1', 't1']);
  });

  it('a Super group joins by re: (in a later event turn) and by rule 2A (one message waiting)', () => {
    const ref = msgRef('Answer the Orbit inbox');
    const ev = '[super events] batch=b2 items=1\n- item=q4 child=child-zeta event=done';
    const conv = [user('u1', 'Answer the Orbit inbox', 1000), say('t1', 'Gave it out.', 1100), user('u2', 'other', 2000), say('t2', 'x', 2100),
      user('e1', ev, 3000, { superEvent: 'batch' } as Partial<ChatItem>), say('t3', 'The inbox is answered.', 3100, [ref])];
    expect(ids(lineThread(conv, key({ refs: [{ ref, at: 1000 }] }), [], SUPER))).toEqual(['t1', 't3', 'u1']);
  });

  it('a Super-ask row (key through threadKeyOf) shows only its own card and its asking turn', () => {
    const k = threadKeyOf({ waiting: { id: 'qa', kind: 'ask' }, label: 'Super' })!;
    expect(k.child).toBeUndefined();
    const conv = [user('u1', 'ship it?', 100), tool('k1', 110), say('t1', 'Asking you.', 120), user('u2', 'other', 200), say('t2', 'x', 210)];
    const t = lineThread(conv, k, [{ item: 'qa', kind: 'ask', toolItemId: 'k1' }], SUPER);
    expect(ids(t)).toEqual(['k1', 't1']);
    expect(t.card({ item: 'qa', toolItemId: 'k1' })).toBe(true);
    // A team result card and the Super's stalled card carry the Super's own session: not this row's.
    expect(t.card({ item: 'team-done', sessionId: SUPER })).toBe(false);
    expect(t.card({ item: 'stalled', sessionId: SUPER })).toBe(false);
  });

  it('a line whose in-thread Super reply asks a question shows that card', () => {
    const conv = [user('u1', '[About agenda line note=n1 section=now]\nline: "Orbit"\n\nwhat now?', 100), tool('k2', 110), say('t1', 'I asked you on the card.', 120)];
    const t = lineThread(conv, key({ note: 'n1' }), [{ item: 'qb', kind: 'ask', toolItemId: 'k2' }], SUPER);
    expect(t.entries.has('k2')).toBe(true);
    expect(t.card({ item: 'qb', toolItemId: 'k2' })).toBe(true);
    expect(t.card({ item: 'qz', toolItemId: 'elsewhere' })).toBe(false);
  });

  it('the job\'s own question card belongs by its session', () => {
    const t = lineThread([], key({ note: 'n1', child: C1 }), [], SUPER, { cards: [{ item: 'q1', sessionId: C1 }] });
    expect(t.card({ item: 'q1', sessionId: C1 })).toBe(true);
    expect(t.empty).toBe(false);
  });

  it('a key naming the Super\'s own session matches no card and no event turn by it', () => {
    const ev = '[super events] batch=b1 items=1\n- item=q1 child=sup-1 event=done';
    const conv = [user('e1', ev, 100, { superEvent: 'batch' } as Partial<ChatItem>), say('t1', 'x', 110)];
    const t = lineThread(conv, key({ child: SUPER }), [], SUPER);
    expect(ids(t)).toEqual([]);
    expect(t.card({ item: 'any', sessionId: SUPER })).toBe(false);
  });
});

describe('the empty state (criterion 3)', () => {
  it('a line with no linked message, or one from an earlier session, is empty', () => {
    const conv = [user('u1', 'hello', 100), say('t1', 'hi', 110)];
    const t = lineThread(conv, key({ note: 'n42', refs: [{ ref: 'abc123', at: 5 }] }), [], SUPER);
    expect(t.empty).toBe(true);
    expect(t.count).toBe(0);
  });
});
