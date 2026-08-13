import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tickAll, tickProject } from '../../src/lib/automations/tick.js';
import { createAutomation, setAutomationEnabled, writeAutomationCache } from '../../src/lib/automations/store.js';
import { enqueueFire, queuedFire } from '../../src/lib/automations/queue.js';
import { registerProject, readDispatcherHeartbeat } from '../../src/lib/automations/registry.js';
import { automationsLogPath } from '../../src/lib/automations/launchd.js';
import { LOG_ROTATE_BYTES, type AutomationCache, type RunOutcome } from '../../src/lib/automations/types.js';
import type { runAutomation } from '../../src/lib/automations/runner.js';

/** Fixed, injected — never Date.now()/new Date() in assertions. Schedule fires
 *  daily at 18:00; NOW sits exactly at that fire.
 *
 *  `Schedule.at` is machine-LOCAL wall-clock (schedule.ts's own contract) —
 *  pin TZ=UTC for this whole file (mirrors automations-schedule.test.ts's own
 *  per-test TZ forcing) so "18:00" means 18:00 UTC everywhere this suite
 *  runs, regardless of the host machine's ambient timezone. */
const NOW = new Date('2026-07-26T18:00:00.000Z');

let originalTZ: string | undefined;

beforeAll(() => {
  originalTZ = process.env.TZ;
  process.env.TZ = 'UTC';
});

afterAll(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

let projectRoot: string;
let contextRoot: string;
let home: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-automations-tick-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'dc-automations-tick-home-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function makeDue(slug: string, overrides?: Partial<Parameters<typeof createAutomation>[1]>) {
  return createAutomation(contextRoot, {
    slug,
    title: `Test — ${slug}`,
    days: 'daily',
    at: '18:00',
    prompt: 'Say hello.',
    ...overrides,
  });
}

function baseCache(overrides: Partial<AutomationCache> = {}): AutomationCache {
  return {
    slug: 'x',
    lastRunAt: null,
    lastFireAt: null,
    status: null,
    durationMs: null,
    outputPath: null,
    error: null,
    exitCode: null,
    history: [],
    ...overrides,
  };
}

function fakeOutcome(slug: string, status: RunOutcome['status']): RunOutcome {
  return {
    slug,
    status,
    outputPath: status === 'ok' ? `/tmp/fake/${slug}.md` : null,
    error: status === 'ok' ? null : `fake ${status}`,
    durationMs: 5,
    event: null,
    cache: null,
    denials: 0,
    costUsd: null,
  };
}

/** A fake `runImpl` matching `typeof runAutomation` exactly, so tick.ts's own
 *  tests never spawn a real `claude` (or even drive the real runner's spawn
 *  plumbing) — tick's contract is "call runImpl once per due automation, in
 *  order", not "the runner's spawn logic is correct" (that's T6's suite). */
function fakeRunner(
  status: RunOutcome['status'] | ((slug: string) => RunOutcome['status']),
  opts?: { calls?: Array<{ slug: string; fireAt: Date | undefined }>; concurrency?: { current: number; max: number } },
): typeof runAutomation {
  return vi.fn(async (_contextRoot: string, slug: string, runOpts) => {
    const st = typeof status === 'function' ? status(slug) : status;
    if (opts?.concurrency) {
      opts.concurrency.current += 1;
      opts.concurrency.max = Math.max(opts.concurrency.max, opts.concurrency.current);
    }
    opts?.calls?.push({ slug, fireAt: runOpts?.fireAt });
    // Yield so a caller that (incorrectly) fired calls concurrently would race here.
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (opts?.concurrency) opts.concurrency.current -= 1;
    return fakeOutcome(slug, st);
  }) as unknown as typeof runAutomation;
}

// ─── tickProject ─────────────────────────────────────────────────────────────

