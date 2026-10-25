// AC19: the phone shows the project's open chats STACKED — one focused chat, every other open
// chat (this phone's tabs AND the Mac's running chats, each once) a one-line row above it, waiting
// first; a tap switches to a tab or adopts a Mac chat. The rows are plain functions (phoneStack.ts);
// the wiring is checked against the source, like mac-phone-drawer.test.ts (root vitest runs under
// plain Node). The live swap on a real phone is scripts/verify/handsfree-mobile.mjs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chatLastLine, stackRows, stackTap, type StackTab } from '../../dashboard/src/components/sleepy/phoneStack.js';
import type { LiveChatWire } from '../../dashboard/src/components/handsfree/macContract.js';
import { liveChatLastLine } from '../../src/server/routes/agent-chat.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const code = (p: string) => readFileSync(join(ROOT, p), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const info = (kind: 'working' | 'asking' | 'ready', label = kind) => ({ kind, label }) as unknown as StackTab['info'];
const tab = (id: string, kind: 'working' | 'asking' | 'ready', claudeId?: string): StackTab => ({ id, paneId: 'p1', title: `T ${id}`, info: info(kind), claudeId, attention: false });
const live = (conversationId: string, state: LiveChatWire['state'], vault: string | null = 'proj', lastLine: string | null = null): LiveChatWire =>
  ({ conversationId, vault, title: `L ${conversationId}`, busy: state === 'working', state, lastLine, updatedAt: null });

describe('stackRows (AC19)', () => {
  it('one open chat and nothing on the Mac: no rows (today\'s single chat)', () => {
    expect(stackRows({ tabs: [tab('a', 'ready')], activeId: 'a', live: [], vault: 'proj' })).toEqual([]);
  });

  it('the focused tab is not a row; the other tabs and this project\'s Mac chats are, waiting first, the rest in order', () => {
    const rows = stackRows({
      tabs: [tab('a', 'ready'), tab('b', 'working'), tab('c', 'ready')],
      activeId: 'a',
      live: [live('m1', 'idle'), live('m2', 'asking', 'proj', 'Ship it?')],
      vault: 'proj',
    });
    expect(rows.map((r) => r.key)).toEqual(['mac:m2', 'tab:b', 'tab:c', 'mac:m1']);
    expect(rows[0]).toMatchObject({ kind: 'mac', waiting: true, stateKey: 'handsfree.mac.state.asking', dot: 'asking', lastLine: 'Ship it?' });
    expect(rows[1]).toMatchObject({ kind: 'tab', waiting: false, stateKey: 'handsfree.mac.state.working', dot: 'working' });
    expect(rows[3]).toMatchObject({ stateKey: 'handsfree.mac.state.idle', dot: 'ready', lastLine: '' });
  });

  it('a waiting TAB sorts first too', () => {
    const rows = stackRows({ tabs: [tab('a', 'ready'), tab('b', 'working'), tab('c', 'asking')], activeId: 'a', live: [], vault: 'proj' });
    expect(rows.map((r) => r.id)).toEqual(['c', 'b']);
    expect(rows[0]).toMatchObject({ waiting: true, stateKey: 'handsfree.mac.state.asking' });
  });

  it('each conversation once: a Mac chat this phone holds as a tab (focused or not) is not stacked again', () => {
    const rows = stackRows({
      tabs: [tab('a', 'ready', 'conv-a'), tab('b', 'working', 'conv-b')],
      activeId: 'a',
      live: [live('conv-a', 'idle'), live('conv-b', 'working'), live('conv-c', 'idle')],
      vault: 'proj',
    });
    expect(rows.map((r) => r.key)).toEqual(['tab:b', 'mac:conv-c']);
  });

  it('a tab holds its live id AND its roster id: a Mac chat under either is not stacked again', () => {
    const t2: StackTab = { ...tab('b', 'working', 'live-b'), altClaudeId: 'roster-b' };
    const rows = stackRows({ tabs: [tab('a', 'ready'), t2], activeId: 'a', live: [live('live-b', 'working'), live('roster-b', 'working')], vault: 'proj' });
    expect(rows.map((r) => r.key)).toEqual(['tab:b']);
  });

  it('another chosen project\'s chats, unregistered folders and draining conversations are not stacked here', () => {
    const rows = stackRows({
      tabs: [tab('a', 'ready')], activeId: 'a',
      live: [live('x', 'asking', 'other'), live('y', 'idle', null), live('z', 'idle')],
      draining: [],
      vault: 'proj',
    });
    expect(rows.map((r) => r.id)).toEqual(['z']);
  });
});

