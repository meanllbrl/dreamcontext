/**
 * The board switcher's pure half (A16): which boards the "All boards" popover shows, in what
 * order, which one the keyboard is on, and which may be deleted. React-free on purpose so the
 * root vitest (plain Node) can import it — `tests/unit/whiteboard-switcher.test.ts`.
 */

/** The default board (round-2 contract): the server's `GET /api/whiteboards/default` ensures
 *  it exists under the store lock. The client never creates it and never deletes it. */
export const DEFAULT_BOARD_SLUG = 'control-panel';

/** The fields of a `GET /api/whiteboards` row the switcher reads. */
export interface SwitcherBoard {
  slug: string;
  name: string;
  description?: string;
  elements?: number;
  updatedAt?: string;
  corrupt?: string;
}

export function isDefaultBoard(slug: string): boolean {
  return slug === DEFAULT_BOARD_SLUG;
}

/** Every board but the default may be deleted from the switcher. */
export function canDeleteBoard(slug: string): boolean {
  return !isDefaultBoard(slug);
}

/** Case- and accent-free, with Turkish dotless ı folded to i ("İş", "is", "IS" all meet). */
const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ı/g, 'i');

/**
 * The popover's list: the default board first, then the most recently updated. A query
 * matches name, slug or description, case- and accent-insensitively ("gunluk" finds
 * "Günlük"); every whitespace-separated word must match.
 */
export function filterBoards<T extends SwitcherBoard>(boards: readonly T[], query: string): T[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const hit = (b: T) => {
    if (words.length === 0) return true;
    const hay = fold(`${b.name} ${b.slug} ${b.description ?? ''}`);
    return words.every((w) => hay.includes(w));
  };
  const time = (b: T) => {
    const t = b.updatedAt ? Date.parse(b.updatedAt) : NaN;
    return Number.isNaN(t) ? 0 : t;
  };
  return boards.filter(hit).sort((a, b) => {
    if (isDefaultBoard(a.slug) !== isDefaultBoard(b.slug)) return isDefaultBoard(a.slug) ? -1 : 1;
    return time(b) - time(a) || a.name.localeCompare(b.name);
  });
}

/**
 * The keyboard-highlighted row after a key press. Arrows wrap, Home/End jump; any other key
 * leaves it where it was. `-1` means nothing is highlighted (an empty list).
 */
export function moveActive(index: number, key: string, count: number): number {
  if (count <= 0) return -1;
  const from = Math.min(Math.max(index, -1), count - 1);
  switch (key) {
    case 'ArrowDown': return from < 0 ? 0 : (from + 1) % count;
    case 'ArrowUp': return from <= 0 ? count - 1 : from - 1;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return from < 0 ? 0 : from;
  }
}

/** The board Enter opens: the highlighted row, if it is in range. */
export function pickActive<T>(list: readonly T[], index: number): T | null {
  return index >= 0 && index < list.length ? list[index] : null;
}

/** A name the create field accepts: trimmed, non-empty. `null` = the Create action is off. */
export function newBoardName(raw: string): string | null {
  const name = raw.trim();
  return name ? name : null;
}
