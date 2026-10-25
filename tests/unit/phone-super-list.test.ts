// AC4 (client) and AC6: a handed-over project's Sohbetler list on the phone is ONE Super Agent row
// and nothing else; without a hand-over the list is unchanged. The row opens the Super Agent's
// chat as a mirror (never `reattach=1`), and the owner's words typed on the other surface arrive
// as `owner_echo` and draw as the owner's bubble. Rules are plain functions; the wiring is
// checked against the source like the other phone tests (root vitest runs under plain Node).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { superRowFor, superTap } from '../../dashboard/src/components/sleepy/phoneList.js';
import { parseChatLine } from '../../dashboard/src/lib/chatProtocol.js';
import type { StackTab } from '../../dashboard/src/components/sleepy/phoneStack.js';
import type { SuperChatWire } from '../../dashboard/src/components/handsfree/macContract.js';
import { ownerEchoFrame } from '../../src/lib/super/phone-mirror.js';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const code = (p: string) => readFileSync(join(ROOT, p), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const SUPER = '11111111-2222-4333-8444-555555555555';
const row = (o: Partial<SuperChatWire> = {}): SuperChatWire => ({
  conversationId: SUPER, vault: 'proj', title: null, busy: false, state: 'idle', lastLine: null, updatedAt: null, live: true, ...o,
});
const tab = (id: string, claudeId?: string, altClaudeId?: string): StackTab =>
  ({ id, paneId: 'p1', title: id, info: { kind: 'ready', label: 'ready' } as unknown as StackTab['info'], claudeId, altClaudeId, attention: false });

describe('the Super Agent row (AC6)', () => {
  it('only a hand-over of THIS project makes the list one row', () => {
    expect(superRowFor(undefined, 'proj')).toBeNull();
    expect(superRowFor({}, 'proj')).toBeNull();
    expect(superRowFor({ supers: [] }, 'proj')).toBeNull();
    expect(superRowFor({ supers: [row({ vault: 'other' })] }, 'proj')).toBeNull();
    expect(superRowFor({ supers: [row({ vault: 'other' }), row()] }, 'proj')).toEqual(row());
  });

  it('a tap selects this phone\'s tab of it, else opens it while the Mac runs it, else does nothing', () => {
    expect(superTap(row(), [tab('t1', 'x'), tab('t2', SUPER)])).toEqual({ select: { paneId: 'p1', id: 't2' } });
    expect(superTap(row({ live: false }), [tab('t3', 'x', SUPER)])).toEqual({ select: { paneId: 'p1', id: 't3' } });
    expect(superTap(row(), [tab('t1', 'x')])).toEqual({ open: row() });
    expect(superTap(row({ live: false }), [])).toBeNull();
  });

  it('in the one list (W3) a handed-over project is its one Super row: no chat of it, no new chat there', async () => {
    const list = code('dashboard/src/components/sleepy/PhoneChatList.tsx');
    expect(list).toContain('data-testid="super-row"');
    expect(list).toMatch(/const superHere = superRowFor\(live, vault\);/);
    // No ＋ in a handed-over project (its chats are the Super's); the rest of the list stays.
    expect(list).toMatch(/\{!superHere && \(\s*<button type="button" className="mlist-foot-btn mlist-foot-btn--primary" onClick=\{onNewChat\} data-testid="list-new">/);
    for (const kept of ['list-search', 'past-row', 'mac-live-row']) expect(list).toContain(kept);
    const { homeRows } = await import('../../dashboard/src/components/sleepy/phoneHome.js');
    const rows = homeRows({
      vault: 'acme', tabs: [], projects: ['acme'], pastByVault: { acme: [{ id: 'old', title: 'old', preview: '', updatedAt: 1, startedAt: 1, sizeBytes: 1, gitBranch: '' }] },
      live: { chats: [{ conversationId: 'c1', vault: 'acme', title: 'x', busy: false, state: 'idle', lastLine: null, updatedAt: 1 }], draining: [], supers: [{ conversationId: 's', vault: 'acme', title: null, busy: false, state: 'idle', lastLine: null, updatedAt: 1, live: true }] },
    });
    expect(rows.map((r) => r.kind)).toEqual(['super']);
  });

  it('opening it never evicts the window: a passive open, no `reattach=1`', () => {
    const surface = code('dashboard/src/components/sleepy/AgentSurface.tsx');
    const fn = surface.slice(surface.indexOf('const openSuperOnPhone = useCallback'), surface.indexOf('}, [resumePastSession]);', surface.indexOf('const openSuperOnPhone')));
    expect(fn).toMatch(/resumePastSession\(\{ id: row\.conversationId[^]*'passive'\)/);
    expect(fn).not.toContain("'1'");
    expect(surface).toMatch(/onOpenSuper=\{\(row\) => \{ openSuperOnPhone\(row\); setPhoneView\('chat'\); \}\}/);
  });

  it('both languages carry the row\'s words', () => {
    const i18n = readFileSync(join(ROOT, 'dashboard/src/context/I18nContext.tsx'), 'utf-8');
    for (const k of ['handsfree.super.title', 'handsfree.super.hint', 'handsfree.super.offline']) {
      expect(i18n.split(`'${k}':`).length - 1).toBe(2);
    }
  });
});

describe('the owner\'s words from the other surface (AC4)', () => {
  it('the server\'s frame parses to an owner echo; an empty one is ignored', () => {
    expect(parseChatLine(ownerEchoFrame('  what is running?  '))).toEqual({ kind: 'owner-echo', text: 'what is running?' });
    expect(parseChatLine(ownerEchoFrame('   '))?.kind).toBe('ignored');
  });

  it('the chat draws it as the owner\'s own bubble', () => {
    const session = code('dashboard/src/components/sleepy/chatSession.ts');
    const at = session.indexOf("if (ev.kind === 'owner-echo') {");
    expect(at).toBeGreaterThan(0);
    expect(session.slice(at, at + 400)).toMatch(/kind: 'user', id: nextItemId\(\), text: ev\.text/);
  });
});
