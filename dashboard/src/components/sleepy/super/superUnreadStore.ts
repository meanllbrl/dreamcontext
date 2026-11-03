import { useSyncExternalStore } from 'react';
import type { SuperId } from '../../../lib/superTypes';

/**
 * The unread count of each Super Agent chat, keyed by vault + superId (`'main'` or `m:<member>`,
 * plan-r10 1), for what sits outside the pane (the rail, the drawer, the phone's list). The pane
 * is the only writer. A key is born with a pane's first count (or its first open question) and
 * dies with the pane, or when it has neither: a project closed leaves nothing here.
 *
 * `asking`: the super has an open owner question (the Ekip row's question colour).
 */
interface Held { count: number; asking: boolean; pane: object; view: SuperUnreadView }
export interface SuperUnreadView { count: number; asking: boolean }

const NONE: SuperUnreadView = Object.freeze({ count: 0, asking: false });

const counts = new Map<string, Held>();
const listeners = new Set<() => void>();
const emit = () => { for (const fn of [...listeners]) fn(); };

/** One key per vault + super. A newline never appears in a vault name or a superId. */
const keyOf = (vault: string, superId: SuperId): string => `${vault}\n${superId}`;

export function publishSuperUnread(vault: string, count: number, pane: object, superId: SuperId = 'main', asking = false): void {
  const key = keyOf(vault, superId);
  const held = counts.get(key);
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (n > 0 || asking) {
    if (held && held.count === n && held.asking === asking) {
      if (held.pane !== pane) counts.set(key, { ...held, pane });
      return;
    }
    counts.set(key, { count: n, asking, pane, view: { count: n, asking } });
    emit();
  } else if (counts.delete(key)) emit();
}

/** Only the pane that published: a pane replaced by a new one must not wipe the new one's count. */
export function dropSuperUnread(vault: string, pane: object, superId: SuperId = 'main'): void {
  const key = keyOf(vault, superId);
  if (counts.get(key)?.pane === pane && counts.delete(key)) emit();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** A super's unread view, or the frozen zero (the same object every time, for `useSyncExternalStore`). */
export function readSuperUnread(vault: string | null, superId: SuperId = 'main'): SuperUnreadView {
  if (!vault) return NONE;
  return counts.get(keyOf(vault, superId))?.view ?? NONE;
}

/** Main Super's count, as every reader before Wave 3 knows it. */
export function useSuperUnreadCount(vault: string | null): number {
  const read = () => readSuperUnread(vault, 'main').count;
  return useSyncExternalStore(subscribe, read, read);
}

/** One super's unread count and whether it asks the owner something (plan-r10 1d, pinned). */
export function useSuperUnread(vault: string | null, superId: SuperId): SuperUnreadView {
  const read = () => readSuperUnread(vault, superId);
  return useSyncExternalStore(subscribe, read, read);
}

/** Tests only. */
export function _superUnreadSize(): number { return counts.size; }
