/**
 * The board tab strip's pure half: which boards sit open as tabs, in what order, and which
 * named, coloured groups they are gathered in — Chrome's tab strip, for whiteboards.
 * React-free on purpose so the root vitest (plain Node) can import it —
 * `tests/unit/whiteboard-tab-strip.test.ts`.
 *
 * Every operation returns a NEW layout and runs it through {@link normalizeLayout}, so the one
 * invariant the strip draws from always holds: a group's tabs sit next to each other, and a
 * group with no tabs does not exist.
 */

/** Chrome's group palette. Each name maps to a `--chart-*` token in BoardTabs.css. */
export const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan'] as const;
export type GroupColor = typeof GROUP_COLORS[number];

export interface TabGroup {
  id: string;
  /** May be empty: an unnamed group shows as a coloured dot, as in Chrome. */
  name: string;
  color: GroupColor;
  collapsed: boolean;
}

export interface BoardTab {
  slug: string;
  group?: string;
}

export interface TabLayout {
  tabs: BoardTab[];
  groups: TabGroup[];
}

/** What the strip draws, left to right. A collapsed group's tabs are left out, except the
 *  open board's: the board you are looking at always has its tab. */
export type StripItem =
  | { kind: 'group'; group: TabGroup; count: number }
  | { kind: 'tab'; slug: string; group?: TabGroup };

export const emptyLayout = (): TabLayout => ({ tabs: [], groups: [] });

const isColor = (v: unknown): v is GroupColor => typeof v === 'string' && (GROUP_COLORS as readonly string[]).includes(v);

/**
 * A layout read from storage: anything malformed is dropped rather than trusted, duplicates
 * keep their first place, and a tab naming an unknown group is ungrouped.
 */
export function sanitizeLayout(raw: unknown): TabLayout {
  if (!raw || typeof raw !== 'object') return emptyLayout();
  const r = raw as { tabs?: unknown; groups?: unknown };
  const groups: TabGroup[] = [];
  const groupIds = new Set<string>();
  for (const g of Array.isArray(r.groups) ? r.groups : []) {
    if (!g || typeof g !== 'object') continue;
    const { id, name, color, collapsed } = g as Record<string, unknown>;
    if (typeof id !== 'string' || !id || groupIds.has(id)) continue;
    groupIds.add(id);
    groups.push({
      id,
      name: typeof name === 'string' ? name.slice(0, 80) : '',
      color: isColor(color) ? color : 'grey',
      collapsed: collapsed === true,
    });
  }
  const tabs: BoardTab[] = [];
  const seen = new Set<string>();
  for (const t of Array.isArray(r.tabs) ? r.tabs : []) {
    if (!t || typeof t !== 'object') continue;
    const { slug, group } = t as Record<string, unknown>;
    if (typeof slug !== 'string' || !slug || seen.has(slug)) continue;
    seen.add(slug);
    tabs.push(typeof group === 'string' && groupIds.has(group) ? { slug, group } : { slug });
  }
  return normalizeLayout({ tabs, groups });
}

/**
 * Pull each group's tabs together at the place of its first tab (Chrome never splits a
 * group), and drop groups left with no tabs.
 */
export function normalizeLayout(layout: TabLayout): TabLayout {
  const known = new Set(layout.groups.map((g) => g.id));
  const tabs = layout.tabs.map((t) => (t.group && !known.has(t.group) ? { slug: t.slug } : t));
  const out: BoardTab[] = [];
  const placed = new Set<string>();
  for (const t of tabs) {
    if (!t.group) { out.push(t); continue; }
    if (placed.has(t.group)) continue;
    placed.add(t.group);
    for (const m of tabs) if (m.group === t.group) out.push(m);
  }
  return { tabs: out, groups: layout.groups.filter((g) => placed.has(g.id)) };
}

export function hasTab(layout: TabLayout, slug: string): boolean {
  return layout.tabs.some((t) => t.slug === slug);
}

/** Give a board a tab, at the end of the strip. An open tab stays where it is. */
export function openTab(layout: TabLayout, slug: string): TabLayout {
  if (hasTab(layout, slug)) return layout;
  return normalizeLayout({ ...layout, tabs: [...layout.tabs, { slug }] });
}

/** Take a board's tab off the strip. The board itself is untouched. */
export function closeTab(layout: TabLayout, slug: string): TabLayout {
  return normalizeLayout({ ...layout, tabs: layout.tabs.filter((t) => t.slug !== slug) });
}

export function closeOtherTabs(layout: TabLayout, slug: string): TabLayout {
  return normalizeLayout({ ...layout, tabs: layout.tabs.filter((t) => t.slug === slug) });
}

/** Close every tab of a group, and with them the group. */
export function closeGroup(layout: TabLayout, groupId: string): TabLayout {
  return normalizeLayout({ ...layout, tabs: layout.tabs.filter((t) => t.group !== groupId) });
}

/**
 * The board to show once `slug`'s tab closes: its right neighbour, else its left one, else
 * `null` (the strip is empty; the page falls back to the default board).
 */
export function neighbourAfterClose(layout: TabLayout, slug: string): string | null {
  const i = layout.tabs.findIndex((t) => t.slug === slug);
  if (i < 0) return null;
  return layout.tabs[i + 1]?.slug ?? layout.tabs[i - 1]?.slug ?? null;
}

