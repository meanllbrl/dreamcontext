/**
 * The new shell's chat drawer as data (task codex-tarzi-yeni-kabuk W2-A, AC 7/8b/9/10): row
 * order, the Super Agent row always first, only team members with work, mounted vs fan-out
 * sources, the intent rule at the ceiling, reordering, and the History fan-out merge.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildDrawerRows, buildGlobalTeam, dropInOrder, ekipByProject, fanoutWithMarks, intentLands, liveMembersOf, moveInOrder, teamChildOf,
  teamRowsOf, windowDropBefore, windowDropIsNoop, type DrawerChild, type DrawerProjectInput,
} from '../../dashboard/src/components/layout/newshell/drawerModel.js';
import { buildEkip, ekipFaces, ekipLine, ekipRank, globalOpenVault, ownerFacing, setMemberEnabled } from '../../dashboard/src/components/aiteam/teamModel.js';
import type { SuperMemberSummary } from '../../dashboard/src/lib/superTypes.js';
import { fanOutHistory, HISTORY_PARALLEL, HISTORY_PER_VAULT } from '../../dashboard/src/components/layout/newshell/historyFanout.js';
import { chill, oldestEvictable } from '../../dashboard/src/components/layout/instanceCeiling.js';
import type { ProjectRollup } from '../../dashboard/src/components/sleepy/agentStatus.js';

const rollup = (o: Partial<Record<string, number>> = {}) => ({
  worst: 'idle', live: 0, waiting: 0, asking: 0, working: 0, idle: 0, flagged: 0, alive: 0, ...o,
}) as any;

const project = (name: string, o: Partial<DrawerProjectInput> = {}): DrawerProjectInput => ({
  name, logo: false, logoStamp: null, mounted: false, asleep: false, otherWindow: false, rollup: null, ...o,
});

/** One `summary=1` `members` entry. */
function summary(slug: string, o: Partial<SuperMemberSummary> = {}): SuperMemberSummary {
  return { slug, global: false, enabled: true, ownerWorking: 0, asking: false, approval: false, unread: 0, superOnly: false, lastAt: 0, ...o };
}

const team = (slug: string, status: string, extra: Record<string, unknown> = {}) => ({
  slug, title: slug, hasPhoto: false, status, readOnly: false, ...extra,
}) as any;

describe('drawer rows', () => {
  it('keeps the picker order and expands several projects at once', () => {
    const rows = buildDrawerRows({
      projects: [project('acme', { mounted: true, rollup: rollup() }), project('globex'), project('initech')],
      activeVault: 'acme',
      expanded: ['acme', 'initech'],
      facts: {},
      fanout: {},
    });
    expect(rows.map((r) => r.name)).toEqual(['acme', 'globex', 'initech']);
    expect(rows.map((r) => r.expanded)).toEqual([true, false, true]);
    expect(rows[1].children).toEqual([]);
  });

  it('puts the Super Agent row first under every expanded project, even before anything is read', () => {
    const rows = buildDrawerRows({
      projects: [project('acme', { mounted: true, rollup: rollup() }), project('globex')],
      activeVault: 'acme', expanded: ['acme', 'globex'], facts: {}, fanout: {},
    });
    for (const r of rows) {
      expect(r.children[0].kind).toBe('super');
    }
    // Nothing read yet: no window row is invented for it (New Chat comes with the facts).
    expect(rows[1].children.map((c) => c.kind)).toEqual(['super']);
    expect(rows[1].source).toBe('none');
  });

  it('lists only members with work, those that want the owner first', () => {
    const listed = teamRowsOf([
      team('idle-one', 'idle'), team('runner', 'working'), team('asker', 'needs'),
      team('paused-one', 'paused'), team('review', 'approval'), team('theirs', 'needs', { readOnly: true }),
    ]);
    expect(listed.map((m) => m.slug)).toEqual(['asker', 'review', 'runner']);
  });

  it('takes a mounted project from its facts and rollup, a far one from the fan-out', () => {
    const rows = buildDrawerRows({
      projects: [
        project('acme', { mounted: true, rollup: rollup({ live: 4, working: 2, asking: 1, idle: 1, flagged: 1 }) }),
        project('globex'),
      ],
      activeVault: 'acme',
      expanded: ['acme', 'globex'],
      facts: { acme: { superOn: true, superSelected: false, chatOpen: true, team: [{ slug: 'digest', title: 'Digest', hasPhoto: false, status: 'working' }] } },
      fanout: { globex: { tabs: 3, superOn: false, team: [] } },
    });
    expect(rows[0].source).toBe('mounted');
    expect(rows[0].children).toEqual([
      { kind: 'super', on: true, selected: false, working: 0, asking: false },
      // No member row: a headless row alone is no Ekip row (plan-r10 1d reads `summary=1` `members`).
      { kind: 'window', id: 'main', name: 'Chat', working: 2, asking: 1, flagged: 1, other: 1, selected: true },
    ]);
    expect(rows[1].source).toBe('fanout');
    // No ring for a project that is not mounted: nothing runs there.
    expect(rows[1].children[1]).toMatchObject({ kind: 'window', working: 0, other: 3, selected: false });
  });

  it('marks the Super row selected (not the window) while the stage is on screen, only for the active project', () => {
    const facts = { superOn: true, superSelected: true, chatOpen: true, team: [] };
    const rows = buildDrawerRows({
      projects: [project('acme', { mounted: true, rollup: rollup() }), project('globex', { mounted: true, rollup: rollup() })],
      activeVault: 'acme', expanded: ['acme', 'globex'], facts: { acme: facts, globex: facts }, fanout: {},
    });
    expect(rows[0].children[0]).toMatchObject({ kind: 'super', selected: true });
    expect(rows[0].children.map((c) => c.kind)).toEqual(['super']);
    expect(rows[1].children[0]).toMatchObject({ kind: 'super', selected: false });
  });

  it('says which rows this window holds, which sleep and which live in another window', () => {
    const rows = buildDrawerRows({
      projects: [project('acme', { mounted: true }), project('globex', { asleep: true }), project('initech', { otherWindow: true }), project('umbrella')],
      activeVault: 'acme', expanded: [], facts: {}, fanout: {},
    });
    expect(rows.map((r) => [r.held, r.asleep, r.otherWindow])).toEqual([
      [true, false, false], [true, true, false], [false, false, true], [false, false, false],
    ]);
  });
});

