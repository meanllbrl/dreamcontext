/**
 * One-off and few-times Super schedules: `super schedule add|change --once | --on | --times`
 * (src/lib/super/schedule-limit.ts). A one-off fires once and retires itself, a few-times job
 * after n fires, and a one-off whose time went by is told as missed, never run late, never twice.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAutomation, readAutomationCache, recordRun } from '../../src/lib/automations/store.js';
import { checkApproval, registerProject } from '../../src/lib/automations/registry.js';
import { tickProject } from '../../src/lib/automations/tick.js';
import { listScheduleItems } from '../../src/lib/super/schedule-queue.js';
import { scopeOfContextRoot } from '../../src/lib/telegram/config.js';
import { SCHEDULE_LINES, scheduleVerb, sweepProject, type ScheduleDeps } from '../../src/server/super-schedule.js';

let projectRoot: string;
let contextRoot: string;
let home: string;
let scope: string;

/** Local wall clock, like the schedule itself: 2026-11-<day> hh:mm. */
const at = (day: number, h: number, min = 0) => new Date(2026, 10, day, h, min);

function verbDeps(said: string[], now: Date): ScheduleDeps & { nowDate: () => Date } {
  return { home, nowDate: () => now, now: () => now.getTime(), banner: (_t, b) => { said.push(b); }, hub: () => null };
}

async function add(body: Record<string, unknown>, now: Date, said: string[] = []): Promise<string> {
  const r = await scheduleVerb(contextRoot, { op: 'add', job: 'Bana ilacımı hatırlat', ...body }, verbDeps(said, now));
  if (!r.ok) throw new Error(`${r.error}: ${r.message}`);
  return (r.result as { id: string }).id;
}

async function rowOf(id: string, now: Date): Promise<Record<string, unknown> | undefined> {
  const r = await scheduleVerb(contextRoot, { op: 'list' }, verbDeps([], now));
  return (r as { result: { schedules: Array<Record<string, unknown>> } }).result.schedules.find((x) => x.id === id);
}

/** The tick with a runner that only records the fire (what the real runner does for a Super job). */
const ranSlugs: string[] = [];
const tick = (now: Date) => tickProject(projectRoot, {
  now, home, log: () => {},
  runImpl: (async (_c: string, slug: string, o: { fireAt: Date }) => {
    ranSlugs.push(slug);
    const iso = o.fireAt.toISOString();
    const cache = recordRun(contextRoot, slug, {
      firedAt: iso, startedAt: iso, finishedAt: iso, status: 'ok', durationMs: 0, outputPath: null, error: null,
      exitCode: null, sessionId: null, costUsd: null, numTurns: null, permissionDenials: 0,
    }, { advanceWatermark: true });
    return { slug, status: 'ok', cache };
  }) as never,
});

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-super-schedule-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'dc-super-schedule-home-'));
  scope = scopeOfContextRoot(contextRoot);
  registerProject(projectRoot, home);
  ranSlugs.length = 0;
});
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('--once', () => {
  it('fires once at the next --at, retires, stays in list as done for a day, then is gone', async () => {
    const said: string[] = [];
    const id = await add({ at: '21:00', once: true }, at(22, 20), said);
    expect(said[0]).toBe('⏰ Kuruldu: 22 Kas 21:00, bir kez · cevap: neredeysem · «Bana ilacımı hatırlat»');
    expect(readFileSync(getAutomation(contextRoot, id, home)!.path, 'utf-8')).toMatch(/once_on: '?2026-11-22'?/);
    expect(await rowOf(id, at(22, 20))).toMatchObject({ once: '2026-11-22', runsLeft: 1, next: 'Sun 2026-11-22 21:00' });

    expect((await tick(at(22, 20, 59))).ran).toHaveLength(0);
    expect((await tick(at(22, 21, 1))).ran.map((r) => r.slug)).toEqual([id]);
    expect(getAutomation(contextRoot, id, home)!.enabled).toBe(false);
    // Retired, still approved: its queued fire is still handed to the Super.
    expect(checkApproval(projectRoot, getAutomation(contextRoot, id, home)!, home, 'run').approved).toBe(true);
    expect(await rowOf(id, at(22, 21, 2))).toMatchObject({ done: true, runsLeft: 0, next: null });

    // Never twice: the same evening, and that date's slot a day later.
    expect((await tick(at(22, 21, 6))).ran).toHaveLength(0);
    expect((await tick(at(23, 21, 1))).ran).toHaveLength(0);
    expect(ranSlugs).toEqual([id]);
    // A day after it retired it leaves the list.
    await tick(at(23, 21, 30));
    expect(getAutomation(contextRoot, id, home)).toBeNull();
  });

  it('a time already gone today means tomorrow', async () => {
    const id = await add({ at: '08:00', once: true }, at(22, 20));
    expect(await rowOf(id, at(22, 20))).toMatchObject({ once: '2026-11-23', next: 'Mon 2026-11-23 08:00' });
  });
});