/**
 * Drop a dragged tab before `beforeSlug` (`null` = the end of the strip), as a member of
 * `group` (`null` = no group). The strip decides the group from where it was dropped: on a
 * grouped tab it joins that group, on the strip's empty end it leaves any group.
 */
export function moveTab(layout: TabLayout, slug: string, beforeSlug: string | null, group: string | null): TabLayout {
  const moving = layout.tabs.find((t) => t.slug === slug);
  if (!moving || slug === beforeSlug) return layout;
  const rest = layout.tabs.filter((t) => t.slug !== slug);
  const at = beforeSlug === null ? rest.length : rest.findIndex((t) => t.slug === beforeSlug);
  const placed: BoardTab = group && layout.groups.some((g) => g.id === group) ? { slug, group } : { slug };
  const tabs = [...rest];
  tabs.splice(at < 0 ? rest.length : at, 0, placed);
  return normalizeLayout({ ...layout, tabs });
}

/** The first colour no group wears yet; all taken → round again. */
export function nextGroupColor(layout: TabLayout): GroupColor {
  const used = new Set(layout.groups.map((g) => g.color));
  return GROUP_COLORS.find((c) => !used.has(c)) ?? GROUP_COLORS[layout.groups.length % GROUP_COLORS.length];
}

/**
 * Start a new group holding `slug`. The tab stays where it is; if it sat inside another
 * group it steps out past that group's end, since a group is never split.
 */
export function addToNewGroup(layout: TabLayout, slug: string, id: string): TabLayout {
  if (!hasTab(layout, slug) || layout.groups.some((g) => g.id === id)) return layout;
  const group: TabGroup = { id, name: '', color: nextGroupColor(layout), collapsed: false };
  const left = removeFromGroup(layout, slug);
  return normalizeLayout({
    tabs: left.tabs.map((t) => (t.slug === slug ? { slug, group: id } : t)),
    groups: [...left.groups, group],
  });
}

/** Move a tab into an existing group, as its last tab. */
export function addToGroup(layout: TabLayout, slug: string, groupId: string): TabLayout {
  return placeAfterGroup(layout, slug, groupId, groupId);
}

/** Take a tab out of its group; it lands just right of the group, as Chrome does. */
export function removeFromGroup(layout: TabLayout, slug: string): TabLayout {
  const group = layout.tabs.find((t) => t.slug === slug)?.group;
  return group ? placeAfterGroup(layout, slug, group, null) : layout;
}

/** Put `slug` right after `anchorGroup`'s last other tab, as a member of `group`. A tab that
 *  is its anchor group's only member just takes the new membership in place. */
function placeAfterGroup(layout: TabLayout, slug: string, anchorGroup: string, group: string | null): TabLayout {
  if (!hasTab(layout, slug)) return layout;
  const rest = layout.tabs.filter((t) => t.slug !== slug);
  const last = rest.map((t) => t.group).lastIndexOf(anchorGroup);
  const placed: BoardTab = group ? { slug, group } : { slug };
  if (last < 0) {
    if (group) return layout;
    return normalizeLayout({ ...layout, tabs: layout.tabs.map((t) => (t.slug === slug ? placed : t)) });
  }
  const tabs = [...rest];
  tabs.splice(last + 1, 0, placed);
  return normalizeLayout({ ...layout, tabs });
}

/** Dissolve a group; its tabs stay open where they are. */
export function ungroup(layout: TabLayout, groupId: string): TabLayout {
  return normalizeLayout({
    tabs: layout.tabs.map((t) => (t.group === groupId ? { slug: t.slug } : t)),
    groups: layout.groups.filter((g) => g.id !== groupId),
  });
}

export function updateGroup(
  layout: TabLayout, groupId: string, patch: Partial<Pick<TabGroup, 'name' | 'color' | 'collapsed'>>,
): TabLayout {
  return {
    ...layout,
    groups: layout.groups.map((g) => (g.id === groupId
      ? {
        ...g,
        ...(patch.name !== undefined ? { name: patch.name.slice(0, 80) } : {}),
        ...(patch.color !== undefined && isColor(patch.color) ? { color: patch.color } : {}),
        ...(patch.collapsed !== undefined ? { collapsed: patch.collapsed } : {}),
      }
      : g)),
  };
}

/** Drop tabs whose board is gone (deleted here, by the CLI or by an agent). */
export function pruneTabs(layout: TabLayout, existing: ReadonlySet<string>): TabLayout {
  if (layout.tabs.every((t) => existing.has(t.slug))) return layout;
  return normalizeLayout({ ...layout, tabs: layout.tabs.filter((t) => existing.has(t.slug)) });
}

/** The strip, left to right: each group's chip before its tabs. */
export function stripItems(layout: TabLayout, active: string | null): StripItem[] {
  const byId = new Map(layout.groups.map((g) => [g.id, g]));
  const items: StripItem[] = [];
  let current: string | undefined;
  for (const t of layout.tabs) {
    const group = t.group ? byId.get(t.group) : undefined;
    if (group && group.id !== current) {
      items.push({ kind: 'group', group, count: layout.tabs.filter((m) => m.group === group.id).length });
    }
    current = group?.id;
    if (group?.collapsed && t.slug !== active) continue;
    items.push(group ? { kind: 'tab', slug: t.slug, group } : { kind: 'tab', slug: t.slug });
  }
  return items;
}
