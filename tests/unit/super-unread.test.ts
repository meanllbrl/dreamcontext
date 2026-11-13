import { describe, expect, it } from 'vitest';
import {
  DWELL_MS, GLIDE_REACH, PROSE_LANDING, SAME_MESSAGE_MS, START_SLACK, SUPER_QUESTION_EVENT, advanceDwell, landingFor, readSide, startInView, startSeen, startSide, chooseLine, firstMountedRow, glideEase, glideFrom, leadIndex, mergeMarks, mostlyVisible, ownerCanRead, sideOf, unreadOf, unreadUnits, wordsKey, withRead,
  type ReadMarks, type UnreadItem,
} from '../../dashboard/src/components/sleepy/super/superUnread';

const text = (id: string, words: string, ts: number, done = true): UnreadItem => ({ kind: 'text', id, text: words, ts, done });
const user = (id: string, words: string, ts: number): UnreadItem => ({ kind: 'user', id, text: words, ts });
const units = (items: UnreadItem[], open: Array<{ id: string; createdAt: number }> = []) => unreadUnits(items, { fold: true, ownerBatches: [], openQuestions: open });
const marks = (since: number, read: ReadMarks['read'] = []): ReadMarks => ({ since, read });

describe('what counts as unread', () => {
  it('never counts the owner\'s own messages, and counts a block only when it is finished', () => {
    const all = units([user('u', 'mine', 10), text('a', 'done block', 11), text('b', 'still streaming', 12, false), text('c', '   ', 13)]);
    expect(all.map((u) => u.itemId)).toEqual(['a']);
  });

  it('a turn folded behind an event line is ONE unit, on the line', () => {
    const all = units([user('e', '[super event] x finished', 10), text('r', 'the result', 11), text('r2', 'more', 12)]);
    expect(all.map((u) => u.itemId)).toEqual(['e']);
  });

  it('an event read live stays read when the replay stores longer words for it', () => {
    const live = units([user('e', '[super handover] 1 chat', 10), text('r', 'arranged', 11)]);
    const replay = units([user('h0', '[super handover] The owner handed you these chats: x, y, z. Arrange the stage.', 12), text('h1', 'arranged', 13)]);
    expect(replay[0].key).toBe(live[0].key);
    expect(unreadOf(replay, marks(0, [{ key: live[0].key, ts: 10 }]))).toEqual([]);
  });

  it('the same words at another time are another message, however long the list', () => {
    const gap = SAME_MESSAGE_MS + 1000;
    const all = units([user('u', 'go', 1), text('a', 'ok', 1000), text('b', 'ok', 1000 + gap)]);
    expect(unreadOf(all, marks(0, [{ key: all[0].key, ts: 1000 }])).map((u) => u.itemId)).toEqual(['b']);
    // The older one fell out of the replay's tail: the read one stays read.
    const tail = units([user('u', 'go', 1000), text('b', 'ok', 1000 + gap)]);
    expect(unreadOf(tail, marks(0, [{ key: all[1].key, ts: 1000 + gap }]))).toEqual([]);
  });

  it('a reply landing after its line was read flags the line again', () => {
    const before = units([user('e', '[super recap] back', 10)]);
    const after = units([user('e', '[super recap] back', 10), text('r', 'while you were away', 11)]);
    expect(unreadOf(after, marks(0, [{ key: before[0].key, ts: 10 }]))).toHaveLength(1);
  });

  it('a re-sent owed turn is bookkeeping unless the Super said something in it', () => {
    const owed = '[super owed] items=1\n- owed=o2 kind=msg ref=abc at=23:04\n';
    expect(units([user('u', 'go', 1), user('e', owed, 10)])).toEqual([]);
    expect(units([user('u', 'go', 1), user('e', owed, 10), text('r', 'sorry, here it is', 11)]).map((u) => u.itemId)).toEqual(['e']);
  });

  it('a batch is keyed by its id, whatever its item lines say', () => {
    const live = units([user('e', '[super events] batch=b1 items=1\n- item=i child=c1 event=idle', 10), text('r', 'x', 11)]);
    const replay = units([user('e', '[super events] batch=b1 items=2\n- item=i team=t member=m\n- item=j child=c2 event=idle', 10), text('r', 'x', 11)]);
    expect(replay[0].key).toBe(live[0].key);
  });

  it('an open question is a unit on its card, placed by its own time', () => {
    const all = units([user('u', 'go', 5), text('a', 'first', 10), text('b', 'second', 30)], [{ id: 'q1', createdAt: 20 }]);
    expect(all.map((u) => u.question ?? u.itemId)).toEqual(['a', 'q1', 'b']);
  });

  it('flags nothing before the marks load, and nothing older than the record', () => {
    const all = units([user('u', 'go', 1), text('old', 'old', 5), text('new', 'new', 50)]);
    expect(unreadOf(all, null)).toEqual([]);
    expect(unreadOf(all, marks(10)).map((u) => u.itemId)).toEqual(['new']);
  });

  it('an undated message is never flagged', () => {
    expect(unreadOf(units([user('u', 'go', 0), text('a', 'no time', 0)]), marks(0))).toEqual([]);
  });

  it('a read message stays read after a replay redates it and adds its reply mark', () => {
    const live = units([user('u', 'go', 1), text('live-id', 'Tamam, oldu.\n\nDevam.', 1000)]);
    const read = marks(0, [{ key: live[0].key, ts: 1000 }]);
    const replay = units([user('u', 'go', 1), text('history-3', '<!-- re:abc123 -->\nTamam, oldu. Devam.', 1500)]);
    expect(replay[0].key).toBe(live[0].key);
    expect(unreadOf(replay, read)).toEqual([]);
  });

  it('the same words much later are a new message', () => {
    const later = units([user('u', 'go', 1), text('a', 'Tamam.', 1000 + SAME_MESSAGE_MS + 1)]);
    expect(unreadOf(later, marks(0, [{ key: later[0].key, ts: 1000 }]))).toHaveLength(1);
  });

  it('counts down as marks land, and a slow answer cannot bring a dot back', () => {
    const all = units([user('u', 'go', 1), text('a', 'one', 10), text('b', 'two', 20), text('c', 'three', 30)]);
    let m = marks(0);
    expect(unreadOf(all, m)).toHaveLength(3);
    m = withRead(m, [{ key: all[0].key, ts: 10 }]);
    expect(unreadOf(all, m).map((u) => u.itemId)).toEqual(['b', 'c']);
    m = mergeMarks(m, marks(0));
    expect(unreadOf(all, m).map((u) => u.itemId)).toEqual(['b', 'c']);
  });

  it('prose cut from its event by the replay\'s tail is no new message', () => {
    expect(units([text('r', 'folded once', 10), user('u', 'next', 20), text('a', 'after', 21)]).map((u) => u.itemId)).toEqual(['a']);
  });

  it('keys ignore whitespace, not words', () => {
    expect(wordsKey('a  b\nc')).toBe(wordsKey('a b c'));
    expect(wordsKey('a b')).not.toBe(wordsKey('a c'));
  });
});

