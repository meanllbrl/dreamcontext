/**
 * Named chat windows in one project's chat surface (task codex-tarzi-yeni-kabuk W3, D8):
 * the pure model in `chatWindows.ts`, and the source guards that hold AgentSurface to it.
 *
 *  - switching windows parks the shown window's panes and keeps every session (none is closed,
 *    none drops out of the roster; parked tabs are never pulled into the window on screen);
 *  - the last window cannot be closed; a closed window's neighbour comes up;
 *  - each window has its own rollup (ring and count) for the drawer;
 *  - save → restore keeps each tab in its window, with ONE pane index across the surface, and a
 *    roster from before windows restores as one window;
 *  - every path that adds a tab passes `admitTab()` (the 40-tab ceiling), bar the named exemptions.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  addWindow, dropWindow, initialWindows, neighbourOf, parkedHomes, placeTab, pruneParked, renameWindow, restoreWindows,
  rowsByWindow, savePlacement, splitOut, joinInto, switchWindow, unparkPanes, windowOfTab, TAB_CAP,
  type WindowsState, type WinTab,
} from '../../dashboard/src/components/sleepy/chatWindows.js';
import { rollupProject, type SessionRow } from '../../dashboard/src/components/sleepy/agentStatus.js';
import { MAX_SESSIONS } from '../../src/server/routes/agent-sessions.js';

const SURFACE = readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'sleepy', 'AgentSurface.tsx'), 'utf-8');

const tabs: WinTab[] = [
  { id: 'agent-1', claudeId: 'c1' },
  { id: 'agent-2', claudeId: 'c2' },
  { id: 'agent-3', claudeId: 'c3' },
];
let seq = 0;
const mint = () => `pane-t${++seq}`;

/** Two windows: main shows c1|c2 (two panes), w2 is parked holding c3. */
function twoWindows(): { state: WindowsState; live: { panes: Array<{ id: string; tabs: string[]; active: string }>; activePaneId: string } } {
  const live = { panes: [{ id: 'p1', tabs: ['agent-1'], active: 'agent-1' }, { id: 'p2', tabs: ['agent-2'], active: 'agent-2' }], activePaneId: 'p2' };
  const state: WindowsState = {
    list: [
      { id: 'main', name: 'Chat', panes: [], activePaneId: '' },
      { id: 'w2', name: 'Refactor', panes: [{ id: 'p3', tabs: ['c3'], active: 'c3' }], activePaneId: 'p3' },
    ],
    activeId: 'main',
  };
  return { state, live };
}