describe('stackTap (AC19)', () => {
  it('a tab row switches to that tab; a Mac row adopts the running chat (never a resume)', () => {
    const [b, m] = stackRows({ tabs: [tab('a', 'ready'), tab('b', 'ready')], activeId: 'a', live: [live('m', 'working')], vault: 'proj' });
    expect(stackTap(b)).toEqual({ select: { paneId: 'p1', id: 'b' } });
    const d = stackTap(m);
    expect('adopt' in d && d.adopt.conversationId).toBe('m');
  });
});

describe('chatLastLine (a phone tab\'s row)', () => {
  const text = (t: string) => ({ kind: 'text', id: t, index: 0, text: t, done: true, ts: 0 }) as const;
  it('a waiting question shows the question; a permission shows only the tool', () => {
    expect(chatLastLine({ items: [text('hi')], history: [], pending: [{ kind: 'question', requestId: 'r', toolName: 'AskUserQuestion', questions: [{ question: 'Delete the old ones?', options: [] }] }] })).toBe('Delete the old ones?');
    expect(chatLastLine({ items: [], history: [], pending: [{ kind: 'permission', requestId: 'r', toolName: 'Bash', input: { command: 'rm -rf x' } }] as never })).toBe('Bash');
  });
  it('else the last line of the newest text, whitespace collapsed; else the history; else empty', () => {
    expect(chatLastLine({ items: [text('first'), { kind: 'user', id: 'u', text: 'go', ts: 0 }, text('line one\n\n  14 found,   all old  \n')], history: [], pending: [] })).toBe('14 found, all old');
    expect(chatLastLine({ items: [], history: [text('from before')], pending: [] })).toBe('from before');
    expect(chatLastLine({ items: [], history: [], pending: [] })).toBe('');
    expect(chatLastLine({ items: [text('x'.repeat(300))], history: [], pending: [] })).toHaveLength(140);
  });
});

describe('liveChatLastLine (the wire\'s lastLine for a Mac chat)', () => {
  const e = (o: Partial<{ status: string; pendingQuestion: unknown; lastAssistantText: string[] }>) =>
    ({ status: 'idle', pendingQuestion: null, lastAssistantText: [], ...o }) as never;
  it('a question shows its first line; a permission only its tool name, never the command', () => {
    expect(liveChatLastLine([e({ status: 'asking', pendingQuestion: { requestId: 'r', toolName: 'AskUserQuestion', isPermission: false, text: 'Ship it?\nSecond', options: [] } })])).toBe('Ship it?');
    expect(liveChatLastLine([e({ status: 'asking', pendingQuestion: { requestId: 'r', toolName: 'Bash', isPermission: true, text: 'rm -rf /secret/path', options: [] } })])).toBe('Bash');
    expect(liveChatLastLine([e({ status: 'asking', pendingQuestion: { requestId: 'r', toolName: 'AskUserQuestion', isPermission: false, text: '\n  \nShip it?', options: [] } })])).toBe('Ship it?');
  });
  it('else the newest assistant text\'s last line, clipped; gone entries and empty texts give null', () => {
    expect(liveChatLastLine([e({ lastAssistantText: ['old', 'Summary\n\nAll  green.'] })])).toBe('All green.');
    expect(liveChatLastLine([e({ status: 'gone', lastAssistantText: ['dead'] })])).toBeNull();
    expect(liveChatLastLine([])).toBeNull();
    expect(liveChatLastLine([e({ lastAssistantText: ['y'.repeat(400)] })])).toHaveLength(140);
  });
});

