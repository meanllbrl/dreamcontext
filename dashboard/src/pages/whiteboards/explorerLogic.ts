/**
 * The board explorer's pure half: what the left sidebar shows (Pinned, Recent, the groups and
 * Ungrouped), and the per-machine memory behind it. React-free on purpose so the root vitest
 * (plain Node) can import it — `tests/unit/whiteboard-explorer.test.ts`.
 *
 * A board's group is its own frontmatter (`group`, read by the server). Groups are DERIVED from
 * the boards, keyed by {@link fold}, so "Tilki" and "tilki" written by two hands show as one
 * group. An empty group (just made, nothing dropped in yet) lives only in these prefs.
 *
 * Groups are FOLDERS, two levels deep (owner, 2026-11-13): a group is "Folder" or
 * "Folder/Sub-folder". A folder holds boards and sub-folders; a sub-folder holds only boards.
 */
import { fold, type SwitcherBoard } from './boardSwitcherLogic';

/** Mirrors `GROUP_MAX` / `groupLength` in src/lib/whiteboards/validate.ts (separate build roots). */
export const GROUP_MAX = 60;
export const groupLength = (s: string): number => [...s].length;

export const FOLDER_SEP = '/';
export const FOLDER_DEPTH = 2;

/** One folder name (no "/"), the way the server cleans each part of a path, or null. */
export function validFolderName(raw: string): string | null {
  const s = raw.normalize('NFC').trim();
  // eslint-disable-next-line no-control-regex
  if (!s || groupLength(s) > GROUP_MAX || /[\u0000-\u001f\u007f-\u009f\u2028\u2029\/]/.test(s) || fold(s).includes(FOLDER_SEP)) return null;
  return s;
}

/** A folder path the server will take ("Folder" or "Folder/Sub-folder"), or null. Same rules as `parseGroupInput`. */
export function validGroupName(raw: string): string | null {
  const parts = raw.split(FOLDER_SEP);
  if (parts.length > FOLDER_DEPTH) return null;
  const clean = parts.map(validFolderName);
  return clean.some((p) => p === null) ? null : clean.join(FOLDER_SEP);
}

export const folderParts = (group: string): string[] => group.split(FOLDER_SEP);

/** Is `group` the folder `key` (folded) or one of its sub-folders? */
export function inFolder(group: string, key: string): boolean {
  const g = fold(group);
  return g === key || g.startsWith(`${key}${FOLDER_SEP}`);
}

/**
 * Where a board in `group` lands when the folder `from` is renamed or moved to `to`, or deleted
 * (`to: null`: a sub-folder's boards go into its parent, a folder's out of every folder, and its
 * sub-folders become folders). `undefined` = the board is not in that folder. Mirrors
 * `renameWhiteboardGroup` in src/lib/whiteboards/store.ts.
 */
export function movedFolderPath(group: string, from: string, to: string | null): string | null | undefined {
  if (!inFolder(group, fold(from))) return undefined;
  const fromParts = folderParts(from);
  const rest = folderParts(group).slice(fromParts.length);
  if (to !== null) return [to, ...rest].join(FOLDER_SEP);
  if (rest.length > 0) return rest.join(FOLDER_SEP);
  return fromParts.length > 1 ? fromParts[0] : null;
}

export interface ExplorerPrefs {
  /** Open on a desktop; `null` = never chosen (open from 1100 px). The phone never reads it. */
  open: boolean | null;
  /** Folded names of collapsed groups. */
  collapsed: string[];
  pinned: string[];
  /** Most recent first, at most {@link RECENT_MAX}. */
  recent: string[];
  /** Groups made here that no board carries yet. */
  emptyGroups: string[];
}

export const RECENT_MAX = 5;
/** How many recent boards are shown (the open one left out). */
export const RECENT_SHOWN = 3;

export const emptyExplorerPrefs = (): ExplorerPrefs => ({ open: null, collapsed: [], pinned: [], recent: [], emptyGroups: [] });