describe('tickProject', () => {
  it('runs a due, enabled automation and reports it in ran[] and verdicts[]', async () => {
    makeDue('eod-digest');
    const runImpl = fakeRunner('ok');

    const result = await tickProject(projectRoot, { now: NOW, runImpl });

    expect(result.projectRoot).toBe(projectRoot);
    expect(result.contextRoot).toBe(contextRoot);
    expect(result.considered).toBe(1);
    expect(result.ran).toHaveLength(1);
    expect(result.ran[0].slug).toBe('eod-digest');
    expect(result.ran[0].status).toBe('ok');
    expect(result.verdicts).toEqual([{ slug: 'eod-digest', verdict: 'due' }]);
    expect(runImpl).toHaveBeenCalledTimes(1);
  });

  it('skips a disabled automation WITHOUT calling isDue-driven runImpl, verdict "disabled"', async () => {
    const m = makeDue('weekly-report');
    setAutomationEnabled(contextRoot, m.slug, false);
    const runImpl = fakeRunner('ok');

    const result = await tickProject(projectRoot, { now: NOW, runImpl });

    expect(result.considered).toBe(1);
    expect(result.ran).toHaveLength(0);
    expect(result.verdicts).toEqual([{ slug: 'weekly-report', verdict: 'disabled' }]);
    expect(runImpl).not.toHaveBeenCalled();
  });

  it('an automation not yet due is skipped with the isDue reason, no spawn', async () => {
    makeDue('research', { at: '23:59' }); // fires at 23:59, NOW is 18:00 — not yet
    const runImpl = fakeRunner('ok');

    const result = await tickProject(projectRoot, { now: NOW, runImpl });

    expect(result.ran).toHaveLength(0);
    expect(result.verdicts).toHaveLength(1);
    expect(['not-yet', 'already-ran', 'outside-catchup', 'no-schedule']).toContain(result.verdicts[0].verdict);
    expect(runImpl).not.toHaveBeenCalled();
  });

  it('an already-recorded fire (same fire, lastFireAt already advanced) is not re-run', async () => {
    const m = makeDue('eod-digest');
    writeAutomationCache(contextRoot, m.slug, baseCache({ slug: m.slug, lastFireAt: NOW.toISOString() }));
    const runImpl = fakeRunner('ok');

    const result = await tickProject(projectRoot, { now: NOW, runImpl });

    expect(result.ran).toHaveLength(0);
    expect(runImpl).not.toHaveBeenCalled();
  });

  it('maps a "blocked" run outcome to the dedicated "blocked" verdict', async () => {
    makeDue('needs-approval');
    const runImpl = fakeRunner('blocked');

    const result = await tickProject(projectRoot, { now: NOW, runImpl });

    expect(result.ran[0].status).toBe('blocked');
    expect(result.verdicts).toEqual([{ slug: 'needs-approval', verdict: 'blocked' }]);
  });

  it('maps an "orphaned" run outcome to the dedicated "orphaned" verdict', async () => {
    makeDue('has-orphan');
    const runImpl = fakeRunner('orphaned');

    const result = await tickProject(projectRoot, { now: NOW, runImpl });

    expect(result.ran[0].status).toBe('orphaned');
    expect(result.verdicts).toEqual([{ slug: 'has-orphan', verdict: 'orphaned' }]);
  });

  it('a "deferred" run outcome (sleep-lock/self-overlap) collapses to "due" — full status stays in ran[]', async () => {
    makeDue('sleepy');
    const runImpl = fakeRunner('deferred');

    const result = await tickProject(projectRoot, { now: NOW, runImpl });

    expect(result.ran[0].status).toBe('deferred');
    expect(result.verdicts).toEqual([{ slug: 'sleepy', verdict: 'due' }]);
  });

  it('passes the ACTUAL fire time (not `now`) to runImpl as fireAt, for a catch-up run', async () => {
    // Fires daily at 18:00; NOW is 18:20 — inside the default 6h catchup window.
    const late = new Date('2026-07-26T18:20:00.000Z');
    makeDue('eod-digest');
    const calls: Array<{ slug: string; fireAt: Date | undefined }> = [];
    const runImpl = fakeRunner('ok', { calls });

    await tickProject(projectRoot, { now: late, runImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0].fireAt?.toISOString()).toBe('2026-07-26T18:00:00.000Z');
  });

  it('runs multiple due automations SEQUENTIALLY, never concurrently', async () => {
    makeDue('alpha');
    makeDue('bravo');
    makeDue('charlie');
    const concurrency = { current: 0, max: 0 };
    const calls: Array<{ slug: string; fireAt: Date | undefined }> = [];
    const runImpl = fakeRunner('ok', { calls, concurrency });

    const result = await tickProject(projectRoot, { now: NOW, runImpl });

    expect(result.ran.map((r) => r.slug)).toEqual(['alpha', 'bravo', 'charlie']);
    expect(calls.map((c) => c.slug)).toEqual(['alpha', 'bravo', 'charlie']);
    expect(concurrency.max).toBe(1); // never more than one in flight at a time
  });

  it('a project with zero manifests considers nothing and calls runImpl zero times', async () => {
    const runImpl = fakeRunner('ok');

    const result = await tickProject(projectRoot, { now: NOW, runImpl });

    expect(result.considered).toBe(0);
    expect(result.ran).toHaveLength(0);
    expect(result.verdicts).toHaveLength(0);
    expect(runImpl).not.toHaveBeenCalled();
  });

  it('defaults `now` to the real clock when omitted (no throw, returns a result)', async () => {
    const runImpl = fakeRunner('ok');
    const result = await tickProject(projectRoot, { runImpl });
    expect(result.considered).toBe(0);
  });
});

