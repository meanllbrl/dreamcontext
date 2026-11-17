/**
 * The Super chat's thread filter (task ajanda-gunluk, plan ajanda-filtre C3, C4.3; criteria 5
 * and 7): the store's press / switch / same-row clear, the About chip it stages and takes back
 * (never his own), the sends it links, the jump gate, and the read rule applied when a filter
 * ends. Fictional words throughout.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetThreadFiltersForTests, clearThreadFilter, lastClearOf, noteThreadSend, pressThread, revealHiddenCard, setThreadHider, threadFilterOf,
} from '../../dashboard/src/components/sleepy/super/superThreadFilter.js';
import { dropScratch, insertRef, markInserted, readScratch, withdrawRef } from '../../dashboard/src/components/sleepy/chat/composerScratch.js';
import { agendaAboutBlock, type ThreadKey } from '../../dashboard/src/components/sleepy/super/superHandover.js';
import { readsAfterFilter, unreadSinceRead, type UnreadUnit } from '../../dashboard/src/components/sleepy/super/superUnread.js';
import { msgRef } from '../../dashboard/src/lib/superTypes.js';

const SID = 'sup-orbit';
const CONV = 'conv-orbit';
const key = (note: string): ThreadKey => ({ note, refs: [], sent: [], label: `line ${note}` });
const chipOf = (note: string) => ({ convId: CONV, name: `About: line ${note}`, text: agendaAboutBlock({ section: 'now', note, text: `line ${note}` }) });
const abouts = () => readScratch(CONV).attachments.filter((a) => a.kind === 'about');
const press = (note: string) => pressThread(SID, { rowKey: `row-${note}`, key: key(note), chip: chipOf(note) });

afterEach(() => {
  __resetThreadFiltersForTests();
  dropScratch(CONV);
});

describe('the filter store (C3)', () => {
  it('a press sets the filter and stages the row chip; the same row again clears both', () => {
    expect(press('n1')).toBe('on');
    const f = threadFilterOf(SID)!;
    expect(f.rowKey).toBe('row-n1');
    expect(abouts().map((a) => a.text)).toEqual([chipOf('n1').text]);
    expect(f.attachment?.id).toBe(abouts()[0].id);

    expect(press('n1')).toBe('off');
    expect(threadFilterOf(SID)).toBeNull();
    // Still pending (no composer drew its token): it simply leaves.
    expect(abouts()).toEqual([]);
    expect(lastClearOf(SID)?.reason).toBe('user');
  });

  it('another row switches: its chip replaces the first, and the full chat place is kept', () => {
    press('n1');
    const f1 = threadFilterOf(SID)!;
    f1.anchor = { id: 'u-9', ts: 9, kind: 'user', offset: 12, stick: false };
    expect(press('n2')).toBe('on');
    const f2 = threadFilterOf(SID)!;
    expect(f2.rowKey).toBe('row-n2');
    expect(f2.n).toBeGreaterThan(f1.n);
    expect(f2.anchor).toEqual(f1.anchor);
    expect(abouts().map((a) => a.text)).toEqual([chipOf('n2').text]);
    expect(lastClearOf(SID)?.reason).toBe('switch');
  });

  it('a chip he staged himself is never stored, so never removed', () => {
    insertRef(CONV, { id: 'att-his', kind: 'about', name: 'his', text: chipOf('n1').text });
    press('n1');
    expect(threadFilterOf(SID)!.attachment).toBeUndefined();
    clearThreadFilter(SID);
    expect(abouts().map((a) => a.id)).toEqual(['att-his']);
  });

  it('a chip already drawn in the box is flagged for the composer, which removes token and chip', () => {
    press('n1');
    const id = threadFilterOf(SID)!.attachment!.id;
    // The composer drew it (no longer pending).
    markInserted(CONV, [id]);
    clearThreadFilter(SID);
    expect(abouts().find((a) => a.id === id)?.withdraw).toBe(true);
    // A second take-back is a no-op; one for a chip that is gone too.
    withdrawRef(CONV, id);
    withdrawRef(CONV, 'att-none');
    expect(abouts()).toHaveLength(1);
  });

  it('after an accepted send the chip is staged again; a send without it is linked by its ref', () => {
    press('n1');
    const block = chipOf('n1').text;
    // The send carried the chip: the composer dropped it (dropSentAttachments), no pair.
    dropScratch(CONV);
    noteThreadSend(SID, `${block}\n\nkalın olsun`, 1000);
    let f = threadFilterOf(SID)!;
    expect(f.key.sent).toEqual([]);
    expect(abouts().map((a) => a.text)).toEqual([block]);
    expect(f.attachment?.id).toBe(abouts()[0].id);

    // He removed the chip and wrote: that message joins the thread through `sent`.
    dropScratch(CONV);
    noteThreadSend(SID, 'ikonsuz olsun', 2000);
    f = threadFilterOf(SID)!;
    expect(f.key.sent).toEqual([{ ref: msgRef('ikonsuz olsun'), at: 2000 }]);
    expect(abouts().map((a) => a.text)).toEqual([block]);

    // × and the same row again: the chipless send is still in its thread; another row has none.
    clearThreadFilter(SID, 'user');
    press('n1');
    expect(threadFilterOf(SID)!.key.sent).toEqual([{ ref: msgRef('ikonsuz olsun'), at: 2000 }]);
    press('n2');
    expect(threadFilterOf(SID)!.key.sent).toEqual([]);
  });

  it('a send in another session, or with no filter, changes nothing', () => {
    noteThreadSend(SID, 'hello');
    noteThreadSend(null, 'hello');
    press('n1');
    noteThreadSend('sup-other', 'hello');
    expect(threadFilterOf(SID)!.key.sent).toEqual([]);
  });
});

describe('the jump gate (C4)', () => {
  it('a door to a card the filter hides clears the filter and retries after the draw', async () => {
    press('n1');
    setThreadHider(SID, (item) => item === 'q-hidden');
    let retried = 0;
    expect(revealHiddenCard('q-shown', () => { retried += 1; })).toBe(false);
    expect(threadFilterOf(SID)).not.toBeNull();
    expect(revealHiddenCard('q-hidden', () => { retried += 1; })).toBe(true);
    expect(threadFilterOf(SID)).toBeNull();
    expect(lastClearOf(SID)?.reason).toBe('gate');
    await new Promise((r) => setTimeout(r, 5));
    expect(retried).toBe(1);
  });

  it('no filter: a missing card is just missing', () => {
    setThreadHider(SID, () => true);
    expect(revealHiddenCard('q-1', () => {})).toBe(false);
  });
});

describe('reads after a filter ends (C4.3, criterion 7)', () => {
  const u = (key: string, ts: number): UnreadUnit => ({ key, ts, itemId: key, question: null });
  // Read up to r0; then a (out of thread, arrived during the filter), b (in thread, he read it).
  const r0 = u('r0', 1);
  const a = u('a', 2);
  const b = u('b', 3);

  it('a seen in-thread answer newer than an unseen out-of-thread message stays unread', () => {
    const units = [r0, a, b];
    const unread = [a, b];
    expect(readsAfterFilter(units, unread, [b])).toEqual([]);
    // So the count still includes the out-of-thread message.
    expect(unreadSinceRead(units, unread).map((x) => x.key)).toEqual(['a', 'b']);
  });

  it('a seen message before every unseen unread is read', () => {
    const c = u('c', 4);
    expect(readsAfterFilter([r0, b, a, c], [b, a, c], [b])).toEqual([b]);
  });

  it('everything seen, nothing older unseen: all of it is read; a unit read meanwhile is skipped', () => {
    expect(readsAfterFilter([r0, a, b], [a, b], [a, b])).toEqual([a, b]);
    expect(readsAfterFilter([r0, a, b], [b], [a, b])).toEqual([b]);
  });
});