const strings = (v: unknown, max: number): string[] => {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) if (typeof x === 'string' && x && !out.includes(x) && out.length < max) out.push(x);
  return out;
};

/** Prefs read from storage: shape only. Slugs are pruned later, against a list that loaded. */
export function sanitizeExplorerPrefs(raw: unknown): ExplorerPrefs {
  if (!raw || typeof raw !== 'object') return emptyExplorerPrefs();
  const r = raw as Record<string, unknown>;
  return {
    open: typeof r.open === 'boolean' ? r.open : null,
    collapsed: strings(r.collapsed, 500),
    pinned: strings(r.pinned, 500),
    recent: strings(r.recent, RECENT_MAX),
    emptyGroups: strings(r.emptyGroups, 200).filter((g) => validGroupName(g) === g),
  };
}

export function touchRecent(prefs: ExplorerPrefs, slug: string): ExplorerPrefs {
  if (prefs.recent[0] === slug) return prefs;
  return { ...prefs, recent: [slug, ...prefs.recent.filter((s) => s !== slug)].slice(0, RECENT_MAX) };
}

export function togglePin(prefs: ExplorerPrefs, slug: string): ExplorerPrefs {
  const pinned = prefs.pinned.includes(slug) ? prefs.pinned.filter((s) => s !== slug) : [...prefs.pinned, slug];
  return { ...prefs, pinned };
}

export function toggleCollapsed(prefs: ExplorerPrefs, name: string): ExplorerPrefs {
  const key = fold(name);
  const collapsed = prefs.collapsed.includes(key) ? prefs.collapsed.filter((k) => k !== key) : [...prefs.collapsed, key];
  return { ...prefs, collapsed };
}

/** Open a folder and, for a sub-folder, its parent (the open board's place is always visible). */
export function expandFolder(prefs: ExplorerPrefs, group: string): ExplorerPrefs {
  const parts = folderParts(group);
  const keys = parts.map((_, i) => fold(parts.slice(0, i + 1).join(FOLDER_SEP)));
  if (!keys.some((k) => prefs.collapsed.includes(k))) return prefs;
  return { ...prefs, collapsed: prefs.collapsed.filter((k) => !keys.includes(k)) };
}

/** Add an empty group (no-op when a real or empty group already folds the same way). */
export function addEmptyGroup(prefs: ExplorerPrefs, name: string, realGroups: readonly string[]): ExplorerPrefs {
  const key = fold(name);
  if ([...realGroups, ...prefs.emptyGroups].some((g) => fold(g) === key)) return prefs;
  return { ...prefs, emptyGroups: [...prefs.emptyGroups, name] };
}

/** Forget an empty folder and every empty sub-folder in it. */
export function removeEmptyGroup(prefs: ExplorerPrefs, name: string): ExplorerPrefs {
  const key = fold(name);
  return { ...prefs, emptyGroups: prefs.emptyGroups.filter((g) => !inFolder(g, key)) };
}

/**
 * Forget what the list no longer has: pins and recents of deleted boards, and empty groups a
 * board now carries. Call ONLY with a list that loaded (never a loading, failed or optimistic
 * one), or every page open would wipe the pins. Returns the same object when nothing changed.
 */
export function pruneExplorerPrefs(prefs: ExplorerPrefs, boards: readonly SwitcherBoard[]): ExplorerPrefs {
  const slugs = new Set(boards.map((b) => b.slug));
  // A folder is real when a board sits in it or in one of its sub-folders.
  const real = new Set(boards.flatMap((b) => (b.group ? [fold(b.group), fold(folderParts(b.group)[0])] : [])));
  const pinned = prefs.pinned.filter((s) => slugs.has(s));
  const recent = prefs.recent.filter((s) => slugs.has(s));
  const emptyGroups = prefs.emptyGroups.filter((g) => !real.has(fold(g)));
  if (pinned.length === prefs.pinned.length && recent.length === prefs.recent.length && emptyGroups.length === prefs.emptyGroups.length) return prefs;
  return { ...prefs, pinned, recent, emptyGroups };
}

