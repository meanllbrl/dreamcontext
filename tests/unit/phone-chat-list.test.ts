// AC21-AC22: the phone opens on the Sohbetler list — every chat of the project, Açık (this phone's
// tabs and the Mac's running chats, each once, waiting first) and Kapalı (past chats), with a
// search and Tümü / Açık / Kapalı chips; a tap opens, adopts or resumes. The rules are plain
// functions (phoneList.ts); the wiring is checked against the source like the other phone tests
// (root vitest runs under plain Node). The live list is scripts/verify/handsfree-mobile.mjs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ageLabel, chatLastTs, chatSearchText, closedRows, foldCase, highlight, listTap, listView, openMatches, openRows, queryTokens,
} from '../../dashboard/src/components/sleepy/phoneList.js';
import { foldCase as serverFoldCase, matchSnippet } from '../../src/lib/transcript-sessions.js';
import { liveChatUpdatedAt } from '../../src/server/routes/agent-chat.js';
import type { StackTab } from '../../dashboard/src/components/sleepy/phoneStack.js';
import { CLOSED_TTL_MS, markClosed, recentlyClosed } from '../../dashboard/src/components/sleepy/phoneClosed.js';
import type { LiveChatWire } from '../../dashboard/src/components/handsfree/macContract.js';
import type { PastSession } from '../../dashboard/src/components/sleepy/ChatHistoryPicker.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const code = (p: string) => readFileSync(join(ROOT, p), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const tab = (id: string, kind: string, claudeId?: string): StackTab => ({ id, paneId: 'p1', title: `T ${id}`, info: { kind, label: kind } as unknown as StackTab['info'], claudeId, attention: false });
const live = (conversationId: string, state: LiveChatWire['state'], vault: string | null = 'proj'): LiveChatWire =>
  ({ conversationId, vault, title: `L ${conversationId}`, busy: state === 'working', state, lastLine: `line ${conversationId}`, updatedAt: null });
const past = (id: string, extra: Partial<PastSession> = {}): PastSession =>
  ({ id, title: `P ${id}`, preview: `prev ${id}`, updatedAt: 1, startedAt: null, sizeBytes: 1, gitBranch: '', ...extra });

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

describe('closedRows (AC21, AC18 rule)', () => {
  it('a past chat open here, running on the Mac or draining is not closed; the match snippet wins over the preview', () => {
    const rows = closedRows({
      past: [past('open-here'), past('running'), past('draining'), past('old', { match: '…the push token…' }), past('older')],
      live: [live('running', 'idle')], draining: ['draining'], openClaudeIds: ['open-here'],
    });
    expect(rows.map((r) => r.id)).toEqual(['old', 'older']);
    expect(rows[0].line).toBe('…the push token…');
    expect(rows[1].line).toBe('prev older');
    // A hit that only repeats the title shows the last message instead.
    expect(closedRows({ past: [past('t', { title: 'zebra plan', match: 'zebra plan' })], live: [], openClaudeIds: [] })[0].line).toBe('prev t');
  });
});

describe('listView: chips and counts (AC21-AC22)', () => {
  it('Tümü holds both, Açık only open, Kapalı only closed; counts follow the Mac\'s total minus what is not closed', () => {
    const base = { open: [1, 2], closed: ['x'], closedTotal: 9, closedDropped: 2 };
    expect(listView({ ...base, filter: 'all' })).toEqual({ open: [1, 2], closed: ['x'], counts: { all: 9, open: 2, closed: 7 } });
    expect(listView({ ...base, filter: 'open' }).closed).toEqual([]);
    expect(listView({ ...base, filter: 'closed' }).open).toEqual([]);
    // Never fewer than what is on screen.
    expect(listView({ open: [], closed: ['a', 'b'], closedTotal: 0, closedDropped: 0, filter: 'all' }).counts.closed).toBe(2);
  });
});