// ─── Draining the queue (D9), BEFORE isDue() ────────────────────────────────

describe('tickProject — draining the queue before isDue()', () => {
  it('runs a drained fire with its ORIGINAL firedAt, and does not run it a second time via isDue()', async () => {
    // Schedule ALSO matches NOW exactly, so isDue() would independently want
    // to run this too — proving the drain phase and the isDue() loop hand out
    // exactly ONE run for the same owed fire, not two.
    makeDue('eod-digest');
    // Within the default 6h catchup window (so the drain phase actually runs
    // it) but distinct from NOW (so a `fireAt` equal to NOW would prove
    // nothing about which phase ran it).
    const OLD_FIRE = '2026-07-26T16:00:00.000Z';
    enqueueFire(projectRoot, 'eod-digest', OLD_FIRE, home, NOW.getTime());
    const calls: Array<{ slug: string; fireAt: Date | undefined }> = [];
    const runImpl = fakeRunner('ok', { calls });

    const result = await tickProject(projectRoot, { now: NOW, home, runImpl });

    expect(runImpl).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([{ slug: 'eod-digest', fireAt: new Date(OLD_FIRE) }]);
    expect(result.ran).toHaveLength(1);
    expect(result.ran[0].slug).toBe('eod-digest');
    expect(result.verdicts).toEqual([{ slug: 'eod-digest', verdict: 'due' }]);
    // drained AND run ⇒ gone from the queue
    expect(queuedFire(projectRoot, 'eod-digest', home)).toBeNull();
  });

  it('keeps a queued fire for a DISABLED automation — re-enqueued with the ORIGINAL firedAt, never run (R5)', async () => {
    const m = makeDue('weekly-report');
    setAutomationEnabled(contextRoot, m.slug, false);
    const OLD_FIRE = '2026-07-25T18:00:00.000Z';
    enqueueFire(projectRoot, m.slug, OLD_FIRE, home, NOW.getTime());
    const runImpl = fakeRunner('ok');

    const result = await tickProject(projectRoot, { now: NOW, home, runImpl });

    expect(runImpl).not.toHaveBeenCalled();
    expect(result.ran).toHaveLength(0);
    // the isDue() loop still gives it its normal 'disabled' verdict — exactly
    // once, not doubled by the drain phase.
    expect(result.verdicts).toEqual([{ slug: m.slug, verdict: 'disabled' }]);
    // OWED, not lost — still on disk with its ORIGINAL firedAt preserved.
    expect(queuedFire(projectRoot, m.slug, home)).toEqual({
      slug: m.slug,
      firedAt: OLD_FIRE,
      enqueuedAt: NOW.toISOString(),
    });
  });

  it('drops a queued fire whose automation no longer exists, without throwing', async () => {
    enqueueFire(projectRoot, 'ghost-automation', '2026-07-25T18:00:00.000Z', home, NOW.getTime());
    const runImpl = fakeRunner('ok');

    const result = await tickProject(projectRoot, { now: NOW, home, runImpl });

    expect(runImpl).not.toHaveBeenCalled();
    expect(result.considered).toBe(0);
    expect(result.ran).toHaveLength(0);
    expect(result.verdicts).toHaveLength(0);
    // the drain already cleared it — nothing left to keep for a slug that
    // does not exist.
    expect(queuedFire(projectRoot, 'ghost-automation', home)).toBeNull();
  });

  it('drops a queued fire outside the manifest catchupHours window, without running it', async () => {
    // Scheduled for 23:59 — not due right now for its own reasons, so the
    // ONLY thing that could make this run is the drain phase.
    makeDue('research', { at: '23:59', catchupHours: 6 });
    const STALE_FIRE = '2026-07-20T18:00:00.000Z'; // days old
    enqueueFire(projectRoot, 'research', STALE_FIRE, home, NOW.getTime());
    const runImpl = fakeRunner('ok');

    const result = await tickProject(projectRoot, { now: NOW, home, runImpl });

    expect(runImpl).not.toHaveBeenCalled();
    expect(result.ran).toHaveLength(0);
    // drained (and dropped) regardless — the queue never grows unboundedly
    // with fires nobody will ever run.
    expect(queuedFire(projectRoot, 'research', home)).toBeNull();
  });

  it('an empty queue changes nothing — the fresh-machine no-op stays a no-op', async () => {
    makeDue('eod-digest', { at: '23:59' }); // not due right now
    const runImpl = fakeRunner('ok');

    const result = await tickProject(projectRoot, { now: NOW, home, runImpl });

    expect(runImpl).not.toHaveBeenCalled();
    expect(result.ran).toHaveLength(0);
    expect(result.verdicts).toHaveLength(1);
  });

  it('keeps considered.length === verdicts.length across a mixed drain + isDue pass', async () => {
    makeDue('alpha'); // drained + run
    const bravo = makeDue('bravo');
    setAutomationEnabled(contextRoot, bravo.slug, false); // drained + kept (disabled)
    makeDue('charlie', { at: '23:59' }); // normal isDue() path, not due

    enqueueFire(projectRoot, 'alpha', '2026-07-26T16:00:00.000Z', home, NOW.getTime()); // within catchup
    enqueueFire(projectRoot, 'bravo', '2026-07-25T18:00:00.000Z', home, NOW.getTime()); // disabled — never reaches the catchup check
    enqueueFire(projectRoot, 'ghost', '2026-07-25T18:00:00.000Z', home, NOW.getTime()); // no manifest

    const runImpl = fakeRunner('ok');
    const result = await tickProject(projectRoot, { now: NOW, home, runImpl });

    expect(result.considered).toBe(3); // alpha, bravo, charlie — ghost was never a manifest
    expect(result.verdicts).toHaveLength(3);
    expect(result.verdicts.map((v) => v.slug).sort()).toEqual(['alpha', 'bravo', 'charlie']);
    expect(result.verdicts.find((v) => v.slug === 'alpha')?.verdict).toBe('due');
    expect(result.verdicts.find((v) => v.slug === 'bravo')?.verdict).toBe('disabled');
    expect(runImpl).toHaveBeenCalledTimes(1); // alpha only
  });
});