/**
 * A folder renamed, moved or deleted (`to: null`, see {@link movedFolderPath}): its collapsed and
 * empty entries, and those of its sub-folders, follow it.
 */
export function renameGroupInPrefs(prefs: ExplorerPrefs, from: string, to: string | null): ExplorerPrefs {
  const key = fold(from);
  const collapsed: string[] = [];
  for (const k of prefs.collapsed) {
    const next = inFolder(k, key) ? movedFolderPath(k, from, to) : k;
    if (next !== null && next !== undefined && !collapsed.includes(fold(next))) collapsed.push(fold(next));
  }
  const emptyGroups: string[] = [];
  for (const g of prefs.emptyGroups) {
    const next = inFolder(g, key) ? movedFolderPath(g, from, to) : g;
    if (next !== null && next !== undefined && !emptyGroups.some((x) => fold(x) === fold(next))) emptyGroups.push(next);
  }
  return { ...prefs, collapsed, emptyGroups };
}

export interface ExplorerGroup<T> {
  /** Folded path: the folder's identity. */
  key: string;
  /** The full path the server takes ("Folder" or "Folder/Sub-folder"), each part in the spelling
   *  most boards carry, ties to the smallest string. */
  name: string;
  /** The folder's own name, what its row shows. */
  label: string;
  /** The parent folder's key; null for a top folder. */
  parent: string | null;
  /** The boards directly in it. */
  boards: T[];
  /** Its sub-folders (always empty for a sub-folder: two levels). */
  subs: ExplorerGroup<T>[];
  /** Boards in it and in its sub-folders. */
  total: number;
  collapsed: boolean;
  /** No board in it or in its sub-folders: it lives only in prefs. */
  empty: boolean;
}

export interface ExplorerView<T> {
  searching: boolean;
  pinned: T[];
  recent: T[];
  groups: ExplorerGroup<T>[];
  ungrouped: T[];
  /** Every board shown, in screen order (Enter opens the first while searching). */
  hits: T[];
}

const byName = <T extends SwitcherBoard>(a: T, b: T) =>
  a.name.localeCompare(b.name, 'tr', { sensitivity: 'base' }) || (a.slug < b.slug ? -1 : 1);

/** The spelling a fold-group shows (and the server adopts): most boards, then smallest string. */
export function groupSpelling(spellings: readonly string[]): string {
  const votes = new Map<string, number>();
  for (const s of spellings) votes.set(s, (votes.get(s) ?? 0) + 1);
  let best = spellings[0] ?? '';
  let bestN = 0;
  for (const [s, n] of votes) if (n > bestN || (n === bestN && s < best)) { best = s; bestN = n; }
  return best;
}

/**
 * What the sidebar draws. While searching (any non-blank query) only boards whose name, slug,
 * description or group match every word are kept, groups with hits are open, and Pinned,
 * Recent and empty groups hide.
 */
