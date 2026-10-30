import { useSyncExternalStore } from 'react';

/**
 * The unread count of each project's Super Agent chat, for what sits outside the pane (the
 * rail, the phone's list). The pane is the only writer. A key is born with a pane's first
 * count and dies with the pane (`dropSuperUnread`): a project closed leaves nothing here.
 */
const counts = new Map<string, number>();
const listeners = new Set<() => void>();
const emit = () => { for (const fn of listeners) fn(); };

export function publishSuperUnread(vault: string, count: number): void {
  if ((counts.get(vault) ?? 0) === count && (count > 0 || !counts.has(vault))) return;
  if (count > 0) counts.set(vault, count); else counts.delete(vault);
  emit();
}

export function dropSuperUnread(vault: string): void {
  if (counts.delete(vault)) emit();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useSuperUnreadCount(vault: string | null): number {
  const read = () => (vault ? counts.get(vault) ?? 0 : 0);
  return useSyncExternalStore(subscribe, read, read);
}

/** Tests only. */
export function _superUnreadSize(): number { return counts.size; }
