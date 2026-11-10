/**
 * The new shell's rail (task codex-tarzi-yeni-kabuk W1, AC 4): exactly the approved order, every
 * page the classic sidebar reaches reachable exactly once on the rail or in More, and the ≤600
 * bottom bar of five with everything else (Settings included) in More.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../dashboard/src/components/sleepy/AgentSurface.js', () => ({ PROJECT_ROLLUP_EVENT: 'dc-project-rollup' }));
const { BOTTOM_BAR, MORE_PAGES, RAIL_ENTRIES, RAIL_FOOT, morePagesNarrow, railPageOf } = await import('../../dashboard/src/components/layout/newshell/railModel.js');
const { NAV_GROUPS } = await import('../../dashboard/src/components/layout/Sidebar.js');

const railPages = RAIL_ENTRIES.flatMap((e: any) => (e.kind === 'page' ? [e.page] : []));

describe('new rail', () => {
  it('is Chat, Tasks, Insights, Roadmap, Hypotheses, Whiteboards, Apps | Knowledge, Map | More, Settings at the foot (no AI Team row, plan-r10 1d)', () => {
    expect(RAIL_ENTRIES.map((e: any) => (e.kind === 'page' ? e.page : e.kind))).toEqual([
      'chat', 'tasks', 'lab', 'roadmap', 'hypotheses', 'whiteboards', 'apps', 'sep', 'knowledge', 'brain', 'sep', 'more',
    ]);
    expect(RAIL_FOOT).toBe('settings');
  });

  it('every classic page is reachable exactly once (rail or More)', () => {
    // Stats joined More only: the classic sidebar stays as it was (shell-render-equality), and ⌘U and
    // the composer's Usage details reach the page there.
    const classic = new Set<string>(['stats']);
    for (const g of NAV_GROUPS) for (const i of g.items as any[]) if (!('launch' in i)) classic.add(i.page);
    const reach = [...railPages, RAIL_FOOT, ...MORE_PAGES];
    expect(new Set(reach).size).toBe(reach.length);
    expect([...classic].sort()).toEqual([...reach].sort());
  });

  it('at 600 and below: a bottom bar of five, the rest plus Settings in More, each once', () => {
    expect(BOTTOM_BAR).toEqual(['chat', 'tasks', 'lab', 'roadmap', 'more']);
    const narrow = [...BOTTOM_BAR.filter((x) => x !== 'chat' && x !== 'more'), ...morePagesNarrow()];
    expect(new Set(narrow).size).toBe(narrow.length);
    expect(narrow.sort()).toEqual([...railPages, RAIL_FOOT, ...MORE_PAGES].sort());
    expect(morePagesNarrow().at(-1)).toBe('settings');
  });

  it('the old AI Team page keys are deep-link aliases: no rail row lights for them', () => {
    expect(railPageOf('agents')).toBe('agents');
    expect(railPageOf('automations')).toBe('automations');
    expect(railPageOf('tasks')).toBe('tasks');
    expect(railPages).not.toContain('automations');
    expect(railPages).not.toContain('agents');
    expect(BOTTOM_BAR).not.toContain('automations');
  });
});
