import { useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import '../handsfree.css';
import { usePhoneLink } from './phoneState';

/**
 * The phone's Bag note: once per hands-free run while Bag mode is on, under the header (the chat
 * list and an open chat). "OK" dismisses it for THIS run: the key is the run's `startedAt`, so a
 * Return + start shows it again. Writing a key drops the older ones. No `startedAt`, or a
 * localStorage that throws (iOS private mode): the dismissal lives in memory only.
 */

export const BAG_NOTE_PREFIX = 'hf-bag-note:';

/** Dismissals kept in memory (no startedAt, or storage refused). */
const memory = new Set<string>();

export interface NoteStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  readonly length: number;
  key(i: number): string | null;
}

function storage(): NoteStorage | null {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
}

/** Was the note dismissed for the run that started at `startedAt`? */
export function bagNoteDismissed(startedAt: string | null, store: NoteStorage | null = storage()): boolean {
  const k = startedAt ?? '';
  if (memory.has(k)) return true;
  if (!startedAt || !store) return false;
  try { return store.getItem(BAG_NOTE_PREFIX + startedAt) === '1'; } catch { return false; }
}

/** Dismiss it for this run; older runs' keys are removed. */
export function dismissBagNote(startedAt: string | null, store: NoteStorage | null = storage()): void {
  memory.add(startedAt ?? '');
  if (!startedAt || !store) return;
  try {
    const old: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k && k.startsWith(BAG_NOTE_PREFIX) && k !== BAG_NOTE_PREFIX + startedAt) old.push(k);
    }
    for (const k of old) store.removeItem(k);
    store.setItem(BAG_NOTE_PREFIX + startedAt, '1');
  } catch { /* memory holds it */ }
}

/** Tests only. */
export function resetBagNoteMemoryForTests(): void { memory.clear(); }

export function PhoneBagNote() {
  const { t } = useI18n();
  const { state } = usePhoneLink();
  const [, bump] = useState(0);
  if (!state?.bagMode || bagNoteDismissed(state.startedAt)) return null;
  return (
    <div className="hf-phone-bag-note" role="note" data-testid="phone-bag-note">
      <p>{t('handsfree.mac.phoneBagNote')}</p>
      <button type="button" data-testid="phone-bag-note-ok" onClick={() => { dismissBagNote(state.startedAt); bump((n) => n + 1); }}>
        {t('handsfree.mac.ok')}
      </button>
    </div>
  );
}
