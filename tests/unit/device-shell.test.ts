/**
 * A device shell (the tunnel on any device, a phone on the laptop listener) in the new shell
 * (hands-free W2 part 1): its drawer is chats only (a handed-over project is its one Super row, no
 * Super Agent button, no AI Team members, no window rows), New chat waits for the tunnel's live
 * read and never appears in a handed-over project, History hides what it must not open and a
 * pick is guarded twice (the window's `onPickIn`, then the surface's fresh answer), the chrome
 * offers no Settings, New project or Project Relations, and a local phone refusal is counted.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildDrawerRows, deviceChatsOf, deviceRefusesIntent, deviceWaitingCount, historyPickRefused, openChatPlan, NO_DEVICE_CHATS,
  type DrawerChild, type DrawerFacts, type DrawerProjectInput,
} from '../../dashboard/src/components/layout/newshell/drawerModel.js';
import { morePagesNarrow, DEVICE_HIDDEN_PAGES, DEVICE_MORE_PAGES } from '../../dashboard/src/components/layout/newshell/railModel.js';
import { tunnelProjects } from '../../dashboard/src/hooks/useShellProjects.js';
import { keyboardShown } from '../../dashboard/src/hooks/useKeyboardUp.js';
import type { DrawerChatFact } from '../../dashboard/src/lib/drawerIntents.js';
import type { LiveChatWire, LiveChatsWire, SuperChatWire } from '../../dashboard/src/components/handsfree/macContract.js';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const project = (name: string, o: Partial<DrawerProjectInput> = {}): DrawerProjectInput => ({
  name, logo: false, logoStamp: null, mounted: false, asleep: false, otherWindow: false, rollup: null, ...o,
});
const info = (kind: string) => ({ kind, label: kind, mood: kind }) as any;
const tab = (id: string, kind: string, o: Partial<DrawerChatFact> = {}): DrawerChatFact => ({
  id, paneId: 'p1', title: `T ${id}`, info: info(kind), attention: false, claudeId: `c-${id}`, altClaudeId: `c-${id}`, windowId: 'main', ...o,
});
const live = (vault: string, id: string, state: LiveChatWire['state'] = 'idle'): LiveChatWire => ({
  conversationId: id, vault, title: `Live ${id}`, busy: state === 'working', state, lastLine: null, updatedAt: 1,
});
const sup = (vault: string, id: string, liveNow = true, state: LiveChatWire['state'] = 'idle'): SuperChatWire => ({ jobs: [], runningIds: [], childIds: [],
  conversationId: id, vault, title: 'whatever the Mac calls it', busy: false, state, lastLine: null, updatedAt: 2, live: liveNow,
});
const facts = (o: Partial<DrawerFacts>): DrawerFacts => ({ superOn: false, superSelected: false, chatOpen: true, team: [{ slug: 'ada', title: 'Ada', hasPhoto: false, status: 'working' }], ...o });
const chats = (cs: DrawerChild[]) => cs.filter((c): c is Extract<DrawerChild, { kind: 'chat' }> => c.kind === 'chat');

/** Two chosen projects (acme on screen, globex handed over) and the Mac's live answer. */
function fixture(o: { answered?: boolean; wire?: LiveChatsWire } = {}) {
  const wire: LiveChatsWire = o.wire ?? {
    chats: [live('acme', 'c-run', 'asking'), live('globex', 'c-mine', 'working')],
    draining: ['c-drain'],
    supers: [{ ...sup('globex', 'c-super'), childIds: ['c-kid'] }],
  };
  const device = deviceChatsOf({
    activeVault: 'acme', projects: ['acme', 'globex'], tunnel: true, liveAnswered: o.answered ?? true,
    tabsByVault: { acme: [tab('a', 'ready')] }, live: o.answered === false ? undefined : wire,
  });
  const rows = buildDrawerRows({
    projects: [project('acme', { mounted: true }), project('globex')],
    activeVault: 'acme', expanded: ['acme', 'globex'], fanout: {},
    facts: { acme: facts({ windows: [{ id: 'main', name: 'Chat', working: 0, asking: 0, flagged: 0, other: 1, tabs: 1 }], activeChatId: 'a', chats: [tab('a', 'ready')] }) },
    live: o.answered === false ? undefined : wire,
    device,
  });
  return { device, rows, wire };
}