describe('switching windows', () => {
  it('parks the shown panes and brings the target back live, by conversation id', () => {
    const { state, live } = twoWindows();
    const sw = switchWindow(state, 'w2', live, tabs)!;
    expect(sw.state.activeId).toBe('w2');
    expect(sw.panes).toEqual([{ id: 'p3', tabs: ['agent-3'], active: 'agent-3' }]);
    expect(sw.activePaneId).toBe('p3');
    // main is parked with BOTH panes and its focus: nothing of it was closed.
    const main = sw.state.list.find((w) => w.id === 'main')!;
    expect(main.panes).toEqual([{ id: 'p1', tabs: ['c1'], active: 'c1' }, { id: 'p2', tabs: ['c2'], active: 'c2' }]);
    expect(main.activePaneId).toBe('p2');
    // …and switching back restores the very same layout.
    const back = switchWindow(sw.state, 'main', { panes: sw.panes, activePaneId: sw.activePaneId }, tabs)!;
    expect(back.panes).toEqual(live.panes);
    expect(back.activePaneId).toBe('p2');
  });

  it('a parked tab survives a respawn (its session id changes, its conversation does not)', () => {
    const { state, live } = twoWindows();
    const respawned = tabs.map((t) => (t.id === 'agent-3' ? { id: 'agent-9', claudeId: 'c3' } : t));
    const sw = switchWindow(state, 'w2', live, respawned)!;
    expect(sw.panes[0].tabs).toEqual(['agent-9']);
  });

  it('the parked conversations are known, so the reconcile never pulls them on screen', () => {
    const { state } = twoWindows();
    expect([...parkedHomes(state).entries()]).toEqual([['c3', 'w2']]);
    expect(windowOfTab(state, 'c3')).toBe('w2');
    expect(windowOfTab(state, 'c1')).toBe('main');
    expect(SURFACE).toMatch(/const parked = parkedHomes\(chatWindows\);[\s\S]{0,200}!parked\.has\(m\.claudeId\)/);
  });

  it('the other windows\' chats stay mounted: every chat session is portaled, not only the shown panes\'', () => {
    // `chatPanes` (the portals) are built from the live sessions, never from `panes`.
    expect(SURFACE).toMatch(/\{chatPanes\.map\(\(cs\) => createPortal\(/);
    expect(SURFACE).not.toMatch(/chatPanes = panes\./);
  });

  it('a closed conversation leaves its parked window; an emptied pane goes with it', () => {
    const { state } = twoWindows();
    const pruned = pruneParked(state, new Set(['c1', 'c2']));
    expect(pruned.list.find((w) => w.id === 'w2')!.panes).toEqual([]);
    expect(pruneParked(state, new Set(['c1', 'c2', 'c3']))).toBe(state);
  });
});

describe('new, rename, close', () => {
  it('a new window lands right after the shown one, selected and empty; the shown one is parked', () => {
    const { state, live } = twoWindows();
    const r = addWindow(state, 'Chat 3', live, tabs, 1_700_000_000_000);
    expect(r.state.list.map((w) => w.id)).toEqual(['main', r.id, 'w2']);
    expect(r.state.activeId).toBe(r.id);
    expect(r.id).toMatch(/^[a-z0-9-]{1,24}$/);
    expect(r.state.list[0].panes.length).toBe(2);
  });

  it('a blank rename reverts; a long one is capped', () => {
    const { state } = twoWindows();
    expect(renameWindow(state, 'w2', '   ')).toBe(state);
    expect(renameWindow(state, 'w2', 'x'.repeat(80)).list[1].name).toHaveLength(60);
  });

  it('the last window is never dropped, nor the one on screen', () => {
    const one = initialWindows();
    expect(dropWindow(one, 'main')).toBe(one);
    const { state } = twoWindows();
    expect(dropWindow(state, 'main')).toBe(state);
    expect(dropWindow(state, 'w2').list.map((w) => w.id)).toEqual(['main']);
    expect(neighbourOf(state, 'main')).toBe('w2');
    expect(neighbourOf(state, 'w2')).toBe('main');
  });

  it('closing the last window empties it to a fresh tab, through the one tab-close path, with the in-app confirm', () => {
    const close = SURFACE.slice(SURFACE.indexOf('const closeChatWindow = useCallback('), SURFACE.indexOf('const runDrawerIntentRef'));
    expect(close).toContain('confirmAction(');
    expect(close).not.toMatch(/window\.confirm|\bconfirm\(/);
    expect(close).toContain("tRef.current('shell.windows.closeRunning.body')");
    expect(close).toMatch(/now\.list\.length <= 1\) \{\s+for \(const m of closing\) closeSessionById\(m\.id\);\s+setFreshTabNonce/);
  });
});

describe('the rollup per window', () => {
  const row = (id: string, claudeId: string, kind: 'working' | 'asking' | 'idle'): SessionRow => ({
    id, title: id, kind: 'chat', claudeId, attention: false,
    info: { kind, label: kind, mood: kind === 'idle' ? 'idle' : kind } as SessionRow['info'],
  });
  it("each window's ring counts only its own chats", () => {
    const { state } = twoWindows();
    const rows = [row('agent-1', 'c1', 'working'), row('agent-2', 'c2', 'idle'), row('agent-3', 'c3', 'asking')];
    const by = rowsByWindow(state, rows, () => undefined);
    const main = rollupProject(by.get('main')!);
    const w2 = rollupProject(by.get('w2')!);
    expect([main.working, main.asking]).toEqual([1, 0]);
    expect([w2.working, w2.asking]).toEqual([0, 1]);
  });
});

describe('save and restore', () => {
  it('saves ONE pane index across the surface, window after window, and restores each tab to its window', () => {
    const { state, live } = twoWindows();
    const sp = savePlacement(state, live, tabs);
    expect([...sp.placement.entries()]).toEqual([
      ['agent-1', { window: 'main', pane: 0, active: true }],
      ['agent-2', { window: 'main', pane: 1, active: true }],
      ['agent-3', { window: 'w2', pane: 2, active: true }],
    ]);
    expect(sp.windows).toEqual([{ id: 'main', name: 'Chat', activePane: 1 }, { id: 'w2', name: 'Refactor', activePane: 2 }]);
    expect(sp.activePane).toBe(1);

    // A relaunch: new session ids, same conversations.
    const restored = [
      { id: 'r1', claudeId: 'c1', ...sp.placement.get('agent-1')! },
      { id: 'r2', claudeId: 'c2', ...sp.placement.get('agent-2')! },
      { id: 'r3', claudeId: 'c3', ...sp.placement.get('agent-3')! },
    ];
    const r = restoreWindows(sp.windows, restored, sp.activePane, mint);
    expect(r.state.activeId).toBe('main');
    expect(r.live.map((p) => p.tabs)).toEqual([['r1'], ['r2']]);
    expect(r.live.find((p) => p.id === r.activePaneId)!.tabs).toEqual(['r2']);
    expect(unparkPanes(r.state.list[1].panes, [{ id: 'r3', claudeId: 'c3' }]).map((p) => p.tabs)).toEqual([['r3']]);
    expect(r.state.list.map((w) => w.name)).toEqual(['Chat', 'Refactor']);
  });

  it('the window holding the focused pane comes up', () => {
    const r = restoreWindows(
      [{ id: 'main', name: 'Chat' }, { id: 'w2', name: 'Two', activePane: 3 }],
      [{ id: 'a', claudeId: 'ca', window: 'main', pane: 0 }, { id: 'b', claudeId: 'cb', window: 'w2', pane: 3 }],
      3, mint,
    );
    expect(r.state.activeId).toBe('w2');
    expect(r.live.map((p) => p.tabs)).toEqual([['b']]);
  });

  it('a roster from before windows restores as ONE window with every tab, panes as saved', () => {
    const r = restoreWindows(undefined, [
      { id: 'a', claudeId: 'ca', pane: 0, active: true },
      { id: 'b', claudeId: 'cb', pane: 2 },
      { id: 'c', claudeId: 'cc', pane: 2, active: true },
    ], 2, mint);
    expect(r.state.list.map((w) => w.id)).toEqual(['main']);
    expect(r.live.map((p) => [p.tabs, p.active])).toEqual([[['a'], 'a'], [['b', 'c'], 'c']]);
  });

  it('a tab naming an unknown window lands in the first', () => {
    const r = restoreWindows([{ id: 'w9', name: 'Only' }], [{ id: 'a', claudeId: 'ca', window: 'gone', pane: 0 }], undefined, mint);
    expect(r.state.activeId).toBe('w9');
    expect(r.live.map((p) => p.tabs)).toEqual([['a']]);
  });

  it('AgentSurface saves `windows` and each tab\'s `window`, and classic hands both back unchanged', () => {
    expect(SURFACE).toMatch(/windows: windowsOut,/);
    expect(SURFACE).toMatch(/\.\.\.\(windowOf\.has\(m\.id\) \? \{ window: windowOf\.get\(m\.id\) \} : \{\}\)/);
    expect(SURFACE).toMatch(/classicHomeRef\.current\.get\(m\.claudeId\)/);
    expect(SURFACE).toMatch(/windowsOut = chatWindows\.list\.map\(\(w\) => \(\{ id: w\.id, name: w\.name \}\)\)/);
  });
});

describe('pane moves inside a parked window', () => {
  it('split, join and place keep the shapes the live surface makes', () => {
    const panes = [{ id: 'p1', tabs: ['c1', 'c2'], active: 'c2' }];
    expect(splitOut(panes, 'c2', 'pn')).toEqual([{ id: 'p1', tabs: ['c1'], active: 'c1' }, { id: 'pn', tabs: ['c2'], active: 'c2' }]);
    expect(joinInto([{ id: 'p1', tabs: ['c1'], active: 'c1' }, { id: 'p2', tabs: ['c2'], active: 'c2' }], 'c2', 'p1'))
      .toEqual([{ id: 'p1', tabs: ['c1', 'c2'], active: 'c2' }]);
    expect(placeTab(panes, 'p1', 'c9', false, 'pn')).toEqual({ panes: [{ id: 'p1', tabs: ['c1', 'c2', 'c9'], active: 'c9' }], activePaneId: 'p1' });
    expect(placeTab(panes, 'p1', 'c9', true, 'pn').panes.map((p) => p.id)).toEqual(['p1', 'pn']);
    expect(placeTab([], '', 'c9', false, 'pn')).toEqual({ panes: [{ id: 'pn', tabs: ['c9'], active: 'c9' }], activePaneId: 'pn' });
  });
});

describe('the 40-tab ceiling (admitTab)', () => {
  it("is the server's MAX_SESSIONS", () => {
    expect(TAB_CAP).toBe(MAX_SESSIONS);
    expect(TAB_CAP).toBe(40);
  });

  it('every path that adds a tab passes admitTab first, bar the named exemptions', () => {
    const lines = SURFACE.split('\n');
    const adds = lines.map((l, i) => ({ l, i })).filter(({ l }) => /setSessionList\(\(prev\) => (\[\.\.\.prev|\(prev\.some)/.test(l));
    expect(adds.length).toBeGreaterThanOrEqual(15);
    const unguarded: number[] = [];
    for (const { i } of adds) {
      const before = lines.slice(Math.max(0, i - 45), i).join('\n');
      const exempt = lines.slice(Math.max(0, i - 3), i).some((l) => l.includes('admitTab: exempt'));
      if (!exempt && !before.includes('admitTab()')) unguarded.push(i + 1);
    }
    expect(unguarded).toEqual([]);
    // Exactly the three the plan names: the restore, Plan→Develop, the Super Agent's own session.
    expect(SURFACE.match(/admitTab: exempt/g)).toHaveLength(3);
    // `spawnAndRegister` is gated by its callers, and only these two call it.
    expect([...SURFACE.matchAll(/spawnAndRegister\(/g)]).toHaveLength(2);
    for (const fn of ['const addSession = useCallback(', 'const addSplitSession = useCallback(']) {
      const at = SURFACE.indexOf(fn);
      expect(SURFACE.slice(at, SURFACE.indexOf('spawnAndRegister(', at))).toContain('if (!admitTab()) return');
    }
  });

  it('a refusal shows the lasting notice, and the doorbell answers "refused"', () => {
    expect(SURFACE).toMatch(/if \(open < TAB_CAP\) return true;\s+setTabCapNotice\(true\);\s+return false;/);
    expect(SURFACE).toContain("title={t('shell.notice.tabsFull')}");
    expect(SURFACE).toMatch(/openChat: \(inline, token, mode\) => \{[\s\S]{0,200}if \(!admitTab\(\)\) return null;/);
  });

  it('the hand-over checks the cap before it starts', () => {
    const at = SURFACE.indexOf('const handOver = useCallback(');
    const h = SURFACE.slice(at, SURFACE.indexOf('await enableSuper(scopedApi', at));
    expect(h.length).toBeGreaterThan(100);
    expect(h).toContain('admitTab()');
  });
});
