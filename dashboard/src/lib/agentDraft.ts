/**
 * Pure logic the New agent / Edit agent dialog leans on.
 *
 * Extracted from the component ON PURPOSE: this repo's vitest runs in `node`
 * with no jsdom, so anything left inline in the JSX can only ever be checked
 * by scanning source text. These two behaviours are the ones most worth
 * asserting for real — a prefill that overwrites what you typed, and a delete
 * that fires on the first click, are both the kind of bug you only find by
 * losing work to it.
 */

import type { Weekday } from '../hooks/useAutomations';

/** How long a primed Delete stays primed, in ms. The
 *  `inline-two-click-confirm` pattern's own figure — long enough to be a
 *  decision, short enough that an armed destructive button never outlives the
 *  glance that armed it. */
export const DELETE_ARM_MS = 5000;

/**
 * What a click on Delete should DO, given whether it is already armed.
 *
 * A function rather than an inline `if` so the invariant that matters —
 * **the first click never deletes** — is assertable without a DOM.
 */
export function deleteAction(armed: boolean): 'arm' | 'commit' {
  return armed ? 'commit' : 'arm';
}

/**
 * A time-of-day mentioned in the plain-language description, as `HH:MM`, or
 * `null` when there isn't one.
 *
 * Accepts `09:00` and `09.00` (the Turkish written form the owner actually
 * types) and validates the parts, so `25:99` in a sentence about a version
 * number never becomes a schedule.
 */
export function timeFromDescription(text: string): string | null {
  const m = text.match(/\b(\d{1,2})[:.](\d{2})\b/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
  if (hh > 23 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * A name derived from the description's first clause, capped so it fits the
 * Name field without scrolling.
 *
 * Callers must only apply this while the owner has NOT touched Name
 * themselves — see `shouldPrefill`. Deriving unconditionally is what makes a
 * form eat your edit the moment you go back to fix a typo upstream.
 */
export function nameFromDescription(text: string): string {
  const firstClause = text.split(/[;.\n]/)[0] ?? '';
  return firstClause.trim().slice(0, 48);
}

/**
 * May the dialog still prefill this field from the description?
 *
 * Two independent vetoes, and both matter:
 *  - `touched` — the owner has typed in the field, so it is theirs now.
 *  - `editing` — an EXISTING agent's name and time were chosen deliberately
 *    once already; re-deriving them from the prompt on an edit would rename
 *    an agent because someone fixed a typo in its description.
 */
export function shouldPrefill({ touched, editing }: { touched: boolean; editing: boolean }): boolean {
  return !touched && !editing;
}

/** `'daily'` when every weekday is picked, so an agent set to all seven reads
 *  "every day" everywhere instead of a seven-item list. */
export function packDays(days: Weekday[]): 'daily' | Weekday[] {
  return days.length === 7 ? 'daily' : days;
}
