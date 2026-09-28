/**
 * Automations — pure schedule math. No I/O, no imports beyond `types.ts`.
 * `now` is always an injected parameter, never `Date.now()`/`new Date()` read
 * internally, so every function here is deterministic and unit-testable.
 *
 * A schedule is a UNION of slots (see {@link ScheduleSlot}): the agent is due
 * at every moment any slot names. `mostRecentFire` is the latest fire across
 * all slots, `nextFire` the earliest, and `isDue` asks one question of that
 * union — so two slots on one day both fire (09:30 ran, 16:30 is still owed),
 * while two slots that were BOTH missed collapse into one fire, the most recent
 * one. That collapse is the same rule a single slot has always had after a
 * week offline: the watermark (`lastFireAt`) moves to the fire that ran, and
 * every earlier fire is behind it.
 *
 * Wall-clock, machine-local design: every `at` is a local "HH:MM", and
 * candidates are constructed via `new Date(y, m, d, hh, mm)` — local-time field
 * arithmetic — so DST is handled by the platform's Date implementation, not
 * hand-rolled offset math. Verified empirically (America/New_York, 2026
 * transitions): a nonexistent spring-forward wall time (02:30 on the day the
 * clock jumps 02:00→03:00) normalizes FORWARD to 03:30; an ambiguous fall-back
 * wall time (01:30, which occurs twice) resolves to the FIRST occurrence. Which
 * calendar DAY a slot matches is decided on that day's local noon, so no DST
 * shift can move a candidate onto the neighbouring date. All of it is
 * exercised in automations-schedule.test.ts under a forced `TZ`.
 */

import { WEEKDAYS, type AutomationMode, type Schedule, type ScheduleSlot, type Weekday } from './types.js';

export interface DueVerdict {
  due: boolean;
  fireAt: Date | null;
  /** NOTE: 'disabled' is part of this literal union for shape-compatibility
   *  with the tick layer's SlugVerdict (which ORs in 'disabled' and other
   *  states isDue cannot itself determine), but `isDue` NEVER returns it —
   *  this function has no `enabled` input. Tick checks `manifest.enabled` and
   *  skips calling `isDue` at all for a disabled automation, deciding
   *  'disabled' one layer up. See this module's isDue doc comment. */
  reason: 'due' | 'no-schedule' | 'on-call' | 'disabled' | 'not-yet' | 'already-ran' | 'outside-catchup';
}

/** Monday-first, the order a week is read in — used for labels and ranges. */
const WEEK_ORDER: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MAX_EVERY_WEEKS = 52;
/** How far back/forward a calendar slot is searched. A year and a bit covers
 *  every structured cadence (a 5th-weekday slot can skip three months); cron
 *  gets eight years because `0 9 29 2 *` is a legal once-per-leap-year job. */
const DAY_HORIZON = 400;
const CRON_DAY_HORIZON = 366 * 8 + 2;

// ─── Parsing (manifest YAML → Schedule) ─────────────────────────────────────

export type ScheduleParse = { schedule: Schedule; error: null } | { schedule: null; error: string | null };

/**
 * Parse a manifest's `schedule` value, saying WHY when it cannot.
 *
 * `error: null` with `schedule: null` means there is no schedule at all
 * (absent/null) — the on-call and "never set" case, which is not a fault.
 * Anything else that fails names the slot ("slot 2: …") so `list` can print
 * exactly which part of a multi-slot schedule is broken. One broken slot
 * fails the WHOLE schedule: an agent silently running on half its schedule is
 * worse than one that visibly runs on none.
 */
export function parseScheduleDetailed(v: unknown): ScheduleParse {
  if (v === null || v === undefined) return { schedule: null, error: null };
  if (typeof v !== 'object' || Array.isArray(v)) {
    return { schedule: null, error: 'schedule must be a mapping — { days, at } or { slots: [...] }' };
  }
  const rec = v as Record<string, unknown>;
  if ('slots' in rec) {
    const extra = Object.keys(rec).filter((k) => k !== 'slots');
    if (extra.length > 0) {
      return { schedule: null, error: `schedule has both slots and ${extra.join(', ')} — put every time inside slots` };
    }
    if (!Array.isArray(rec.slots) || rec.slots.length === 0) {
      return { schedule: null, error: 'schedule.slots must be a non-empty list' };
    }
    const slots: ScheduleSlot[] = [];
    for (let i = 0; i < rec.slots.length; i++) {
      const r = parseSlot(rec.slots[i]);
      if ('error' in r) return { schedule: null, error: `slot ${i + 1}: ${r.error}` };
      slots.push(r.slot);
    }
    return { schedule: { slots }, error: null };
  }
  const r = parseSlot(rec);
  if ('error' in r) return { schedule: null, error: r.error };
  return { schedule: { slots: [r.slot] }, error: null };
}

