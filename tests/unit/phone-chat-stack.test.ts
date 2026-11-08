// AC19, kept by hands-free W2: the phone's stack is gone (the drawer switches chats), but its rules
// live on in the device shell's rows of one project (`openRows`): every open chat, this phone's
// tabs AND the Mac's running chats, each conversation once, waiting first, then working, then the
// rest; a Mac chat of another project, an unregistered folder or a draining conversation is no row
// here. The wire's lastLine and the phone's restore are checked against the source, like
// mac-phone-drawer.test.ts (root vitest runs under plain Node).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openRows } from '../../dashboard/src/components/sleepy/phoneList.js';
import type { StackTab } from '../../dashboard/src/components/sleepy/phoneStack.js';
import type { LiveChatWire } from '../../dashboard/src/components/handsfree/macContract.js';
import { liveChatLastLine } from '../../src/server/routes/agent-chat.js';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const code = (p: string) => readFileSync(join(ROOT, p), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const info = (kind: 'working' | 'asking' | 'ready', label = kind) => ({ kind, label }) as unknown as StackTab['info'];
const tab = (id: string, kind: 'working' | 'asking' | 'ready', claudeId?: string): StackTab => ({ id, paneId: 'p1', title: `T ${id}`, info: info(kind), claudeId, attention: false });
const live = (conversationId: string, state: LiveChatWire['state'], vault: string | null = 'proj', lastLine: string | null = null): LiveChatWire =>
  ({ conversationId, vault, title: `L ${conversationId}`, busy: state === 'working', state, lastLine, updatedAt: null });

describe('openRows: one project\'s open chats (AC19 rules)', () => {
  it('one open tab and nothing on the Mac: that tab only', () => {
    expect(openRows({ tabs: [tab('a', 'ready')], live: [], vault: 'proj' }).map((r) => r.key)).toEqual(['tab:a']);
  });

  it('tabs and this project\'s Mac chats, waiting first, then working, the rest in order', () => {
    const rows = openRows({
      tabs: [tab('a', 'ready'), tab('b', 'working'), tab('c', 'ready')],
      live: [live('m1', 'idle'), live('m2', 'asking', 'proj', 'Ship it?')],
      vault: 'proj',
    });
    expect(rows.map((r) => r.key)).toEqual(['mac:m2', 'tab:b', 'tab:a', 'tab:c', 'mac:m1']);
    expect(rows[0]).toMatchObject({ kind: 'mac', waiting: true, stateKey: 'handsfree.mac.state.asking', dot: 'asking', lastLine: 'Ship it?' });
    expect(rows[1]).toMatchObject({ kind: 'tab', waiting: false, stateKey: 'handsfree.mac.state.working', dot: 'working' });
    expect(rows[4]).toMatchObject({ stateKey: 'handsfree.mac.state.idle', dot: 'ready', lastLine: '' });
  });

  it('each conversation once: a Mac chat this phone holds as a tab is not a second row', () => {
    const rows = openRows({
      tabs: [tab('a', 'ready', 'conv-a'), tab('b', 'working', 'conv-b')],
      live: [live('conv-a', 'idle'), live('conv-b', 'working'), live('conv-c', 'idle')],
      vault: 'proj',
    });
    expect(rows.map((r) => r.key)).toEqual(['tab:b', 'tab:a', 'mac:conv-c']);
  });

  it('a tab holds its live id AND its roster id: a Mac chat under either is not a second row', () => {
    const t2: StackTab = { ...tab('b', 'working', 'live-b'), altClaudeId: 'roster-b' };
    const rows = openRows({ tabs: [t2], live: [live('live-b', 'working'), live('roster-b', 'working')], vault: 'proj' });
    expect(rows.map((r) => r.key)).toEqual(['tab:b']);
  });

  it('another chosen project\'s chats, unregistered folders and draining conversations are no row here', () => {
    const rows = openRows({
      tabs: [], live: [live('x', 'asking', 'other'), live('y', 'idle', null), live('z', 'idle'), live('d', 'working')],
      draining: ['d'], vault: 'proj',
    });
    expect(rows.map((r) => r.id)).toEqual(['z']);
  });

  it('a tab whose chat the Mac says is asking waits too (its own state is not working)', () => {
    const rows = openRows({ tabs: [tab('a', 'ready', 'held')], live: [live('held', 'asking')], vault: 'proj' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'tab', waiting: true, dot: 'asking' });
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

describe('the phone\'s rows are fed honestly (AC19-AC20)', () => {
  const surface = code('dashboard/src/components/sleepy/AgentSurface.tsx');
  const server = code('src/server/routes/agent-chat.ts');

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

  it('the wire carries lastLine from the registry', () => {
    expect(server).toMatch(/lastLine: vault \? liveChatLastLine\(entries\) : null/);
  });

  it('a Mac chat held by any roster tab (dormant too) is not listed again: claudeId from the roster', () => {
    expect(surface).toMatch(/claudeId: sessions\.current\.get\(t\.id\)\?\.claudeId \|\| claudeIdOf\.get\(t\.id\),\s*altClaudeId: claudeIdOf\.get\(t\.id\)/);
  });
});