// ─── tickAll ─────────────────────────────────────────────────────────────────

describe('tickAll', () => {
  it('an EMPTY registry is a silent no-op: zero projects, zero missing, zero spawns', async () => {
    const runImpl = fakeRunner('ok');

    const result = await tickAll({ now: NOW, home, runImpl });

    expect(result.projects).toHaveLength(0);
    expect(result.missing).toHaveLength(0);
    expect(result.startedAt).toBe(NOW.toISOString());
    expect(runImpl).not.toHaveBeenCalled();
  });

  it('writes BOTH heartbeat timestamps even on a no-op tick', async () => {
    await tickAll({ now: NOW, home, runImpl: fakeRunner('ok') });

    const hb = readDispatcherHeartbeat(home);
    expect(hb.lastTickStartedAt).toBe(NOW.toISOString());
    expect(hb.lastTickCompletedAt).not.toBeNull();
    expect(typeof hb.lastTickDurationMs).toBe('number');
    expect(hb.lastTickDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('writes both heartbeat timestamps when there IS work to do, too', async () => {
    registerProject(projectRoot, home);
    makeDue('eod-digest');

    await tickAll({ now: NOW, home, runImpl: fakeRunner('ok') });

    const hb = readDispatcherHeartbeat(home);
    expect(hb.lastTickStartedAt).toBe(NOW.toISOString());
    expect(hb.lastTickCompletedAt).not.toBeNull();
  });

  it('a registered project whose _dream_context/ is missing is warned about and skipped, without aborting the loop', async () => {
    const ghostRoot = join(projectRoot, 'never-existed');
    registerProject(ghostRoot, home);
    registerProject(projectRoot, home);
    makeDue('eod-digest');
    const warnings: string[] = [];

    const result = await tickAll({ now: NOW, home, runImpl: fakeRunner('ok'), log: (l) => warnings.push(l) });

    expect(result.missing).toEqual([ghostRoot]);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].projectRoot).toBe(projectRoot);
    expect(result.projects[0].ran).toHaveLength(1);
    expect(warnings.some((w) => w.includes(ghostRoot))).toBe(true);
  });

  it('iterates every registered project, calling tickProject-equivalent logic for each', async () => {
    const projectB = mkdtempSync(join(tmpdir(), 'dc-automations-tick-b-'));
    const contextB = join(projectB, '_dream_context');
    mkdirSync(contextB, { recursive: true });
    try {
      registerProject(projectRoot, home);
      registerProject(projectB, home);
      makeDue('alpha');
      createAutomation(contextB, {
        slug: 'beta', title: 'Beta', days: 'daily', at: '18:00', prompt: 'Say hi.',
      });

      const result = await tickAll({ now: NOW, home, runImpl: fakeRunner('ok') });

      expect(result.missing).toHaveLength(0);
      expect(result.projects).toHaveLength(2);
      const slugsRan = result.projects.flatMap((p) => p.ran.map((r) => r.slug)).sort();
      expect(slugsRan).toEqual(['alpha', 'beta']);
    } finally {
      rmSync(projectB, { recursive: true, force: true });
    }
  });

  it('rotates the dispatcher log once it exceeds LOG_ROTATE_BYTES', async () => {
    const logPath = automationsLogPath(home);
    mkdirSync(join(home, '.dreamcontext', 'logs'), { recursive: true });
    writeFileSync(logPath, 'x'.repeat(LOG_ROTATE_BYTES + 1));

    await tickAll({ now: NOW, home, runImpl: fakeRunner('ok') });

    expect(existsSync(`${logPath}.1`)).toBe(true);
  });

  it('does NOT rotate the log when it is under the size cap', async () => {
    const logPath = automationsLogPath(home);
    mkdirSync(join(home, '.dreamcontext', 'logs'), { recursive: true });
    writeFileSync(logPath, 'small');

    await tickAll({ now: NOW, home, runImpl: fakeRunner('ok') });

    expect(existsSync(`${logPath}.1`)).toBe(false);
  });

  it('defaults `now`/`home` when omitted and still completes (no throw)', async () => {
    // `home` omitted ⇒ registry.ts falls through to the real `os.homedir()`,
    // which honours `$HOME` on POSIX — point it at an empty temp dir for the
    // duration so this asserts a PROVABLY empty registry, not "hopefully the
    // developer's real machine has none registered" (a real machine WILL have
    // one the moment they run `automations install` — that's the feature).
    const prevHome = process.env.HOME;
    const emptyHome = mkdtempSync(join(tmpdir(), 'dc-tick-home-'));
    process.env.HOME = emptyHome;
    try {
      const result = await tickAll({ runImpl: fakeRunner('ok') });
      expect(result.projects).toHaveLength(0);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });
});

// Note: the "tick never calls killRunGroup" invariant is enforced by T6's
// tests/unit/automations-no-auto-reap.test.ts, which source-scans this file —
// not duplicated here.
