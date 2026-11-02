import { useSyncExternalStore } from 'react';
import type { SuperId, SuperStateView } from '../../../lib/superTypes';

/**
 * Every Super Agent record this window holds, keyed by vault + superId (`'main'` or
 * `m:<member-slug>`). The server's record per super (pushed as `super_state`, read once after a
 * reload) lives here, not in a component's state, so a stage can show several supers side by side
 * (Wave 3) while the view state (which screen, width, dock, motion, pending patches) stays ONE copy
 * in the pane, bound to its active super.
 *
 * The same shape as `superUnreadStore.ts`: a Map, listeners, `useSyncExternalStore`. A key is born
 * with its first non-null write and dies with a null write or with the pane that wrote it
 * (`dropSuperRecords`, called from the pane's unmount): a project closed leaves nothing here, and a
 * pane replaced by a new one never wipes the new one's record.
 */

export const MAIN_SUPER: SuperId = 'main';

/** A member's slug as the server stores it (`[a-z0-9][a-z0-9-]*`, no `..`, no `/`). */
const MEMBER_ID = /^m:[a-z0-9][a-z0-9-]*$/;

/** A frame's or caller's superId: a well-formed `m:<slug>`, else `'main'` (absent, unknown or
 *  malformed all read as main, exactly as the server reads an absent one). */
export function superIdOf(raw: unknown): SuperId {
  return typeof raw === 'string' && MEMBER_ID.test(raw) ? (raw as SuperId) : MAIN_SUPER;
}

interface Held { record: SuperStateView; pane: object }

const records = new Map<string, Held>();
const listeners = new Set<() => void>();
const emit = () => { for (const fn of [...listeners]) fn(); };

/** One key per vault + super. A newline never appears in a vault name or a superId. */
const keyOf = (vault: string | null, superId: SuperId): string => `${vault ?? ''}\n${superId}`;
const vaultPrefix = (vault: string | null): string => `${vault ?? ''}\n`;

/** The record of this super in this vault, or null (none yet, or dropped). */
export function readSuperRecord(vault: string | null, superId: SuperId = MAIN_SUPER): SuperStateView | null {
  return records.get(keyOf(vault, superId))?.record ?? null;
}

export type SuperRecordUpdate =
  | SuperStateView
  | null
  | ((prev: SuperStateView | null) => SuperStateView | null);

/**
 * Write a super's record (the value, or an updater over the one held now, like a state setter).
 * Null deletes the key. The writing pane becomes the key's owner. Answers the record held after
 * the write. Listeners hear only a real change (a new record object or a death).
 */
export function writeSuperRecord(vault: string | null, superId: SuperId, next: SuperRecordUpdate, pane: object): SuperStateView | null {
  const key = keyOf(vault, superId);
  const held = records.get(key);
  const prev = held?.record ?? null;
  const value = typeof next === 'function' ? next(prev) : next;
  if (value === null) {
    if (records.delete(key)) emit();
    return null;
  }
  if (held && held.record === value) {
    if (held.pane !== pane) records.set(key, { record: value, pane });
    return value;
  }
  records.set(key, { record: value, pane });
  emit();
  return value;
}

/** The pane's death: every record of this vault the pane wrote goes. A record another pane has
 *  written since (a replaced pane's successor) stays. With a superId, only that one. */
export function dropSuperRecords(vault: string | null, pane: object, superId?: SuperId): void {
  let changed = false;
  if (superId !== undefined) {
    const key = keyOf(vault, superId);
    if (records.get(key)?.pane === pane) changed = records.delete(key);
  } else {
    const prefix = vaultPrefix(vault);
    for (const [key, held] of [...records]) {
      if (key.startsWith(prefix) && held.pane === pane) { records.delete(key); changed = true; }
    }
  }
  if (changed) emit();
}

/** Called after every change to any record. Returns the unsubscribe. */
export function subscribeSuperRecords(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The record of one super, followed: for readers outside the writing pane (the rail, a second
 *  stage). The superId defaults to main. */
export function useSuperRecord(vault: string | null, superId: SuperId = MAIN_SUPER): SuperStateView | null {
  const read = () => readSuperRecord(vault, superId);
  return useSyncExternalStore(subscribeSuperRecords, read, read);
}

/** Tests only. */
export function _superRecordSize(): number { return records.size; }