describe('--on', () => {
  it('a future date fires on that day only', async () => {
    const id = await add({ at: '09:00', on: '2026-11-25' }, at(22, 20));
    expect((await tick(at(23, 9, 1))).ran).toHaveLength(0);
    expect((await tick(at(24, 9, 1))).ran).toHaveLength(0);
    expect((await tick(at(25, 9, 1))).ran.map((r) => r.slug)).toEqual([id]);
    expect(getAutomation(contextRoot, id, home)!.enabled).toBe(false);
  });

  it('tomorrow, and the refusals: a past time, --days or --times beside it, a date a year ahead', async () => {
    const id = await add({ at: '07:30', on: 'tomorrow' }, at(22, 20));
    expect(await rowOf(id, at(22, 20))).toMatchObject({ once: '2026-11-23' });
    const refuse = async (body: Record<string, unknown>) => {
      const r = await scheduleVerb(contextRoot, { op: 'add', job: 'x', ...body }, verbDeps([], at(22, 20)));
      expect(r).toMatchObject({ ok: false, error: 'invalid_args' });
    };
    await refuse({ at: '19:00', on: 'today' });
    await refuse({ at: '09:00', on: '2026-11-25', days: 'mon' });
    await refuse({ at: '09:00', on: '2026-11-25', times: '2' });
    await refuse({ at: '09:00', on: '2027-11-23' });
    await refuse({ at: '09:00', on: '2026-02-30' });
  });
});

describe('--times', () => {
  it('times=3 runs three mornings, then retires; list counts down', async () => {
    const said: string[] = [];
    const id = await add({ at: '09:00', days: 'daily', times: '3' }, at(22, 20), said);
    expect(said[0]).toContain('her gün 09:00 · 3 kez');
    for (const day of [23, 24, 25]) expect((await tick(at(day, 9, 1))).ran.map((r) => r.slug)).toEqual([id]);
    expect(readAutomationCache(contextRoot, id)?.runsDone).toBe(3);
    expect(getAutomation(contextRoot, id, home)!.enabled).toBe(false);
    expect(await rowOf(id, at(25, 12))).toMatchObject({ done: true, runsLeft: 0 });
    // The fourth morning: not run (and, a day after it retired, gone).
    expect((await tick(at(26, 9, 1))).ran).toHaveLength(0);
    expect(ranSlugs).toEqual([id, id, id]);
  });

  it('the count survives the runner rewriting the cache', async () => {
    const id = await add({ at: '09:00', times: '2' }, at(22, 20));
    await tick(at(23, 9, 1));
    expect(await rowOf(id, at(23, 10))).toMatchObject({ runsLeft: 1 });
  });
});

