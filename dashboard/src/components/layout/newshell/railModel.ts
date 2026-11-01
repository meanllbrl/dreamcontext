import type { Page } from '../Sidebar';

/**
 * The new shell's navigation, as data (owner-approved prototype r27, D3/W1):
 * the rail is Chat, Tasks, AI Team, Insights, Roadmap, Hypotheses, Whiteboards, Apps | Knowledge, Map |
 * More, with Settings at the bottom. More holds the rest. Every page the classic sidebar reaches
 * is reachable exactly once, on the rail or in More (new-rail.test.ts).
 */
export type RailEntry = { kind: 'chat' } | { kind: 'page'; page: Page } | { kind: 'sep' } | { kind: 'more' };

export const RAIL_ENTRIES: readonly RailEntry[] = [
  { kind: 'chat' },
  { kind: 'page', page: 'tasks' },
  { kind: 'page', page: 'automations' },
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

/** More's rows, in order. Announcements carries its unread count. */
export const MORE_PAGES: readonly Page[] = ['council', 'core', 'taxonomy', 'sleep', 'packs', 'announcements', 'about'];

/** At 600px and below the rail is a bottom bar of five; everything else, Settings included,
 *  moves into More. */
export const BOTTOM_BAR: readonly (Page | 'chat' | 'more')[] = ['chat', 'tasks', 'automations', 'lab', 'more'];

/** More's rows on the bottom bar: the rail pages the bar has no room for, then More's own, then
 *  Settings. */
export function morePagesNarrow(): Page[] {
  const onBar = new Set<string>(BOTTOM_BAR);
  const railPages = RAIL_ENTRIES.flatMap((e) => (e.kind === 'page' && !onBar.has(e.page) ? [e.page] : []));
  return [...railPages, ...MORE_PAGES, RAIL_FOOT];
}

/** The page a rail row lights for: `agents` is the AI Team too. */
export function railPageOf(page: Page): Page {
  return page === 'agents' ? 'automations' : page;
}
