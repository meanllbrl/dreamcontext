/**
 * The device shell's chat rows over every chosen project (hands-free sekmeler W3, AC15/AC16, kept
 * by hands-free W2 for the drawer and the chat screen): sections in order waiting → working →
 * idle, a project tag on every row, the Super row for a handed-over project, the swipe order across
 * projects, the drawer toggle's waiting count and the waiting toast. Past chats are not rows any
 * more (History lists them).
 */
import { describe, it, expect } from 'vitest';
import { homeRows, newlyWaiting, swipeTarget, HOME_SECTIONS } from '../../dashboard/src/components/sleepy/phoneHome.js';
import { deviceWaitingCount } from '../../dashboard/src/components/layout/newshell/drawerModel.js';
import type { LiveChatWire, LiveChatsWire } from '../../dashboard/src/components/handsfree/macContract.js';
import type { StackTab } from '../../dashboard/src/components/sleepy/phoneStack.js';

const live = (conversationId: string, vault: string, state: LiveChatWire['state'], title = conversationId): LiveChatWire => ({
  conversationId, vault, title, busy: state === 'working', state, lastLine: `${title} line`, updatedAt: 1,
});
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
  const rows = homeRows({ vault: 'acme', tabs: [tab('t1', 'a-tab', 'asking')], projects: ['acme', 'beta', 'gamma'], live: LIVE });

  it('every chosen project in one list, sections waiting → working → idle, each row tagged; no closed section', () => {
    expect(HOME_SECTIONS).toEqual(['waiting', 'working', 'idle']);
    expect(rows.map((r) => [r.section, r.vault])).toEqual([
      ['waiting', 'acme'], ['waiting', 'beta'], ['working', 'acme'], ['idle', 'beta'],
    ]);
  });

  it('a draining chat is no row', () => {
    expect(rows.some((r) => r.key.includes('c-gone'))).toBe(false);
  });

  it('a handed-over project contributes its one Super row beside its own chats', () => {
    const r = homeRows({
      vault: 'acme', tabs: [], projects: ['acme', 'beta'],
      live: { ...LIVE, supers: [{ ...live('sup', 'beta', 'asking'), vault: 'beta', live: true, jobs: [], runningIds: [], childIds: [] }] },
    });
    const beta = r.filter((x) => x.vault === 'beta');
    expect(beta[0].kind).toBe('super');
    expect(beta[0].section).toBe('waiting');
    expect(beta.length).toBe(1 + LIVE.chats.filter((c) => c.vault === 'beta').length);
  });

  it('a mounted project\'s tabs come from otherTabs; an unmounted one shows only the Mac\'s chats', () => {
    const r = homeRows({ vault: 'acme', tabs: [], otherTabs: { beta: [tab('bt', 'b-tab', 'working')] }, projects: ['acme', 'beta'], live: { chats: [], draining: [] } });
    expect(r.map((x) => [x.vault, x.kind, x.section])).toEqual([['beta', 'open', 'working']]);
  });
});

describe('the chat screen across projects', () => {
  const rows = homeRows({ vault: 'acme', tabs: [tab('t1', 'a-tab', 'asking')], projects: ['acme', 'beta'], live: LIVE });
  const keyOf = (part: string) => rows.find((r) => r.key.includes(part))!.key;

  it('a swipe moves to the next / previous OPEN chat in the list\'s order, across projects', () => {
    expect(swipeTarget(rows, keyOf('t1'), 1)?.vault).toBe('beta');
    expect(swipeTarget(rows, keyOf('b-ask'), 1)?.key).toBe(keyOf('a-work'));
    expect(swipeTarget(rows, keyOf('b-ask'), -1)?.key).toBe(keyOf('t1'));
    expect(swipeTarget(rows, keyOf('t1'), -1)).toBeNull();
    expect(swipeTarget(rows, 'nowhere', 1)).toBeNull();
  });

  it('an offline Super row is never a swipe target', () => {
    const r = homeRows({ vault: 'acme', tabs: [tab('t1', 'a-tab', 'asking')], projects: ['acme', 'beta'], live: { chats: [], draining: [], supers: [{ ...live('sup', 'beta', 'idle'), live: false, jobs: [], runningIds: [], childIds: [] }] } });
    expect(swipeTarget(r, r[0].key, 1)).toBeNull();
  });

  it('the drawer toggle counts chats waiting, the one on screen excluded', () => {
    expect(deviceWaitingCount({ rows }, { vault: 'acme', chatId: 't1' })).toBe(1);
    expect(deviceWaitingCount({ rows }, null)).toBe(2);
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
      live: { chats: [live('held-there', 'acme', 'asking')], draining: [] },
    });
    expect(rows.map((r) => [r.kind, r.section])).toEqual([['open', 'waiting']]);
    expect(deviceWaitingCount({ rows }, null)).toBe(1);
  });
});
