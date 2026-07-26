/**
 * Pure in-progress state for one pinned checklist window (chat-interactive-views
 * plan §1.13) — a checkbox, an always-available note, and optional attached file
 * paths per item. No React, no localStorage, no Tauri: this module only reduces
 * actions to a new state and reports progress, so it is trivially unit-testable.
 *
 * Deliberately absent from this shape: anything for a `wants:'secret'` item's
 * masked value. That value lives in the checklist window's own React state
 * (never dispatched through this reducer, never part of `ChecklistState`), which
 * is what makes `checklistStore.ts`'s "never persist a secret" guarantee hold by
 * construction rather than by a filter that could be bypassed by a future caller.
 */
import type { ChecklistViewSpec } from './chatViewSpec';

export interface ChecklistState {
  v: 1;
  updatedAt: number;
  checked: Record<string, boolean>;
  notes: Record<string, string>;
  files: Record<string, string[]>;
}

export type ChecklistAction =
  | { t: 'toggle'; id: string }
  | { t: 'setNote'; id: string; text: string }
  | { t: 'addFile'; id: string; paths: string[] }
  | { t: 'removeFile'; id: string; path: string }
  | { t: 'reset' };

/** A note this long is someone dictating a whole procedure, not annotating a
 *  step — capped so one item can't blow out the eventual submit payload. */
export const MAX_NOTE_CHARS = 4000;

/** Fresh state for a spec: every current item starts unchecked, with no note
 *  and no attached file. Seeding `checked` for every item (rather than leaving
 *  it empty) is what lets `checklistStore.ts`'s reconciliation tell "unchecked"
 *  apart from "an id that no longer exists in this checklist" when it reads a
 *  persisted blob back against a possibly-reissued spec. */
export function emptyState(spec: ChecklistViewSpec): ChecklistState {
  const checked: Record<string, boolean> = {};
  for (const item of spec.items) checked[item.id] = false;
  return { v: 1, updatedAt: Date.now(), checked, notes: {}, files: {} };
}

/** One item's total done/total readout — counted against `spec.items`, NOT
 *  `Object.keys(state.checked)`, so a stale id left over from a checklist the
 *  agent re-issued with fewer items never inflates the count. */
export function doneCount(spec: ChecklistViewSpec, s: ChecklistState): number {
  let n = 0;
  for (const item of spec.items) if (s.checked[item.id]) n++;
  return n;
}

export function checklistReducer(s: ChecklistState, a: ChecklistAction): ChecklistState {
  switch (a.t) {
    case 'toggle':
      return { ...s, checked: { ...s.checked, [a.id]: !s.checked[a.id] }, updatedAt: Date.now() };

    case 'setNote': {
      const text = a.text.length > MAX_NOTE_CHARS ? a.text.slice(0, MAX_NOTE_CHARS) : a.text;
      const notes = { ...s.notes };
      if (text) notes[a.id] = text; else delete notes[a.id];
      return { ...s, notes, updatedAt: Date.now() };
    }

    case 'addFile': {
      const existing = s.files[a.id] ?? [];
      const merged = [...existing];
      for (const p of a.paths) if (!merged.includes(p)) merged.push(p);
      return { ...s, files: { ...s.files, [a.id]: merged }, updatedAt: Date.now() };
    }

    case 'removeFile': {
      const existing = s.files[a.id] ?? [];
      // A path/id that was never attached is a no-op, not an error — nothing to
      // undo, so `files` comes back value-equal rather than growing an empty entry.
      if (!existing.includes(a.path)) return s;
      const filtered = existing.filter((p) => p !== a.path);
      const files = { ...s.files };
      if (filtered.length) files[a.id] = filtered; else delete files[a.id];
      return { ...s, files, updatedAt: Date.now() };
    }

    case 'reset':
      return { v: 1, updatedAt: Date.now(), checked: {}, notes: {}, files: {} };

    default:
      return s;
  }
}
