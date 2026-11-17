/**
 * Where the full Super chat was when a thread filter began, and how to find that place again
 * (ajanda-filtre C3/C4): the first visible entry by its id, else by its time and kind (a replay
 * renames ids), and its distance from the scroller's top.
 */
import type { ChatItem } from '../chatSession';
import type { ThreadAnchor } from './superThreadFilter';

const tsOf = (it: ChatItem | undefined): number => ((it as { ts?: number } | undefined)?.ts ?? 0);

/** Read off the mounted rows: the first one whose bottom is below the scroller's top. */
export function readThreadAnchor(el: HTMLElement | null, stick: boolean, itemOf: (id: string) => ChatItem | undefined): ThreadAnchor {
  if (!el || el.clientHeight === 0) return { id: null, ts: 0, kind: '', offset: 0, stick: true };
  const top = el.getBoundingClientRect().top;
  const row = [...el.querySelectorAll<HTMLElement>('[data-item-id]')].find((r) => r.getBoundingClientRect().bottom > top) ?? null;
  const id = row?.dataset.itemId ?? null;
  const it = id ? itemOf(id) : undefined;
  return { id, ts: tsOf(it), kind: it?.kind ?? '', offset: row ? row.getBoundingClientRect().top - top : 0, stick };
}

/** The anchor's index in history + items, or -1. */
export function anchorIndex(a: ThreadAnchor, history: readonly ChatItem[], items: readonly ChatItem[]): number {
  const all = history.length ? [...history, ...items] : items;
  if (a.id) {
    const i = all.findIndex((it) => it.id === a.id);
    if (i >= 0) return i;
  }
  if (!a.ts) return -1;
  return all.findIndex((it) => it.kind === a.kind && tsOf(it) === a.ts);
}

/** The anchor's mounted row, by id, else by time and kind. */
export function findAnchorRow(el: HTMLElement, a: ThreadAnchor, entries: readonly ChatItem[]): HTMLElement | null {
  const byId = (id: string) => el.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`);
  if (a.id) {
    const row = byId(a.id);
    if (row) return row;
  }
  if (!a.ts) return null;
  const twin = entries.find((it) => it.kind === a.kind && tsOf(it) === a.ts);
  return twin ? byId(twin.id) : null;
}
