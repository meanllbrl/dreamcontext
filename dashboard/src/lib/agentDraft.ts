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
import type { ScheduleSlot } from '../../../src/lib/automations/types.js';
import { parseSlot } from '../../../src/lib/automations/schedule.js';

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

// ─── Schedule slots (the dialog's "When does it run?" rows) ─────────────────

/** How one row fires. `weeks` is weekly with an "every N weeks" count. */
export type SlotCadence = 'weekly' | 'weeks' | 'monthdays' | 'nth' | 'cron';

/**
 * One editable row. It keeps EVERY cadence's inputs at once, so flipping the
 * cadence select back and forth never throws away what the owner typed; only
 * the fields of the chosen cadence become the slot. Month days and nth
 * weekdays are text ("1, 15, last" / "1st mon, last fri") because a picker for
 * each would be a calendar the owner has to learn — and the text is exactly
 * what the CLI's `month:` slot takes.
 */
export interface SlotRow {
  id: number;
  cadence: SlotCadence;
  days: Weekday[];
  at: string;
  everyWeeks: number;
  /** YYYY-MM-DD — a day in a week the slot fires. */
  anchor: string;
  monthText: string;
  nthText: string;
  cron: string;
}

let slotRowSeq = 0;

function todayString(today: Date): string {
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}

export function newSlotRow(today: Date, over: Partial<SlotRow> = {}): SlotRow {
  slotRowSeq += 1;
  return {
    id: slotRowSeq,
    cadence: 'weekly',
    days: ['mon', 'tue', 'wed', 'thu', 'fri'],
    at: '09:00',
    everyWeeks: 2,
    anchor: todayString(today),
    monthText: '1',
    nthText: '1st mon',
    cron: '0 9 * * 1',
    ...over,
  };
}

const ALL_DAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** A saved slot → an editable row. */
export function slotRowFromSlot(slot: ScheduleSlot, today: Date): SlotRow {
  switch (slot.kind) {
    case 'weekly': {
      const days = slot.days === 'daily' ? [...ALL_DAYS] : [...slot.days];
      return slot.everyWeeks && slot.everyWeeks > 1
        ? newSlotRow(today, { cadence: 'weeks', days, at: slot.at, everyWeeks: slot.everyWeeks, anchor: slot.anchor ?? todayString(today) })
        : newSlotRow(today, { cadence: 'weekly', days, at: slot.at });
    }
    case 'monthdays':
      return newSlotRow(today, {
        cadence: 'monthdays',
        at: slot.at,
        monthText: slot.monthdays.map((d) => (d === -1 ? 'last' : String(d))).join(', '),
      });
    case 'nth':
      return newSlotRow(today, {
        cadence: 'nth',
        at: slot.at,
        nthText: slot.nth
          .map((x) => `${x.n === -1 ? 'last' : x.n < 0 ? String(x.n) : `${x.n}${x.n === 1 ? 'st' : x.n === 2 ? 'nd' : x.n === 3 ? 'rd' : 'th'}`} ${x.weekday}`)
          .join(', '),
      });
    case 'cron':
      return newSlotRow(today, { cadence: 'cron', cron: slot.cron });
  }
}

/** The rows a dialog opens with: the agent's saved slots, else one row from
 *  the starter's `days`/`at`, else weekdays at 09:00. */
export function initialSlotRows(
  saved: ScheduleSlot[] | null | undefined,
  start: { days?: Weekday[]; at?: string } | undefined,
  today: Date,
): SlotRow[] {
  if (saved && saved.length > 0) return saved.map((s) => slotRowFromSlot(s, today));
  return [newSlotRow(today, { ...(start?.days ? { days: start.days } : {}), ...(start?.at ? { at: start.at } : {}) })];
}

/**
 * A row → the slot it means, or why it means none. Goes through
 * `parseSlot` — the SAME validator the server's write path uses — so the
 * dialog can never accept a slot the save would then refuse.
 */
export function slotFromRow(row: SlotRow): { slot: ScheduleSlot } | { error: string } {
  const split = (t: string) => t.split(',').map((x) => x.trim()).filter(Boolean);
  switch (row.cadence) {
    case 'weekly':
      if (row.days.length === 0) return { error: 'Pick at least one day.' };
      return parseSlot({ days: packDays(row.days), at: row.at });
    case 'weeks':
      if (row.days.length === 0) return { error: 'Pick at least one day.' };
      return parseSlot({ days: packDays(row.days), at: row.at, every_weeks: row.everyWeeks, anchor: row.anchor });
    case 'monthdays':
      return parseSlot({ monthdays: split(row.monthText), at: row.at });
    case 'nth':
      return parseSlot({ nth: split(row.nthText), at: row.at });
    case 'cron':
      return parseSlot({ cron: row.cron });
  }
}

/** Every row as a slot, or the first row's problem ("Time 2: …"). */
export function slotsFromRows(rows: SlotRow[]): { slots: ScheduleSlot[] } | { error: string } {
  const slots: ScheduleSlot[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = slotFromRow(rows[i]);
    if ('error' in r) return { error: rows.length > 1 ? `Time ${i + 1}: ${r.error}` : r.error };
    slots.push(r.slot);
  }
  if (slots.length === 0) return { error: 'Add at least one time.' };
  return { slots };
}

/**
 * "today 16:30", "tomorrow 09:30", "Mon 09:30" within the week, else
 * "12 Oct, 10:00". The next fire is a moment the owner plans around, so it is
 * named the way a person says it rather than as an ISO stamp.
 */
export function nextFireWords(iso: string | null, now: Date): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate(), 12).getTime();
  const dayDiff = Math.round((startOf(d) - startOf(now)) / 86_400_000);
  if (dayDiff === 0) return `today ${time}`;
  if (dayDiff === 1) return `tomorrow ${time}`;
  if (dayDiff > 1 && dayDiff < 7) return `${WEEKDAY_LABEL[d.getDay()]} ${time}`;
  return `${d.getDate()} ${MONTH_LABEL[d.getMonth()]}, ${time}`;
}

const WEEKDAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_LABEL = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