describe('the stack is wired on the phone (AC19-AC20)', () => {
  const surface = code('dashboard/src/components/sleepy/AgentSurface.tsx');
  const stack = code('dashboard/src/components/sleepy/PhoneChatStack.tsx');
  const css = code('dashboard/src/components/sleepy/MobileChat.css');
  const server = code('src/server/routes/agent-chat.ts');

  it('mounts above the panes only on a phone without the list, switches with selectTab, adopts with adoptLiveChat', () => {
    expect(surface).toMatch(/\{isMobile && !macPhone && \(\s*<PhoneChatStack[\s\S]*?onSelect=\{selectTab\}\s*onAdopt=\{adoptLiveChat\}[\s\S]*?\/>\s*\)\}\s*<div\s+ref=\{panesRowRef\}/);
  });

  // The owner, 2026-10-17: two screens, the list and one chat; the open chats live on the list.
  it('Mac mode\'s phone shows a chat alone: no stack there, and the two screens move forward and back', () => {
    expect(surface).not.toMatch(/\{isMobile && \(\s*<PhoneChatStack/);
    expect(surface).toMatch(/data-phone-nav=\{macPhone && phoneNav \? phoneNav : undefined\}/);
    expect(surface).toMatch(/setPhoneNav\(phoneView === 'chat' \? 'push' : 'pop'\)/);
    expect(css).toMatch(/\[data-phone-nav="push"\] \.agent-panes \{ animation: mnavPush 220ms/);
    expect(css).toMatch(/\[data-phone-nav="pop"\] \.mlist-screen > \* \{ animation: mnavPop 220ms/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.agent-surface\[data-phone-nav\] \.agent-overlay-head,[\s\S]*?animation: none; \}/);
  });

  // Review r1 (edge-cases): the pure filter alone left the restore's wiring untested.
  it('Mac mode\'s phone restores through phoneRestorable over live-chats, and keeps what it could not judge', () => {
    expect(surface).toMatch(/if \(isMacPhoneSurface\(\)\) \{\s*const ask = \(\) => scopedApi\.get<LiveChatsWire>\('\/agent\/live-chats'\);[\s\S]{0,300}?saved = phoneRestorable\(stored, live\);\s*if \(!live\) unrestored = stored;[\s\S]{0,900}?\}\s*if \(!cancelled\) unrestoredRef\.current = unrestored;/);
    // A remote computer with no live tab of its own seeds from the Mac window's, by the same live rule (D3).
    expect(surface).toMatch(/if \(live && saved\.length === 0 && readRemoteDesktop\(\)\) \{[\s\S]{0,300}?\/agent\/sessions\?of=desktop[\s\S]{0,200}?saved = phoneRestorable\(seededRoster\(/);
    // An explicit close drops the conversation from the carry.
    expect(surface).toMatch(/const closeSessionById = useCallback[\s\S]{0,2500}?if \(claudeId\) unrestoredRef\.current = unrestoredRef\.current\.filter\(\(m\) => m\.sessionId !== claudeId\);/);
    expect(surface).toMatch(/\.\.\.carriedUnrestored\(unrestoredRef\.current, new Set\(sessionList\.map\(\(m\) => m\.claudeId\)\)\)\]/);
    // A stored automation tab the Mac runs is adopted passively too, never superseded.
    expect(surface).toMatch(/isMacPhoneSurface\(\)\s*\? spawn\(m\.bypass, m\.sessionId, true, claudeKind, [^)]*'passive'\)\s*: spawn\(m\.bypass, m\.sessionId, true, claudeKind\)/);
  });

  it('polls the Mac only while the phone chat is on screen; rows are labelled with the state words', () => {
    expect(surface).toMatch(/polling=\{onScreenChatId !== ''\}/);
    // 3 s base cadence through pollMs (slower when unfocused, none while hidden), only while polling.
    expect(stack).toMatch(/enabled: polling,\s*refetchInterval: polling \? \(\) => pollMs\(3_000\) : false/);
    expect(stack).toContain("t('handsfree.mac.stack')");
  });

  it('the wire carries lastLine from the registry', () => {
    expect(server).toMatch(/lastLine: vault \? liveChatLastLine\(entries\) : null/);
  });

  it('a row is a real button inside a list item (the button keeps its role for screen readers)', () => {
    expect(stack).toMatch(/<ul className="mchat-stack"[\s\S]*?<li key=\{row\.key\} className="mchat-stack-item">\s*<button\s+className="mchat-stack-row"/);
    expect(stack).not.toMatch(/role="listitem"/);
  });

  it('a Mac chat held by any roster tab (dormant too) is not stacked again: claudeId from the roster', () => {
    expect(surface).toMatch(/claudeId: sessions\.current\.get\(t\.id\)\?\.claudeId \|\| claudeIdOf\.get\(t\.id\),\s*altClaudeId: claudeIdOf\.get\(t\.id\)/);
  });

  it('rows are >= 44px; the swap is <= 250 ms and off under reduced motion', () => {
    expect(css).toMatch(/\.mchat-stack-row \{[^}]*min-height: 44px;/);
    for (const m of css.matchAll(/animation: mchat(?:Swap[AB]|RowIn) (\d+)ms/g)) expect(Number(m[1])).toBeLessThanOrEqual(250);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.mchat-stack-row,\s*\.agent-surface\[data-mobile\] \.agent-panes\[data-swap\] \{ animation: none; \}/);
  });
});
