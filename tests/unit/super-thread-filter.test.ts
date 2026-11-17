/**
 * The Super chat's thread filter (task ajanda-gunluk, plan ajanda-filtre C3, C4.3; criteria 5
 * and 7): the store's press / switch / same-row clear, the row's About block a filtered send opens
 * with (nothing staged in the composer), the sends it links, the jump gate, and the read rule applied when a filter
 * ends. Fictional words throughout.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetThreadFiltersForTests, clearThreadFilter, lastClearOf, noteThreadSend, pressThread, revealHiddenCard, setThreadHider, threadFilterOf, withThreadAbout,
} from '../../dashboard/src/components/sleepy/super/superThreadFilter.js';
import { readScratch } from '../../dashboard/src/components/sleepy/chat/composerScratch.js';
import { agendaAboutBlock, type ThreadKey } from '../../dashboard/src/components/sleepy/super/superHandover.js';
import { readsAfterFilter, unreadSinceRead, type UnreadUnit } from '../../dashboard/src/components/sleepy/super/superUnread.js';
import { msgRef } from '../../dashboard/src/lib/superTypes.js';

const SID = 'sup-orbit';
const CONV = 'conv-orbit';
const key = (note: string): ThreadKey => ({ note, refs: [], sent: [], label: `line ${note}` });
const aboutOf = (note: string) => agendaAboutBlock({ section: 'now', note, text: `line ${note}` });
const press = (note: string) => pressThread(SID, { rowKey: `row-${note}`, key: key(note), about: aboutOf(note) });

afterEach(() => {
  __resetThreadFiltersForTests();
});

describe('the filter store (C3)', () => {
  it('a press sets the filter and stages nothing in the composer; the same row again clears it', () => {
    expect(press('n1')).toBe('on');
    const f = threadFilterOf(SID)!;
    expect(f.rowKey).toBe('row-n1');
    expect(f.about).toBe(aboutOf('n1'));
    // Owner 2026-11-17: the strip alone says which thread he is in, the box stays his.
    expect(readScratch(CONV).attachments).toEqual([]);

    expect(press('n1')).toBe('off');
    expect(threadFilterOf(SID)).toBeNull();
    expect(lastClearOf(SID)?.reason).toBe('user');
  });

  it('another row switches, and the full chat place is kept', () => {
    press('n1');
    const f1 = threadFilterOf(SID)!;
    f1.anchor = { id: 'u-9', ts: 9, kind: 'user', offset: 12, stick: false };
    expect(press('n2')).toBe('on');
    const f2 = threadFilterOf(SID)!;
    expect(f2.rowKey).toBe('row-n2');
    expect(f2.about).toBe(aboutOf('n2'));
    expect(f2.n).toBeGreaterThan(f1.n);
    expect(f2.anchor).toEqual(f1.anchor);
    expect(lastClearOf(SID)?.reason).toBe('switch');
  });

  it('a message sent while filtered opens with the row block; a slash command or his own About does not', () => {
    expect(withThreadAbout(SID, 'kalın olsun')).toBe('kalın olsun');
    press('n1');
    const block = aboutOf('n1');
    expect(withThreadAbout(SID, 'kalın olsun')).toBe(`${block}\n\nkalın olsun`);
    expect(withThreadAbout(SID, '/compact', { slash: true })).toBe('/compact');
    expect(withThreadAbout(SID, `${aboutOf('n2')}\n\nbaşka satır`, { ownAbout: true })).toBe(`${aboutOf('n2')}\n\nbaşka satır`);
    // Already carrying it (he pressed Ask on the same row): never twice.
    expect(withThreadAbout(SID, `${block}\n\nbir kez`)).toBe(`${block}\n\nbir kez`);
    expect(withThreadAbout('sup-other', 'merhaba')).toBe('merhaba');
  });

  it('a send carrying the block links by it; one without it is linked by its ref', () => {
    press('n1');
    const block = aboutOf('n1');
    noteThreadSend(SID, `${block}\n\nkalın olsun`, 1000);
    expect(threadFilterOf(SID)!.key.sent).toEqual([]);

    noteThreadSend(SID, '/compact', 2000);
    expect(threadFilterOf(SID)!.key.sent).toEqual([{ ref: msgRef('/compact'), at: 2000 }]);

    // × and the same row again: the blockless send is still in its thread; another row has none.
    clearThreadFilter(SID, 'user');
    press('n1');
    expect(threadFilterOf(SID)!.key.sent).toEqual([{ ref: msgRef('/compact'), at: 2000 }]);
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
