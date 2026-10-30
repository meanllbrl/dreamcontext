import { describe, expect, it } from 'vitest';
import {
  DWELL_MS, SAME_MESSAGE_MS, advanceDwell, firstMountedRow, leadIndex, mergeMarks, mostlyVisible, ownerCanRead, sideOf, unreadOf, unreadUnits, wordsKey, withRead,
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

  it('the same words twice are two messages', () => {
    const all = units([text('a', 'ok', 10), text('b', 'ok', 20)]);
    expect(all[0].key).not.toBe(all[1].key);
    expect(unreadOf(all, marks(0, [{ key: all[0].key, ts: 10 }])).map((u) => u.itemId)).toEqual(['b']);
  });

  it('a reply landing after its line was read flags the line again', () => {
    const before = units([user('e', '[super recap] back', 10)]);
    const after = units([user('e', '[super recap] back', 10), text('r', 'while you were away', 11)]);
    expect(unreadOf(after, marks(0, [{ key: before[0].key, ts: 10 }]))).toHaveLength(1);
  });

  it('a batch is keyed by its id, whatever its item lines say', () => {
    const live = units([user('e', '[super events] batch=b1 items=1\n- item=i child=c1 event=idle', 10), text('r', 'x', 11)]);
    const replay = units([user('e', '[super events] batch=b1 items=2\n- item=i team=t member=m\n- item=j child=c2 event=idle', 10), text('r', 'x', 11)]);
    expect(replay[0].key).toBe(live[0].key);
  });

  it('an open question is a unit on its card, placed by its own time', () => {
    const all = units([text('a', 'first', 10), text('b', 'second', 30)], [{ id: 'q1', createdAt: 20 }]);
    expect(all.map((u) => u.question ?? u.itemId)).toEqual(['a', 'q1', 'b']);
  });

  it('flags nothing before the marks load, and nothing older than the record', () => {
    const all = units([text('old', 'old', 5), text('new', 'new', 50)]);
    expect(unreadOf(all, null)).toEqual([]);
    expect(unreadOf(all, marks(10)).map((u) => u.itemId)).toEqual(['new']);
  });

  it('an undated message is never flagged', () => {
    expect(unreadOf(units([text('a', 'no time', 0)]), marks(0))).toEqual([]);
  });

  it('a read message stays read after a replay redates it and adds its reply mark', () => {
    const live = units([text('live-id', 'Tamam, oldu.\n\nDevam.', 1000)]);
    const read = marks(0, [{ key: live[0].key, ts: 1000 }]);
    const replay = units([text('history-3', '<!-- re:abc123 -->\nTamam, oldu. Devam.', 1500)]);
    expect(replay[0].key).toBe(live[0].key);
    expect(unreadOf(replay, read)).toEqual([]);
  });

  it('the same words much later are a new message', () => {
    const later = units([text('a', 'Tamam.', 1000 + SAME_MESSAGE_MS + 1)]);
    expect(unreadOf(later, marks(0, [{ key: later[0].key, ts: 1000 }]))).toHaveLength(1);
  });

  it('counts down as marks land, and a slow answer cannot bring a dot back', () => {
    const all = units([text('a', 'one', 10), text('b', 'two', 20), text('c', 'three', 30)]);
    let m = marks(0);
    expect(unreadOf(all, m)).toHaveLength(3);
    m = withRead(m, [{ key: all[0].key, ts: 10 }]);
    expect(unreadOf(all, m).map((u) => u.itemId)).toEqual(['b', 'c']);
    m = mergeMarks(m, marks(0));
    expect(unreadOf(all, m).map((u) => u.itemId)).toEqual(['b', 'c']);
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
