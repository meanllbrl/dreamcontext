// AC21-AC22, kept by hands-free W2: the phone's Sohbetler list is gone (the new shell's drawer
// switches chats, History lists past ones), but its rules live on: every open chat once, waiting
// first (`openRows`, the drawer's rows); Turkish-aware search folding mirrored on the Mac and used
// by History's highlight; a chat closed here is no live row while it exits; the window's ONE
// back mark. Rules are plain functions; the wiring is checked against the source like the other
// phone tests (root vitest runs under plain Node). The live phone is scripts/verify/handsfree-mobile.mjs.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { foldCase, highlight, openRows, queryTokens } from '../../dashboard/src/components/sleepy/phoneList.js';
import { foldCase as serverFoldCase, matchSnippet } from '../../src/lib/transcript-sessions.js';
import { liveChatUpdatedAt } from '../../src/server/routes/agent-chat.js';
import type { StackTab } from '../../dashboard/src/components/sleepy/phoneStack.js';
import { CLOSED_TTL_MS, markClosed, recentlyClosed } from '../../dashboard/src/components/sleepy/phoneClosed.js';
import { deviceChatsOf } from '../../dashboard/src/components/layout/newshell/drawerModel.js';
import type { LiveChatWire } from '../../dashboard/src/components/handsfree/macContract.js';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const code = (p: string) => readFileSync(join(ROOT, p), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const tab = (id: string, kind: string, claudeId?: string): StackTab => ({ id, paneId: 'p1', title: `T ${id}`, info: { kind, label: kind } as unknown as StackTab['info'], claudeId, attention: false });
const live = (conversationId: string, state: LiveChatWire['state'], vault: string | null = 'proj'): LiveChatWire =>
  ({ conversationId, vault, title: `L ${conversationId}`, busy: state === 'working', state, lastLine: `line ${conversationId}`, updatedAt: null });

describe('openRows (AC21)', () => {
  it('every open chat once, waiting first, then working, then the rest; tabs before the Mac within a rank', () => {
    const rows = openRows({
      tabs: [tab('a', 'ready', 'conv-a'), tab('b', 'working'), tab('c', 'asking')],
      live: [live('conv-a', 'working'), live('m1', 'idle'), live('m2', 'asking'), live('m3', 'working')],
      vault: 'proj',
    });
    expect(rows.map((r) => r.key)).toEqual(['tab:c', 'mac:m2', 'tab:b', 'mac:m3', 'tab:a', 'mac:m1']);
    expect(rows.find((r) => r.id === 'm2')).toMatchObject({ kind: 'mac', waiting: true, stateKey: 'handsfree.mac.state.asking', lastLine: 'line m2' });
  });
  it('another chosen project\'s chats and unregistered folders are not listed here', () => {
    expect(openRows({ tabs: [], live: [live('x', 'idle', 'other'), live('y', 'idle', null)], vault: 'proj' })).toEqual([]);
  });
});

describe('search folding, shared by History and the Mac (AC22)', () => {
  it('tokens are folded, split on whitespace, empties dropped', () => {
    expect(queryTokens('  Push   TOKEN ')).toEqual(['push', 'token']);
    expect(queryTokens('   ')).toEqual([]);
  });
  it('highlight marks every hit, keeps the rest, escapes regex characters', () => {
    expect(highlight('Fix the push PUSH', ['push'])).toEqual([
      { text: 'Fix the ', hit: false }, { text: 'push', hit: true }, { text: ' ', hit: false }, { text: 'PUSH', hit: true },
    ]);
    expect(highlight('a (b) c', ['(b)'])).toEqual([{ text: 'a ', hit: false }, { text: '(b)', hit: true }, { text: ' c', hit: false }]);
    expect(highlight('plain', [])).toEqual([{ text: 'plain', hit: false }]);
  });

  it('Turkish İ / I / ı fold to i on both sides, so a typed "istanbul" or "ışık" finds and marks the capitalised title', () => {
    expect(foldCase('İstanbul IŞIK ılık')).toBe('istanbul işik ilik');
    for (const s of ['İstanbul', 'IŞIK', 'Ünlü Çağrı', 'emoji 🚀 İ']) expect(foldCase(s)).toHaveLength(s.length);
    expect(queryTokens('İŞ  listesi')).toEqual(['iş', 'listesi']);
    expect(highlight('Yeni İstanbul planı', queryTokens('istanbul'))).toEqual([
      { text: 'Yeni ', hit: false }, { text: 'İstanbul', hit: true }, { text: ' planı', hit: false },
    ]);
    expect(highlight('IŞIK', queryTokens('ışık'))).toEqual([{ text: 'IŞIK', hit: true }]);
  });

  it('the Mac folds exactly as the phone (mirror), and its snippet is cut from the original at the folded hit', () => {
    for (const s of ['İstanbul', 'IŞIK ılık', 'Plain ASCII', 'Çğüşöı İI', '']) expect(serverFoldCase(s)).toBe(foldCase(s));
    // Every İ before the hit used to push the window right by one: the hit must sit where it is.
    expect(matchSnippet(['İİİİ İstanbul hedef'], 'hedef', 3)).toBe('…ul hedef');
    expect(matchSnippet(['İş listesi'], 'iş')).toBe('İş listesi');
  });
});

describe('a Mac chat\'s age (AC21)', () => {
  it('is when it last moved: a turn starting or ending, or a registry entry changing; null when unknown', () => {
    expect(liveChatUpdatedAt({ turnStartedAt: null, lastTurnEndedAt: null }, [])).toBeNull();
    expect(liveChatUpdatedAt({ turnStartedAt: 1_000, lastTurnEndedAt: 3_000 }, [{ updatedAt: new Date(2_000).toISOString() }])).toBe(3_000);
    expect(liveChatUpdatedAt({ turnStartedAt: null, lastTurnEndedAt: null }, [{ updatedAt: new Date(9_000).toISOString() }, { updatedAt: 'bad' }])).toBe(9_000);
  });
});

describe('a chat closed here is not a Mac row while it exits', () => {
  it('remembers closed ids for the TTL, then forgets them; the rows treat them as draining', () => {
    markClosed(['gone-1', undefined], 1_000);
    expect(recentlyClosed(1_000 + CLOSED_TTL_MS - 1)).toContain('gone-1');
    expect(openRows({ tabs: [], live: [live('gone-1', 'idle')], draining: recentlyClosed(1_001), vault: 'proj' })).toEqual([]);
    expect(recentlyClosed(1_000 + CLOSED_TTL_MS + 1)).not.toContain('gone-1');
  });

  it('the device shell\'s rows drop it, and History hides it while it exits', () => {
    const d = deviceChatsOf({ activeVault: 'proj', projects: ['proj'], tabsByVault: {}, live: { chats: [live('gone-2', 'idle')], draining: [] }, tunnel: true, liveAnswered: true, closed: ['gone-2'] });
    expect(d.rows).toEqual([]);
    expect(d.hiddenIds.has('gone-2')).toBe(true);
  });
});

describe('the phone is the new shell (hands-free W2)', () => {
  const chrome = code('dashboard/src/components/layout/WindowChrome.tsx');
  const surface = code('dashboard/src/components/sleepy/AgentSurface.tsx');

  it('only this visit\'s history entry is unwound, and a marker left by a reload is cleared (review r1 M1)', () => {
    // The back mark is the window's now (one for every project, hands-free W2): the same rule.
    const chrome = code('dashboard/src/components/layout/WindowChrome.tsx');
    // Unwinding ANY phoneChat entry stepped out of the app after a reload: the old entry kept its state.
    expect(chrome).not.toMatch(/if \(window\.history\.state\?\.phoneChat\) window\.history\.back\(\)/);
    expect(chrome).toMatch(/if \(window\.history\.state\?\.phoneChat === mark\) window\.history\.back\(\)/);
    expect(chrome).toMatch(/if \(isMobile && window\.history\.state\?\.phoneChat\) window\.history\.replaceState\(null, ''\)/);
    expect(surface).not.toContain('history.state?.phoneChat');
  });

  it('the list, its stack and its drawer are gone; nothing mounts them', () => {
    for (const f of ['PhoneChatList.tsx', 'PhoneChatStack.tsx', 'MobileSessionDrawer.tsx', 'usePhoneHome.ts']) {
      expect(existsSync(join(ROOT, 'dashboard/src/components/sleepy', f)), f).toBe(false);
    }
    expect(existsSync(join(ROOT, 'dashboard/src/components/layout/PhoneBar.tsx'))).toBe(false);
    expect(surface).not.toMatch(/PhoneChatList|PhoneChatStack|MobileSessionDrawer|phoneView|phoneNav/);
  });

  it('the list\'s duties moved to the tunnel drawer\'s foot: the notification opt-in and the connection log', () => {
    expect(chrome).toMatch(/\{\.\.\.\(tunnel \? \{ foot: <><PushOptIn \/><PhoneLogSend \/><\/> \} : \{\}\)\}/);
    expect(code('dashboard/src/components/layout/newshell/ChatDrawer.tsx')).toMatch(/\{p\.foot && <div className="ns-dr-foot" data-testid="drawer-foot">\{p\.foot\}<\/div>\}/);
  });

  it('past chats are searched on the Mac and listed by History, never by the phone itself', () => {
    expect(code('src/lib/transcript-sessions.ts')).toMatch(/tokens\.length \? \{ \.\.\.rest, match, matchIn: TIERS\[tier\] \} : rest/);
    expect(code('dashboard/src/components/sleepy/ChatHistoryPicker.tsx')).toMatch(/import \{ highlight, queryTokens \} from '\.\/phoneList';/);
  });
});