/** Lenient: anything that doesn't cleanly resolve to a valid schedule is
 *  `null` rather than a thrown error — a malformed manifest is never due, and
 *  that malformance is surfaced by `list` (via {@link parseScheduleDetailed}),
 *  not by an exception here. */
export function parseSchedule(v: unknown): Schedule | null {
  return parseScheduleDetailed(v).schedule;
}

const SLOT_KEYS = new Set(['days', 'at', 'every_weeks', 'anchor', 'monthdays', 'nth', 'cron']);

/** One slot from its YAML mapping. */
export function parseSlot(v: unknown): { slot: ScheduleSlot } | { error: string } {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return { error: 'a slot must be a mapping like { days: [mon], at: "09:30" }' };
  }
  const rec = v as Record<string, unknown>;
  const unknown = Object.keys(rec).filter((k) => !SLOT_KEYS.has(k));
  if (unknown.length > 0) return { error: `unknown key${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}` };

  const cadences = (['days', 'monthdays', 'nth', 'cron'] as const).filter((k) => rec[k] !== undefined);
  if (cadences.length === 0) return { error: 'needs one of days, monthdays, nth or cron' };
  if (cadences.length > 1) return { error: `has both ${cadences.join(' and ')} — one cadence per slot, use two slots` };
  const cadence = cadences[0];

  if (cadence === 'cron') {
    for (const k of ['at', 'every_weeks', 'anchor'] as const) {
      if (rec[k] !== undefined) return { error: `a cron slot carries its own time — drop ${k}` };
    }
    if (typeof rec.cron !== 'string') return { error: 'cron must be a string like "30 9 * * 1"' };
    const expr = rec.cron.trim().replace(/\s+/g, ' ');
    const parsed = parseCron(expr);
    if ('error' in parsed) return { error: `cron "${rec.cron}": ${parsed.error}` };
    return { slot: { kind: 'cron', cron: expr } };
  }

  if (rec.at === undefined) return { error: 'missing at (a 24h "HH:MM" time)' };
  const at = parseAtString(rec.at);
  if (at === null) return { error: `at "${String(rec.at)}" is not a 24h "HH:MM" time` };

  if (cadence !== 'days') {
    for (const k of ['every_weeks', 'anchor'] as const) {
      if (rec[k] !== undefined) return { error: `${k} only applies to a days slot` };
    }
  }

  if (cadence === 'monthdays') {
    const list = Array.isArray(rec.monthdays) ? rec.monthdays : [rec.monthdays];
    const days: number[] = [];
    for (const raw of list) {
      const d = parseMonthday(raw);
      if (d === null) return { error: `monthdays "${String(raw)}" must be 1..31, or -1..-31 counted from the end (-1 or "last" = last day)` };
      if (!days.includes(d)) days.push(d);
    }
    if (days.length === 0) return { error: 'monthdays is empty' };
    return { slot: { kind: 'monthdays', monthdays: days, at } };
  }

  if (cadence === 'nth') {
    const list = Array.isArray(rec.nth) ? rec.nth : [rec.nth];
    const items: { weekday: Weekday; n: number }[] = [];
    for (const raw of list) {
      const item = parseNthItem(raw);
      if (item === null) {
        return { error: `nth "${typeof raw === 'object' ? JSON.stringify(raw) : String(raw)}" must be { weekday: mon, n: 1 } (n 1..5, or -1..-5 from the end)` };
      }
      if (!items.some((x) => x.weekday === item.weekday && x.n === item.n)) items.push(item);
    }
    if (items.length === 0) return { error: 'nth is empty' };
    return { slot: { kind: 'nth', nth: items, at } };
  }

  const days = parseDays(rec.days);
  if (days === null) {
    return { error: `days "${Array.isArray(rec.days) ? rec.days.join(',') : String(rec.days)}" must be "daily" or weekdays (sun..sat, ranges like mon-fri)` };
  }
  let everyWeeks = 1;
  if (rec.every_weeks !== undefined) {
    const n = Number(rec.every_weeks);
    if (!Number.isInteger(n) || n < 1 || n > MAX_EVERY_WEEKS) return { error: `every_weeks must be a whole number 1..${MAX_EVERY_WEEKS}` };
    everyWeeks = n;
  }
  let anchor: string | undefined;
  if (rec.anchor !== undefined) {
    const a = parseAnchor(rec.anchor);
    if (a === null) return { error: `anchor "${String(rec.anchor)}" must be a YYYY-MM-DD date` };
    anchor = a;
  }
  if (everyWeeks > 1 && anchor === undefined) {
    return { error: `every_weeks: ${everyWeeks} needs an anchor date (YYYY-MM-DD in a week it should fire)` };
  }
  if (everyWeeks === 1) return { slot: { kind: 'weekly', days, at } };
  return { slot: { kind: 'weekly', days, at, everyWeeks, anchor } };
}

