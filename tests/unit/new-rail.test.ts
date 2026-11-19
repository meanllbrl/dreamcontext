/**
 * The new shell's rail (Mağaza D1 C7): core first (Chat, Tasks, Knowledge, Map, Whiteboards), the
 * plugin pages this Mac pinned, then Launchpad, Mağaza and More, Settings at the foot. Every core
 * page is reachable exactly once on the rail or in More; a plugin page is reached when pinned, from
 * Launchpad, or (not installed) as its Mağaza page. At ≤600 a bottom bar of five.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../dashboard/src/hooks/useAppsWaiting.js', () => ({ useAppsWaiting: () => 0, APPS_WAITING_KEY: 'apps-waiting' }));
vi.mock('../../dashboard/src/components/sleepy/AgentSurface.js', () => ({ PROJECT_ROLLUP_EVENT: 'dc-project-rollup' }));
const { BOTTOM_BAR, MORE_PAGES, RAIL_ENTRIES, RAIL_FOOT, morePagesNarrow, railEntries, railPageOf } = await import('../../dashboard/src/components/layout/newshell/railModel.js');
const { NAV_GROUPS } = await import('../../dashboard/src/components/layout/Sidebar.js');
const { PLUGIN_PAGES, railPluginPages, pageHidden } = await import('../../dashboard/src/lib/plugins.js');

const shape = (entries: readonly any[]) => entries.map((e: any) => (e.kind === 'page' ? e.page : e.kind));
const railPages = RAIL_ENTRIES.flatMap((e: any) => (e.kind === 'page' ? [e.page] : []));

const view = (rows: Array<[string, boolean, boolean]>) => ({
  version: '0.0.0',
  plugins: rows.map(([id, installed, pinned]) => ({ id, installed, pinned, source: 'data', hasData: installed })),
});

describe('new rail', () => {
  it('nothing pinned: Chat, Tasks, Knowledge, Map, Whiteboards | Launchpad, Mağaza, More; Settings at the foot', () => {
    expect(shape(RAIL_ENTRIES)).toEqual(['chat', 'tasks', 'knowledge', 'brain', 'whiteboards', 'sep', 'apps', 'store', 'more']);
    expect(RAIL_FOOT).toBe('settings');
  });

  it('pinned plugin pages sit between two separators, in the order given', () => {
    expect(shape(railEntries(['roadmap', 'lab']))).toEqual([
      'chat', 'tasks', 'knowledge', 'brain', 'whiteboards', 'sep', 'roadmap', 'lab', 'sep', 'apps', 'store', 'more',
    ]);
  });

  it('pins follow the installed set in registry order; an unknown set shows every plugin page', () => {
    expect(railPluginPages(null)).toEqual([...PLUGIN_PAGES]);
    expect(railPluginPages(view([['council', true, true], ['roadmap', true, true], ['lab', true, false], ['hypotheses', false, true]])))
      .toEqual(['roadmap', 'council']);
    expect(pageHidden(null, 'roadmap')).toBe(false);
    expect(pageHidden(view([['roadmap', false, false]]), 'roadmap')).toBe(true);
    expect(pageHidden(view([['roadmap', true, false]]), 'roadmap')).toBe(false);
    expect(pageHidden(view([['roadmap', false, false]]), 'tasks')).toBe(false);
  });

  it('every classic page is reachable exactly once: rail, More, or a plugin page (pin, Launchpad, Mağaza)', () => {
    const classic = new Set<string>(['stats']);
    for (const g of NAV_GROUPS) for (const i of g.items as any[]) if (!('launch' in i)) classic.add(i.page);
    const reach = [...railPages, RAIL_FOOT, ...MORE_PAGES, ...PLUGIN_PAGES];
    expect(new Set(reach).size).toBe(reach.length);
    expect([...classic].sort()).toEqual([...reach].sort());
  });

  it('at 600 and below: a bottom bar of five, the rest plus Settings in More, each once', () => {
    expect(BOTTOM_BAR).toEqual(['chat', 'tasks', 'knowledge', 'apps', 'more']);
    const narrow = [...BOTTOM_BAR.filter((x) => x !== 'chat' && x !== 'more'), ...morePagesNarrow()];
    expect(new Set(narrow).size).toBe(narrow.length);
    expect(narrow.sort()).toEqual([...railPages, RAIL_FOOT, ...MORE_PAGES].sort());
    expect(morePagesNarrow().at(-1)).toBe('settings');
    expect(morePagesNarrow(false, ['roadmap'])).toContain('roadmap');
  });

  it('the old AI Team page keys are deep-link aliases: no rail row lights for them', () => {
    expect(railPageOf('agents')).toBe('agents');
    expect(railPageOf('automations')).toBe('automations');
    expect(railPages).not.toContain('automations');
    expect(railPages).not.toContain('agents');
    expect(BOTTOM_BAR).not.toContain('automations');
  });
});
