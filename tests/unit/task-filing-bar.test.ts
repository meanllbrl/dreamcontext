import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertTaskFilingBar, isSleepCycleLive, cycleTasksFiled, recordCycleTaskFiled,
  MIN_SLEEP_WHY_CHARS, type FilingActor,
} from '../../src/lib/task-filing-bar.js';
import { appendTombstone } from '../../src/lib/task-tombstones.js';
import { updateSetupConfig } from '../../src/lib/setup-config.js';
import { SLEEP_LOCK_STALE_MS } from '../../src/lib/sleep-consolidation.js';

/**
 * B2. The bar is a floor against the EMPTY TEMPLATE, not a quality judge — B0
 * measured the thinnest REAL task on this brain at 146 characters of
 * justification and found exactly one task with none at all. What matters most
 * in these tests is who the bar does NOT stop: a person working while a
 * background cycle runs must get a clear way through, not a silent block.
 */

let project = '';
let ctx = '';

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'dc-bar-'));
  ctx = join(project, '_dream_context');
  mkdirSync(join(ctx, 'state'), { recursive: true });
  delete process.env.DREAMCONTEXT_AUTO_SLEEP;
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
  delete process.env.DREAMCONTEXT_AUTO_SLEEP;
});

function writeSleep(extra: Record<string, unknown> = {}): void {
  writeFileSync(join(ctx, 'state', '.sleep.json'), JSON.stringify({
    debt: 0, last_sleep: null, last_sleep_summary: null, sleep_started_at: null,
    sessions: [], bookmarks: [], triggers: [], knowledge_access: {}, dashboard_changes: [],
    compaction_log: [], pendingMigrationNotices: [], ...extra,
  }, null, 2));
}

const liveEpoch = () => new Date().toISOString();
const staleEpoch = () => new Date(Date.now() - SLEEP_LOCK_STALE_MS - 60_000).toISOString();
const GOOD_WHY = 'The dashboard shows a stale count because the cache is never invalidated on write.';

const bar = (actor: FilingActor, why?: string, slug?: string) =>
  assertTaskFilingBar({ contextRoot: ctx, actor, why, slug });

describe('when the bar applies at all', () => {
  it('is OFF with no sleep state at all', () => {
    expect(bar('unknown', '').allowed).toBe(true);
    expect(bar('unknown', '').underBar).toBe(false);
  });

  it('is OFF when no cycle is running', () => {
    writeSleep();
    expect(bar('unknown', '')).toMatchObject({ allowed: true, underBar: false });
  });

  it('is ON during a live cycle', () => {
    writeSleep({ sleep_started_at: liveEpoch() });
    expect(isSleepCycleLive(ctx)).toBe(true);
    expect(bar('unknown', '').allowed).toBe(false);
  });

  it('is OFF again once the lock goes STALE — a crashed sleep must not wedge it on forever', () => {
    writeSleep({ sleep_started_at: staleEpoch() });
    expect(isSleepCycleLive(ctx)).toBe(false);
    expect(bar('unknown', '')).toMatchObject({ allowed: true, underBar: false });
  });

  it('is ON under DREAMCONTEXT_AUTO_SLEEP even with no epoch stamped yet', () => {
    writeSleep();
    process.env.DREAMCONTEXT_AUTO_SLEEP = '1';
    expect(isSleepCycleLive(ctx)).toBe(true);
    expect(bar('unknown', '').allowed).toBe(false);
  });

  it('is ON for an explicit `--by sleep` even outside a cycle — a specialist is taken at its word', () => {
    writeSleep();
    expect(bar('sleep', 'short').allowed).toBe(false);
  });

  it('NEVER applies to an explicit human, cycle or not', () => {
    writeSleep({ sleep_started_at: liveEpoch() });
    process.env.DREAMCONTEXT_AUTO_SLEEP = '1';
    expect(bar('human', '')).toMatchObject({ allowed: true, underBar: false });
  });
});

describe('the justification floor', () => {
  beforeEach(() => writeSleep({ sleep_started_at: liveEpoch() }));

  it('refuses an empty Why — the exact shape of the one junk task on this brain', () => {
    const v = bar('sleep', '');
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain(`at least ${MIN_SLEEP_WHY_CHARS} characters`);
  });

  it.each([undefined, null, '   ', '(To be defined)'])('refuses the placeholder %s', (why) => {
    expect(bar('sleep', why as string | undefined).allowed).toBe(false);
  });

  it('accepts a real justification', () => {
    expect(bar('sleep', GOOD_WHY)).toMatchObject({ allowed: true, underBar: true });
  });

  it('tells an UNKNOWN caller the escape hatch, so a person is never silently blocked', () => {
    expect(bar('unknown', '').reason).toContain('--by human');
  });

  it('does not dangle that hatch in front of a specialist that named itself', () => {
    expect(bar('sleep', '').reason).not.toContain('--by human');
  });
});