export function buildExplorer<T extends SwitcherBoard>(
  boards: readonly T[],
  prefs: ExplorerPrefs,
  query: string,
  openSlug: string | null,
  /** The owner's group order (`whiteboards/.groups.json`), top first; see {@link sortGroups}. */
  groupOrder: readonly string[] = [],
): ExplorerView<T> {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const searching = words.length > 0;
  const hit = (b: T) => {
    if (!searching) return true;
    const hay = fold(`${b.name} ${b.slug} ${b.description ?? ''} ${b.group ?? ''}`);
    return words.every((w) => hay.includes(w));
  };
  const shown = boards.filter(hit);
  const bySlug = new Map(boards.map((b) => [b.slug, b]));

  // Spellings: every board votes, not only the search hits, so a search never renames. A top
  // folder's spelling is voted by every board under it; a sub-folder's by the boards in it.
  // Maps keyed by fold: a folder named `__proto__` is just a key.
  const topSpell = new Map<string, string[]>();
  const subSpell = new Map<string, string[]>();
  for (const b of boards) {
    if (!b.group) continue;
    const [t, sub] = folderParts(b.group);
    topSpell.set(fold(t), [...(topSpell.get(fold(t)) ?? []), t]);
    if (sub !== undefined) subSpell.set(fold(b.group), [...(subSpell.get(fold(b.group)) ?? []), sub]);
  }

  const tops = new Map<string, ExplorerGroup<T>>();
  const topOf = (t: string, empty: boolean): ExplorerGroup<T> => {
    const key = fold(t);
    let g = tops.get(key);
    if (!g) {
      const name = topSpell.has(key) ? groupSpelling(topSpell.get(key)!) : t;
      g = { key, name, label: name, parent: null, boards: [], subs: [], total: 0, collapsed: !searching && prefs.collapsed.includes(key), empty };
      tops.set(key, g);
    }
    return g;
  };
  const subOf = (top: ExplorerGroup<T>, path: string, sub: string, empty: boolean): ExplorerGroup<T> => {
    const key = fold(path);
    let g = top.subs.find((x) => x.key === key);
    if (!g) {
      const label = subSpell.has(key) ? groupSpelling(subSpell.get(key)!) : sub;
      g = { key, name: `${top.name}${FOLDER_SEP}${label}`, label, parent: top.key, boards: [], subs: [], total: 0, collapsed: !searching && prefs.collapsed.includes(key), empty };
      top.subs.push(g);
    }
    return g;
  };

  const ungrouped: T[] = [];
  for (const b of shown) {
    if (!b.group) { ungrouped.push(b); continue; }
    const [t, sub] = folderParts(b.group);
    const top = topOf(t, false);
    (sub === undefined ? top : subOf(top, b.group, sub, false)).boards.push(b);
  }
  if (!searching) {
    for (const g of prefs.emptyGroups) {
      const [t, sub] = folderParts(g);
      const known = topSpell.has(fold(t)) || tops.has(fold(t));
      const top = topOf(t, !known);
      if (sub !== undefined && !subSpell.has(fold(g))) subOf(top, g, sub, true);
    }
  }
  const groups = [...tops.values()];
  for (const top of groups) {
    top.boards.sort(byName);
    for (const sub of top.subs) { sub.boards.sort(byName); sub.total = sub.boards.length; }
    sortGroups(top.subs, groupOrder);
    top.total = top.boards.length + top.subs.reduce((n, x) => n + x.total, 0);
    if (top.total > 0) top.empty = false;
  }
  sortGroups(groups, groupOrder);
  ungrouped.sort(byName);

  const pick = (slugs: readonly string[]) => slugs.flatMap((s) => (bySlug.has(s) ? [bySlug.get(s)!] : []));
  const pinned = searching ? [] : pick(prefs.pinned);
  const recent = searching ? [] : pick(prefs.recent).filter((b) => b.slug !== openSlug).slice(0, RECENT_SHOWN);
  const hits = [
    ...groups.flatMap((g) => (g.collapsed ? [] : [...g.subs.flatMap((x) => (x.collapsed ? [] : x.boards)), ...g.boards])),
    ...ungrouped,
  ];
  return { searching, pinned, recent, groups, ungrouped, hits };
}

/** The group names boards carry (one spelling per fold), for menus and the empty-group check. */
export function realGroupNames(boards: readonly SwitcherBoard[]): string[] {
  const m = new Map<string, string[]>();
  const vote = (g: string) => m.set(fold(g), [...(m.get(fold(g)) ?? []), g]);
  for (const b of boards) {
    if (!b.group) continue;
    vote(b.group);
    // A folder that holds only sub-folders is still a folder.
    if (folderParts(b.group).length > 1) vote(folderParts(b.group)[0]);
  }
  return [...m.values()].map(groupSpelling).sort((a, b) => a.localeCompare(b, 'tr', { sensitivity: 'base' }));
}

