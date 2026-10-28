/**
 * The board explorer's pure half: what the left sidebar shows (Pinned, Recent, the groups and
 * Ungrouped), and the per-machine memory behind it. React-free on purpose so the root vitest
 * (plain Node) can import it — `tests/unit/whiteboard-explorer.test.ts`.
 *
 * A board's group is its own frontmatter (`group`, read by the server). Groups are DERIVED from
 * the boards, keyed by {@link fold}, so "Tilki" and "tilki" written by two hands show as one
 * group. An empty group (just made, nothing dropped in yet) lives only in these prefs.
 */
import { fold, type SwitcherBoard } from './boardSwitcherLogic';

/** Mirrors `GROUP_MAX` / `groupLength` in src/lib/whiteboards/validate.ts (separate build roots). */
export const GROUP_MAX = 60;
export const groupLength = (s: string): number => [...s].length;

/** A group name the server will take, or null. Same rules as `parseGroupInput`. */
export function validGroupName(raw: string): string | null {
  const s = raw.normalize('NFC').trim();
  // eslint-disable-next-line no-control-regex
  if (!s || groupLength(s) > GROUP_MAX || /[\u0000-\u001f\u007f-\u009f\u2028\u2029\/]/.test(s)) return null;
  return s;
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

/** Add an empty group (no-op when a real or empty group already folds the same way). */
export function addEmptyGroup(prefs: ExplorerPrefs, name: string, realGroups: readonly string[]): ExplorerPrefs {
  const key = fold(name);
  if ([...realGroups, ...prefs.emptyGroups].some((g) => fold(g) === key)) return prefs;
  return { ...prefs, emptyGroups: [...prefs.emptyGroups, name] };
}

export function removeEmptyGroup(prefs: ExplorerPrefs, name: string): ExplorerPrefs {
  const key = fold(name);
  return { ...prefs, emptyGroups: prefs.emptyGroups.filter((g) => fold(g) !== key) };
}

/**
 * Forget what the list no longer has: pins and recents of deleted boards, and empty groups a
 * board now carries. Call ONLY with a list that loaded (never a loading, failed or optimistic
 * one), or every page open would wipe the pins. Returns the same object when nothing changed.
 */
export function pruneExplorerPrefs(prefs: ExplorerPrefs, boards: readonly SwitcherBoard[]): ExplorerPrefs {
  const slugs = new Set(boards.map((b) => b.slug));
  const real = new Set(boards.flatMap((b) => (b.group ? [fold(b.group)] : [])));
  const pinned = prefs.pinned.filter((s) => slugs.has(s));
  const recent = prefs.recent.filter((s) => slugs.has(s));
  const emptyGroups = prefs.emptyGroups.filter((g) => !real.has(fold(g)));
  if (pinned.length === prefs.pinned.length && recent.length === prefs.recent.length && emptyGroups.length === prefs.emptyGroups.length) return prefs;
  return { ...prefs, pinned, recent, emptyGroups };
}

/** A group renamed (or ungrouped, `to: null`): its collapsed and empty entries follow it. */
export function renameGroupInPrefs(prefs: ExplorerPrefs, from: string, to: string | null): ExplorerPrefs {
  const key = fold(from);
  const wasCollapsed = prefs.collapsed.includes(key);
  const collapsed = prefs.collapsed.filter((k) => k !== key);
  if (wasCollapsed && to !== null) collapsed.push(fold(to));
  const hadEmpty = prefs.emptyGroups.some((g) => fold(g) === key);
  const emptyGroups = prefs.emptyGroups.filter((g) => fold(g) !== key);
  if (hadEmpty && to !== null && !emptyGroups.some((g) => fold(g) === fold(to))) emptyGroups.push(to);
  return { ...prefs, collapsed, emptyGroups };
}

export interface ExplorerGroup<T> {
  /** Folded name: the group's identity. */
  key: string;
  /** The spelling shown: the one most boards carry, ties to the smallest string. */
  name: string;
  boards: T[];
  collapsed: boolean;
  /** Lives only in prefs: no board carries it yet. */
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

  // A Map keyed by fold: a group named `__proto__` is just a key.
  const buckets = new Map<string, { spellings: string[]; boards: T[] }>();
  const ungrouped: T[] = [];
  for (const b of shown) {
    if (!b.group) { ungrouped.push(b); continue; }
    const key = fold(b.group);
    const bucket = buckets.get(key) ?? { spellings: [], boards: [] };
    bucket.spellings.push(b.group);
    bucket.boards.push(b);
    buckets.set(key, bucket);
  }
  // Every spelling on every board votes, not only the search hits, so a search never renames.
  const allSpellings = new Map<string, string[]>();
  for (const b of boards) if (b.group) allSpellings.set(fold(b.group), [...(allSpellings.get(fold(b.group)) ?? []), b.group]);

  const groups: ExplorerGroup<T>[] = [...buckets].map(([key, bucket]) => ({
    key,
    name: groupSpelling(allSpellings.get(key) ?? bucket.spellings),
    boards: bucket.boards.sort(byName),
    // Every group is open while searching. (The open board's group is opened once, when the
    // board is opened, by the explorer; a click may fold it again.)
    collapsed: !searching && prefs.collapsed.includes(key),
    empty: false,
  }));
  if (!searching) {
    for (const g of prefs.emptyGroups) {
      const key = fold(g);
      if (allSpellings.has(key) || groups.some((x) => x.key === key)) continue;
      groups.push({ key, name: g, boards: [], collapsed: false, empty: true });
    }
  }
  groups.sort((a, b) => a.name.localeCompare(b.name, 'tr', { sensitivity: 'base' }) || (a.name < b.name ? -1 : 1));
  ungrouped.sort(byName);

  const pick = (slugs: readonly string[]) => slugs.flatMap((s) => (bySlug.has(s) ? [bySlug.get(s)!] : []));
  const pinned = searching ? [] : pick(prefs.pinned);
  const recent = searching ? [] : pick(prefs.recent).filter((b) => b.slug !== openSlug).slice(0, RECENT_SHOWN);
  const hits = [...groups.flatMap((g) => (g.collapsed ? [] : g.boards)), ...ungrouped];
  return { searching, pinned, recent, groups, ungrouped, hits };
}

/** The group names boards carry (one spelling per fold), for menus and the empty-group check. */
export function realGroupNames(boards: readonly SwitcherBoard[]): string[] {
  const m = new Map<string, string[]>();
  for (const b of boards) if (b.group) m.set(fold(b.group), [...(m.get(fold(b.group)) ?? []), b.group]);
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
  const others = boards.some((b) => b.slug !== movedSlug && b.group && fold(b.group) === key);
  if (others) return prefs;
  const spelling = groupSpelling(boards.filter((b) => b.group && fold(b.group) === key).map((b) => b.group!));
  return prefs.emptyGroups.some((g) => fold(g) === key) ? prefs : { ...prefs, emptyGroups: [...prefs.emptyGroups, spelling] };
}
