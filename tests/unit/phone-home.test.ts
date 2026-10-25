/**
 * The phone's one list over every chosen project (hands-free sekmeler W3, AC15/AC16):
 * sections in order waiting → working → idle → closed, a project tag on every row, the Super row
 * for a handed-over project, "Proje ▾" narrowing, the swipe order across projects, the back
 * badge and the waiting toast.
 */
import { describe, it, expect } from 'vitest';
import {
  homeRows, homeSections, narrowTo, newlyWaiting, swipeTarget, waitingElsewhere,
} from '../../dashboard/src/components/sleepy/phoneHome.js';
import type { LiveChatWire, LiveChatsWire } from '../../dashboard/src/components/handsfree/macContract.js';
import type { StackTab } from '../../dashboard/src/components/sleepy/phoneStack.js';

const live = (conversationId: string, vault: string, state: LiveChatWire['state'], title = conversationId): LiveChatWire => ({
  conversationId, vault, title, busy: state === 'working', state, lastLine: `${title} line`, updatedAt: 1,
});
const past = (id: string, title = id) => ({ id, title, preview: `${title} preview`, updatedAt: 5, startedAt: 1, sizeBytes: 1, gitBranch: '' });
const tab = (id: string, claudeId: string, kind: string): StackTab => ({
  id, paneId: 'p1', title: `tab ${id}`, claudeId, attention: false, info: { kind, label: kind } as StackTab['info'],
});

const LIVE: LiveChatsWire = {
  chats: [
    live('a-work', 'acme', 'working'), live('b-ask', 'beta', 'asking', 'Fiyat sayfası'), live('b-idle', 'beta', 'idle'),
    live('c-gone', 'gamma', 'working'),
  ],
  draining: ['c-gone'],
};

describe('homeRows', () => {
  const rows = homeRows({
    vault: 'acme', tabs: [tab('t1', 'a-tab', 'asking')], projects: ['acme', 'beta', 'gamma'], live: LIVE,
    pastByVault: { acme: [past('a-old')], beta: [past('b-old'), past('b-ask')], gamma: [past('g-old')] },
  });

  it('every chosen project in one list, sections waiting → working → idle → closed, each row tagged', () => {
    expect(rows.map((r) => [r.section, r.vault])).toEqual([
      ['waiting', 'acme'], ['waiting', 'beta'], ['working', 'acme'], ['idle', 'beta'],
      ['closed', 'acme'], ['closed', 'beta'], ['closed', 'gamma'],
    ]);
    expect(homeSections(rows).map((s) => s.section)).toEqual(['waiting', 'working', 'idle', 'closed']);
  });

  it('a chat the Mac runs is never also a closed row; a draining one is in neither', () => {
    const keys = rows.map((r) => r.key);
    expect(keys.some((k) => k.endsWith('past:b-ask'))).toBe(false);
    expect(keys.some((k) => k.includes('c-gone'))).toBe(false);
  });

  it('"Proje ▾" narrows to one project', () => {
    expect(narrowTo(rows, 'beta').every((r) => r.vault === 'beta')).toBe(true);
    expect(narrowTo(rows, null)).toHaveLength(rows.length);
  });

  it('a handed-over project contributes its one Super row and nothing else', () => {
    const r = homeRows({
      vault: 'acme', tabs: [], projects: ['acme', 'beta'],
      live: { ...LIVE, supers: [{ ...live('sup', 'beta', 'asking'), vault: 'beta', live: true }] }, pastByVault: { beta: [past('b-old')] },
    });
    const beta = r.filter((x) => x.vault === 'beta');
    expect(beta.map((x) => [x.kind, x.section])).toEqual([['super', 'waiting']]);
  });
});

describe('the chat screen across projects', () => {
  const rows = homeRows({
    vault: 'acme', tabs: [tab('t1', 'a-tab', 'asking')], projects: ['acme', 'beta'], live: LIVE, pastByVault: {},
  });
  const keyOf = (part: string) => rows.find((r) => r.key.includes(part))!.key;

  it('a swipe moves to the next / previous OPEN chat in the list\'s order, across projects', () => {
    expect(swipeTarget(rows, keyOf('t1'), 1)?.vault).toBe('beta');
    expect(swipeTarget(rows, keyOf('b-ask'), 1)?.key).toBe(keyOf('a-work'));
    expect(swipeTarget(rows, keyOf('b-ask'), -1)?.key).toBe(keyOf('t1'));
    expect(swipeTarget(rows, keyOf('t1'), -1)).toBeNull();
    expect(swipeTarget(rows, 'nowhere', 1)).toBeNull();
  });

  it('the back badge counts chats waiting elsewhere', () => {
    expect(waitingElsewhere(rows, keyOf('t1'))).toBe(1);
    expect(waitingElsewhere(rows, keyOf('a-work'))).toBe(2);
  });

  it('the toast names a chat that STARTED waiting since the last look, never the one on screen', () => {
    const seen = new Set([keyOf('t1')]);
    expect(newlyWaiting(rows, seen, keyOf('a-work'))?.key).toBe(keyOf('b-ask'));
    expect(newlyWaiting(rows, new Set([keyOf('t1'), keyOf('b-ask')]), null)).toBeNull();
    expect(newlyWaiting(rows, seen, keyOf('b-ask'))).toBeNull();
  });
});

describe('a tab whose chat another screen holds', () => {
  it('waits when the Mac says that chat is asking (the tab itself was closed 4409)', () => {
    const rows = homeRows({
      vault: 'acme', tabs: [tab('t9', 'held-there', 'taken')], projects: ['acme'],
      live: { chats: [live('held-there', 'acme', 'asking')], draining: [] }, pastByVault: {},
    });
    expect(rows.map((r) => [r.kind, r.section])).toEqual([['open', 'waiting']]);
    expect(waitingElsewhere(rows, null)).toBe(1);
  });
});
