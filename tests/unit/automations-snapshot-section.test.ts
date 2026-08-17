import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildAutomationsSnapshot, renderAutomationsSection } from '../../src/lib/automations/snapshot.js';
import { createAutomation, recordRun, sidecarPathFor, writeRunSidecar } from '../../src/lib/automations/store.js';
import { approveAutomation } from '../../src/lib/automations/registry.js';
import type { AutomationManifest, RunEvent, RunSidecar } from '../../src/lib/automations/types.js';

/**
 * Tests for the pure snapshot renderer (T7). Three independent signals are
 * exercised separately and in combination:
 *   - cache history        → recent runs / failures
 *   - checkApproval         → blocked-pending-approval (incl. NO cache record)
 *   - the run sidecar       → live-orphan detection
 *
 * `process.kill` is spied directly for liveness probing — the SAME convention
 * `tests/unit/file-lock.test.ts` uses for its own `verifyPidLiveness` checks —
 * rather than adding an injectable prober to the module, keeping this file's
 * public contract exactly the `{ now, home, windowHours }` shape the plan
 * specifies.
 */

const NOW = new Date('2026-07-25T20:00:00.000Z');

let projectRoot: string;
let contextRoot: string;
let home: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-automations-snapshot-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'dc-automations-snapshot-home-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ─── fixtures ────────────────────────────────────────────────────────────────

function makeAutomation(slug: string): AutomationManifest {
  return createAutomation(contextRoot, {
    slug,
    title: `Title for ${slug}`,
    days: 'daily',
    at: '18:00',
    prompt: 'Do the thing.',
  });
}

function fakeEvent(overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    firedAt: '2026-07-25T18:00:00.000Z',
    startedAt: '2026-07-25T18:00:01.000Z',
    finishedAt: '2026-07-25T18:00:05.000Z',
    status: 'ok',
    durationMs: 4000,
    outputPath: '/out.md',
    error: null,
    exitCode: 0,
    sessionId: 'sess_1',
    costUsd: 0.01,
    numTurns: 3,
    permissionDenials: 0,
    ...overrides,
  };
}

function validSidecar(slug: string, overrides: Partial<RunSidecar> = {}): RunSidecar {
  return {
    slug,
    runnerPid: 60001,
    childPid: 60002,
    childPgid: 60002,
    fireAt: NOW.toISOString(),
    startedAt: NOW.toISOString(),
    timeoutAt: NOW.toISOString(),
    ...overrides,
  };
}

/** Write just enough of `state/.sleep.json` for the snapshot's OWN lenient
 *  reader to pick up the boundary — deliberately NOT via `writeSleepState`
 *  (`cli/commands/sleep.ts`): a lib module must not depend on a CLI command
 *  file (see snapshot.ts's module doc on `readLastConsolidatedAt`). */
function writeConsolidationBoundary(iso: string | null): void {
  const dir = join(contextRoot, 'state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.sleep.json'), JSON.stringify({ last_consolidated_at: iso }) + '\n', 'utf-8');
}

/** Write an automation output file with an EXPLICIT mtime so pending-output
 *  detection can be tested deterministically against the boundary. */