describe('where the page starts', () => {
  it('a unit with no row leads: it is above the window', () => {
    expect(leadIndex([500, null, 300])).toBe(1);
  });

  it('else the topmost row leads, whatever the time order', () => {
    expect(leadIndex([500, 100, 300])).toBe(1);
    expect(leadIndex([])).toBe(-1);
  });

  it('a question in the tail says nothing about the window', () => {
    const us = [{ itemId: null }, { itemId: 'a' }, { itemId: 'b' }];
    expect(firstMountedRow(us, [true, false, true])).toBe(2);
    expect(firstMountedRow(us, [true, false, false])).toBe(-1);
  });
});

describe('the line stays put', () => {
  const base = { held: true, heldInView: true, heldIsLead: false, lead: true, leadInView: false, pinned: false };
  it('holds its row while that row is on screen, read or not', () => {
    expect(chooseLine(base)).toBe('held');
    expect(chooseLine({ ...base, lead: false })).toBe('held');
  });
  it('off screen it goes to the lead, or away', () => {
    expect(chooseLine({ ...base, heldInView: false })).toBe('lead');
    expect(chooseLine({ ...base, heldInView: false, lead: false })).toBe('none');
  });
  it('a held lead off screen does not repaint', () => {
    expect(chooseLine({ ...base, heldInView: false, heldIsLead: true })).toBe('held');
  });
  it('a message arriving under a pinned view draws none', () => {
    expect(chooseLine({ ...base, held: false, heldInView: false, leadInView: true, pinned: true })).toBe('none');
    expect(chooseLine({ ...base, held: false, heldInView: false, leadInView: true })).toBe('lead');
  });
});

