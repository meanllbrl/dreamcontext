import type { Page } from '../Sidebar';

/**
 * The new shell's navigation, as data (owner-approved prototype r27, D3/W1):
 * the rail is Chat, Tasks, Insights, Roadmap, Hypotheses, Whiteboards, Apps | Knowledge, Map |
 * More, with Settings at the bottom. More holds the rest. Every page the classic sidebar reaches
 * is reachable exactly once, on the rail or in More (new-rail.test.ts).
 */
export type RailEntry = { kind: 'chat' } | { kind: 'page'; page: Page } | { kind: 'sep' } | { kind: 'more' };

export const RAIL_ENTRIES: readonly RailEntry[] = [
  { kind: 'chat' },
  { kind: 'page', page: 'tasks' },
  // No AI Team row (plan-r10 1d, `uv773y`): members live in each project's Ekip row and in
  // "Üyeleri yönet"; the `agents` page id is only a deep-link alias.
  { kind: 'page', page: 'lab' },
  { kind: 'page', page: 'roadmap' },
  { kind: 'page', page: 'hypotheses' },
  { kind: 'page', page: 'whiteboards' },
  // Apps on the rail, not in More: the first 30 seconds need it in sight (dreamcontext-apps r19).
  { kind: 'page', page: 'apps' },
  { kind: 'sep' },
  { kind: 'page', page: 'knowledge' },
  { kind: 'page', page: 'brain' },
  { kind: 'sep' },
  { kind: 'more' },
];

/** Pinned to the rail's foot. */
export const RAIL_FOOT: Page = 'settings';

/** More's rows, in order. */
export const MORE_PAGES: readonly Page[] = ['council', 'core', 'sleep', 'stats'];

/** At 600px and below the rail is a bottom bar of five; everything else, Settings included,
 *  moves into More. */
export const BOTTOM_BAR: readonly (Page | 'chat' | 'more')[] = ['chat', 'tasks', 'lab', 'roadmap', 'more'];

/** The phone's More (a device shell's bottom bar): the pages worth opening on a phone, and only
 *  these. The one line to change that list. */
export const DEVICE_MORE_PAGES: readonly Page[] = ['roadmap', 'whiteboards', 'knowledge'];

/** More's rows on the bottom bar: the rail pages the bar has no room for, then More's own, then
 *  Settings. A device shell has its own short list. */
export function morePagesNarrow(device = false): Page[] {
  if (device) return [...DEVICE_MORE_PAGES];
  const onBar = new Set<string>(BOTTOM_BAR);
  const railPages = RAIL_ENTRIES.flatMap((e) => (e.kind === 'page' && !onBar.has(e.page) ? [e.page] : []));
  return [...railPages, ...MORE_PAGES, RAIL_FOOT];
}

/** Pages a device shell (`readDeviceShell`) never offers: it drives another machine's project
 *  set, so it changes neither that machine's settings nor its projects' relations. */
export const DEVICE_HIDDEN_PAGES: ReadonlySet<Page> = new Set<Page>(['settings', 'relations']);

/** The page a rail row lights for. The AI Team row is gone: its old page ids (`agents`,
 *  `automations`) are deep-link aliases that open "Üyeleri yönet", and light nothing. */
export function railPageOf(page: Page): Page {
  return page;
}

/* ── The local new shell's page tabs (tek-kenar C7): the rail above is the device shells' only. ── */

/** A title-bar tab: Chat, a page, or More ▾. */
export type TabEntry = 'chat' | Page | 'more';

/** The tabs in the bar, in order, before More. */
export const TAB_PAGES: readonly ('chat' | Page)[] = ['chat', 'tasks', 'lab', 'whiteboards', 'apps'];

/** More's rows: Roadmap, Hypotheses, Knowledge and Map first (D8c), then the rail's own More. Settings
 *  is the sidebar's foot, so it is in neither list. */
export const TAB_MORE: readonly Page[] = ['roadmap', 'hypotheses', 'knowledge', 'brain', ...MORE_PAGES];

/** The tabs that move into More at a narrow window (≤900, a fixed breakpoint). */
export const TAB_NARROW_TO_MORE: readonly Page[] = ['lab', 'apps'];

/** The bar's tabs and More's rows at this width. Every page is reachable exactly once. */
export function tabsModel(narrow: boolean): { tabs: ('chat' | Page)[]; more: Page[] } {
  if (!narrow) return { tabs: [...TAB_PAGES], more: [...TAB_MORE] };
  const moved = new Set<string>(TAB_NARROW_TO_MORE);
  return {
    tabs: TAB_PAGES.filter((p) => !moved.has(p)),
    more: [...TAB_NARROW_TO_MORE, ...TAB_MORE],
  };
}

/** The tab lit for what the project shows: Chat while its chat is open, More when the page sits in
 *  More, else the page's own tab. */
export function litTab(page: Page, chatOpen: boolean, narrow: boolean): TabEntry {
  if (chatOpen) return 'chat';
  const { tabs } = tabsModel(narrow);
  return (tabs as string[]).includes(page) ? page : 'more';
}
