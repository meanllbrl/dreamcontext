import type { Page } from '../Sidebar';

/**
 * The new shell's navigation, as data (Mağaza D1 C7): core first (Chat, Tasks, Knowledge, Map,
 * Whiteboards), then the plugin pages this Mac pinned, then Launchpad, Mağaza and More, with
 * Settings at the foot. A plugin page that is installed but not pinned is reached from Launchpad;
 * one that is not installed is reached only as its Mağaza page.
 */
export type RailEntry = { kind: 'chat' } | { kind: 'page'; page: Page } | { kind: 'sep' } | { kind: 'more' };

/** The core pages on the rail, after Chat. */
export const CORE_RAIL_PAGES: readonly Page[] = ['tasks', 'knowledge', 'brain', 'whiteboards'];

/** The rail for a set of pinned plugin pages (registry order, installed ones only). */
export function railEntries(pinned: readonly Page[] = []): RailEntry[] {
  return [
    { kind: 'chat' },
    ...CORE_RAIL_PAGES.map((page): RailEntry => ({ kind: 'page', page })),
    { kind: 'sep' },
    ...(pinned.length ? [...pinned.map((page): RailEntry => ({ kind: 'page', page })), { kind: 'sep' } as RailEntry] : []),
    // Launchpad (the `apps` page) holds installed plugins and apps; Mağaza is where more come from.
    { kind: 'page', page: 'apps' },
    { kind: 'page', page: 'store' },
    { kind: 'more' },
  ];
}

/** The rail with nothing pinned. */
export const RAIL_ENTRIES: readonly RailEntry[] = railEntries();

/** Pinned to the rail's foot. */
export const RAIL_FOOT: Page = 'settings';

/** More's rows, in order. */
export const MORE_PAGES: readonly Page[] = ['core', 'sleep', 'stats'];

/** At 600px and below the rail is a bottom bar of five; everything else, Settings included,
 *  moves into More. */
export const BOTTOM_BAR: readonly (Page | 'chat' | 'more')[] = ['chat', 'tasks', 'knowledge', 'apps', 'more'];

/** The phone's More (a device shell's bottom bar): the pages worth opening on a phone, and only
 *  these. The one line to change that list. A plugin page that is not installed is dropped. */
export const DEVICE_MORE_PAGES: readonly Page[] = ['roadmap', 'whiteboards', 'knowledge', 'store'];

/** More's rows on the bottom bar: the rail pages the bar has no room for, then More's own, then
 *  Settings. A device shell has its own short list. */
export function morePagesNarrow(device = false, pinned: readonly Page[] = []): Page[] {
  if (device) return [...DEVICE_MORE_PAGES];
  const onBar = new Set<string>(BOTTOM_BAR);
  const railPages = railEntries(pinned).flatMap((e) => (e.kind === 'page' && !onBar.has(e.page) ? [e.page] : []));
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