describe('the glide', () => {
  it('a short way glides whole', () => {
    expect(glideFrom(1000, 700)).toBe(1000);
  });
  it('a long way starts one reach off the target, on the side it came from', () => {
    expect(glideFrom(5000, 100)).toBe(100 + GLIDE_REACH);
    expect(glideFrom(100, 5000)).toBe(5000 - GLIDE_REACH);
  });
  it('the ease runs from 0 to 1 and never overshoots', () => {
    expect(glideEase(0)).toBe(0);
    expect(glideEase(1)).toBe(1);
    for (const t of [0.25, 0.5, 0.75, 0.99]) expect(glideEase(t)).toBeLessThan(1);
  });
});

describe('the reading rule', () => {
  const view = { top: 0, bottom: 100 };

  it('needs most of the row in view', () => {
    expect(mostlyVisible({ top: 50, bottom: 100 }, view)).toBe(true);
    expect(mostlyVisible({ top: 80, bottom: 120 }, view)).toBe(false);
    expect(mostlyVisible({ top: 200, bottom: 240 }, view)).toBe(false);
  });

  it('a row taller than the view counts when it fills most of it', () => {
    expect(mostlyVisible({ top: -500, bottom: 500 }, view)).toBe(true);
    expect(mostlyVisible({ top: 60, bottom: 900 }, view)).toBe(false);
  });

  it('reads the side a row lies on', () => {
    expect(sideOf({ top: -50, bottom: 0 }, view)).toBe('above');
    expect(sideOf({ top: 100, bottom: 120 }, view)).toBe('below');
    expect(sideOf({ top: 90, bottom: 120 }, view)).toBe('in');
  });

  it('reads nothing in the back, unfocused, or covered', () => {
    expect(ownerCanRead({ docVisible: true, focused: true, paneShown: true })).toBe(true);
    expect(ownerCanRead({ docVisible: false, focused: true, paneShown: true })).toBe(false);
    expect(ownerCanRead({ docVisible: true, focused: false, paneShown: true })).toBe(false);
    expect(ownerCanRead({ docVisible: true, focused: true, paneShown: false })).toBe(false);
  });

  it('a unit is seen after the dwell, not before', () => {
    const a = advanceDwell(new Map(), ['k'], 0);
    expect(a.seen).toEqual([]);
    expect(advanceDwell(a.started, ['k'], DWELL_MS - 1).seen).toEqual([]);
    expect(advanceDwell(a.started, ['k'], DWELL_MS).seen).toEqual(['k']);
  });

  it('leaving the view loses the time, so scrolling past never adds up', () => {
    const a = advanceDwell(new Map(), ['k'], 0);
    const gone = advanceDwell(a.started, [], 500);
    const back = advanceDwell(gone.started, ['k'], 600);
    expect(advanceDwell(back.started, ['k'], 1100).seen).toEqual([]);
    expect(advanceDwell(back.started, ['k'], 1600).seen).toEqual(['k']);
  });
});

