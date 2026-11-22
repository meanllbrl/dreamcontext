/**
 * Which rows the title bar's project picker draws, and which ⌘ number each gets.
 * A project the owner hid (drawer's Hidden group) is out of the list and out of ⌘1-9, but a
 * typed name still finds it, and the project on screen stays listed so it never loses itself.
 */
export interface HideableRow { name: string; active: boolean; hidden?: boolean }

export function visiblePickerRows<T extends HideableRow>(rows: readonly T[], needle: string): T[] {
  const n = needle.trim().toLowerCase();
  if (n) return rows.filter((r) => r.name.toLowerCase().includes(n));
  return rows.filter((r) => !r.hidden || r.active);
}

/** ⌘N for a row: its place among the NOT hidden projects, in order (what the key listener
 *  picks); a hidden row has none. Null past nine. */
export function shortcutFor(rows: readonly HideableRow[], name: string): number | null {
  const shown = rows.filter((r) => !r.hidden);
  const i = shown.findIndex((r) => r.name === name);
  return i >= 0 && i < 9 ? i + 1 : null;
}