function writePendingOutput(slug: string, date: string, mtimeIso: string): void {
  const dir = join(contextRoot, 'automations', 'output', slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${date}.md`);
  writeFileSync(path, '# output\n', 'utf-8');
  const mtime = new Date(mtimeIso);
  utimesSync(path, mtime, mtime);
}

/** `process.kill` mock: `alivePids` answer with no throw; every other pid throws ESRCH. */
function mockLiveness(alivePids: number[]): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
    if (alivePids.includes(pid)) return true;
    const err = new Error('No such process') as NodeJS.ErrnoException;
    err.code = 'ESRCH';
    throw err;
  }) as typeof process.kill);
}

// ─── clean brain — the "ships fully disabled" guarantee ─────────────────────

describe('clean brain', () => {
  it('renderAutomationsSection returns [] when there are no automations at all', () => {
    expect(renderAutomationsSection(contextRoot, { now: NOW, home })).toEqual([]);
  });

  it('buildAutomationsSnapshot returns empty lines, a zero total and all-false flags', () => {
    expect(buildAutomationsSnapshot(contextRoot, { now: NOW, home })).toEqual({
      lines: [],
      total: 0,
      hasBlocked: false,
      hasFailure: false,
      hasOrphan: false,
      hasPendingOutputs: false,
      hasPendingReview: false,
    });
  });

  it('still returns [] when the automations directory does not exist on disk at all', () => {
    const freshProjectRoot = mkdtempSync(join(tmpdir(), 'dc-automations-snapshot-fresh-'));
    const freshContextRoot = join(freshProjectRoot, '_dream_context'); // never mkdir'd
    try {
      expect(renderAutomationsSection(freshContextRoot, { now: NOW, home })).toEqual([]);
    } finally {
      rmSync(freshProjectRoot, { recursive: true, force: true });
    }
  });
});

// ─── no ANSI / chalk ─────────────────────────────────────────────────────────

describe('plain text only', () => {
  it('never emits an ANSI escape sequence even with every kind of line present at once', () => {
    makeAutomation('eod-digest'); // never approved -> blocked line
    const weekly = makeAutomation('weekly-report');
    approveAutomation(projectRoot, weekly, NOW, home);
    recordRun(contextRoot, weekly.slug, fakeEvent({ status: 'failed', error: 'boom', finishedAt: '2026-07-25T19:00:00.000Z' }));
    writeRunSidecar(contextRoot, weekly.slug, validSidecar(weekly.slug, { runnerPid: 70001, childPgid: 70002 }));
    mockLiveness([70002]); // childPgid alive, runnerPid dead -> orphan line too

    const lines = renderAutomationsSection(contextRoot, { now: NOW, home });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toMatch(/\x1b\[[0-9;]*m/);
  });
});

// ─── blocked pending approval — the required gate scenario ──────────────────

describe('blocked pending approval', () => {
  it('a never-approved automation with NO cache record is still surfaced, naming the exact approve command', () => {
    const m = makeAutomation('eod-digest');
    // Deliberately no recordRun call — this automation has never been ticked,
    // so automations/cache/eod-digest.json does not exist on disk.
    const snap = buildAutomationsSnapshot(contextRoot, { now: NOW, home });
    expect(snap.hasBlocked).toBe(true);
    expect(snap.hasFailure).toBe(false);
    expect(snap.hasOrphan).toBe(false);
    expect(snap.lines).toEqual([
      `- ${m.slug}: blocked pending approval (never-approved) — run \`dreamcontext automations approve ${m.slug}\``,
    ]);
  });

  it('does not surface an approved automation that has no cache record yet', () => {
    const m = makeAutomation('eod-digest');
    approveAutomation(projectRoot, m, NOW, home);
    expect(renderAutomationsSection(contextRoot, { now: NOW, home })).toEqual([]);
  });

  it('still counts that quiet automation in `total` — "nothing to report" is not "nothing exists"', () => {
    // The distinction the snapshot's zero state is built on: a vault with no
    // automations and a vault whose automations are simply quiet both render
    // zero lines, so `lines` alone cannot tell them apart and "none" would be
    // a lie over the second one.
    const m = makeAutomation('weekly-report');
    approveAutomation(projectRoot, m, NOW, home);
    const snap = buildAutomationsSnapshot(contextRoot, { now: NOW, home });
    expect(snap.lines).toEqual([]);
    expect(snap.total).toBe(1);
  });

  it('a manifest edited after approval (manifest-changed) is surfaced the same way, still naming approve', () => {
    const m = makeAutomation('eod-digest');
    approveAutomation(projectRoot, m, NOW, home);
    // Simulate a synced teammate's edit to the hashed prompt field.
    const raw = readFileSync(m.path, 'utf-8');
    writeFileSync(m.path, raw.replace('Do the thing.', 'Do a DIFFERENT thing.'), 'utf-8');

    const snap = buildAutomationsSnapshot(contextRoot, { now: NOW, home });
    expect(snap.hasBlocked).toBe(true);
    expect(snap.lines).toHaveLength(1);
    expect(snap.lines[0]).toContain('manifest-changed');
    expect(snap.lines[0]).toContain(`dreamcontext automations approve ${m.slug}`);
  });
});

// ─── live orphan — the required gate scenario ────────────────────────────────

