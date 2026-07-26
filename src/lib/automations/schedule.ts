/**
 * Automations — pure schedule math. No I/O, no imports beyond `types.ts`.
 * `now` is always an injected parameter, never `Date.now()`/`new Date()` read
 * internally, so every function here is deterministic and unit-testable.
 *
 * Wall-clock, machine-local design (see the task's Constraints & Decisions):
 * `Schedule.at` is a local "HH:MM", and `mostRecentFire`/`nextFire` construct
 * candidates via `new Date(y, m, d, hh, mm)` — local-time field arithmetic —
 * so DST is handled by the platform's Date implementation, not hand-rolled
 * offset math. Verified empirically on this machine (America/New_York, 2026
 * transitions): a nonexistent spring-forward wall time (02:30 on the day the
 * clock jumps 02:00→03:00) normalizes FORWARD to 03:30; an ambiguous
 * fall-back wall time (01:30, which occurs twice) resolves to the FIRST
 * occurrence (the pre-transition, still-DST offset). Both are exercised in
 * automations-schedule.test.ts under a forced `TZ`.
 */

import { WEEKDAYS, type Schedule, type Weekday } from './types.js';

export interface DueVerdict {
  due: boolean;
  fireAt: Date | null;
  /** NOTE: 'disabled' is part of this literal union for shape-compatibility
   *  with the tick layer's SlugVerdict (which ORs in 'disabled' and other
   *  states isDue cannot itself determine), but `isDue` NEVER returns it —
   *  this function has no `enabled` input. Tick checks `manifest.enabled` and
   *  skips calling `isDue` at all for a disabled automation, deciding
   *  'disabled' one layer up. See this module's isDue doc comment. */
  reason: 'due' | 'no-schedule' | 'disabled' | 'not-yet' | 'already-ran' | 'outside-catchup';
}

/** Lenient: anything that doesn't cleanly resolve to a valid schedule is
 *  `null` rather than a thrown error — a malformed manifest is never due, and
 *  that malformance is surfaced by `list`, not by an exception here. */
export function parseSchedule(v: unknown): Schedule | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const rec = v as Record<string, unknown>;
  const days = parseDays(rec.days);
  const at = parseAtString(rec.at);
  if (days === null || at === null) return null;
  return { days, at };
}

/** `mostRecentFire`/`nextFire` trust `schedule.days`/`schedule.at` came from a
 *  real `Schedule` value, but stay defensive about a hand-built `at` that
 *  doesn't match "HH:MM" — returning `null` rather than constructing an
 *  Invalid Date. */
export function mostRecentFire(schedule: Schedule, now: Date): Date | null {
  const at = parseAtParts(schedule.at);
  if (at === null) return null;
  for (let daysAgo = 0; daysAgo <= 7; daysAgo++) {
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, at.hh, at.mm, 0, 0);
    if (candidate.getTime() > now.getTime()) continue; // must be at-or-before now
    if (!dayMatches(schedule.days, candidate)) continue;
    return candidate;
  }
  return null; // e.g. schedule.days is an empty array — no valid day ever
}

export function nextFire(schedule: Schedule, now: Date): Date | null {
  const at = parseAtParts(schedule.at);
  if (at === null) return null;
  for (let daysAhead = 0; daysAhead <= 7; daysAhead++) {
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysAhead, at.hh, at.mm, 0, 0);
    if (candidate.getTime() <= now.getTime()) continue; // must be strictly after now
    if (!dayMatches(schedule.days, candidate)) continue;
    return candidate;
  }
  return null;
}

/**
 * Dueness verdict — an object, not a boolean, so `tick` can log WHY nothing
 * ran instead of just that nothing ran.
 *
 * Rule: due iff `now ≥ fire` (guaranteed by construction — `mostRecentFire`
 * only ever returns a fire at-or-before `now`) AND `lastFireAt < fire`
 * (this exact fire hasn't been recorded yet) AND `now − fire ≤ catchupHours`
 * (still inside the catch-up window).
 *
 * When the most recent applicable fire was already recorded, this function
 * further distinguishes 'already-ran' (that fire was TODAY — e.g. re-ticking
 * minutes after a run just completed) from 'not-yet' (that fire was on an
 * earlier calendar day — the steady-state "waiting for the next scheduled
 * day" case). Both are `due: false`; the split exists purely so a snapshot
 * or log line can say something more useful than "not due" in the common
 * case.
 *
 * 'disabled' is never returned — see the DueVerdict doc comment.
 */
export function isDue(
  schedule: Schedule | null,
  lastFireAt: string | null,
  now: Date,
  catchupHours: number,
): DueVerdict {
  if (schedule === null) return { due: false, fireAt: null, reason: 'no-schedule' };

  const fire = mostRecentFire(schedule, now);
  if (fire === null) return { due: false, fireAt: null, reason: 'no-schedule' };

  const lastFireMs = lastFireAt !== null ? Date.parse(lastFireAt) : NaN;
  const alreadyHandled = Number.isFinite(lastFireMs) && lastFireMs >= fire.getTime();

  if (alreadyHandled) {
    const reason = isSameCalendarDay(fire, now) ? 'already-ran' : 'not-yet';
    return { due: false, fireAt: fire, reason };
  }

  const ageMs = now.getTime() - fire.getTime();
  const catchupMs = catchupHours * 60 * 60 * 1000;
  if (ageMs > catchupMs) return { due: false, fireAt: fire, reason: 'outside-catchup' };

  return { due: true, fireAt: fire, reason: 'due' };
}

/** Human-readable schedule summary for CLI output (`list`, `show`). */
export function formatSchedule(schedule: Schedule | null): string {
  if (schedule === null) return 'no schedule';
  if (schedule.days === 'daily') return `every day at ${schedule.at}`;
  if (schedule.days.length === 0) return 'no schedule';
  return `${schedule.days.join(', ')} at ${schedule.at}`;
}

// ─── internal helpers ───────────────────────────────────────────────────────

function parseDays(v: unknown): 'daily' | Weekday[] | null {
  if (v === 'daily') return 'daily';
  if (Array.isArray(v)) return normalizeDayList(v.map((d) => String(d)));
  if (typeof v === 'string') {
    const trimmed = v.trim().toLowerCase();
    if (trimmed === 'daily') return 'daily';
    return normalizeDayList(trimmed.split(','));
  }
  return null;
}

function normalizeDayList(raw: string[]): Weekday[] | null {
  const days = raw.map((d) => d.trim().toLowerCase()).filter((d) => d.length > 0);
  if (days.length === 0) return null;
  if (!days.every((d): d is Weekday => (WEEKDAYS as readonly string[]).includes(d))) return null;
  return days as Weekday[];
}

function parseAtString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const parts = parseAtParts(v);
  if (parts === null) return null;
  return `${String(parts.hh).padStart(2, '0')}:${String(parts.mm).padStart(2, '0')}`;
}

/** Accepts "HH:MM", "H:MM", and a "." separator ("18.00"); rejects anything
 *  else, including an out-of-range hour/minute. */
function parseAtParts(at: string): { hh: number; mm: number } | null {
  if (typeof at !== 'string') return null;
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(at.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(hh) || hh < 0 || hh > 23) return null;
  if (!Number.isInteger(mm) || mm < 0 || mm > 59) return null;
  return { hh, mm };
}

function dayMatches(days: 'daily' | Weekday[], date: Date): boolean {
  if (days === 'daily') return true;
  if (days.length === 0) return false;
  const dow = WEEKDAYS[date.getDay()]; // getDay(): 0=Sun..6=Sat — matches WEEKDAYS order
  return (days as readonly string[]).includes(dow);
}

function isSameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
