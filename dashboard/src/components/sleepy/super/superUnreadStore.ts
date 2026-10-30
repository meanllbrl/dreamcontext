import { useSyncExternalStore } from 'react';

/**
 * The unread count of each project's Super Agent chat, for what sits outside the pane (the
 * rail, the phone's list). The pane is the only writer. A key is born with a pane's first
 * count and dies with the pane or at zero: a project closed leaves nothing here.
 */
const counts = new Map<string, { count: number; pane: object }>();
const listeners = new Set<() => void>();
const emit = () => { for (const fn of listeners) fn(); };

export function publishSuperUnread(vault: string, count: number, pane: object): void {
  const held = counts.get(vault);
  if (count > 0) {
    if (held?.count === count && held.pane === pane) return;
    counts.set(vault, { count, pane });
    if (held?.count !== count) emit();
  } else if (counts.delete(vault)) emit();
}

/** Only the pane that published: a pane replaced by a new one must not wipe the new one's count. */
export function dropSuperUnread(vault: string, pane: object): void {
  if (counts.get(vault)?.pane === pane && counts.delete(vault)) emit();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useSuperUnreadCount(vault: string | null): number {
  const read = () => (vault ? counts.get(vault)?.count ?? 0 : 0);
  return useSyncExternalStore(subscribe, read, read);
}

/** Tests only. */
export function _superUnreadSize(): number { return counts.size; }