describe('search on the phone (AC22)', () => {
  it('tokens AND across title, last line and loaded text, case-insensitive', () => {
    const tk = queryTokens('  Push   TOKEN ');
    expect(tk).toEqual(['push', 'token']);
    expect(openMatches(tk, 'Push notes', 'the token expired')).toBe(true);
    expect(openMatches(tk, 'Push notes', 'nothing')).toBe(false);
    expect(openMatches([], 'anything')).toBe(true);
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
    expect(openMatches(queryTokens('istanbul'), 'İstanbul planı')).toBe(true);
    expect(openMatches(queryTokens('ışık'), 'IŞIK ayarı')).toBe(true);
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
  it('a loaded conversation is searchable (history + live, messages and answers) and dated by its newest item', () => {
    const m = { history: [{ kind: 'user', id: 'h', text: 'old ask', ts: 5 }], items: [{ kind: 'text', id: 't', index: 0, text: 'new answer', done: true, ts: 9 }, { kind: 'thinking', id: 'k', index: 1, text: 'hidden', done: true, ts: 0 }] } as never;
    expect(chatSearchText(m)).toBe('old ask\nnew answer\n');
    expect(chatLastTs(m)).toBe(9);
    expect(chatLastTs({ items: [], history: [] })).toBeNull();
  });
  it('ageLabel reads now / m / h / d', () => {
    const now = 1_000_000_000;
    expect(ageLabel(now, now)).toBe('now');
    expect(ageLabel(now - 5 * 60_000, now)).toBe('5m');
    expect(ageLabel(now - 3 * 3_600_000, now)).toBe('3h');
    expect(ageLabel(now - 2 * 86_400_000, now)).toBe('2d');
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
});

describe('listTap (AC21)', () => {
  it('a tab opens, a Mac chat is adopted (never resumed), a closed chat resumes', () => {
    const [t, m] = openRows({ tabs: [tab('a', 'ready')], live: [live('m', 'idle')], vault: 'proj' });
    expect(listTap(t)).toEqual({ select: { paneId: 'p1', id: 'a' } });
    expect('adopt' in listTap(m)).toBe(true);
    const [c] = closedRows({ past: [past('z')], live: [], openClaudeIds: [] });
    expect(listTap(c)).toEqual({ resume: c.past });
  });
});

describe('the list is the Mac phone\'s home (AC21)', () => {
  const surface = code('dashboard/src/components/sleepy/AgentSurface.tsx');
  const list = code('dashboard/src/components/sleepy/PhoneChatList.tsx');
  const server = code('src/lib/transcript-sessions.ts');

  it('starts on the list; every open path goes to the chat; the chat\'s ‹ and the back gesture come back', () => {
    expect(surface).toMatch(/useState<'list' \| 'chat'>\('list'\)/);
    expect(surface).toMatch(/\{macPhone && expanded && phoneView === 'list' && \(\s*<PhoneChatList/);
    for (const call of ['selectTab\\(paneId, sid\\)', 'adoptLiveChat\\(chat\\)', 'resumePastSession\\(past\\)', 'addSession\\(claudeKind\\)']) {
      expect(surface).toMatch(new RegExp(`${call}; setPhoneView\\('chat'\\)`));
    }
    expect(surface).toMatch(/window\.history\.pushState\(\{ phoneChat: mark \}, ''\);\s*const onPop = \(\) => setPhoneView\('list'\)/);
    expect(surface).toMatch(/data-testid="chat-back"/);
  });

  it('only this visit\'s history entry is unwound, and a marker left by a reload is cleared (review r1 M1)', () => {
    // Unwinding ANY phoneChat entry stepped out of the app after a reload: the old entry kept its state.
    expect(surface).not.toMatch(/if \(window\.history\.state\?\.phoneChat\) window\.history\.back\(\)/);
    expect(surface).toMatch(/if \(window\.history\.state\?\.phoneChat === mark\) window\.history\.back\(\)/);
    expect(surface).toMatch(/if \(macPhone && window\.history\.state\?\.phoneChat\) window\.history\.replaceState\(null, ''\)/);
    expect(surface).toMatch(/phoneChatMark\.current && window\.history\.state\?\.phoneChat === phoneChatMark\.current\) window\.history\.back\(\)/);
  });

  it('the chat under the list is inert while the list is up, and focus moves with the view (review r1 M2)', () => {
    expect(list).toMatch(/for \(const c of covered\) c\.setAttribute\('inert', ''\)/);
    expect(list).toMatch(/return \(\) => \{ for \(const c of covered\) c\.removeAttribute\('inert'\); \}/);
    expect(list).toMatch(/<h1 className="mlist-h" tabIndex=\{-1\}>/);
    expect(surface).toMatch(/querySelector<HTMLElement>\('\[data-testid="chat-back"\]'\)\?\.focus/);
  });

  it('a closed row cannot be resumed twice by a double tap (review r1 C1)', () => {
    expect(list).toMatch(/if \('adopt' in d\) \{ onAdopt\(d\.adopt\); return; \}\s*if \(tapping\.current\) return;/);
    // r2 F1: open rows are never held by the guard, and a stalled re-check times out into a resume.
    expect(list).toMatch(/setTimeout\(\(\) => reject\(new Error\('timeout'\)\), RECHECK_TIMEOUT_MS\)/);
    // r3: a later tap or leaving the list supersedes a re-check in flight; its late answer does nothing.
    expect(list).toMatch(/const seq = \+\+tapSeq\.current;\s*const d = listTap\(row\);/);
    expect(list).toMatch(/useEffect\(\(\) => \(\) => \{ tapSeq\.current\+\+; \}, \[\]\)/);
    expect(list).toMatch(/if \(seq !== tapSeq\.current\) return;\s*const r = pastTap/);
    expect(list).toMatch(/if \(seq !== tapSeq\.current\) return;\s*onResume\(d\.resume\);/);
    expect(list).toMatch(/tapping\.current = true;[\s\S]*?finally \{\s*tapping\.current = false;/);
    expect(list).toMatch(/disabled=\{pendingId !== null\}/);
  });

  it('chips and the clear button are 44px targets (review r1 M3)', () => {
    const css = readFileSync(join(ROOT, 'dashboard/src/components/sleepy/MobileChat.css'), 'utf-8');
    // r2 F2: both chip rows (projects and filters) keep 8px below, so the hit area is not clipped.
    expect(css).toMatch(/\.mlist-projects,\s*\.mlist-chips \{[^}]*padding: var\(--space-2\) var\(--space-3\);/);
    expect(css).toMatch(/\.mlist-chip::after,\s*\.mlist-clear::after \{ content: ''; position: absolute; inset: calc\(-1 \* var\(--space-1\) - 2px\) 0; \}/);
  });

  it('a notification tap opens that chat past the list; on the list no chat counts as on screen', () => {
    expect(surface).toMatch(/OPEN_SESSION_EVENT, \(detail\) => \{\s*if \(!detail\?\.claudeId\) return;\s*setPhoneView\('chat'\);/);
    expect(surface).toMatch(/isMacPhoneSurface\(\) && phoneView === 'chat' \? \(mobileActive\?\.id \?\? ''\) : ''/);
  });

  it('the drawer stays off the Mac phone; the list carries its duties', () => {
    expect(surface).toMatch(/\{isMobile && !macPhone && \(\s*<MobileSessionDrawer/);
    expect(list).toContain('<PushOptIn />');
    expect(list).toMatch(/chrome\.addTab\(p\.name\)/);
    expect(list).toMatch(/onClick=\{onExitToDashboard\}/);
  });

  it('closed chats are searched on the Mac; a closed tap re-asks the Mac and adopts a chat that turned live', () => {
    expect(list).toMatch(/\/agent\/chat-sessions\?limit=\$\{PAST_LIMIT\}&q=\$\{encodeURIComponent\(dq\)\}/);
    expect(list).toMatch(/const r = pastTap\(d\.resume\.id, fresh\.chats\);\s*if \('adopt' in r\) \{ onAdopt\(r\.adopt\); return; \}/);
    expect(server).toMatch(/tokens\.length \? \{ \.\.\.rest, match: matchSnippet\(lines, tokens\[0\]\) \} : rest/);
  });
});