/**
 * After a move or a delete takes the LAST board out of a group, keep the group as an empty
 * one, so it does not vanish under the owner's hand.
 */
export function keepGroupIfEmptied(prefs: ExplorerPrefs, boards: readonly SwitcherBoard[], movedSlug: string): ExplorerPrefs {
  const from = boards.find((b) => b.slug === movedSlug)?.group;
  if (!from) return prefs;
  const key = fold(from);
  // A folder that still has a board in a sub-folder is not empty.
  const others = boards.some((b) => b.slug !== movedSlug && b.group && inFolder(b.group, key));
  if (others) return prefs;
  const spelling = groupSpelling(boards.filter((b) => b.group && fold(b.group) === key).map((b) => b.group!));
  return prefs.emptyGroups.some((g) => fold(g) === key) ? prefs : { ...prefs, emptyGroups: [...prefs.emptyGroups, spelling] };
}

/**
 * Groups in the owner's order: the ones the order lists first, in its order (matched by fold),
 * then every other group by name. Sorts in place and returns the array.
 */
export function sortGroups<G extends { key: string; name: string }>(groups: G[], order: readonly string[]): G[] {
  const rank = new Map<string, number>();
  order.forEach((g, i) => { const k = fold(g); if (!rank.has(k)) rank.set(k, i); });
  return groups.sort((a, b) => {
    const ra = rank.get(a.key);
    const rb = rank.get(b.key);
    if (ra !== undefined || rb !== undefined) {
      if (ra === undefined) return 1;
      if (rb === undefined) return -1;
      if (ra !== rb) return ra - rb;
    }
    return a.name.localeCompare(b.name, 'tr', { sensitivity: 'base' }) || (a.name < b.name ? -1 : 1);
  });
}

/**
 * The order after moving group `key` to sit before (`after: false`) or after `target` among
 * `shown` (every group, in screen order). Returns the names to store, or null when nothing moves.
 */
export function moveGroup(
  shown: readonly { key: string; name: string }[],
  key: string,
  target: string,
  after: boolean,
): string[] | null {
  if (key === target) return null;
  const from = shown.findIndex((g) => g.key === key);
  if (from < 0 || !shown.some((g) => g.key === target)) return null;
  const rest = shown.filter((g) => g.key !== key);
  const at = rest.findIndex((g) => g.key === target) + (after ? 1 : 0);
  const next = [...rest.slice(0, at), shown[from], ...rest.slice(at)];
  if (next.every((g, i) => g.key === shown[i].key)) return null;
  return next.map((g) => g.name);
}

/**
 * The whole order to store after siblings were rearranged: every top folder, each followed by
 * its sub-folders. `parent` names whose siblings `names` are (null = the top folders).
 */
export function composeOrder(
  tops: readonly { key: string; name: string; subs: readonly { name: string }[] }[],
  parent: string | null,
  names: readonly string[] | null,
): string[] | null {
  if (!names) return null;
  const subsOf = (t: { key: string; subs: readonly { name: string }[] }) => (parent === t.key ? [...names] : t.subs.map((x) => x.name));
  if (parent === null) {
    const topByName = new Map(tops.map((t) => [t.name, t]));
    return names.flatMap((n) => { const t = topByName.get(n); return t ? [n, ...subsOf(t)] : [n]; });
  }
  return tops.flatMap((t) => [t.name, ...subsOf(t)]);
}

/** One step up (`-1`) or down (`1`): the keyboard's way to reorder (the group's ⋯ menu). */
export function stepGroup(shown: readonly { key: string; name: string }[], key: string, dir: -1 | 1): string[] | null {
  const i = shown.findIndex((g) => g.key === key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= shown.length) return null;
  return moveGroup(shown, key, shown[j].key, dir === 1);
}
