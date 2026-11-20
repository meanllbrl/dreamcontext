/**
 * The Super chat's job filter (plan super-v3 D9, K11): tapping an agenda row narrows the chat to
 * that job until he taps it again or "Show all". One window-wide value, never written to the
 * record. W1 opens the seam (the card outline reads it); W2 fills `inJob`.
 */
import { useSyncExternalStore } from 'react';

let current: string | null = null;
const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The job the chat is narrowed to (a child's session id or an agenda line's id), or null. */
export function useJobFilter(): string | null {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

/** Narrow the chat to `job`, or clear it with null. */
export function setJobFilter(job: string | null): void {
  if (job === current) return;
  current = job;
  for (const fn of [...listeners]) fn();
}

/** The value now, outside React. */
export function jobFilterNow(): string | null { return current; }

/** Does `item` stay in the chat while it is narrowed to `job`? Until W2 fills it: everything. */
export function inJob(_item: unknown, job: string | null): boolean {
  void job;
  return true;
}