describe("a member Super's turns for main Super are never the owner's unread (plan-r10 1, mainBatches)", () => {
  const ev = (id: string, batch: string, ts: number): UnreadItem => user(id, `[super events] batch=${batch} items=1\n- item=q1 event=request from=super`, ts);
  const withMain = (items: UnreadItem[], main: string[], fold = true) => unreadUnits(items, { fold, ownerBatches: [], openQuestions: [], mainBatches: main });

  it('skips the event line and every prose block under a main batch', () => {
    const items = [ev('e1', 'B1', 10), text('r1', 'working on the request', 11), text('r2', 'done', 12)];
    expect(withMain(items, ['B1'])).toEqual([]);
  });

  it('counts the owner\'s own turn after it as before', () => {
    const items = [ev('e1', 'B1', 10), text('r1', 'for main', 11), user('u', 'owner asks', 20), text('o1', 'owner answer', 21)];
    expect(withMain(items, ['B1']).map((u) => u.itemId)).toEqual(['o1']);
  });

  it('a batch not named main still counts', () => {
    const items = [ev('e1', 'B1', 10), text('r1', 'reply', 11), ev('e2', 'B2', 30), text('r2', 'other', 31)];
    expect(withMain(items, ['B2']).map((u) => u.itemId)).toEqual(['e1']);
  });

  it('skips main work with the fold off too (prose rows, not lines)', () => {
    const items = [ev('e1', 'B1', 10), text('r1', 'for main', 11), user('u', 'mine', 20), text('o1', 'mine back', 21)];
    expect(withMain(items, ['B1'], false).map((u) => u.itemId)).toEqual(['o1']);
  });

  it('no mainBatches = main Super exactly as before', () => {
    const items = [ev('e1', 'B1', 10), text('r1', 'reply', 11)];
    expect(unreadUnits(items, { fold: true, ownerBatches: [], openQuestions: [] })).toEqual(withMain(items, []));
  });

  it('an open question still counts under a main batch (it is the record\'s, the owner\'s own)', () => {
    const got = unreadUnits([ev('e1', 'B1', 10)], { fold: true, ownerBatches: [], openQuestions: [{ id: 'q', createdAt: 11 }], mainBatches: ['B1'] });
    expect(got.map((u) => u.question)).toEqual(['q']);
  });
});

describe('where a message START stands to the view (owner 2026-11-12)', () => {
  it('read needs the START: the end of a tall row filling the view is not seen', () => {
    const view = { top: 0, bottom: 500 };
    // Start 600 px above, the rest fills the view: mostly visible by the old rule, not seen now. (Mutation: start rule dropped.)
    expect(startSeen({ top: -600, bottom: 600 }, view)).toBe(false);
    expect(startInView({ top: -600, bottom: 600 }, view)).toBe(false);
    expect(startSide({ top: -600, bottom: 600 }, view)).toBe('above');
    // Its start on screen and it fills most of the view: seen.
    expect(startSeen({ top: 40, bottom: 1200 }, view)).toBe(true);
    // The slack: a first line a few px under the edge still counts.
    expect(startInView({ top: -START_SLACK, bottom: 300 }, view)).toBe(true);
    expect(startInView({ top: -START_SLACK - 1, bottom: 300 }, view)).toBe(false);
    expect(startSide({ top: 500, bottom: 700 }, view)).toBe('below');
    expect(startSide({ top: 499, bottom: 700 }, view)).toBe('in');
  });

  it('the reader\'s side: in only when seen, a start peeking in at the bottom is ahead', () => {
    const view = { top: 0, bottom: 500 };
    expect(readSide({ top: 484, bottom: 690 }, view)).toBe('below');
    expect(readSide({ top: 64, bottom: 300 }, view)).toBe('in');
    expect(readSide({ top: -600, bottom: 600 }, view)).toBe('above');
  });

  it('a question card lands whole when it fits, its top when it does not', () => {
    expect(landingFor('prose', 2000, 500)).toBe(PROSE_LANDING);
    expect(landingFor('question', 300, 500)).toBe(PROSE_LANDING);
    expect(landingFor('question', 470, 500)).toBe(30);
    expect(landingFor('question', 584, 459)).toBe(12);
  });

  it('the door event keeps its name (showQuestionCard and the pane)', () => {
    expect(SUPER_QUESTION_EVENT).toBe('dc:super-question');
  });
});
