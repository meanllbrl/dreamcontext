import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chatWindowPanes, pageCorner, sessionHome, superLanding, superOwnedIds, superRowMarks } from '../../dashboard/src/components/sleepy/super/sessionHome';
import { adoptionBody, needsOwner } from '../../dashboard/src/components/sleepy/super/superHandover';
import { planStage, STAGE, stageItems } from '../../dashboard/src/components/sleepy/super/superLayout';
import { buildDrawerRows } from '../../dashboard/src/components/layout/newshell/drawerModel';
import { drawerTogglePanel, PAGES_WITH_PANEL } from '../../dashboard/src/lib/uxMode';
import { rosterSummary } from '../../src/server/routes/agent-sessions';

const src = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf-8');
const SURFACE = 'dashboard/src/components/sleepy/AgentSurface.tsx';
const child = (o: Record<string, unknown> = {}) => ({ sessionId: 'x', brief: '', adopted: false, startedAt: 1, ...o });
const record = (o: Record<string, unknown> = {}) => ({ enabled: true, session: 'sup', children: {}, queue: [], containers: [], ...o }) as never;

describe('note 1 and the one-home rule: a Super session never enters a chat window', () => {
  const state = record({ children: { live: child(), ended: child({ endedAt: 5 }), mine: child({ adopted: true }) }, formerChildren: ['pruned'] });

  it('owned: started, adopted, ended, pruned, being opened, and the Super itself', () => {
    const owned = superOwnedIds(state, new Map([['opening', 9]]));
    expect([...owned].sort()).toEqual(['ended', 'live', 'mine', 'opening', 'pruned', 'sup']);
    for (const id of owned) expect(sessionHome({ claudeId: id }, owned, 'sup')).toBe('super');
    expect(sessionHome({ claudeId: 'owners' }, owned, 'sup')).toBe('chat');
    expect(sessionHome({ mode: 'super' }, owned, null)).toBe('super');
  });

  it('a chat window draws only its own tabs; the panes themselves are left whole', () => {
    const panes = [{ id: 'a', tabs: ['c1', 'o1'], active: 'c1' }, { id: 'b', tabs: ['c2'], active: 'c2' }, { id: 'c', tabs: ['o2'], active: 'o2' }];
    const before = JSON.stringify(panes);
    const shown = chatWindowPanes(panes, (id) => id.startsWith('o'));
    expect(shown).toEqual([{ id: 'a', tabs: ['o1'], active: 'o1' }, { id: 'c', tabs: ['o2'], active: 'o2' }]);
    expect(JSON.stringify(panes)).toBe(before);
  });

  it("a project's saved count leaves the Super's tabs out and keeps them on disk", () => {
    const sessions = [{ sessionId: 'mine' }, { sessionId: 'pruned' }, { sessionId: 'sup' }, { sessionId: 'owners' }, {}] as never;
    const s = rosterSummary({ sessions, windows: undefined as never }, state as never);
    expect(s.tabs).toBe(2);
    expect((sessions as unknown[]).length).toBe(5);
  });

  it('the hand-over remembers a child it prunes, never drops the id', () => {
    expect(src('src/lib/super/handover.ts')).toMatch(/s\.formerChildren = \[/);
  });

  it('the running children still hold the ceiling: the window rollup is not filtered', () => {
    expect(src(SURFACE)).toMatch(/const rollup: ProjectRollup = rollupProject\(dockRows,/);
  });

  it('opening the Super in the new shell adopts no chat; classic still adopts', () => {
    expect(src(SURFACE)).toContain('adoptionBody(windowed ? [] : tabs, before?.session)');
    expect(adoptionBody([{ id: 'a', claudeId: '11111111-1111-4111-8111-111111111111', title: 't', kind: 'chat' }], null).adopt).toHaveLength(1);
  });

  it('History and links: a Super pick lands on its card, else its transcript, never a tab', () => {
    const st = { session: 'sup', containers: [{ kind: 'chat', ref: 'live' }] } as never;
    expect(superLanding('sup', st)).toBe('centre');
    expect(superLanding('live', st)).toBe('card');
    expect(superLanding('ended', st)).toBe('transcript');
    expect(src(SURFACE)).toMatch(/setExpanded\(true\);\n\s+if \(openInSuperWindowRef\.current\(past\)\) return;/);
  });

  it('window verbs: another chat cannot reach a Super tab', () => {
    expect(src(SURFACE)).toMatch(/const inScope = .*inChatWindow\(m\)/);
  });
});

describe('note 2: the Super stage has no bar and chat windows have no Super button', () => {
  it('the head is hidden on the stage, and the Super tab is gone in the new shell', () => {
    const s = src(SURFACE);
    expect(s).toContain('className="agent-overlay-head" hidden={windowed && handedOver}');
    expect(s).toMatch(/const superTab = !windowed && panesLive/);
    expect(src('dashboard/src/components/sleepy/AgentTerminal.css')).toMatch(/\.agent-overlay-head\[hidden\] \{ display: none; \}/);
  });
});

describe('note 3: a team member opens in the chat area', () => {
  it('the row sends a member intent, never the AI Team page', () => {
    const d = src('dashboard/src/components/layout/newshell/ChatDrawer.tsx');
    expect(d).not.toContain("page: 'automations'");
    expect(d).toContain("{ kind: 'member', slug: c.slug, title: c.title }");
  });
  it('the drawer marks the member on screen', () => {
    const rows = buildDrawerRows({
      projects: [{ name: 'acme', logo: false, logoStamp: null, mounted: true, asleep: false, otherWindow: false, rollup: null }],
      activeVault: 'acme', expanded: ['acme'], fanout: {},
      facts: { acme: { superOn: true, superSelected: false, chatOpen: true, team: [{ slug: 'scout', title: 'Scout', hasPhoto: false, status: 'working' }], member: 'scout' } },
    });
    expect(rows[0].children.find((c) => c.kind === 'member')).toMatchObject({ selected: true });
  });
});

describe('note 4: the drawer button stays on the page', () => {
  it('a page panel when the page has one, the chat drawer everywhere else', () => {
    expect([...PAGES_WITH_PANEL].sort()).toEqual(['brain', 'whiteboards']);
    expect(drawerTogglePanel({ chatOpen: false, page: 'whiteboards' })).toBe('page');
    expect(drawerTogglePanel({ chatOpen: false, page: 'brain' })).toBe('page');
    expect(drawerTogglePanel({ chatOpen: false, page: 'tasks' })).toBe('chat-drawer');
    expect(drawerTogglePanel({ chatOpen: true, page: 'whiteboards' })).toBe('chat-drawer');
  });
  it('the bridge never opens Chat by itself', () => {
    const i = src('dashboard/src/ProjectInstance.tsx');
    const bridge = i.slice(i.indexOf('function PageDrawerToggleBridge'), i.indexOf('function DrawerPageBridge'));
    expect(bridge).not.toContain('openAgentSurface');
  });
});

describe('note 5: no floating chat list in the new shell', () => {
  it('a page corner holds only the Super pill', () => {
    expect(pageCorner({ newShell: true, superPill: false, superDock: false, chips: 10 })).toBe('none');
    expect(pageCorner({ newShell: true, superPill: false, superDock: false, chips: 0 })).toBe('none');
    expect(pageCorner({ newShell: true, superPill: true, superDock: true, chips: 10 })).toBe('super');
  });
  it('classic keeps its corner', () => {
    expect(pageCorner({ newShell: false, superPill: false, superDock: false, chips: 3 })).toBe('chips');
    expect(pageCorner({ newShell: false, superPill: false, superDock: false, chips: 0 })).toBe('fab');
    expect(pageCorner({ newShell: false, superPill: false, superDock: true, chips: 3 })).toBe('none');
  });
});

describe('note 7: the stage leans right beside the drawer', () => {
  const FLOAT = { mode: 'float' } as never;
  const agenda = { id: 'ag', kind: 'agenda', ref: 'agenda', shape: 'portrait', place: 'float', by: 'super', size: 'large' };
  const card = (id: string, o = {}) => ({ id, kind: 'chat', ref: id, shape: 'portrait', place: 'float', by: 'super', ...o });
  const plan = (cs: unknown[], w: number, leanRight: boolean) => planStage(stageItems(cs as never, [] as never, FLOAT), FLOAT, { width: w, height: 900 }, { leanRight });

  it('with the drawer open the chat widens and moves right, the right card reaches the margin', () => {
    const cs = [agenda, card('a')];
    const off = plan(cs, 1160, false);
    const on = plan(cs, 1160, true);
    expect(on.centre.width).toBeGreaterThan(off.centre.width);
    expect(on.centre.x + on.centre.width).toBeGreaterThan(off.centre.x + off.centre.width);
    const right = on.cards.a.rect ?? on.cards.ag.rect;
    expect(on.cards.ag.size).toBe(off.cards.ag.size);
    for (const c of Object.values(on.cards)) {
      if (c.where !== 'float') continue;
      const clear = c.rect.x + c.rect.width <= on.centre.x || c.rect.x >= on.centre.x + on.centre.width;
      expect(clear).toBe(true);
      expect(c.rect.x + c.rect.width).toBeLessThanOrEqual(1160 - STAGE.MARGIN + 1e-6);
    }
    expect(right).toBeTruthy();
  });

  it('closed, the plan is byte for byte the centred one', () => {
    const cs = [agenda, card('a'), card('b')];
    const a = plan(cs, 1400, false);
    expect(a.centre.x + a.centre.width / 2).toBeCloseTo(700, 6);
    expect(JSON.stringify(planStage(stageItems(cs as never, [] as never, FLOAT), FLOAT, { width: 1400, height: 900 }, {}))).toBe(JSON.stringify(a));
  });

  it("a card the owner dropped keeps the stage as he arranged it", () => {
    const cs = [agenda, card('a', { pos: { x: 0.9, y: 0.4 }, by: 'owner' })];
    expect(JSON.stringify(plan(cs, 1160, true))).toBe(JSON.stringify(plan(cs, 1160, false)));
  });

  it('a stage too narrow to gain keeps the centred plan and every card', () => {
    const cs = [agenda, card('a'), card('b'), card('c')];
    for (const w of [640, 744, 900]) {
      const on = plan(cs, w, true);
      const off = plan(cs, w, false);
      expect(on.others.length, String(w)).toBeLessThanOrEqual(off.others.length);
      expect(on.centre.width, String(w)).toBeGreaterThanOrEqual(off.centre.width - 1e-6);
    }
  });
});

describe('note 8: New project in the shell', () => {
  it('both doors open the existing flow and it lands in this window', () => {
    expect(src('dashboard/src/components/layout/newshell/ChatDrawer.tsx')).toContain('data-testid="drawer-new-project"');
    expect(src('dashboard/src/components/layout/newshell/ProjectPicker.tsx')).toContain('data-testid="ns-picker-new-project"');
    expect(src('dashboard/src/components/layout/newshell/NewProjectFlow.tsx')).toContain('<Onboarding');
    expect(src('dashboard/src/pages/onboarding/Handoff.tsx')).toContain('landHere(project.name');
  });
});

describe('note 9: the Super Agent row', () => {
  const q = (o: Record<string, unknown>) => ({ id: 'q', sessionId: 's', kind: 'done', state: 'pending', createdAt: 1, ...o });
  it('counts children at work only, from the record', () => {
    const st = record({ children: { a: child({ row: 'working' }), b: child({ row: 'working' }), c: child({ row: 'done' }), d: child({ row: 'working', endedAt: 3 }) } });
    expect(superRowMarks(st)).toEqual({ working: 2, asking: false });
    expect(superRowMarks(null)).toEqual({ working: 0, asking: false });
  });
  it('asks while an item waits on the owner, and stops when it is done', () => {
    expect(superRowMarks(record({ queue: [q({ kind: 'owner' })] })).asking).toBe(true);
    expect(superRowMarks(record({ queue: [q({ kind: 'owner', state: 'done' })] })).asking).toBe(false);
  });
  it('the server\'s marks for a project not mounted agree with the window on every kind', () => {
    const items = [
      q({ kind: 'permission' }), q({ kind: 'owner' }), q({ kind: 'question' }), q({ kind: 'question', direct: true }),
      q({ kind: 'question', direct: true, team: 'j' }), q({ kind: 'question', state: 'escalated' }), q({ kind: 'done' }), q({ kind: 'owner', state: 'done' }),
    ];
    for (const item of items) {
      const s = rosterSummary({ sessions: [] as never, windows: undefined as never }, record({ queue: [item] }));
      expect(s.superAsking, JSON.stringify(item)).toBe(needsOwner(item as never));
    }
  });
  it('the row carries the marks on a mounted and on a far project; folded, the project row asks', () => {
    const base = { logo: false, logoStamp: null, asleep: false, otherWindow: false, rollup: null };
    const rows = buildDrawerRows({
      projects: [{ ...base, name: 'here', mounted: true }, { ...base, name: 'far', mounted: false }, { ...base, name: 'fold', mounted: false }],
      activeVault: 'here', expanded: ['here', 'far'],
      facts: { here: { superOn: true, superSelected: false, chatOpen: true, team: [], superMarks: { working: 3, asking: false } } },
      fanout: { far: { tabs: 0, superOn: true, team: [], superMarks: { working: 1, asking: true } }, fold: { tabs: 0, superOn: true, team: [], superMarks: { working: 0, asking: true } } },
    });
    expect(rows[0].children[0]).toMatchObject({ kind: 'super', working: 3, asking: false });
    expect(rows[1].children[0]).toMatchObject({ kind: 'super', working: 1, asking: true });
    expect(rows[2].superAsking).toBe(true);
  });
});