// ─── Serialization (Schedule → manifest YAML) ───────────────────────────────

/** The YAML-ready value for a slot. snake_case keys, like every other manifest field. */
export function serializeSlot(slot: ScheduleSlot): Record<string, unknown> {
  switch (slot.kind) {
    case 'weekly':
      return slot.everyWeeks && slot.everyWeeks > 1
        ? { days: slot.days, at: slot.at, every_weeks: slot.everyWeeks, anchor: slot.anchor }
        : { days: slot.days, at: slot.at };
    case 'monthdays':
      return { monthdays: slot.monthdays, at: slot.at };
    case 'nth':
      return { nth: slot.nth.map((x) => ({ weekday: x.weekday, n: x.n })), at: slot.at };
    case 'cron':
      return { cron: slot.cron };
  }
}

/** One slot is written FLAT — so a one-slot weekly agent keeps the exact
 *  legacy `{ days, at }` shape it has always had — and more than one as
 *  `{ slots: [...] }`. */
export function serializeSchedule(schedule: Schedule | null): Record<string, unknown> | null {
  if (schedule === null || schedule.slots.length === 0) return null;
  if (schedule.slots.length === 1) return serializeSlot(schedule.slots[0]);
  return { slots: schedule.slots.map(serializeSlot) };
}

// ─── The slot string (`--slot "mon-fri@16:30"`) ─────────────────────────────

/**
 * Parse the CLI's slot string. Grammar (the time may follow `@` or a space):
 *
 *   daily@09:00 · mon@09:30 · mon-fri@16:30 · mon,wed,fri@08:00
 *   2w:mon@10:00                   every 2 weeks, this week is a fire week
 *   2w/2026-09-28:mon@10:00        every 2 weeks, anchored to that date's week
 *   month:1,15,last@09:00          days of the month (-2 = second to last)
 *   month:1st-mon@09:30            nth weekday (1st..5th, last)
 *   cron:30 9 * * 1                5-field cron, local time
 *
 * `today` supplies the default anchor for `Nw:` so the parse stays pure.
 */
export function parseSlotSpec(spec: string, today: Date): { slot: ScheduleSlot } | { error: string } {
  const s = spec.trim().replace(/–/g, '-');
  if (!s) return { error: 'empty slot' };

  const cron = /^cron:\s*(.+)$/i.exec(s);
  if (cron) return parseSlot({ cron: cron[1] });

  const timed = /^(.*?)(?:@|\s+)(\d{1,2}[:.]\d{2})$/.exec(s);
  if (!timed || !timed[1].trim()) {
    return { error: `"${spec}" — expected <days>@HH:MM (e.g. mon-fri@16:30), Nw:<days>@HH:MM, month:<days>@HH:MM or cron:<expr>` };
  }
  const when = timed[1].trim();
  const at = timed[2];

  const month = /^month(?:ly)?:(.+)$/i.exec(when);
  if (month) {
    const items = month[1].split(',').map((x) => x.trim()).filter(Boolean);
    if (items.length === 0) return { error: `"${spec}" — month: needs days (1,15,last) or weekdays (1st-mon)` };
    const nthItems = items.filter((x) => /[a-z]{3}$/i.test(x) && x.toLowerCase() !== 'last');
    if (nthItems.length > 0 && nthItems.length < items.length) {
      return { error: `"${spec}" mixes days of the month with nth weekdays — pass them as two --slot values` };
    }
    const r = nthItems.length > 0 ? parseSlot({ nth: items, at }) : parseSlot({ monthdays: items, at });
    return 'error' in r ? { error: `"${spec}" — ${r.error}` } : r;
  }

  const weeks = /^(\d+)w(?:\/([^:]+))?:(.+)$/i.exec(when);
  if (weeks) {
    const r = parseSlot({
      days: weeks[3].trim(),
      at,
      every_weeks: Number(weeks[1]),
      anchor: weeks[2]?.trim() ?? localDateString(today),
    });
    return 'error' in r ? { error: `"${spec}" — ${r.error}` } : r;
  }

  const r = parseSlot({ days: when, at });
  return 'error' in r ? { error: `"${spec}" — ${r.error}` } : r;
}