describe('the per-cycle cap', () => {
  it('refuses once the configured cap is reached, and says where the candidate should go', () => {
    updateSetupConfig(project, { sleep: { maxNewTasksPerCycle: 2 } });
    writeSleep({ sleep_started_at: liveEpoch(), cycle_tasks_filed: ['a', 'b'] });
    const v = bar('sleep', GOOD_WHY);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('2/2');
    expect(v.reason).toContain('Candidates NOT filed (cap)');
  });

  it('allows up to the cap', () => {
    updateSetupConfig(project, { sleep: { maxNewTasksPerCycle: 2 } });
    writeSleep({ sleep_started_at: liveEpoch(), cycle_tasks_filed: ['a'] });
    expect(bar('sleep', GOOD_WHY).allowed).toBe(true);
  });

  it('a cap of 0 files nothing at all, with its own message', () => {
    updateSetupConfig(project, { sleep: { maxNewTasksPerCycle: 0 } });
    writeSleep({ sleep_started_at: liveEpoch() });
    expect(bar('sleep', GOOD_WHY).reason).toContain('files no tasks during sleep');
  });

  it('defaults to 5 when the brain configured nothing', () => {
    writeSleep({ sleep_started_at: liveEpoch(), cycle_tasks_filed: ['a', 'b', 'c', 'd'] });
    expect(bar('sleep', GOOD_WHY).allowed).toBe(true);
    writeSleep({ sleep_started_at: liveEpoch(), cycle_tasks_filed: ['a', 'b', 'c', 'd', 'e'] });
    expect(bar('sleep', GOOD_WHY).allowed).toBe(false);
  });

  it('reports the CAP rather than the Why when both would fail — the cap is the real blocker', () => {
    updateSetupConfig(project, { sleep: { maxNewTasksPerCycle: 1 } });
    writeSleep({ sleep_started_at: liveEpoch(), cycle_tasks_filed: ['a'] });
    expect(bar('sleep', '').reason).toContain('Cap reached');
  });

  it('recordCycleTaskFiled counts a slug once', () => {
    writeSleep({ sleep_started_at: liveEpoch() });
    recordCycleTaskFiled(ctx, 'x');
    recordCycleTaskFiled(ctx, 'x');
    recordCycleTaskFiled(ctx, 'y');
    expect(cycleTasksFiled(ctx)).toEqual(['x', 'y']);
  });

  it('recordCycleTaskFiled leaves the rest of the state alone', () => {
    writeSleep({ sleep_started_at: liveEpoch(), debt: 42 });
    recordCycleTaskFiled(ctx, 'x');
    const state = JSON.parse(readFileSync(join(ctx, 'state', '.sleep.json'), 'utf8'));
    expect(state.debt).toBe(42);
    expect(state.sleep_started_at).toBeTruthy();
  });
});

describe('a task that was deliberately consolidated away', () => {
  beforeEach(() => writeSleep({ sleep_started_at: liveEpoch() }));

  it('cannot be re-filed while the absorbing task is alive', () => {
    appendTombstone(ctx, { slug: 'old-chore', deletedAt: new Date().toISOString(), absorbedBy: 'the-real-task' });
    const v = bar('sleep', GOOD_WHY, 'old-chore');
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('the-real-task');
    expect(v.reason).toContain('tombstones');
  });

  it('names the whole chain when it was absorbed transitively', () => {
    const at = new Date().toISOString();
    appendTombstone(ctx, { slug: 'a', deletedAt: at, absorbedBy: 'b' });
    appendTombstone(ctx, { slug: 'b', deletedAt: at, absorbedBy: 'c' });
    expect(bar('sleep', GOOD_WHY, 'a').reason).toContain('a → b → c');
  });

  it('CAN be filed again when the chain dead-ends — the work was dropped, not moved', () => {
    appendTombstone(ctx, { slug: 'gone', deletedAt: new Date().toISOString() });
    expect(bar('sleep', GOOD_WHY, 'gone').allowed).toBe(true);
  });

  it('never blocks a human, even on a tombstoned slug', () => {
    appendTombstone(ctx, { slug: 'old-chore', deletedAt: new Date().toISOString(), absorbedBy: 'the-real-task' });
    expect(bar('human', '', 'old-chore').allowed).toBe(true);
  });
});