describe('drawer intents', () => {
  it('travel only to a project this window now shows mounted', () => {
    expect(intentLands('added', true)).toBe(true);
    expect(intentLands('focused-tab', true)).toBe(true);
    // Another OS window holds it: that window comes forward and nothing is queued here.
    expect(intentLands('focused-window', false)).toBe(false);
    // All six busy: refused with the notice.
    expect(intentLands('refused-ceiling', false)).toBe(false);
    // A cold chip the ceiling would not wake.
    expect(intentLands('focused-tab', false)).toBe(false);
  });

  it('a pick at the ceiling puts the oldest idle project to sleep, never one with a live chat', () => {
    const open = [
      { vault: 'a', cold: false, rollup: rollup({ alive: 1 }) },
      { vault: 'b', cold: false, rollup: rollup({ alive: 0 }) },
      { vault: 'c', cold: false, rollup: null },
    ] as any[];
    const victim = oldestEvictable(open, ['c']);
    expect(victim?.vault).toBe('b');
    expect(chill(open, 'b').find((p: any) => p.vault === 'b').cold).toBe(true);
  });
});

describe('drawer order', () => {
  it('moves a project one step, an end stays put', () => {
    expect(moveInOrder(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveInOrder(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(moveInOrder(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
  });

  it('drops a dragged project before the row under the pointer', () => {
    expect(dropInOrder(['a', 'b', 'c', 'd'], 'a', 3)).toEqual(['b', 'c', 'a', 'd']);
    expect(dropInOrder(['a', 'b', 'c', 'd'], 'd', 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(dropInOrder(['a', 'b', 'c', 'd'], 'b', 4)).toEqual(['a', 'c', 'd', 'b']);
  });
});

describe('the drawer and History, wired', () => {
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../dashboard/src/${rel}`, import.meta.url)), 'utf-8');
  it('classic History renders no extra box (byte-identical markup)', () => {
    const picker = src('components/sleepy/ChatHistoryPicker.tsx');
    expect(picker).toMatch(/return on \? <div className="chp-body">\{children\}<\/div> : <>\{children\}<\/>;/);
    expect(picker).toMatch(/<BodyWrap on=\{cross\}>/);
  });
  it('a project row is two sibling buttons, never a button inside a button', () => {
    const drawer = src('components/layout/newshell/ChatDrawer.tsx');
    expect(drawer).not.toMatch(/role="button"/);
    expect(drawer).toMatch(/<button type="button" className="ns-dr-toggle" aria-expanded=\{row\.expanded\}/);
  });
  it('History names the projects it could not read', () => {
    expect(src('components/sleepy/ChatHistoryPicker.tsx')).toMatch(/setFailedVaults\(r\.failed\)/);
  });
});

describe('History across projects', () => {
  it('asks every project, at most three at once, the first 30 each, newest first, each row with its project', async () => {
    let inFlight = 0;
    let peak = 0;
    const read = async (vault: string) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const sessions = Array.from({ length: 40 }, (_, i) => ({ id: `${vault}-${i}`, updatedAt: vault.length * 1000 + (40 - i) }));
      return { sessions, total: 40, agentRuns: 1 };
    };
    const r = await fanOutHistory(['a', 'bb', 'ccc', 'dddd', 'eeeee'], read, () => true);
    expect(peak).toBeLessThanOrEqual(HISTORY_PARALLEL);
    expect(r.sessions).toHaveLength(5 * HISTORY_PER_VAULT);
    expect(r.sessions[0]).toMatchObject({ id: 'eeeee-0', vault: 'eeeee' });
    expect(r.total).toBe(200);
    for (const s of r.sessions) expect(s.id.startsWith(s.vault)).toBe(true);
  });

  it('a newer query stops this one starting more requests; a failed project is named', async () => {
    const asked: string[] = [];
    let live = true;
    const read = async (vault: string) => {
      asked.push(vault);
      if (vault === 'b') throw new Error('down');
      await new Promise((r) => setTimeout(r, 5));
      live = false;
      return { sessions: [] };
    };
    const r = await fanOutHistory(['a', 'b', 'c', 'd', 'e', 'f'], read, () => live);
    expect(asked.length).toBeLessThan(6);
    expect(r.failed).toContain('b');
  });
});

describe('named chat windows in the drawer (W3)', () => {
  const rollupOf = (o: Partial<ProjectRollup> = {}): ProjectRollup => ({ worst: 'idle', live: 0, waiting: 0, alive: 0, asking: 0, working: 0, idle: 0, flagged: 0, ...o });
  const proj = (name: string, o: Partial<DrawerProjectInput> = {}): DrawerProjectInput => ({ name, logo: false, logoStamp: null, mounted: false, asleep: false, otherWindow: false, rollup: null, ...o });

  it('one row per window, each with its own ring and count; only the window on screen is selected', () => {
    const rows = buildDrawerRows({
      projects: [proj('acme', { mounted: true, rollup: rollupOf({ live: 3 }) })],
      activeVault: 'acme', expanded: ['acme'], fanout: {},
      facts: { acme: {
        superOn: false, superSelected: false, chatOpen: true, team: [],
        windows: [
          { id: 'main', name: 'Chat', working: 1, asking: 0, flagged: 0, other: 0 },
          { id: 'w2', name: 'Refactor', working: 0, asking: 1, flagged: 0, other: 1 },
        ],
        activeWindowId: 'w2',
      } },
    });
    expect(rows[0].children.slice(1)).toEqual([
      { kind: 'window', id: 'main', name: 'Chat', working: 1, asking: 0, flagged: 0, other: 0, selected: false },
      { kind: 'window', id: 'w2', name: 'Refactor', working: 0, asking: 1, flagged: 0, other: 1, selected: true },
    ]);
  });

  it('a far project lists its saved windows with their tab counts, no ring', () => {
    const rows = buildDrawerRows({
      projects: [proj('globex')], activeVault: null, expanded: ['globex'], facts: {},
      fanout: { globex: { tabs: 3, superOn: false, team: [], windows: [{ id: 'main', name: 'Chat', tabs: 1 }, { id: 'w2', name: 'Two', tabs: 2 }] } },
    });
    expect(rows[0].children.slice(1).map((c) => c.kind === 'window' && [c.name, c.working, c.other])).toEqual([['Chat', 0, 1], ['Two', 0, 2]]);
  });

  it('a collapsed mounted project shows the sum of its windows beside its name', () => {
    const rows = buildDrawerRows({
      projects: [proj('acme', { mounted: true, rollup: rollupOf({ live: 4, working: 2, asking: 1, flagged: 1 }) })],
      activeVault: 'acme', expanded: [], facts: {}, fanout: {},
    });
    expect(rows[0].sum).toEqual({ live: 4, asking: 1, working: 2, idle: 1, flagged: 1 });
    expect(rows[0].children).toEqual([]);
  });
});

describe('where a dragged chat row lands', () => {
  const rows = [{ id: 'a', top: 100, height: 32 }, { id: 'b', top: 132, height: 32 }, { id: 'c', top: 164, height: 32 }];

  it('lands before the first row whose middle is below the pointer, the last spot is the end', () => {
    expect(windowDropBefore(rows, 120)).toBe('b');
    expect(windowDropBefore(rows, 150)).toBe('c');
    expect(windowDropBefore(rows, 190)).toBeNull();
  });

  it('pulled above the chats (over Super Agent or a team row) it stops at the first chat', () => {
    expect(windowDropBefore(rows, 10)).toBe('a');
  });

  it('a drop on itself or right after itself is no move', () => {
    const ids = ['a', 'b', 'c'];
    expect(windowDropIsNoop(ids, 'b', 'b')).toBe(true);
    expect(windowDropIsNoop(ids, 'b', 'c')).toBe(true);
    expect(windowDropIsNoop(ids, 'c', null)).toBe(true);
    expect(windowDropIsNoop(ids, 'a', null)).toBe(false);
    expect(windowDropIsNoop(ids, 'c', 'a')).toBe(false);
  });

  it('only window rows are chats: Super Agent and the team sit before them, whatever the order', () => {
    const [row] = buildDrawerRows({
      projects: [{ name: 'acme', logo: false, logoStamp: null, mounted: true, asleep: false, otherWindow: false, rollup: null }],
      activeVault: 'acme',
      expanded: ['acme'],
      facts: { acme: {
        superOn: true, superSelected: false, chatOpen: true,
        team: [{ slug: 'm', title: 'M', hasPhoto: false, status: 'working' }],
        members: [summary('m', { ownerWorking: 1 })],
        identities: [{ slug: 'm', title: 'M', hasPhoto: false }],
        windows: [
          { id: 'w2', name: 'Two', working: 0, asking: 0, flagged: 0, other: 1, tabs: 1 },
          { id: 'main', name: 'Chat', working: 1, asking: 0, flagged: 0, other: 0, tabs: 1 },
        ],
        activeWindowId: 'main',
      } },
      fanout: {},
    });
    // A project with members keeps its New chat row (r8-07): its chevron starts a member's conversation.
    expect(row.children.map((c) => (c.kind === 'window' ? c.id : c.kind))).toEqual(['super', 'team', 'w2', 'main', 'new-chat']);
  });
});

describe('the Ekip row (plan-r10 1d) and the Global ekip row (1f)', () => {
  const facts = (members: ReturnType<typeof summary>[], o: Record<string, unknown> = {}) => ({
    superOn: true, superSelected: false, chatOpen: true, team: [], members,
    identities: members.map((m) => ({ slug: m.slug, title: m.slug.toUpperCase(), hasPhoto: false })), ...o,
  });
  const teamOf = (rows: ReturnType<typeof buildDrawerRows>, i = 0) => {
    const r = rows[i];
    return (r.children.find((c) => c.kind === 'team') ?? r.team) as Extract<DrawerChild, { kind: 'team' }> | undefined;
  };

  it('ten members are ONE row, under the Super Agent row', () => {
    const ten = Array.from({ length: 10 }, (_, i) => summary(`m${i}`, { unread: i === 3 ? 2 : 0 }));
    const rows = buildDrawerRows({
      projects: [project('acme', { mounted: true, rollup: rollup() })], activeVault: 'acme', expanded: ['acme'],
      facts: { acme: facts(ten) as any }, fanout: {},
    });
    expect(rows[0].children.filter((c) => c.kind === 'team')).toHaveLength(1);
    expect(rows[0].children[1].kind).toBe('team');
    expect(teamOf(rows)!.members).toHaveLength(10);
  });

  it('one count = owner questions + owner unread + approval cards; question colour when one waits', () => {
    const members = [
      summary('asker', { asking: true }), summary('reader', { unread: 3 }), summary('gate', { approval: true }),
      summary('busy', { ownerWorking: 2 }),
    ];
    const t = teamChildOf('acme', buildEkip(members, []), false)!;
    expect(t.count).toBe(1 + 3 + 1);
    expect(t.asking).toBe(true);
    expect(teamChildOf('acme', buildEkip([summary('reader', { unread: 3 })], []), false)!.asking).toBe(false);
  });

  it('a member working only for the Super is listed with its tag, never counted', () => {
    const members = buildEkip([summary('pera', { superOnly: true }), summary('rota', { asking: true })], []);
    const t = teamChildOf('acme', members, false)!;
    expect(t.members.map((m) => m.slug)).toEqual(['rota', 'pera']);
    expect(t.members.find((m) => m.slug === 'pera')!.superOnly).toBe(true);
    expect(t.count).toBe(1);
    expect(ekipLine(t.members.find((m) => m.slug === 'pera')!)).toEqual({ key: 'drawer.team.superWorking' });
  });

  it('the list order: owner-facing first, then "Super için", then idle, then off', () => {
    const order = buildEkip([
      summary('off', { enabled: false, unread: 4 }), summary('idle', { lastAt: 5 }), summary('forsuper', { superOnly: true }),
      summary('work', { ownerWorking: 2, pending: 1 } as any), summary('ask', { asking: true }),
    ], []).map((m) => m.slug);
    expect(order).toEqual(['ask', 'work', 'forsuper', 'idle', 'off']);
    const work = buildEkip([summary('work', { ownerWorking: 2, pending: 1 } as any)], [])[0];
    // `pending` is main's: it never fills "sırada".
    expect(ekipLine(work)).toEqual({ key: 'drawer.member.working', n: 2, q: 0 });
    expect(ekipLine(buildEkip([summary('o', { enabled: false })], [])[0])).toEqual({ key: 'drawer.team.off' });
  });

  it('main\'s queued requests (`pending`) never show to the owner (AC45): the member stays "Super için", uncounted, not facing', () => {
    // Main ran `super team ask x` three times while x was busy on an earlier one.
    const [x] = buildEkip([summary('x', { superOnly: true, pending: 3 } as any)], []);
    expect(x.superOnly).toBe(true);
    expect(ownerFacing(x)).toBe(false);
    expect(ekipRank(x)).toBe(1);
    expect(ekipLine(x)).toEqual({ key: 'drawer.team.superWorking' });
    expect(Object.keys(x)).not.toContain('queued');
    expect(teamChildOf('acme', [x], false)).toMatchObject({ count: 0, asking: false });
    // A member with nothing of the owner's but main's pending is idle, not owner-facing.
    const [y] = buildEkip([summary('y', { pending: 2 } as any)], []);
    expect(ownerFacing(y)).toBe(false);
    expect(ekipRank(y)).toBe(2);
    // A global member's opening project is never picked by main's pending.
    const per = [
      { vault: 'a', members: buildEkip([summary('g', { global: true, pending: 4, lastAt: 90 } as any)], []) },
      { vault: 'b', members: buildEkip([summary('g', { global: true, unread: 1, lastAt: 10 })], []) },
    ];
    expect(globalOpenVault('g', per, null)).toEqual({ project: 'b', openIn: 'b' });
  });

  it('up to three faces, the ones at work first', () => {
    const members = buildEkip([summary('a'), summary('b'), summary('c', { ownerWorking: 1 }), summary('d', { superOnly: true })], []);
    expect(ekipFaces(members).map((m) => m.slug)).toEqual(['c', 'd', 'a']);
  });

  it('a collapsed project keeps its Ekip row (from the folded read)', () => {
    const fanout = fanoutWithMarks({}, { far: { working: 0, asking: false } }, ['far'], {
      far: { members: [summary('rota', { unread: 1 })], identities: [{ slug: 'rota', title: 'Rota', hasPhoto: false }] },
    });
    const rows = buildDrawerRows({ projects: [project('far')], activeVault: null, expanded: [], facts: {}, fanout });
    expect(rows[0].expanded).toBe(false);
    expect(rows[0].team).toMatchObject({ kind: 'team', vault: 'far', count: 1 });
    expect(rows[0].team!.members[0].title).toBe('Rota');
  });

  it('global members are only in the Global ekip row: summed over projects, approval card once, opening where they face the owner', () => {
    const acme = [summary('rota', { unread: 1 }), summary('atlas', { global: true, asking: true, approval: true, lastAt: 100 })];
    const globex = [summary('gantt', { global: true, lastAt: 50 }), summary('atlas', { global: true, unread: 2, approval: true, lastAt: 300 })];
    const rows = buildDrawerRows({
      projects: [project('acme', { mounted: true, rollup: rollup() }), project('globex')],
      activeVault: 'acme', expanded: ['acme', 'globex'],
      facts: { acme: facts(acme) as any }, fanout: { globex: { tabs: 0, superOn: true, team: [], members: globex, identities: [] } },
    });
    expect(teamOf(rows, 0)!.members.map((m) => m.slug)).toEqual(['rota']);
    expect(teamOf(rows, 1)).toBeUndefined();
    const global = buildGlobalTeam(ekipByProject({
      projects: [project('acme', { mounted: true }), project('globex')],
      facts: { acme: facts(acme) as any }, fanout: { globex: { tabs: 0, superOn: true, team: [], members: globex, identities: [] } },
    }), 'acme')!;
    expect(global.members.map((m) => m.slug)).toEqual(['atlas', 'gantt']);
    // acme: one question; globex: two unread; the approval card ONCE.
    expect(global.count).toBe(1 + 2 + 1);
    expect(global.asking).toBe(true);
    const atlas = global.members.find((m) => m.slug === 'atlas')!;
    // Its newest owner-facing item is in globex (lastAt 300).
    expect(atlas).toMatchObject({ project: 'globex', openIn: 'globex' });
    // Nothing faces the owner: the project in view.
    expect(global.members.find((m) => m.slug === 'gantt')).toMatchObject({ project: null, openIn: 'acme' });
  });

  it('a global member with nothing for the owner and no project in view opens where it last worked, else the first project', () => {
    const per = [
      { vault: 'a', members: buildEkip([summary('g', { global: true, lastAt: 10 })], []) },
      { vault: 'b', members: buildEkip([summary('g', { global: true, lastAt: 90 })], []) },
    ];
    expect(globalOpenVault('g', per, null)).toEqual({ project: null, openIn: 'b' });
    const never = per.map((p) => ({ ...p, members: buildEkip([summary('g', { global: true })], []) }));
    expect(globalOpenVault('g', never, null)).toEqual({ project: null, openIn: 'a' });
  });

  it('no Global ekip row when no project has a member of all projects', () => {
    expect(buildGlobalTeam([{ vault: 'a', members: buildEkip([summary('rota')], []) }], 'a')).toBeNull();
  });

  it('the switch calls POST /api/agents/:slug/enabled, a global member\'s too (it writes the global manifest)', async () => {
    const calls: Array<[string, unknown]> = [];
    const api = { post: async (path: string, body: unknown) => { calls.push([path, body]); return {}; } };
    await setMemberEnabled(api, 'rota', false);
    await setMemberEnabled(api, 'atlas', true);
    expect(calls).toEqual([['/agents/rota/enabled', { enabled: false }], ['/agents/atlas/enabled', { enabled: true }]]);
  });

  it('the drawer and the lists wire the pinned test ids, the switch and the member intent', () => {
    const drawer = readFileSync(fileURLToPath(new URL('../../dashboard/src/components/layout/newshell/ChatDrawer.tsx', import.meta.url)), 'utf8');
    const list = readFileSync(fileURLToPath(new URL('../../dashboard/src/components/layout/newshell/TeamList.tsx', import.meta.url)), 'utf8');
    for (const id of ['drawer-team-row', 'phone-team-row', 'drawer-global-team-row', 'phone-global-team-row', 'new-chat-menu', 'new-chat-claude', 'new-chat-member', 'team-list', 'global-team-list']) {
      expect(drawer, id).toContain(`'${id}'`.replace(/'/g, drawer.includes(`"${id}"`) ? '"' : "'"));
    }
    for (const id of ['team-list-member', 'team-member-switch', 'team-manage', 'phone-team-sheet']) expect(list, id).toContain(id);
    expect(list).toContain('role="switch"');
    expect(drawer).toContain("pick(vault, { kind: 'member', slug: m.slug, title: m.title })");
    // "Üyeleri yönet" is desktop only.
    expect(drawer).toMatch(/!phone && p\.onManage/);
  });

  it('a phone reads its Ekip rows from live-chats members', () => {
    const live = { chats: [], draining: [], members: [{ vault: 'acme', members: [summary('rota', { asking: true })] }, { vault: 7 }, { vault: 'x', members: 'no' }] };
    expect(liveMembersOf(live)).toEqual([{ vault: 'acme', members: [summary('rota', { asking: true })] }]);
    const rows = buildDrawerRows({
      projects: [project('acme', { mounted: true })], activeVault: 'acme', expanded: ['acme'], facts: {}, fanout: {},
      device: { rows: [], members: liveMembersOf(live) },
    });
    expect(rows[0].children.map((c) => c.kind)).toEqual(['team', 'new-chat']);
  });
});
