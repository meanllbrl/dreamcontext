import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAutomation, recordRun } from '../../src/lib/automations/store.js';
import { approveAutomation } from '../../src/lib/automations/registry.js';
import { nextFireIso } from '../../src/lib/automations/approval-card.js';
import { upcomingFire } from '../../src/lib/automations/schedule.js';
import { TICK_INTERVAL_SECONDS } from '../../src/lib/automations/types.js';

/**
 * Owner 2026-11-08: a routine moved to 15:45 at 15:34 read "next tomorrow 15:45" at 15:46, while
 * today's run had not even started (the dispatcher woke at 15:47:33 and the run began 15:48:57).
 * A fire still owed is the next one; only a fire that ran (or can never run) moves "next" on.
 */

// Local time, like the schedule itself: 8 Nov 2026.
const at = (h: number, m: number, day = 8): Date => new Date(2026, 10, day, h, m, 0, 0);
const SCHEDULE = { slots: [{ kind: 'weekly' as const, days: 'daily' as const, at: '15:45' }] };

describe('upcomingFire', () => {
  const yesterday = at(15, 45, 7).toISOString();

  it('before the slot: today', () => {
    expect(upcomingFire(SCHEDULE as never, yesterday, at(15, 34), 1)?.getTime()).toBe(at(15, 45).getTime());
  });

  it('slot passed, not run yet, inside the catch-up window: still today', () => {
    expect(upcomingFire(SCHEDULE as never, yesterday, at(15, 46), 1)?.getTime()).toBe(at(15, 45).getTime());
  });

  it('slot passed and ran: tomorrow', () => {
    expect(upcomingFire(SCHEDULE as never, at(15, 45).toISOString(), at(15, 53), 1)?.getTime()).toBe(at(15, 45, 9).getTime());
  });

  it('not approved: never run, so not owed — tomorrow', () => {
    expect(upcomingFire(SCHEDULE as never, yesterday, at(15, 46), 1, 'sched', false)?.getTime()).toBe(at(15, 45, 9).getTime());
  });

  it('past the catch-up window: the owed fire is dropped — tomorrow', () => {
    expect(upcomingFire(SCHEDULE as never, yesterday, at(17, 0), 1)?.getTime()).toBe(at(15, 45, 9).getTime());
  });

  it('on-call or no schedule: none', () => {
    expect(upcomingFire(SCHEDULE as never, yesterday, at(15, 46), 1, 'call')).toBeNull();
    expect(upcomingFire(null, yesterday, at(15, 46), 1)).toBeNull();
  });
});

describe('nextFireIso (every card, the routines list, the CLI)', () => {
  let projectRoot: string;
  let contextRoot: string;
  let realHome: string | undefined;
  let fakeHome: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dc-owed-'));
    contextRoot = join(projectRoot, '_dream_context');
    mkdirSync(contextRoot, { recursive: true });
    realHome = process.env.HOME;
    fakeHome = mkdtempSync(join(tmpdir(), 'dc-owed-home-'));
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const make = () => createAutomation(contextRoot, {
    slug: 'ai-news', title: 'AI news', days: 'daily', at: '15:45', catchupHours: 1, prompt: 'Find one story.\n',
  });

  const ran = (fired: Date) => recordRun(contextRoot, 'ai-news', {
    firedAt: fired.toISOString(), startedAt: fired.toISOString(), finishedAt: fired.toISOString(), status: 'ok',
    error: null, durationMs: 1, outputPath: null, exitCode: 0, sessionId: null, costUsd: null, numTurns: null,
  } as never);

  it('an approved routine whose slot just passed says today, not tomorrow, until it runs', () => {
    const m = make();
    approveAutomation(projectRoot, m, at(15, 34));
    ran(at(15, 45, 7));
    expect(nextFireIso(m, at(15, 46), { projectRoot })).toBe(at(15, 45).toISOString());
    ran(at(15, 45));
    expect(nextFireIso(m, at(15, 53), { projectRoot })).toBe(at(15, 45, 9).toISOString());
  });

  it('an unapproved one is not owed: tomorrow', () => {
    const m = make();
    ran(at(15, 45, 7));
    expect(nextFireIso(m, at(15, 46), { projectRoot })).toBe(at(15, 45, 9).toISOString());
  });

  it('a routine that runs on another machine is not owed here: tomorrow (its cache never syncs)', () => {
    const m = make();
    approveAutomation(projectRoot, m, at(15, 34));
    ran(at(15, 45, 7));
    mkdirSync(join(contextRoot, 'agents', '.active'), { recursive: true });
    writeFileSync(join(contextRoot, 'agents', '.active', 'ai-news.json'), JSON.stringify({
      machine: 'some-other-mac', name: 'Other Mac', since: at(9, 0).toISOString(), by: m.owner ?? 'someone',
    }));
    expect(nextFireIso(m, at(15, 46), { projectRoot })).toBe(at(15, 45, 9).toISOString());
  });

  it('without a project to read it falls back to the clock', () => {
    const m = make();
    expect(nextFireIso(m, at(15, 46))).toBe(at(15, 45, 9).toISOString());
  });
});

describe('the dispatcher interval', () => {
  it('wakes every minute, so a fire waits at most a minute for its tick', () => {
    expect(TICK_INTERVAL_SECONDS).toBe(60);
  });
});
