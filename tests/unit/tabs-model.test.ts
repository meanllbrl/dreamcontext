/**
 * The local new shell's page tabs (tek-kenar C7): Chat, Tasks, Insights, Whiteboards, Apps, More;
 * More = Roadmap, Hypotheses, Knowledge, Map, then Council, Core, Sleep, Stats; Settings at the
 * sidebar's foot. Every classic page reachable exactly once; at ≤900 Insights and Apps join More.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../dashboard/src/hooks/useAppsWaiting.js', () => ({ useAppsWaiting: () => 0, APPS_WAITING_KEY: 'apps-waiting' }));
vi.mock('../../dashboard/src/components/sleepy/AgentSurface.js', () => ({ PROJECT_ROLLUP_EVENT: 'dc-project-rollup' }));
const { TAB_PAGES, TAB_MORE, RAIL_FOOT, tabsModel, litTab } = await import('../../dashboard/src/components/layout/newshell/railModel.js');
const { NAV_GROUPS } = await import('../../dashboard/src/components/layout/Sidebar.js');

const classic = (): string[] => {
  const s = new Set<string>(['stats']);
  for (const g of NAV_GROUPS) for (const i of g.items as any[]) if (!('launch' in i)) s.add(i.page);
  return [...s].sort();
};

describe('page tabs', () => {
  it('are Chat, Tasks, Insights, Whiteboards, Apps, then More', () => {
    expect(TAB_PAGES).toEqual(['chat', 'tasks', 'lab', 'whiteboards', 'apps']);
    expect(TAB_MORE.slice(0, 4)).toEqual(['roadmap', 'hypotheses', 'knowledge', 'brain']);
    expect(RAIL_FOOT).toBe('settings');
  });

  it.each([false, true])('every classic page is reachable exactly once (narrow=%s)', (narrow) => {
    const { tabs, more } = tabsModel(narrow);
    const reach = [...tabs.filter((t: string) => t !== 'chat'), ...more, RAIL_FOOT];
    expect(new Set(reach).size).toBe(reach.length);
    expect([...reach].sort()).toEqual(classic());
  });

  it('at 900 and below Insights and Apps move into More', () => {
    const { tabs, more } = tabsModel(true);
    expect(tabs).toEqual(['chat', 'tasks', 'whiteboards']);
    expect(more.slice(0, 2)).toEqual(['lab', 'apps']);
  });

  it('lights Chat while chat is open, the page tab, or More for a More page', () => {
    expect(litTab('tasks', true, false)).toBe('chat');
    expect(litTab('whiteboards', false, false)).toBe('whiteboards');
    expect(litTab('roadmap', false, false)).toBe('more');
    expect(litTab('lab', false, true)).toBe('more');
    expect(litTab('lab', false, false)).toBe('lab');
  });
});