describe('live orphan', () => {
  it('produces the kill-hint line when the child group is alive and the runner is dead', () => {
    const m = makeAutomation('eod-digest');
    approveAutomation(projectRoot, m, NOW, home); // approved, so ONLY the orphan line can appear
    writeRunSidecar(contextRoot, m.slug, validSidecar(m.slug, { runnerPid: 60001, childPgid: 60002 }));
    mockLiveness([60002]); // childPgid alive, runnerPid ESRCH

    const snap = buildAutomationsSnapshot(contextRoot, { now: NOW, home });
    expect(snap.hasOrphan).toBe(true);
    expect(snap.lines).toEqual([
      `- automation ${m.slug} may have an orphaned run — run \`dreamcontext automations kill ${m.slug}\``,
    ]);
  });

  it('does NOT flag when both the runner and the child group are alive (a normal in-flight run)', () => {
    const m = makeAutomation('eod-digest');
    approveAutomation(projectRoot, m, NOW, home);
    writeRunSidecar(contextRoot, m.slug, validSidecar(m.slug, { runnerPid: 60003, childPgid: 60004 }));
    mockLiveness([60003, 60004]);

    const snap = buildAutomationsSnapshot(contextRoot, { now: NOW, home });
    expect(snap.hasOrphan).toBe(false);
    expect(snap.lines).toEqual([]);
  });

  it('does NOT flag when both the runner and the child group are dead (cleanly finished, sidecar not yet cleared)', () => {
    const m = makeAutomation('eod-digest');
    approveAutomation(projectRoot, m, NOW, home);
    writeRunSidecar(contextRoot, m.slug, validSidecar(m.slug, { runnerPid: 60005, childPgid: 60006 }));
    mockLiveness([]); // both ESRCH

    const snap = buildAutomationsSnapshot(contextRoot, { now: NOW, home });
    expect(snap.hasOrphan).toBe(false);
    expect(snap.lines).toEqual([]);
  });

  it('treats a non-ESRCH probe error (e.g. EPERM) as alive, same as file-lock.ts', () => {
    const m = makeAutomation('eod-digest');
    approveAutomation(projectRoot, m, NOW, home);
    writeRunSidecar(contextRoot, m.slug, validSidecar(m.slug, { runnerPid: 60007, childPgid: 60008 }));
    vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === 60007) return true; // runner "alive" -> never orphaned, regardless of childPgid's probe
      const err = new Error('exists, not ours') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    }) as typeof process.kill);

    const snap = buildAutomationsSnapshot(contextRoot, { now: NOW, home });
    expect(snap.hasOrphan).toBe(false);
  });

  it('never calls process.kill on a corrupt sidecar — relies on readRunSidecar\'s own content validation', () => {
    const m = makeAutomation('eod-digest');
    approveAutomation(projectRoot, m, NOW, home);
    // Hand-write a sidecar with childPgid=1 — negated that is -1, which would
    // broadcast to every process the caller may signal. readRunSidecar must
    // reject this before this module ever sees a pid to probe.
    const path = sidecarPathFor(contextRoot, m.slug);
    mkdirSync(join(contextRoot, 'automations', 'cache'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        slug: m.slug, runnerPid: 1, childPid: 2, childPgid: 1,
        fireAt: NOW.toISOString(), startedAt: NOW.toISOString(), timeoutAt: NOW.toISOString(),
      }),
      'utf-8',
    );
    const killSpy = vi.spyOn(process, 'kill');

    const snap = buildAutomationsSnapshot(contextRoot, { now: NOW, home });
    expect(killSpy).not.toHaveBeenCalled();
    expect(snap.hasOrphan).toBe(false);
  });
});

// ─── recent runs / failures (last-24h window) ────────────────────────────────

