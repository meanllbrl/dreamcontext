/**
 * The Mac drawer is flat window rows again (no chat rows, nested or not; owner's call, 1 Kasım);
 * chats by name live only in the device shell's drawer (`device-shell.test.ts`). The row-open
 * plan stays for that shell: a tap selects a tab, adopts a running chat, or lands on the stage for a Super child; a
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

describe('the Mac drawer: flat window rows, never a chat row (1 Kasım: back to 0.36.10)', () => {
  const far = (o: Partial<FanoutFacts>): FanoutFacts => ({ tabs: 1, superOn: false, team: [], windows: [{ id: 'main', name: 'Chat', tabs: 1 }], ...o });

  it('a mounted project with published tabs: its window rows only, however many windows', () => {
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
    const kids = rows[0].children;
    expect(chatRows(kids)).toEqual([]);
    // The empty window draws no row; the two with tabs do, flat.
    expect(kids.map((c) => (c.kind === 'window' ? `win:${c.id}` : c.kind))).toEqual(['super', 'win:main', 'win:w2']);
  });

  it('one window holding chats keeps its window row (it is not replaced by its chats)', () => {
    const rows = buildDrawerRows({
      projects: [project('acme', { mounted: true })],
      activeVault: 'acme', expanded: ['acme'], fanout: {},
      facts: { acme: facts({ windows: [win('main', 'Chat', 3)], activeWindowId: 'main', chats: [tab('a', 'ready'), tab('b', 'working')] }) },
    });
    expect(rows[0].children.map((c) => c.kind)).toEqual(['super', 'window']);
  });

  it('no chats at all: the New Chat row, as before', () => {
    const rows = buildDrawerRows({
      projects: [project('acme', { mounted: true })],
      activeVault: 'acme', expanded: ['acme'], fanout: {},
      facts: { acme: facts({ windows: [win('main', 'Chat', 0)], chats: [] }) },
    });
    expect(rows[0].children.map((c) => c.kind)).toEqual(['super', 'new-chat']);
  });

  it('folded: the sum counts the window rows, not the tabs by name', () => {
    const rows = buildDrawerRows({
      projects: [project('acme', { mounted: true })],
      activeVault: 'acme', expanded: [], fanout: {},
      facts: {
        acme: facts({
          windows: [{ id: 'main', name: 'Chat', working: 1, asking: 0, flagged: 0, other: 1, tabs: 2 }], activeWindowId: 'main',
          chats: [tab('a', 'ready'), tab('b', 'working'), tab('c', 'asking')],
        }),
      },
    });
    expect(rows[0].sum).toMatchObject({ working: 1, idle: 1, asking: 0 });
  });

  it('an unmounted project: its window row, never the Mac\'s running chats', () => {
    const liveWire: LiveChatsWire = { chats: [live('globex', 'g1'), live('globex', 'g2', 'asking')], draining: [] };
    const rows = buildDrawerRows({
      projects: [project('acme', { mounted: true }), project('globex')],
      activeVault: 'acme', expanded: ['globex'], facts: {}, fanout: { globex: far({}) },
      // A stray `live` is ignored by the Mac path.
      ...({ live: liveWire } as object),
    });
    expect(rows[1].children.map((c) => c.kind)).toEqual(['super', 'window']);
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