describe('a device shell\'s drawer is chats only', () => {
  it('a project: its chats by name, waiting first; no Super Agent button, no member, no window row', () => {
    const { rows } = fixture();
    const acme = rows[0];
    expect(acme.children.some((c) => c.kind === 'super' || c.kind === 'member' || c.kind === 'window')).toBe(false);
    expect(chats(acme.children).map((c) => [c.id, c.state])).toEqual([['c-run', 'asking'], ['a', 'idle']]);
    expect(chats(acme.children).find((c) => c.id === 'a')?.closable).toBe(true);
    expect(chats(acme.children).find((c) => c.id === 'c-run')?.closable).toBe(false);
  });

  it('a handed-over project lists its Super row first and the owner\'s chats beside it', () => {
    const { rows } = fixture();
    const globex = rows[1];
    const cs = chats(globex.children);
    expect(cs.map((c) => c.id)).toEqual(['super:globex', 'c-mine']);
    expect(cs[0].row.kind).toBe('super');
    expect(cs[0].title).toBe('Super Agent');
    expect(globex.children.some((c) => c.kind === 'new-chat')).toBe(false);
  });

  it('a handed-over project with no chat of the owner\'s offers New chat under its Super row', () => {
    const { rows } = fixture({ wire: { chats: [], draining: [], supers: [sup('globex', 'c-super')] } });
    expect(rows[1].children.map((c) => c.kind)).toEqual(['chat', 'new-chat']);
  });

  it('a tab holding the Super\'s conversation or a child is never one of the owner\'s rows', () => {
    const wire: LiveChatsWire = { chats: [], draining: [], supers: [{ ...sup('acme', 'c-super'), runningIds: ['c-kid'] }] };
    const device = deviceChatsOf({
      activeVault: 'acme', projects: ['acme'], tunnel: true, liveAnswered: true, live: wire,
      tabsByVault: { acme: [{ ...tab('m', 'ready'), claudeId: 'c-super' }, { ...tab('k', 'ready'), claudeId: 'c-kid' }, tab('a', 'ready')] },
    });
    expect(device.rows.map((r) => r.kind === 'super' ? 'super' : r.row.id)).toEqual(['super', 'a']);
  });

  it('an offline Super row is drawn disabled', () => {
    const { rows } = fixture({ wire: { chats: [], draining: [], supers: [sup('globex', 'c-super', false)] } });
    expect(chats(rows[1].children)[0].offline).toBe(true);
  });

  it('a quiet project offers New chat at once: nothing waits for the live read', () => {
    const rows = buildDrawerRows({
      projects: [project('globex')], activeVault: 'acme', expanded: ['globex'], facts: {}, fanout: {},
      device: deviceChatsOf({ activeVault: 'acme', projects: ['globex'], tunnel: true, liveAnswered: false, tabsByVault: {}, live: undefined }),
    });
    expect(rows[0].children).toEqual([{ kind: 'new-chat' }]);
  });

  it('a phone on the laptop listener reads no live chats and never waits for them', () => {
    const d = deviceChatsOf({ activeVault: 'acme', projects: ['acme'], tunnel: false, liveAnswered: false, tabsByVault: {}, live: undefined });
    expect(d.liveAnswered).toBe(true);
  });

  it('a project with a chat waiting opens by itself; folded, it sums its rows', () => {
    const { device } = fixture();
    const rows = buildDrawerRows({ projects: [project('acme'), project('globex')], activeVault: 'acme', expanded: [], facts: {}, fanout: {}, device });
    expect(rows[0].expanded).toBe(true);
    expect(rows[1].expanded).toBe(false);
    expect(rows[1].sum).toMatchObject({ live: 2 });
  });

  it('a Super row tap is the tunnel\'s superTap, never the hand-over', () => {
    const { rows } = fixture();
    const row = chats(rows[1].children)[0].row;
    const plan = openChatPlan(row, { vault: 'globex', hasTab: () => false, superOn: true, isSuperChild: () => false, tunnel: true });
    expect(plan.kind).toBe('super');
    const src = read('dashboard/src/components/sleepy/AgentSurface.tsx');
    // The surface refuses a `super` intent (the hand-over), and only that.
    expect(src).toMatch(/if \(readDeviceShell\(\) && deviceRefusesIntent\(intent\.kind\)\)/);
    expect(deviceRefusesIntent('super')).toBe(true);
    expect(deviceRefusesIntent('new-window')).toBe(false);
    expect(deviceRefusesIntent('new-tab')).toBe(false);
    expect(deviceRefusesIntent('open-chat')).toBe(false);
    expect(src).toMatch(/plan\.kind === 'super'[\s\S]{0,400}superTap\(plan\.row\.row, stackTabsRef\.current\)/);
  });

  it('off a device shell the fact is one constant (the OFF lock)', () => {
    const src = read('dashboard/src/components/layout/WindowChrome.tsx');
    expect(src).toMatch(/if \(!deviceShell\) return NO_DEVICE_CHATS;/);
    expect(NO_DEVICE_CHATS.rows).toEqual([]);
  });

  it('a device shell reads no project roster or team: the fan-out gets no project', () => {
    const src = read('dashboard/src/components/layout/WindowChrome.tsx');
    expect(src).toMatch(/useDrawerProjects\(newShell && !deviceShell \? drawerExpanded : \[\]/);
  });
});

describe('History on a device shell', () => {
  it('hides running, draining, Super and Super-child conversations; a handed-over project keeps its History', () => {
    const { device } = fixture();
    expect([...device.hiddenIds].sort()).toEqual(['c-drain', 'c-kid', 'c-mine', 'c-run', 'c-super']);
    const src = read('dashboard/src/components/layout/WindowChrome.tsx');
    expect(src).toMatch(/projects=\{projectOrder\}\s+currentVault=\{activeVault\}/);
    expect(src).toMatch(/hiddenIds: deviceChats\.hiddenIds, noSuper: true/);
  });

  it('the picker removes hidden rows and asks for no Super rows', () => {
    const src = read('dashboard/src/components/sleepy/ChatHistoryPicker.tsx');
    expect(src).toMatch(/!hiddenIds\?\.has\(x\.id\)/);
    expect(src).toMatch(/const superRows = noSuper \? undefined : 'group' as const;/);
    expect(src).not.toMatch(/historyPath\(q, showAgentRuns, (PAGE_LIMIT|HISTORY_PER_VAULT), '(group|only)'\)/);
    // A scope that left the projects falls back to All.
    expect(src).toMatch(/!\(projects \?\? \[\]\)\.includes\(scope\)\) \{ setScope\(ALL\)/);
  });

  it('the tunnel has ONE picker, the window\'s: every surface opener goes there', () => {
    const src = read('dashboard/src/components/sleepy/AgentSurface.tsx');
    expect(src).toMatch(/if \(historyViaWindow\) windowChrome\.openHistory\(\);/);
    expect(src).toMatch(/\{historyOpen && !historyViaWindow && \(/);
    expect(src.match(/setHistoryOpen\(true\)/g)?.length).toBe(1);
  });

  it('the pick chain: the bridge flags it, the surface asks the Mac fresh', () => {
    expect(read('dashboard/src/components/layout/newshell/DrawerIntentBridge.tsx'))
      .toMatch(/OPEN_SESSION_EVENT, \{ claudeId: intent\.sessionId, pick: true \}/);
    const src = read('dashboard/src/components/sleepy/AgentSurface.tsx');
    expect(src).toMatch(/\.\.\.\(detail\.pick \? \{ pick: true \} : \{\}\)/);
    expect(src).toMatch(/isMacPhoneSurface\(\) && \(!existing \|\| \(pick && existing\.dormant\)\)/);
    expect(src).toMatch(/if \(pick && historyPickRefused\(r, claudeId\)\) return;/);
    // The fresh read names this project (review W2 C1): with 2+ chosen projects the phone listener
    // refuses a vault-less read with 400, and the guard would refuse every pick.
    const guard = src.slice(src.indexOf('isMacPhoneSurface() && (!existing || (pick && existing.dormant))'));
    expect(guard.slice(0, 600)).toMatch(/scopedApi\.get<LiveChatsWire>\('\/agent\/live-chats'\)/);
    expect(guard.slice(0, 600)).not.toMatch(/[^d]api\.get<LiveChatsWire>/);
  });

  it('the live read keeps its last answer across a project switch and a failed poll (review W2 M1)', () => {
    const src = read('dashboard/src/hooks/useDrawerChats.ts');
    expect(src).toMatch(/placeholderData: keepPreviousData/);
    expect(src).toMatch(/answered: data !== undefined/);
  });

  it('a device shell draws no way into Settings (review W2 M2)', () => {
    expect(read('dashboard/src/components/sleepy/chat/McpPicker.tsx')).toMatch(/\{!readDeviceShell\(\) && \(\s*<button type="button" className="mcp-picker-link"/);
    const inst = read('dashboard/src/ProjectInstance.tsx');
    expect(inst).toMatch(/if \(page === 'settings' && readDeviceShell\(\)\) return;/);
    expect(inst).toMatch(/\{!readDeviceShell\(\) && <button\s+type="button"\s+className="start-intent-notice-action"/);
  });

  it('the surface\'s guard resumes no Super chat, no child, no draining chat, nothing on a failed read', () => {
    const wire = { supers: [{ ...sup('globex', 'c-super'), childIds: ['c-kid'] }], draining: ['c-drain'] };
    expect(historyPickRefused(wire, 'c-super')).toBe(true);
    expect(historyPickRefused(wire, 'c-kid')).toBe(true);
    expect(historyPickRefused(wire, 'c-drain')).toBe(true);
    expect(historyPickRefused({ ...wire, parked: ['c-parked'] }, 'c-parked')).toBe(true);
    expect(historyPickRefused(null, 'c-old')).toBe(true);
    // The owner's old chat of a handed-over project opens like any other.
    expect(historyPickRefused(wire, 'c-old')).toBe(false);
  });
});

describe('the device shell\'s chrome', () => {
  it('no Settings and no Project Relations anywhere', () => {
    expect(morePagesNarrow(true)).not.toContain('settings');
    expect(morePagesNarrow(false)).toContain('settings');
    // A phone's More is the short list, from its one constant; the Mac's stays whole.
    expect(DEVICE_MORE_PAGES).toEqual(['roadmap', 'whiteboards', 'knowledge']);
    expect(morePagesNarrow(true)).toEqual(['roadmap', 'whiteboards', 'knowledge']);
    expect(morePagesNarrow(false)).toEqual(expect.arrayContaining(['hypotheses', 'apps', 'brain', 'council', 'core', 'taxonomy', 'sleep', 'stats', 'packs', 'announcements']));
    expect([...DEVICE_HIDDEN_PAGES].sort()).toEqual(['relations', 'settings']);
    expect(read('dashboard/src/components/layout/newshell/Rail.tsx')).toMatch(/!\(device && DEVICE_HIDDEN_PAGES\.has\(RAIL_FOOT\)\) && pageRow\(RAIL_FOOT\)/);
    const shell = read('dashboard/src/components/layout/Shell.tsx');
    expect(shell).toMatch(/!\(newShell && readDeviceShell\(\) && DEVICE_HIDDEN_PAGES\.has\(p as Page\)\)/);
    expect(shell).toMatch(/if \(newShell && readDeviceShell\(\) && DEVICE_HIDDEN_PAGES\.has\(page\)\) return;/);
  });

  it('no New project, Relations, Open in window, Close project or drag in the drawer and picker', () => {
    const d = read('dashboard/src/components/layout/newshell/ChatDrawer.tsx');
    expect(d).toMatch(/\{!p\.device && \(\s*<button type="button" className="ns-dr-row ns-dr-entry" data-testid="drawer-new-project-row"/);
    expect(d).toMatch(/\{!p\.device && \(\s*<button type="button" className="ns-dr-row ns-dr-entry" data-testid="drawer-relations"/);
    expect(d).toMatch(/onPointerDown=\{p\.device \? undefined : /);
    expect(d).toMatch(/\{!p\.device && \(\s*<>[\s\S]{0,900}p\.onOpenInWindow[\s\S]{0,400}p\.onCloseProject/);
    expect(read('dashboard/src/components/layout/newshell/TitleBar.tsx')).toMatch(/onNewProject=\{device \? undefined : onNewProject\}/);
  });

  it('the title bar: the Mac\'s chip on the tunnel, no Hands-free button on any device shell', () => {
    const src = read('dashboard/src/components/layout/newshell/TitleBar.tsx');
    expect(src).toMatch(/\{!device && <div className="ns-tb-hf" data-no-drag><HandsfreeButton/);
    expect(src).toMatch(/\{device\?\.tunnel && <div className="ns-tb-hf"[^>]*><PhoneChip remote=\{device\.remote\} \/>/);
  });

  it('the controls draw only what the phone may read', () => {
    const src = read('dashboard/src/components/layout/newshell/NewShellControls.tsx');
    expect(src).toMatch(/phoneAllows\('GET', '\/api\/sleep'\) && <SleepDebtTracker/);
    expect(src).toMatch(/phoneAllows\('GET', '\/api\/launcher\/upgrade\/status'\) && <UpdateBadge/);
  });
});

describe('the tunnel\'s projects and refusals', () => {
  it('only chosen projects that exist, by name, never a logo', () => {
    expect(tunnelProjects({ vaults: [{ name: 'acme', exists: true }, { name: 'gone', exists: false }, { name: 7 }] }))
      .toEqual([{ name: 'acme', exists: true, logo: false, logoStamp: null }]);
    expect(tunnelProjects(undefined)).toEqual([]);
  });

  it('each local phone_unavailable refusal is counted on window.__dcPhoneRefused', () => {
    const src = read('dashboard/src/api/client.ts');
    expect(src).toMatch(/countPhoneRefusal\(\);\s*throw new RequestError\('Not available on the phone\.', 403, 'phone_unavailable'\)/);
    expect(src).toMatch(/w\.__dcPhoneRefused = \(w\.__dcPhoneRefused \?\? 0\) \+ 1;/);
  });

  it('the launcher and the window list projects through useShellProjects', () => {
    expect(read('dashboard/src/pages/LauncherRoot.tsx')).toMatch(/useShellProjects\(newShell\)/);
    expect(read('dashboard/src/components/layout/WindowChrome.tsx')).toMatch(/useShellProjects\(newShell\)/);
  });

  it('named windows stay the Mac\'s: a device shell keeps the non-window path', () => {
    const surface = read('dashboard/src/components/sleepy/AgentSurface.tsx');
    expect(surface).toContain('const newShell = useIsNewShell();');
    expect(surface).toMatch(/const windowed = newShell && !readDeviceShell\(\);/);
  });
});

describe('the phone layout in the new shell (part 2)', () => {
  const surface = read('dashboard/src/components/sleepy/AgentSurface.tsx');
  const chrome = read('dashboard/src/components/layout/WindowChrome.tsx');

  it('the phone layout exists only in the new shell, and both hooks always run', () => {
    expect(surface).toMatch(/const narrowTouch = useIsMobile\(\);\s*const newShell = useIsNewShell\(\);\s*const isMobile = narrowTouch && newShell;/);
    expect(chrome).toMatch(/const isMobile = newShell && narrowTouch;/);
    // The classic shell has no phone branch left: a classic-frozen tablet keeps its Header.
    const shell = read('dashboard/src/components/layout/Shell.tsx');
    expect(shell).not.toMatch(/PhoneBar|useIsMobile|dataset\.phone/);
    expect(read('dashboard/src/components/layout/Shell.css')).not.toContain('[data-phone]');
  });

  it('the drawer toggle counts what waits elsewhere, never the chat on screen', () => {
    const { device } = fixture();
    // acme's live asking chat is waiting; nothing is on screen.
    expect(deviceWaitingCount(device, null)).toBe(1);
    const waiting = device.rows.find((r) => r.section === 'waiting')!;
    // A tab of acme on screen that is not the waiting one leaves the count as it is.
    expect(deviceWaitingCount(device, { vault: 'acme', chatId: 'a' })).toBe(1);
    expect(waiting.vault).toBe('acme');
    const onScreen = { rows: [{ ...waiting, kind: 'open', row: { kind: 'tab', id: 'x' } } as any] };
    expect(deviceWaitingCount(onScreen, { vault: 'acme', chatId: 'x' })).toBe(0);
    expect(deviceWaitingCount(onScreen, { vault: 'globex', chatId: 'x' })).toBe(1);
  });

  it('a phone opens with the drawer open, unless the window was built for a link', () => {
    expect(chrome).toMatch(/useState\(\(\) => newShell && readIsMobile\(\) && !wasOpenedForLink\(\)\)/);
    // The Chat page coming up under it in the same project is not a reason to close it.
    expect(chrome).toMatch(/if \(isMobile && !prev\.onChat && activeOnChat && prev\.vault === activeVault\) return;/);
    // A link landing closes it; so does a project pick.
    expect(chrome).toMatch(/if \(Object\.keys\(pendingLinks\)\.length > 0\) setFloatingOpen\(false\);/);
    expect(chrome).toMatch(/onPick=\{\(name\) => \{ setFloatingOpen\(false\); void addTab\(name\); \}\}/);
  });

  it('every rail and bottom-bar tap dismisses the drawer', () => {
    const rail = read('dashboard/src/components/layout/newshell/Rail.tsx');
    expect(rail).toContain('onClick={() => { dismissDrawer(); onNavigate(page); }}');
    expect(rail).toContain('onClick={() => { dismissDrawer(); openAgentSurface(bus); }}');
    expect(rail).toContain('onPick={(p) => { setMoreOpen(false); dismissDrawer(); onNavigate(p); }}');
    expect(chrome).toMatch(/dismissDrawer: dismissFloating/);
  });

  it('back is ONE window-level mark: from a chat back to the drawer, never out of the app', () => {
    expect(chrome).toMatch(/const backMarkOn = isMobile && activeOnChat && !drawerVisible && !historyOpen;/);
    expect(chrome).toMatch(/window\.history\.pushState\(\{ phoneChat: mark \}, ''\);\s*\/\/[^\n]*\n\s*const onPop = \(\) => \{ if \(drawerFloatsRef\.current\) setFloatingOpen\(true\); \};/);
    expect(surface).not.toContain('pushState');
  });

  it('the window owns body[data-phone], the full-height first screen and the keyboard switch', () => {
    expect(chrome).toMatch(/useLayoutEffect\(\(\) => \{\s*if \(!isMobile\) return undefined;\s*document\.body\.dataset\.phone = 'true';/);
    expect(chrome).toContain('home={drawerHome}');
    expect(chrome).toContain("data-keyboard={keyboardUp ? 'true' : undefined}");
    expect(read('dashboard/src/components/layout/newshell/ChatDrawer.css')).toMatch(/\.ns-drawer\[data-floating="true"\]\[data-home="true"\]/);
    expect(read('dashboard/src/components/layout/newshell/NewShell.css')).toMatch(/\[data-keyboard="true"\] \.ns-rail\[data-narrow="true"\] \{ display: none; \}/);
    expect(read('dashboard/src/components/layout/ProjectTabs.css')).toMatch(/body\[data-phone\] \.window-chrome \{\s*height: 100dvh;/);
  });

  it('the keyboard counts from 120 px of lost viewport, not a URL bar', () => {
    expect(keyboardShown(844, 844)).toBe(false);
    expect(keyboardShown(844, 780)).toBe(false);
    expect(keyboardShown(844, 500)).toBe(true);
    expect(keyboardShown(0, 0)).toBe(false);
  });

  it('a phone\'s Chat page with no chat is one line and one button, never the setup screen', () => {
    expect(surface).toMatch(/\} else if \(isMobile\) \{\s*body = <div className="agent-term">\{phoneEmpty\}<\/div>;/);
    expect(surface).toContain('{shownPanes.length === 0 && isMobile && phoneEmpty}');
    // A handed-over project: New chat too, and its Super row, disabled while the Mac runs no chat for it.
    expect(surface).toMatch(/disabled=\{!phoneSuperRow\.row\.live\}/);
    expect(surface).toMatch(/\{canSpawn && \(\s*<button type="button" className="chat-btn primary" data-testid="chat-empty-new"/);
  });

  it('the Super Agent button\'s chat half is keyed on the device shell', () => {
    expect(surface).toMatch(/const superTab = !windowed && panesLive && \(handedOver \|\| \(chatMode && !readDeviceShell\(\)\)\)/);
  });

  it('a finger gets the touch title bar: data-touch from a coarse pointer, no zoom menu', () => {
    expect(chrome).toMatch(/data-shell="new" data-touch=\{coarse \? 'true' : undefined\}/);
    expect(read('dashboard/src/components/layout/newshell/TitleBar.tsx')).toContain('{!touch && <ZoomMenu');
  });
});
