/**
 * One-off and few-times Super schedules (`super schedule add --once | --on | --times`).
 *
 * The owner says "remind me tonight at 9" or "three mornings in a row": the job must end on its
 * own, never become a daily job someone has to cancel. Two frontmatter keys on the schedule's own
 * manifest (only `super-is-*` files the verb writes) say how it ends:
 *  - `once_on: YYYY-MM-DD`: a dated job. Its slot is a cron that names that month and day only
 *    (`MM HH D M *`), so even a lost counter cannot make it a daily job; it retires after that
 *    one fire, or as missed once the fire is past its catch-up window.
 *  - `max_runs: n`: a repeating job that retires after n fires.
 * The count lives in the automation's cache beside the watermark (`runsDone`), and a retired job
 * is switched off (`retiredAt`), kept in `list` as done for a day, then removed. Neither key is
 * approval-hashed: like the schedule, they change WHEN it runs, never what it does.
 */
import { readFileSync } from 'node:fs';
import matter from 'gray-matter';
import { readAutomationCache, removeAutomation, updateAutomation, writeAutomationCache } from '../automations/store.js';
import type { AutomationCache, AutomationManifest, ScheduleSlot } from '../automations/types.js';
import { listScheduleItems } from './schedule-queue.js';
import { scopeOfContextRoot } from '../telegram/config.js';

/** Every schedule the verb makes is named with this prefix; the verb touches no other automation. */
export const SCHEDULE_SLUG_PREFIX = 'super-is-';
/** A one-off may still fire this many hours late (the Mac slept, the app was off). */
export const ONCE_CATCHUP_HOURS = 3;
/** A retired job stays in `list` as done this long. */
export const RETIRED_KEEP_MS = 24 * 3_600_000;
/** How far ahead a dated job may be: the cron names month and day, so a date a year or more
 *  ahead would fire on this year's same day first. */
export const ONCE_MAX_DAYS_AHEAD = 364;

export interface RunLimit {
  /** A dated job's local date. */
  onceOn?: string;
  /** A repeating job's total fires. */
  maxRuns?: number;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isoDate(v: unknown): string | null {
  if (v instanceof Date && Number.isFinite(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v !== 'string' || !DATE_RE.test(v.trim())) return null;
  return v.trim();
}

/** The limit on one of the verb's schedules; `{}` for anything else (never throws). */
export function readRunLimit(m: Pick<AutomationManifest, 'slug' | 'path'>): RunLimit {
  if (!m.slug.startsWith(SCHEDULE_SLUG_PREFIX)) return {};
  try {
    const { data } = matter(readFileSync(m.path, 'utf-8'));
    const out: RunLimit = {};
    const on = isoDate(data.once_on);
    if (on) out.onceOn = on;
    if (Number.isInteger(data.max_runs) && (data.max_runs as number) >= 1) out.maxRuns = data.max_runs as number;
    return out;
  } catch {
    return {};
  }
}

/** The local moment of a dated job (`at` = HH:MM), or null when the date is not a real one. */
export function onceMoment(onceOn: string, at: string): Date | null {
  const d = DATE_RE.exec(onceOn);
  const t = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at);
  if (!d || !t) return null;
  const out = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]), 0, 0);
  return localDate(out) === onceOn ? out : null;
}

export function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The one slot of a dated job: that month and day, at that time. */
export function onceSlot(onceOn: string, at: string): ScheduleSlot {
  const [, , mo, d] = DATE_RE.exec(onceOn)!;
  const [hh, mm] = at.split(':');
  return { kind: 'cron', cron: `${Number(mm)} ${Number(hh)} ${Number(d)} ${Number(mo)} *` };
}

/** `--on` (YYYY-MM-DD | today | tomorrow) or `--once` resolved against now, or an error message. */
export function resolveOnceDate(on: unknown, once: boolean, at: string, now: Date): { date: string } | { error: string } {
  if (on !== undefined && once) return { error: 'use --once or --on, not both' };
  let date: string | null;
  if (once) {
    const today = onceMoment(localDate(now), at);
    date = today && today.getTime() > now.getTime() ? localDate(now) : localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12));
  } else {
    const v = typeof on === 'string' ? on.trim().toLowerCase() : '';
    if (v === 'today') date = localDate(now);
    else if (v === 'tomorrow') date = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12));
    else date = isoDate(v);
    if (!date) return { error: '--on is YYYY-MM-DD, today or tomorrow' };
  }
  const moment = onceMoment(date, at);
  if (!moment) return { error: `--on ${date} is not a real date` };
  if (moment.getTime() <= now.getTime()) return { error: `${date} ${at} has already passed: pick a later time or day` };
  const limit = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ONCE_MAX_DAYS_AHEAD, 23, 59);
  if (moment.getTime() > limit.getTime()) return { error: `a one-off is at most ${ONCE_MAX_DAYS_AHEAD} days ahead` };
  return { date };
}