/** The slot string that {@link parseSlotSpec} reads back to the same slot —
 *  what `show` prints so an owner can copy an existing slot into `--slot`. */
export function slotSpec(slot: ScheduleSlot): string {
  switch (slot.kind) {
    case 'weekly': {
      const days = daysLabel(slot.days, '-');
      const prefix = slot.everyWeeks && slot.everyWeeks > 1 ? `${slot.everyWeeks}w/${slot.anchor}:` : '';
      return `${prefix}${days.replace(/, /g, ',')}@${slot.at}`;
    }
    case 'monthdays':
      return `month:${slot.monthdays.map((d) => (d === -1 ? 'last' : String(d))).join(',')}@${slot.at}`;
    case 'nth':
      return `month:${slot.nth.map((x) => `${x.n < -1 ? String(x.n) : ordinal(x.n)}-${x.weekday}`).join(',')}@${slot.at}`;
    case 'cron':
      return `cron:${slot.cron}`;
  }
}

// ─── Labels ─────────────────────────────────────────────────────────────────

/** "mon 09:30", "mon–fri 16:30", "every 2 weeks mon 10:00",
 *  "monthly 1, 15, last 09:00", "monthly 1st mon 09:30", "cron 30 9 * * 1". */
export function formatSlot(slot: ScheduleSlot): string {
  switch (slot.kind) {
    case 'weekly': {
      const days = daysLabel(slot.days, '–');
      return slot.everyWeeks && slot.everyWeeks > 1
        ? `every ${slot.everyWeeks} weeks ${days} ${slot.at}`
        : `${days} ${slot.at}`;
    }
    case 'monthdays':
      return `monthly ${slot.monthdays.map(monthdayLabel).join(', ')} ${slot.at}`;
    case 'nth':
      return `monthly ${slot.nth.map((x) => `${ordinal(x.n)} ${x.weekday}`).join(', ')} ${slot.at}`;
    case 'cron':
      return `cron ${slot.cron}`;
  }
}

/** Human-readable schedule summary for every surface (`list`, `show`, the
 *  dashboard card, the flow's trigger node): slots joined by " · ". */
export function formatSchedule(schedule: Schedule | null): string {
  // A hand-built weekly slot with no days can never fire, so it names nothing.
  const slots = slotsOf(schedule).filter((x) => x.kind !== 'weekly' || x.days === 'daily' || x.days.length > 0);
  if (slots.length === 0) return 'no schedule';
  return slots.map(formatSlot).join(' · ');
}

// ─── Fire math ──────────────────────────────────────────────────────────────

/** The latest fire of ONE slot at-or-before `now`, or null if it never fires
 *  within the search horizon. */
export function slotMostRecentFire(slot: ScheduleSlot, now: Date): Date | null {
  const times = slotTimes(slot);
  if (times === null || times.length === 0) return null;
  const desc = [...times].reverse();
  const horizon = slotHorizon(slot);
  for (let daysAgo = 0; daysAgo <= horizon; daysAgo++) {
    const noon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 12, 0, 0, 0);
    if (!slotDayMatches(slot, noon)) continue;
    for (const t of desc) {
      const candidate = new Date(noon.getFullYear(), noon.getMonth(), noon.getDate(), t.hh, t.mm, 0, 0);
      if (candidate.getTime() <= now.getTime()) return candidate; // must be at-or-before now
    }
  }
  return null;
}