describe('recent runs and failures', () => {
  it('renders an ok run within the window', () => {
    const m = makeAutomation('eod-digest');
    approveAutomation(projectRoot, m, NOW, home);
    recordRun(contextRoot, m.slug, fakeEvent({ status: 'ok', finishedAt: '2026-07-25T18:00:05.000Z', durationMs: 4000 }));

    const snap = buildAutomationsSnapshot(contextRoot, { now: NOW, home });
    expect(snap.hasFailure).toBe(false);
    // Routine success is ONE aggregate line — only failures earn per-run detail.
    expect(snap.lines).toEqual([
      `- 1 ok run(s) in the last 24h: ${m.slug} — \`dreamcontext automations list\``,
    ]);
  });

  it('renders a failed run within the window and sets hasFailure', () => {
    const m = makeAutomation('eod-digest');
    approveAutomation(projectRoot, m, NOW, home);
    recordRun(contextRoot, m.slug, fakeEvent({ status: 'failed', error: 'unparseable CLI output', finishedAt: '2026-07-25T19:00:00.000Z' }));

    const snap = buildAutomationsSnapshot(contextRoot, { now: NOW, home });
    expect(snap.hasFailure).toBe(true);
    expect(snap.lines).toEqual([`- ${m.slug}: FAILED — 1h ago — unparseable CLI output`]);
  });

  it('renders a timeout run within the window and sets hasFailure', () => {
    const m = makeAutomation('eod-digest');
    approveAutomation(projectRoot, m, NOW, home);
    recordRun(contextRoot, m.slug, fakeEvent({ status: 'timeout', error: null, finishedAt: '2026-07-25T19:30:00.000Z' }));

    const snap = buildAutomationsSnapshot(contextRoot, { now: NOW, home });
    expect(snap.hasFailure).toBe(true);
    expect(snap.lines).toEqual([`- ${m.slug}: TIMEOUT — 30m ago`]);
  });

  it('renders a deferred run WITHOUT setting hasFailure', () => {
    const m = makeAutomation('eod-digest');
    approveAutomation(projectRoot, m, NOW, home);
    recordRun(contextRoot, m.slug, fakeEvent({ status: 'deferred', error: null, finishedAt: '2026-07-25T19:59:45.000Z' }));

    const snap = buildAutomationsSnapshot(contextRoot, { now: NOW, home });
    expect(snap.hasFailure).toBe(false);
    expect(snap.lines).toEqual([`- ${m.slug}: DEFERRED — just now`]);
  });

  it('does not render a run older than the window', () => {
    const m = makeAutomation('eod-digest');
    approveAutomation(projectRoot, m, NOW, home);
    recordRun(contextRoot, m.slug, fakeEvent({ status: 'ok', finishedAt: '2026-07-24T18:00:00.000Z' })); // 26h before NOW

    expect(renderAutomationsSection(contextRoot, { now: NOW, home })).toEqual([]);
  });

  it('respects a custom windowHours', () => {
    const m = makeAutomation('eod-digest');
    approveAutomation(projectRoot, m, NOW, home);
    recordRun(contextRoot, m.slug, fakeEvent({ status: 'ok', finishedAt: '2026-07-25T18:00:00.000Z' })); // 2h before NOW

    expect(renderAutomationsSection(contextRoot, { now: NOW, home, windowHours: 1 })).toEqual([]);
    expect(renderAutomationsSection(contextRoot, { now: NOW, home, windowHours: 3 })).toHaveLength(1);
  });

  it('skips blocked and orphaned cache-history entries — they have their own dedicated channels', () => {
    const m = makeAutomation('eod-digest'); // left unapproved -> the approval channel fires instead
    recordRun(contextRoot, m.slug, fakeEvent({ status: 'blocked', error: 'not approved', finishedAt: '2026-07-25T19:00:00.000Z' }), { advanceWatermark: false });
    recordRun(contextRoot, m.slug, fakeEvent({ status: 'orphaned', error: 'previous run still alive', finishedAt: '2026-07-25T19:30:00.000Z' }), { advanceWatermark: false });

    const snap = buildAutomationsSnapshot(contextRoot, { now: NOW, home });
    // Exactly ONE line (the approval channel) — never a second, duplicate line
    // derived from the historical 'blocked'/'orphaned' cache-history entries.
    expect(snap.lines).toEqual([
      `- ${m.slug}: blocked pending approval (never-approved) — run \`dreamcontext automations approve ${m.slug}\``,
    ]);
  });
});

// ─── multiple automations — deterministic ordering ───────────────────────────

describe('multiple automations', () => {
  it('groups recent-run lines then blocked lines, each internally slug-ordered', () => {
    const bbb = makeAutomation('bbb-report');
    const aaa = makeAutomation('aaa-digest');
    approveAutomation(projectRoot, aaa, NOW, home);
    approveAutomation(projectRoot, bbb, NOW, home);
    recordRun(contextRoot, bbb.slug, fakeEvent({ status: 'ok', finishedAt: '2026-07-25T19:00:00.000Z' }));
    recordRun(contextRoot, aaa.slug, fakeEvent({ status: 'ok', finishedAt: '2026-07-25T19:30:00.000Z' }));
    const ccc = makeAutomation('ccc-research'); // never approved -> blocked

    const lines = renderAutomationsSection(contextRoot, { now: NOW, home });
    // Actionable state first; routine success collapses to ONE aggregate line
    // at the end (slug-ordered inside it, since listAutomations sorts by slug).
    expect(lines).toEqual([
      `- ${ccc.slug}: blocked pending approval (never-approved) — run \`dreamcontext automations approve ${ccc.slug}\``,
      `- 2 ok run(s) in the last 24h: ${aaa.slug}, ${bbb.slug} — \`dreamcontext automations list\``,
    ]);
  });
});