describe('a missed one-off', () => {
  it('under 3 hours late it still runs once on wake', async () => {
    const id = await add({ at: '21:00', once: true }, at(22, 20));
    expect((await tick(at(22, 23, 30))).ran.map((r) => r.slug)).toEqual([id]);
    expect((await tick(at(22, 23, 40))).ran).toHaveLength(0);
  });

  it('later than that: never run, retired, told once with its words and put on the agenda', async () => {
    const id = await add({ at: '21:00', once: true }, at(22, 20));
    expect((await tick(at(23, 1))).ran).toHaveLength(0);
    expect(getAutomation(contextRoot, id, home)!.enabled).toBe(false);
    expect(listScheduleItems(scope, home)).toMatchObject([{ slug: id, missed: true }]);
    const said: string[] = [];
    await sweepProject(contextRoot, { home, now: () => at(23, 1).getTime(), banner: (_t, b) => { said.push(b); }, hub: () => null });
    expect(said).toEqual([SCHEDULE_LINES.missedOnce('21:00', 'Bana ilacımı hatırlat')]);
    expect(listScheduleItems(scope, home)).toHaveLength(0);
    // Later ticks neither run it nor tell it again.
    expect((await tick(at(23, 2))).ran).toHaveLength(0);
    expect(listScheduleItems(scope, home)).toHaveLength(0);
    expect(ranSlugs).toEqual([]);
  });

  it('a headless one-off past its window is told as missed too', async () => {
    const id = await add({ at: '21:00', once: true, headless: true, reply: 'mac' }, at(22, 20));
    expect((await tick(at(23, 1))).ran).toHaveLength(0);
    const said: string[] = [];
    await sweepProject(contextRoot, { home, now: () => at(23, 1).getTime(), banner: (_t, b) => { said.push(b); }, hub: () => null });
    expect(said).toEqual([SCHEDULE_LINES.missedOnce('21:00', 'Bana ilacımı hatırlat')]);
    expect(getAutomation(contextRoot, id, home)!.enabled).toBe(false);
  });
});

describe('change', () => {
  it('a daily job changed to --once runs once and retires; --on brings a retired one back', async () => {
    const said: string[] = [];
    const id = await add({ at: '09:00' }, at(22, 20), said);
    const c = await scheduleVerb(contextRoot, { op: 'change', id, once: true }, verbDeps(said, at(22, 20, 5)));
    expect(c.ok).toBe(true);
    expect(said[1]).toBe('⏰ Değişti: 23 Kas 09:00, bir kez · cevap: neredeysem · «Bana ilacımı hatırlat»');
    expect((await tick(at(23, 9, 1))).ran.map((r) => r.slug)).toEqual([id]);
    expect(getAutomation(contextRoot, id, home)!.enabled).toBe(false);
    // Its daily slot is gone: the next morning runs nothing (still listed as done).
    expect((await tick(at(24, 9, 0))).ran).toHaveLength(0);

    const back = await scheduleVerb(contextRoot, { op: 'change', id, on: '2026-11-26', at: '10:00' }, verbDeps(said, at(24, 9)));
    expect(back.ok).toBe(true);
    expect(await rowOf(id, at(24, 9))).toMatchObject({ once: '2026-11-26', runsLeft: 1, enabled: true });
    expect((await tick(at(26, 10, 1))).ran.map((r) => r.slug)).toEqual([id]);
  });

  it('--at on a one-off keeps its date; --days makes it repeat again', async () => {
    const id = await add({ at: '21:00', once: true }, at(22, 20));
    expect((await scheduleVerb(contextRoot, { op: 'change', id, at: '22:30' }, verbDeps([], at(22, 20, 1)))).ok).toBe(true);
    expect(await rowOf(id, at(22, 20, 2))).toMatchObject({ once: '2026-11-22', next: 'Sun 2026-11-22 22:30' });
    expect((await scheduleVerb(contextRoot, { op: 'change', id, days: 'daily' }, verbDeps([], at(22, 20, 3)))).ok).toBe(true);
    const row = await rowOf(id, at(22, 20, 4));
    expect(row?.once).toBeUndefined();
    expect(row?.runsLeft).toBeUndefined();
    expect(row).toMatchObject({ when: 'her gün 22:30' });
    expect(getAutomation(contextRoot, id, home)!.catchupHours).toBe(6);
  });
});