/** The earliest fire of ONE slot strictly after `now`. */
export function slotNextFire(slot: ScheduleSlot, now: Date): Date | null {
  const times = slotTimes(slot);
  if (times === null || times.length === 0) return null;
  const horizon = slotHorizon(slot);
  for (let daysAhead = 0; daysAhead <= horizon; daysAhead++) {
    const noon = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysAhead, 12, 0, 0, 0);
    if (!slotDayMatches(slot, noon)) continue;
    for (const t of times) {
      const candidate = new Date(noon.getFullYear(), noon.getMonth(), noon.getDate(), t.hh, t.mm, 0, 0);
      if (candidate.getTime() > now.getTime()) return candidate; // must be strictly after now
    }
  }
  return null;
}

/** The latest fire across every slot, at-or-before `now`. */
export function mostRecentFire(schedule: Schedule, now: Date): Date | null {
  let best: Date | null = null;
  for (const slot of slotsOf(schedule)) {
    const f = slotMostRecentFire(slot, now);
    if (f !== null && (best === null || f.getTime() > best.getTime())) best = f;
  }
  return best;
}

/** The earliest fire across every slot, strictly after `now`. */
export function nextFire(schedule: Schedule, now: Date): Date | null {
  let best: Date | null = null;
  for (const slot of slotsOf(schedule)) {
    const f = slotNextFire(slot, now);
    if (f !== null && (best === null || f.getTime() < best.getTime())) best = f;
  }
  return best;
}

/** Every slot that names exactly this moment — usually one; two when slots
 *  coincide (e.g. `mon 09:30` and `mon–fri 09:30` on a Monday). Empty for a
 *  moment no slot names, which is what a manual run looks like. */
export function slotsFiringAt(schedule: Schedule | null, fireAt: Date): ScheduleSlot[] {
  return slotsOf(schedule).filter((slot) => slotMostRecentFire(slot, fireAt)?.getTime() === fireAt.getTime());
}

/** The label of the slot(s) behind this fire — "mon 09:30", joined with " + "
 *  when two coincide — or null when no slot names it (a manual run). */
export function fireSlotLabel(schedule: Schedule | null, fireAt: Date): string | null {
  const slots = slotsFiringAt(schedule, fireAt);
  return slots.length === 0 ? null : slots.map(formatSlot).join(' + ');
}

/**
 * Dueness verdict — an object, not a boolean, so `tick` can log WHY nothing
 * ran instead of just that nothing ran.
 *
 * Rule: due iff `now ≥ fire` (guaranteed by construction — `mostRecentFire`
 * only ever returns a fire at-or-before `now`) AND `lastFireAt < fire`
 * (this exact fire hasn't been recorded yet) AND `now − fire ≤ catchupHours`
 * (still inside the catch-up window). `fire` is the most recent fire across
 * ALL slots, so one fire per due moment; see the module header for the
 * same-day and missed-both cases.
 *
 * When the most recent applicable fire was already recorded, this function
 * further distinguishes 'already-ran' (that fire was TODAY — e.g. re-ticking
 * minutes after a run just completed) from 'not-yet' (that fire was on an
 * earlier calendar day — the steady-state "waiting for the next scheduled
 * day" case). Both are `due: false`; the split exists purely so a snapshot
 * or log line can say something more useful than "not due" in the common
 * case. 'already-ran' cannot swallow a later slot on the same day: once that
 * slot's time passes it IS the most recent fire, and the watermark is behind it.
 *
 * 'disabled' is never returned — see the DueVerdict doc comment.
 */
