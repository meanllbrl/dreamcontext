/**
 * Which rows the title bar's project picker draws, and which ⌘ number each gets.
 * A project the owner hid (drawer's Hidden group) sits in a folded "Hidden" section under the
 * list, with no ⌘ number. The project on screen stays in the main list even when hidden, and a
 * typed name finds every project, hidden ones too, in one flat list.
 */
export interface HideableRow { name: string; active: boolean; hidden?: boolean }

export function splitPickerRows<T extends HideableRow>(rows: readonly T[], needle: string): { shown: T[]; hidden: T[] } {
  const n = needle.trim().toLowerCase();
  if (n) return { shown: rows.filter((r) => r.name.toLowerCase().includes(n)), hidden: [] };
  return { shown: rows.filter((r) => !r.hidden || r.active), hidden: rows.filter((r) => r.hidden && !r.active) };
}

/** ⌘N for a row: its place among the NOT hidden projects, in order (what the key listener
 *  picks); a hidden row has none. Null past nine. */
export function shortcutFor(rows: readonly HideableRow[], name: string): number | null {
  const shown = rows.filter((r) => !r.hidden);
  const i = shown.findIndex((r) => r.name === name);
  return i >= 0 && i < 9 ? i + 1 : null;
}