// ─── pending automation output (Change C) ────────────────────────────────────

describe('pending automation output', () => {
  it('renders ONE combined line naming the count and the slug when output postdates the boundary', () => {
    writeConsolidationBoundary('2026-07-25T12:00:00.000Z');
    writePendingOutput('eod-digest', '2026-07-25', '2026-07-25T18:00:00.000Z');

    const snap = buildAutomationsSnapshot(contextRoot, { now: NOW, home });
    expect(snap.hasPendingOutputs).toBe(true);
    expect(snap.lines).toEqual(['- 1 automation output(s) pending consolidation (eod-digest)']);
  });

  it('dedupes and alphabetically sorts slugs across multiple pending outputs', () => {
    writeConsolidationBoundary('2026-07-25T12:00:00.000Z');
    writePendingOutput('weekly-report', '2026-07-25', '2026-07-25T17:00:00.000Z');
    writePendingOutput('eod-digest', '2026-07-24', '2026-07-25T13:00:00.000Z');
    writePendingOutput('eod-digest', '2026-07-25', '2026-07-25T18:00:00.000Z'); // same slug, 2nd file

    const snap = buildAutomationsSnapshot(contextRoot, { now: NOW, home });
    expect(snap.lines).toEqual(['- 3 automation output(s) pending consolidation (eod-digest, weekly-report)']);
  });

  it('does NOT count an output that predates the boundary — ordinary already-consumed material', () => {
    writeConsolidationBoundary('2026-07-25T12:00:00.000Z');
    writePendingOutput('eod-digest', '2026-07-24', '2026-07-24T18:00:00.000Z'); // before boundary

    const snap = buildAutomationsSnapshot(contextRoot, { now: NOW, home });
    expect(snap.hasPendingOutputs).toBe(false);
    expect(snap.lines).toEqual([]);
  });

  it('treats a missing .sleep.json (no cycle has ever completed) as consume-nothing, not a crash', () => {
    writePendingOutput('eod-digest', '2026-07-25', '2026-07-25T18:00:00.000Z');
    // No writeConsolidationBoundary call at all — file does not exist.
    const snap = buildAutomationsSnapshot(contextRoot, { now: NOW, home });
    expect(snap.hasPendingOutputs).toBe(false);
    expect(snap.lines).toEqual([]);
  });

  it('treats a malformed .sleep.json as no boundary, never throws', () => {
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    writeFileSync(join(contextRoot, 'state', '.sleep.json'), '{ not valid json', 'utf-8');
    writePendingOutput('eod-digest', '2026-07-25', '2026-07-25T18:00:00.000Z');

    expect(() => buildAutomationsSnapshot(contextRoot, { now: NOW, home })).not.toThrow();
    const snap = buildAutomationsSnapshot(contextRoot, { now: NOW, home });
    expect(snap.hasPendingOutputs).toBe(false);
  });

  it('orders the pending-output line AFTER blocked and orphan lines', () => {
    writeConsolidationBoundary('2026-07-25T12:00:00.000Z');
    const blocked = makeAutomation('zzz-blocked'); // never approved -> blocked
    const orphaned = makeAutomation('yyy-orphaned');
    approveAutomation(projectRoot, orphaned, NOW, home);
    writeRunSidecar(contextRoot, orphaned.slug, validSidecar(orphaned.slug));
    writePendingOutput('eod-digest', '2026-07-25', '2026-07-25T18:00:00.000Z');
    // orphan signal requires: runner PID dead, child group alive.
    mockLiveness([60002]);

    const lines = renderAutomationsSection(contextRoot, { now: NOW, home });
    expect(lines).toEqual([
      `- ${blocked.slug}: blocked pending approval (never-approved) — run \`dreamcontext automations approve ${blocked.slug}\``,
      `- automation ${orphaned.slug} may have an orphaned run — run \`dreamcontext automations kill ${orphaned.slug}\``,
      '- 1 automation output(s) pending consolidation (eod-digest)',
    ]);
  });
});