/** Fires left for a limited job (null = no limit). A dated job has one until it fires. */
export function runsLeft(limit: RunLimit, cache: Pick<AutomationCache, 'runsDone'> | null): number | null {
  const done = cache?.runsDone ?? 0;
  if (limit.onceOn) return Math.max(0, 1 - done);
  if (limit.maxRuns) return Math.max(0, limit.maxRuns - done);
  return null;
}

/** Switches a job off as done (its queued fire, if any, still goes: delivery reads an approved
 *  manifest, never `enabled`). */
function retire(contextRoot: string, slug: string, now: Date, cache: AutomationCache | null): void {
  updateAutomation(contextRoot, slug, { enabled: false });
  const c = cache ?? readAutomationCache(contextRoot, slug);
  const base: AutomationCache = c ?? { slug, lastRunAt: null, lastFireAt: null, status: null, durationMs: null, outputPath: null, error: null, exitCode: null, history: [] };
  // A job that never ran has no cache yet: the retire mark makes one (list's done, the day-later removal).
  writeAutomationCache(contextRoot, slug, { ...base, retiredAt: now.toISOString() });
}

/**
 * The tick's word after a scheduled fire of `manifest`: counts it when it really ran (the
 * watermark moved to it and it was not a quiet condition check) and retires the job once its
 * limit is spent. Returns true when it retired the job.
 */
export function noteScheduledRun(
  contextRoot: string, manifest: Pick<AutomationManifest, 'slug' | 'path'>, outcome: { status: string; cache?: AutomationCache | null }, fireAt: Date, now: Date,
): boolean {
  const limit = readRunLimit(manifest);
  if (!limit.onceOn && !limit.maxRuns) return false;
  const cache = outcome.cache ?? readAutomationCache(contextRoot, manifest.slug);
  if (!cache || cache.lastFireAt !== fireAt.toISOString() || outcome.status === 'condition-false') {
    // A dated job's own day came and went without a run (a quiet check): it is done.
    if (limit.onceOn && localDate(fireAt) === limit.onceOn && cache?.lastFireAt === fireAt.toISOString()) {
      retire(contextRoot, manifest.slug, now, cache);
      return true;
    }
    return false;
  }
  const next: AutomationCache = { ...cache, runsDone: (cache.runsDone ?? 0) + 1 };
  writeAutomationCache(contextRoot, manifest.slug, next);
  if ((runsLeft(limit, next) ?? 1) > 0) return false;
  retire(contextRoot, manifest.slug, now, next);
  return true;
}

/** A dated job whose own fire is past its catch-up window without a run: retired (the caller
 *  tells the owner it was missed). True when `fireAt` is that job's own fire. */
export function retireMissedOnce(contextRoot: string, manifest: Pick<AutomationManifest, 'slug' | 'path' | 'enabled'>, fireAt: Date, now: Date): boolean {
  const limit = readRunLimit(manifest);
  if (!limit.onceOn || localDate(fireAt) !== limit.onceOn) return false;
  if (manifest.enabled) retire(contextRoot, manifest.slug, now, readAutomationCache(contextRoot, manifest.slug));
  return true;
}

/** A retired job past its day in `list`: removed, but never while one of its fires (a hand-over
 *  or a missed notice) still waits for the desktop server, which reads the job to deliver or
 *  tell it: the app may be closed for days. True when it was removed. */
export function removeIfLongRetired(contextRoot: string, manifest: Pick<AutomationManifest, 'slug' | 'enabled'>, now: Date, home?: string): boolean {
  if (manifest.enabled || !manifest.slug.startsWith(SCHEDULE_SLUG_PREFIX)) return false;
  const at = Date.parse(readAutomationCache(contextRoot, manifest.slug)?.retiredAt ?? '');
  if (!Number.isFinite(at) || now.getTime() - at < RETIRED_KEEP_MS) return false;
  if (listScheduleItems(scopeOfContextRoot(contextRoot), home).some((i) => i.slug === manifest.slug)) return false;
  removeAutomation(contextRoot, manifest.slug);
  return true;
}