export function isDue(
  schedule: Schedule | null,
  lastFireAt: string | null,
  now: Date,
  catchupHours: number,
  /**
   * The agent's {@link AutomationMode}. Defaults to `'sched'` so every existing
   * caller keeps its exact behaviour, and so a caller that forgets to pass it
   * fails toward "evaluate the schedule" — which for an on-call agent is a
   * null schedule and therefore still not due.
   *
   * Checked FIRST, before the schedule is even looked at, because the answer
   * for an on-call agent is never "when does it fire" — it is "it doesn't".
   * The distinct `'on-call'` reason matters: a tick that reported these as
   * `'no-schedule'` would file a deliberate design next to a malformed
   * manifest, and `list` would tell the owner their agent is broken.
   */
  mode: AutomationMode = 'sched',
): DueVerdict {
  if (mode === 'call') return { due: false, fireAt: null, reason: 'on-call' };
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

/** "Mon 2026-09-28 09:30" in local time — how the run's preamble names a fire. */
export function formatLocalFire(d: Date): string {
  const dow = WEEKDAYS[d.getDay()];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${dow[0].toUpperCase()}${dow.slice(1)} ${localDateString(d)} ${hh}:${mm}`;
}

// ─── internal helpers ───────────────────────────────────────────────────────

/**
 * The slots of a schedule, tolerating the legacy flat `{ days, at }` object at
 * runtime. The type says `{ slots }`, but a schedule can reach these functions
 * from JSON written before slots existed (a cached `list --json`, a hand-built
 * fixture); reading it as its one slot beats a TypeError in the dispatcher.
 */
function slotsOf(schedule: Schedule | null): ScheduleSlot[] {
  if (schedule === null || typeof schedule !== 'object') return [];
  if (Array.isArray(schedule.slots)) return schedule.slots;
  const legacy = schedule as unknown as { days?: unknown; at?: unknown };
  if (Array.isArray(legacy.days) && legacy.days.length === 0) return [];
  const r = parseSlot(legacy);
  return 'error' in r ? [] : [r.slot];
}

function parseDays(v: unknown): 'daily' | Weekday[] | null {
  if (v === 'daily') return 'daily';
  if (Array.isArray(v)) return normalizeDayList(v.flatMap((d) => String(d).split(',')));
  if (typeof v === 'string') {
    const trimmed = v.trim().toLowerCase();
    if (trimmed === 'daily') return 'daily';
    return normalizeDayList(trimmed.split(','));
  }
  return null;
}

/** Weekday tokens, each a day (`mon`) or a range (`mon-fri`, wrapping allowed:
 *  `fri-mon`). Order of first appearance is kept; repeats are dropped. */
function normalizeDayList(raw: string[]): Weekday[] | null {
  const tokens = raw.map((d) => d.trim().toLowerCase().replace(/–/g, '-')).filter((d) => d.length > 0);
  if (tokens.length === 0) return null;
  const out: Weekday[] = [];
  const push = (d: Weekday) => { if (!out.includes(d)) out.push(d); };
  for (const token of tokens) {
    const range = /^([a-z]{3})\s*-\s*([a-z]{3})$/.exec(token);
    if (range) {
      const a = WEEK_ORDER.indexOf(range[1] as Weekday);
      const b = WEEK_ORDER.indexOf(range[2] as Weekday);
      if (a < 0 || b < 0) return null;
      for (let i = a; ; i = (i + 1) % 7) {
        push(WEEK_ORDER[i]);
        if (i === b) break;
      }
      continue;
    }
    if (!(WEEKDAYS as readonly string[]).includes(token)) return null;
    push(token as Weekday);
  }
  return out;
}

function parseMonthday(raw: unknown): number | null {
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'last') return -1;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^-?\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(n) || n === 0 || n > 31 || n < -31) return null;
  return n;
}

/** `{ weekday: mon, n: 1 }`, or the string form `1st-mon` / `last-fri`. */
function parseNthItem(raw: unknown): { weekday: Weekday; n: number } | null {
  let weekday: unknown;
  let n: unknown;
  if (typeof raw === 'string') {
    const m = /^(last|-?\d+(?:st|nd|rd|th)?)[-\s]([a-z]{3})$/i.exec(raw.trim());
    if (!m) return null;
    const word = m[1].toLowerCase();
    n = word === 'last' ? -1 : Number(word.replace(/(st|nd|rd|th)$/, ''));
    weekday = m[2].toLowerCase();
  } else if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>;
    if (Object.keys(rec).some((k) => k !== 'weekday' && k !== 'n')) return null;
    weekday = typeof rec.weekday === 'string' ? rec.weekday.trim().toLowerCase() : rec.weekday;
    n = rec.n === 'last' ? -1 : Number(rec.n);
  } else {
    return null;
  }
  if (typeof weekday !== 'string' || !(WEEKDAYS as readonly string[]).includes(weekday)) return null;
  if (typeof n !== 'number' || !Number.isInteger(n) || n === 0 || n > 5 || n < -5) return null;
  return { weekday: weekday as Weekday, n };
}

/** A YYYY-MM-DD string, or the Date js-yaml makes of an unquoted one (UTC midnight). */
function parseAnchor(raw: unknown): string | null {
  if (raw instanceof Date && Number.isFinite(raw.getTime())) {
    return `${raw.getUTCFullYear()}-${String(raw.getUTCMonth() + 1).padStart(2, '0')}-${String(raw.getUTCDate()).padStart(2, '0')}`;
  }
  if (typeof raw !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
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

/** The times of day a slot fires on a matching day, ascending. `null` when a
 *  hand-built slot is malformed — the fire functions then return null rather
 *  than construct an Invalid Date. */
function slotTimes(slot: ScheduleSlot): { hh: number; mm: number }[] | null {
  if (slot.kind === 'cron') {
    const c = cachedCron(slot.cron);
    if (c === null) return null;
    const out: { hh: number; mm: number }[] = [];
    for (const hh of c.hours) for (const mm of c.minutes) out.push({ hh, mm });
    return out;
  }
  const at = parseAtParts(slot.at);
  return at === null ? null : [at];
}

function slotHorizon(slot: ScheduleSlot): number {
  return slot.kind === 'cron' ? CRON_DAY_HORIZON : DAY_HORIZON;
}

/** Does this slot fire on the calendar day of `noon` (a local-noon Date)? */
function slotDayMatches(slot: ScheduleSlot, noon: Date): boolean {
  switch (slot.kind) {
    case 'weekly': {
      if (!weekdayMatches(slot.days, noon)) return false;
      const every = slot.everyWeeks ?? 1;
      if (every <= 1) return true;
      if (!slot.anchor) return false;
      const anchor = parseAnchor(slot.anchor);
      if (anchor === null) return false;
      const [y, m, d] = anchor.split('-').map(Number);
      const diff = mondayWeekIndex(noon.getFullYear(), noon.getMonth(), noon.getDate()) - mondayWeekIndex(y, m - 1, d);
      return ((diff % every) + every) % every === 0;
    }
    case 'monthdays': {
      const d = noon.getDate();
      const len = daysInMonth(noon.getFullYear(), noon.getMonth());
      return slot.monthdays.some((md) => (md > 0 ? md === d : len + md + 1 === d));
    }
    case 'nth': {
      const dow = WEEKDAYS[noon.getDay()];
      const d = noon.getDate();
      const len = daysInMonth(noon.getFullYear(), noon.getMonth());
      const fromStart = Math.floor((d - 1) / 7) + 1; // 1st..5th occurrence of this weekday
      const fromEnd = -(Math.floor((len - d) / 7) + 1); // -1 = last occurrence
      return slot.nth.some((x) => x.weekday === dow && (x.n === fromStart || x.n === fromEnd));
    }
    case 'cron': {
      const c = cachedCron(slot.cron);
      if (c === null) return false;
      if (!c.months.has(noon.getMonth() + 1)) return false;
      const domOk = c.dom.has(noon.getDate());
      const dowOk = c.dow.has(noon.getDay());
      // Vixie cron: when BOTH day fields are restricted, either one matching
      // is enough; when one is `*`, only the other decides.
      if (!c.domStar && !c.dowStar) return domOk || dowOk;
      if (!c.domStar) return domOk;
      if (!c.dowStar) return dowOk;
      return true;
    }
  }
}

function weekdayMatches(days: 'daily' | Weekday[], date: Date): boolean {
  if (days === 'daily') return true;
  if (days.length === 0) return false;
  const dow = WEEKDAYS[date.getDay()]; // getDay(): 0=Sun..6=Sat — matches WEEKDAYS order
  return (days as readonly string[]).includes(dow);
}

/** Index of the Monday-start week containing y-m-d, counted in whole days via
 *  UTC so no DST hour can shift a date across a week boundary. 1970-01-01 was
 *  a Thursday, so day -3 (1969-12-29) is the Monday of week 0. */
function mondayWeekIndex(y: number, m: number, d: number): number {
  const dayNum = Math.floor(Date.UTC(y, m, d) / 86_400_000);
  return Math.floor((dayNum + 3) / 7);
}

function daysInMonth(y: number, m: number): number {
  return new Date(y, m + 1, 0, 12).getDate();
}

function isSameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function localDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function ordinal(n: number): string {
  if (n === -1) return 'last';
  if (n < 0) return `${ordinal(-n)}-last`;
  return `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;
}

function monthdayLabel(d: number): string {
  if (d === -1) return 'last';
  if (d < 0) return `${ordinal(-d)} to last`;
  return String(d);
}

/** Weekdays read Monday-first, runs of three or more joined into a range. */
function daysLabel(days: 'daily' | Weekday[], dash: string): string {
  if (days === 'daily') return 'daily';
  const set = new Set(days);
  if (set.size === 7) return 'daily';
  const ordered = WEEK_ORDER.filter((d) => set.has(d));
  const parts: string[] = [];
  let i = 0;
  while (i < ordered.length) {
    let j = i;
    while (j + 1 < ordered.length && WEEK_ORDER.indexOf(ordered[j + 1]) === WEEK_ORDER.indexOf(ordered[j]) + 1) j++;
    if (j - i >= 2) parts.push(`${ordered[i]}${dash}${ordered[j]}`);
    else for (let k = i; k <= j; k++) parts.push(ordered[k]);
    i = j + 1;
  }
  return parts.join(', ');
}

// ─── cron (5-field, local time) ─────────────────────────────────────────────

interface CronSpec {
  minutes: number[];
  hours: number[];
  dom: Set<number>;
  months: Set<number>;
  dow: Set<number>;
  domStar: boolean;
  dowStar: boolean;
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const cronCache = new Map<string, CronSpec | null>();

function cachedCron(expr: string): CronSpec | null {
  if (!cronCache.has(expr)) {
    const r = parseCron(expr);
    cronCache.set(expr, 'error' in r ? null : r);
  }
  return cronCache.get(expr) ?? null;
}

/** minute hour day-of-month month day-of-week. Supports `*`, lists, ranges,
 *  steps (`*\/15`, `1-5/2`), month and weekday names, and 7 for Sunday. No
 *  `@daily`-style macros, no seconds field, no `L`/`W`/`#` — use a
 *  structured slot (monthdays: [-1], nth) for those. */
export function parseCron(expr: string): CronSpec | { error: string } {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return { error: `needs 5 fields (minute hour day month weekday), got ${fields.length}` };
  const minutes = parseCronField(fields[0], 0, 59, null, 'minute');
  if ('error' in minutes) return minutes;
  const hours = parseCronField(fields[1], 0, 23, null, 'hour');
  if ('error' in hours) return hours;
  const dom = parseCronField(fields[2], 1, 31, null, 'day-of-month');
  if ('error' in dom) return dom;
  const months = parseCronField(fields[3], 1, 12, MONTH_NAMES, 'month');
  if ('error' in months) return months;
  const dow = parseCronField(fields[4], 0, 7, WEEKDAYS, 'weekday');
  if ('error' in dow) return dow;
  const dowSet = new Set(dow.values.map((d) => (d === 7 ? 0 : d)));
  return {
    minutes: [...new Set(minutes.values)].sort((a, b) => a - b),
    hours: [...new Set(hours.values)].sort((a, b) => a - b),
    dom: new Set(dom.values),
    months: new Set(months.values),
    dow: dowSet,
    domStar: fields[2].startsWith('*'),
    dowStar: fields[4].startsWith('*'),
  };
}

function parseCronField(
  field: string,
  min: number,
  max: number,
  names: readonly string[] | null,
  label: string,
): { values: number[] } | { error: string } {
  const values: number[] = [];
  const value = (tok: string): number | null => {
    const lower = tok.toLowerCase();
    if (names) {
      const idx = names.indexOf(lower);
      if (idx >= 0) return idx + (names === MONTH_NAMES ? 1 : 0);
    }
    if (!/^\d+$/.test(tok)) return null;
    const n = Number(tok);
    return n >= min && n <= max ? n : null;
  };
  for (const part of field.split(',')) {
    const m = /^([^/]+)(?:\/(\d+))?$/.exec(part);
    if (!m) return { error: `${label} "${part}" is not a cron value` };
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (!Number.isInteger(step) || step < 1) return { error: `${label} step "${m[2]}" must be 1 or more` };
    let lo: number;
    let hi: number;
    if (m[1] === '*') {
      lo = min;
      hi = max;
    } else {
      const range = /^([a-z0-9]+)-([a-z0-9]+)$/i.exec(m[1]);
      if (range) {
        const a = value(range[1]);
        const b = value(range[2]);
        if (a === null || b === null || a > b) return { error: `${label} range "${m[1]}" must be ascending, within ${min}-${max}` };
        lo = a;
        hi = b;
      } else {
        const a = value(m[1]);
        if (a === null) return { error: `${label} "${m[1]}" must be within ${min}-${max}` };
        lo = a;
        hi = m[2] === undefined ? a : max;
      }
    }
    for (let n = lo; n <= hi; n += step) values.push(n);
  }
  return { values };
}
