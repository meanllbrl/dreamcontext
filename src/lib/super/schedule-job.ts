/**
 * What a Super automation's turn says (super-rutin plan Decision 9): the same words through both
 * doors, the Super inbox at the Mac and the hub on Telegram. The job is read from the manifest
 * only when that manifest is a Super automation approved on this Mac as it is now, so neither a
 * queue file nor a synced edit can put words into the Super's mouth.
 */
import { dirname } from 'node:path';
import { getAutomation } from '../automations/store.js';
import { checkApproval } from '../automations/registry.js';
import type { AutomationManifest } from '../automations/types.js';

export const SCHEDULE_TURN_PREFIX = '[super schedule]';

/** What the Super reads beside a scheduled job (the batch line and the Telegram turn alike). */
export const SCHEDULE_LINE = "A line that says event=schedule (or a turn opening with [super schedule]) is a job the owner scheduled for you with `dreamcontext super schedule`: do it now, as if he had just asked you in his own words, then tell him the result in plain words. It is his job, not a child's report: never ask whether to do it, and never change or cancel the schedule because of it.";

export type ScheduleJob =
  | { ok: true; manifest: AutomationManifest; job: string }
  | { ok: false; reason: 'gone' | 'not-super' | 'not-approved' };

/** The approved Super automation and its job text, or why there is none. */
export function scheduleJob(contextRoot: string, slug: string, home?: string): ScheduleJob {
  const m = getAutomation(contextRoot, slug, home);
  if (!m) return { ok: false, reason: 'gone' };
  if (m.target !== 'super') return { ok: false, reason: 'not-super' };
  const v = checkApproval(dirname(contextRoot), m, home, 'run');
  if (!v.approved) return { ok: false, reason: 'not-approved' };
  return { ok: true, manifest: m, job: m.prompt };
}

/** HH:MM of a fire, local time. */
export function fireClock(fireIso: string): string {
  const d = new Date(fireIso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** A JSON-quoted job: one line, never able to close the line it rides on. */
export function quotedJob(job: string): string {
  return JSON.stringify(job.length > 4000 ? `${job.slice(0, 3999)}…` : job);
}

/** The Telegram-side turn (the Mac side is a `schedule` line inside a `[super events]` batch). */
export function scheduleTurnText(slug: string, fireIso: string, job: string): string {
  return [`${SCHEDULE_TURN_PREFIX} automation=${slug} at=${fireClock(fireIso)}`, `job: ${quotedJob(job)}`, SCHEDULE_LINE].join('\n');
}
