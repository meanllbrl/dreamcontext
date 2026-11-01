/**
 * The new shell's drawer lists chats by name (hands-free phone in the new shell, W1): a mounted
 * project's published tabs, grouped by window, waiting first; a project this window has not
 * mounted lists the chats the Mac runs there only when its read says plainly it is not handed
 * over; a tap selects a tab, adopts a running chat, or lands on the stage for a Super child; a
 * close never brings the project forward and the closed chat never comes back as a live row; the
 * live read polls only while the drawer is on screen and the window focused (the tunnel: while
 * the page is visible).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildDrawerRows, drawerChatsPollMs, openChatPlan, DRAWER_POLL_MS, TUNNEL_CHATS_POLL_MS,
  type DrawerChild, type DrawerFacts, type DrawerProjectInput, type FanoutFacts,
} from '../../dashboard/src/components/layout/newshell/drawerModel.js';
import { landsOnChat, sameSurfaceState, type DrawerChatFact } from '../../dashboard/src/lib/drawerIntents.js';
import { markClosed, recentlyClosed } from '../../dashboard/src/components/sleepy/phoneClosed.js';
import type { LiveChatWire, LiveChatsWire } from '../../dashboard/src/components/handsfree/macContract.js';
import type { HomeRow } from '../../dashboard/src/components/sleepy/phoneHome.js';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const project = (name: string, o: Partial<DrawerProjectInput> = {}): DrawerProjectInput => ({
  name, logo: false, logoStamp: null, mounted: false, asleep: false, otherWindow: false, rollup: null, ...o,
});

const info = (kind: string) => ({ kind, label: kind, mood: kind }) as any;
const tab = (id: string, kind: string, windowId = 'main', o: Partial<DrawerChatFact> = {}): DrawerChatFact => ({
  id, paneId: 'p1', title: `T ${id}`, info: info(kind), attention: false, claudeId: `c-${id}`, altClaudeId: `c-${id}`, windowId, ...o,
});
const win = (id: string, name: string, tabs: number) => ({ id, name, working: 0, asking: 0, flagged: 0, other: tabs, tabs });

const facts = (o: Partial<DrawerFacts>): DrawerFacts => ({ superOn: false, superSelected: false, chatOpen: true, team: [], ...o });
const live = (vault: string | null, id: string, state: LiveChatWire['state'] = 'idle'): LiveChatWire => ({
  conversationId: id, vault, title: `Live ${id}`, busy: state === 'working', state, lastLine: null, updatedAt: 1,
});
const chatRows = (cs: DrawerChild[]) => cs.filter((c): c is Extract<DrawerChild, { kind: 'chat' }> => c.kind === 'chat');

describe('a mounted project: its published tabs by name', () => {
  it('one window: chats by name with their state, waiting first, each once, and no window row', () => {
    const rows = buildDrawerRows({
      projects: [project('acme', { mounted: true })],
      activeVault: 'acme', expanded: ['acme'], fanout: {},
      facts: {
        acme: facts({
          windows: [win('main', 'Chat', 3)], activeWindowId: 'main', activeChatId: 'b',
          chats: [tab('a', 'ready'), tab('b', 'working'), tab('c', 'asking')],
        }),
      },
      // The Mac's live list also names acme's chats: a mounted project never repeats them.
      live: { chats: [live('acme', 'c-a'), live('acme', 'c-x', 'working')], draining: [] },
    });
    const kids = rows[0].children;
    expect(kids.some((c) => c.kind === 'window')).toBe(false);
    const chats = chatRows(kids);
    expect(chats.map((c) => [c.title, c.state])).toEqual([['T c', 'asking'], ['T b', 'working'], ['T a', 'idle']]);
    expect(new Set(chats.map((c) => c.id)).size).toBe(chats.length);
    expect(chats.every((c) => c.closable && c.vault === 'acme' && !c.windowId)).toBe(true);
    expect(chats.find((c) => c.id === 'b')?.selected).toBe(true);
    // The row a tap opens is the phone list's own tab row.
    const r = chats[0].row;
    expect(r.kind === 'open' && r.row.kind === 'tab' && r.row.id).toBe('c');
  });

  it('two or more windows: each window row stays and its chats nest under it', () => {
    const rows = buildDrawerRows({
      projects: [project('acme', { mounted: true })],
      activeVault: 'acme', expanded: ['acme'], fanout: {},
      facts: {
        acme: facts({
          windows: [win('main', 'Chat', 1), win('w2', 'Research', 2), win('w3', 'Empty', 0)], activeWindowId: 'w2',
          chats: [tab('a', 'ready', 'main'), tab('b', 'ready', 'w2'), tab('c', 'asking', 'w2')],
        }),
      },
    });
    const shape = rows[0].children.slice(1).map((c) => (c.kind === 'window' ? `win:${c.id}` : c.kind === 'chat' ? `chat:${c.id}@${c.windowId}` : c.kind));
    expect(shape).toEqual(['win:main', 'chat:a@main', 'win:w2', 'chat:c@w2', 'chat:b@w2']);
  });

  it('no chats at all: the New Chat row, as before', () => {
    const rows = buildDrawerRows({
      projects: [project('acme', { mounted: true })],
      activeVault: 'acme', expanded: ['acme'], fanout: {},
      facts: { acme: facts({ windows: [win('main', 'Chat', 0)], chats: [] }) },
    });
    expect(rows[0].children.map((c) => c.kind)).toEqual(['super', 'new-chat']);
  });

  it('a surface that publishes no chats keeps today\'s window rows', () => {
    const rows = buildDrawerRows({
      projects: [project('acme', { mounted: true })],
      activeVault: 'acme', expanded: ['acme'], fanout: {},
      facts: { acme: facts({ windows: [win('main', 'Chat', 2)] }) },
    });
    expect(rows[0].children.map((c) => c.kind)).toEqual(['super', 'window']);
  });

  it('handed over: the owner\'s chats show, the Super\'s running children (in the live list) never do', () => {
    const rows = buildDrawerRows({
      projects: [project('acme', { mounted: true })],
      activeVault: 'acme', expanded: ['acme'], fanout: {},
      facts: { acme: facts({ superOn: true, windows: [win('main', 'Chat', 1)], chats: [tab('mine', 'ready')] }) },
      live: { chats: [live('acme', 'child-1', 'working'), live('acme', 'child-2')], draining: [] },
    });
    expect(chatRows(rows[0].children).map((c) => c.id)).toEqual(['mine']);
  });
});

describe('a project this window has not mounted', () => {
  const liveWire: LiveChatsWire = {
    chats: [live('globex', 'g1'), live('globex', 'g2', 'asking'), live('globex', 'gone'), live('initech', 'i1'), live(null, 'nameless')],
    draining: ['gone'],
  };
  const far = (o: Partial<FanoutFacts>): FanoutFacts => ({ tabs: 1, superOn: false, team: [], windows: [{ id: 'main', name: 'Chat', tabs: 1 }], ...o });

  it('read as not handed over: its window row, then the Mac\'s running chats by name, waiting first, never a draining one', () => {
    const rows = buildDrawerRows({
      projects: [project('acme', { mounted: true }), project('globex')],
      activeVault: 'acme', expanded: ['globex'], facts: {}, fanout: { globex: far({}) }, live: liveWire,
    });
    const kids = rows[1].children;
    expect(kids.map((c) => c.kind)).toEqual(['super', 'window', 'chat', 'chat']);
    const chats = chatRows(kids);
    expect(chats.map((c) => [c.id, c.state])).toEqual([['g2', 'asking'], ['g1', 'idle']]);
    expect(chats.every((c) => !c.closable && !c.selected)).toBe(true);
    const r = chats[0].row;
    expect(r.kind === 'open' && r.row.kind === 'mac' && r.row.chat.conversationId).toBe('g2');
  });

  it('handed over: its window row and no live rows (they are the Super\'s children)', () => {
    const rows = buildDrawerRows({
      projects: [project('acme', { mounted: true }), project('globex')],
      activeVault: 'acme', expanded: ['globex'], facts: {}, fanout: { globex: far({ superOn: true }) }, live: liveWire,
    });
    expect(rows[1].children.map((c) => c.kind)).toEqual(['super', 'window']);
  });

  it('held by another window: no live rows (a tap there would only bring that window forward)', () => {
    const rows = buildDrawerRows({
      projects: [project('acme', { mounted: true }), project('globex', { otherWindow: true })],
      activeVault: 'acme', expanded: ['globex'], facts: {}, fanout: { globex: far({}) }, live: liveWire,
    });
    expect(chatRows(rows[1].children)).toEqual([]);
  });

  it('not read yet: no live rows at all', () => {
    const rows = buildDrawerRows({
      projects: [project('acme', { mounted: true }), project('globex')],
      activeVault: 'acme', expanded: ['globex'], facts: {}, fanout: {}, live: liveWire,
    });
    expect(rows[1].children.map((c) => c.kind)).toEqual(['super']);
  });

  it('a chat closed here does not come back as a live row while its process exits', () => {
    markClosed(['g1']);
    expect(recentlyClosed()).toContain('g1');
    const rows = buildDrawerRows({
      projects: [project('acme', { mounted: true }), project('globex')],
      activeVault: 'acme', expanded: ['globex'], facts: {}, fanout: { globex: far({}) }, live: liveWire, closed: recentlyClosed(),
    });
    expect(chatRows(rows[1].children).map((c) => c.id)).toEqual(['g2']);
  });
});

describe('what a chat row opens', () => {
  const tabRow = (vault: string, id: string): HomeRow => ({
    key: `${vault}:tab:${id}`, vault, kind: 'open', section: 'idle', title: '', line: '', updatedAt: null,
    row: { kind: 'tab', key: `tab:${id}`, id, paneId: 'p1', title: '', dot: 'ready', stateKey: null, label: '', waiting: false, rank: 2 },
  });
  const macRow = (vault: string, id: string): HomeRow => ({
    key: `${vault}:mac:${id}`, vault, kind: 'open', section: 'idle', title: '', line: '', updatedAt: 1,
    row: { kind: 'mac', key: `mac:${id}`, id, chat: live(vault, id), title: '', dot: 'ready', stateKey: '', waiting: false, rank: 2, lastLine: '' },
  });
  const ctx = (o: Partial<Parameters<typeof openChatPlan>[1]> = {}) => ({
    vault: 'acme', hasTab: (id: string) => id === 'agent-1', superOn: false, isSuperChild: () => false, tunnel: false, ...o,
  });

  it('a tab here is selected; a tab that has gone opens nothing', () => {
    expect(openChatPlan(tabRow('acme', 'agent-1'), ctx())).toEqual({ kind: 'tab', id: 'agent-1' });
    expect(openChatPlan(tabRow('acme', 'agent-9'), ctx())).toEqual({ kind: 'none' });
  });

  it('a chat the Mac runs is adopted (the same process), never resumed beside it', () => {
    const plan = openChatPlan(macRow('acme', 'conv-1'), ctx());
    expect(plan.kind).toBe('adopt');
    expect(plan.kind === 'adopt' && plan.chat.conversationId).toBe('conv-1');
  });

  it('a stale "not handed over" read with a Super child row lands on the stage and adopts nothing', () => {
    // The drawer read superOn: false; the project's own record says it is handed over now.
    const plan = openChatPlan(macRow('acme', 'child-1'), ctx({ superOn: true, isSuperChild: (id) => id === 'child-1' }));
    expect(plan).toEqual({ kind: 'stage' });
    // The owner's own chat in a handed-over project still adopts.
    expect(openChatPlan(macRow('acme', 'mine'), ctx({ superOn: true, isSuperChild: (id) => id === 'child-1' })).kind).toBe('adopt');
  });

  it('a row of another project opens nothing here; a Super row opens only on the tunnel', () => {
    expect(openChatPlan(tabRow('globex', 'agent-1'), ctx())).toEqual({ kind: 'none' });
    const superRow: HomeRow = { key: 'super:acme', vault: 'acme', kind: 'super', section: 'idle', title: '', line: '', updatedAt: null, row: { ...live('acme', 's'), vault: 'acme', live: true } };
    expect(openChatPlan(superRow, ctx())).toEqual({ kind: 'none' });
    expect(openChatPlan(superRow, ctx({ tunnel: true })).kind).toBe('super');
  });
});

describe('the live read\'s cadence', () => {
  const mac = { tunnel: false, desktop: true, drawerVisible: true, focused: true, hidden: false };
  it('the Mac polls only while the drawer is on screen and the window focused', () => {
    expect(drawerChatsPollMs(mac)).toBe(DRAWER_POLL_MS);
    expect(drawerChatsPollMs({ ...mac, drawerVisible: false })).toBe(false);
    expect(drawerChatsPollMs({ ...mac, focused: false })).toBe(false);
    expect(drawerChatsPollMs({ ...mac, hidden: true, focused: false })).toBe(false);
  });
  it('a window the route does not answer never polls', () => {
    expect(drawerChatsPollMs({ ...mac, desktop: false })).toBe(false);
  });
  it('the tunnel polls at its quicker cadence the whole time the page is visible (drawer or chat screen)', () => {
    expect(drawerChatsPollMs({ ...mac, tunnel: true, desktop: false })).toBe(TUNNEL_CHATS_POLL_MS);
    expect(drawerChatsPollMs({ ...mac, tunnel: true, desktop: false, drawerVisible: false })).toBe(TUNNEL_CHATS_POLL_MS);
    expect(drawerChatsPollMs({ ...mac, tunnel: true, desktop: false, hidden: true })).toBe(false);
  });
});

describe('the intents', () => {
  it('a close never lands on the chat area; an open does', () => {
    expect(landsOnChat({ kind: 'close-chat', id: 'x' })).toBe(false);
    expect(landsOnChat({ kind: 'open-chat', row: {} as HomeRow })).toBe(true);
  });

  it('a change in the published chats is a change in the surface state', () => {
    const base = { superOn: false, superSelected: false, chats: [tab('a', 'ready')], activeChatId: 'a' };
    expect(sameSurfaceState(base, { ...base })).toBe(true);
    expect(sameSurfaceState(base, { ...base, chats: [tab('a', 'working')] })).toBe(false);
    expect(sameSurfaceState(base, { ...base, activeChatId: 'b' })).toBe(false);
  });

  it('the window queues a close without bringing the project forward', () => {
    const src = read('dashboard/src/components/layout/WindowChrome.tsx');
    expect(src).toMatch(/if \(intent\.kind === 'move-window' \|\| intent\.kind === 'close-chat'\) return 'focused-tab';/);
  });

  it('the surface closes through the one tab-close path, asks first through confirmAction, marks it closed', () => {
    const src = read('dashboard/src/components/sleepy/AgentSurface.tsx');
    const body = src.slice(src.indexOf('const closeChatRow = useCallback'), src.indexOf('const openChatTab = useCallback'));
    // The state the row shows decides: sub-agents at work and a starting chat ask too.
    expect(body).toMatch(/deriveSessionStatus\(\{[^}]*agentsWorking: agentsWorkingOf\(live\)/);
    expect(body).toMatch(/shown === 'working' \|\| shown === 'asking' \|\| shown === 'starting'/);
    expect(body).toMatch(/await confirmAction\(/);
    expect(body).not.toMatch(/window\.confirm|[^.]confirm\(/);
    expect(body.indexOf('markClosed(')).toBeGreaterThan(-1);
    expect(body.indexOf('markClosed(')).toBeLessThan(body.indexOf('closeSessionById(id)'));
    // A close returns before anything expands or moves.
    const run = src.slice(src.indexOf('runDrawerIntentRef.current = (intent) =>'));
    expect(run.indexOf("intent.kind === 'close-chat'")).toBeLessThan(run.indexOf('setExpanded(true)'));
  });

  it('on touch the chat row is as tall as its 44 px close, so the close never reaches the row above', () => {
    const css = read('dashboard/src/components/layout/newshell/ChatDrawer.css');
    const coarse = css.slice(css.indexOf('@media (pointer: coarse)', css.indexOf('.ns-dr-cclose')));
    const block = coarse.slice(0, coarse.indexOf('\n}\n'));
    expect(block).toMatch(/\.ns-dr-cclose \{[^}]*width: 44px;[^}]*height: 44px;/);
    expect(block).toMatch(/\.ns-dr-chat \.ns-dr-chatrow \{[^}]*height: 44px;/);
  });

  it('the live read builds its own client for the project on screen, never the instance\'s', () => {
    const src = read('dashboard/src/hooks/useDrawerChats.ts');
    expect(src).toMatch(/new ApiClient\(o\.activeVault\)\.get<LiveChatsWire>\('\/agent\/live-chats'\)/);
    expect(src).not.toMatch(/useApi\(/);
  });
});
