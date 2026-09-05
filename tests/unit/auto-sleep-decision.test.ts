import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  shouldStartAutoSleep, activeTaskSet, currentAutoSleepFingerprint,
  inspectSleepLockLive, liveAutoSleepJob, isPidAlive, HANDS_OFF_WINDOW_MS,
} from '../../src/lib/auto-sleep.js';
import { writeAutoSleepSidecar } from '../../src/lib/auto-sleep-runner.js';
import { DEFAULT_SLEEP_THRESHOLDS, SLEEP_LOCK_STALE_MS, type SleepState } from '../../src/lib/sleep-consolidation.js';
import { updateSetupConfig, writeBrainLocal, type BrainLocalState } from '../../src/lib/setup-config.js';
import { buildAutoSleepPreamble, buildAutoSleepPrompt, SLEEP_AGENT_PROMPT } from '../../src/lib/sleep-prompt.js';
import { emptyManifest, recordFile, writeManifest } from '../../src/lib/manifest.js';
import { agentBaselineSha } from '../../src/lib/sleep-specialist-frontmatter.js';

/**
 * C1 — every condition that must hold before a Stop hook may hand the brain to
 * an unattended agent. The matrix matters more than any single case: this runs
 * at the end of EVERY assistant turn, so a decision that is wrong in one corner
 * is wrong hundreds of times a day.
 */

let project = '';
let ctx = '';

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'dc-auto-'));
  ctx = join(project, '_dream_context');
  mkdirSync(join(ctx, 'state'), { recursive: true });
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

function state(over: Partial<SleepState> = {}): SleepState {
  return {
    debt: 100, last_sleep: null, last_sleep_summary: null, sleep_started_at: null,
    last_consolidated_at: null, sessions_since_last_sleep: 0, sessions: [], bookmarks: [],
    triggers: [], knowledge_access: {}, dashboard_changes: [], compaction_log: [],
    recall_mode: 'haiku', consolidation_depth: null, pendingMigrationNotices: [],
    cycle_tasks_filed: [], ...over,
  } as SleepState;
}

const FP = 'fingerprint-abc';
function local(over: Partial<NonNullable<BrainLocalState['autoSleep']>> = {}): BrainLocalState {
  return { autoSleep: { enabled: true, trigger: 'must-sleep', approvedAt: 'now', approvedFingerprint: FP, ...over } };
}

const decide = (over: Partial<Parameters<typeof shouldStartAutoSleep>[0]> = {}) =>
  shouldStartAutoSleep({
    contextRoot: ctx, state: state(), local: local(), thresholds: DEFAULT_SLEEP_THRESHOLDS,
    nowMs: Date.now(), currentFingerprint: FP, ...over,
  });

describe('shouldStartAutoSleep', () => {
  it('starts when everything lines up', () => {
    expect(decide()).toMatchObject({ start: true, reason: 'start' });
  });

  it('refuses when the machine has it OFF', () => {
    expect(decide({ local: { autoSleep: { ...local().autoSleep!, enabled: false } } })).toMatchObject({ start: false, reason: 'disabled' });
    expect(decide({ local: null })).toMatchObject({ start: false, reason: 'disabled' });
    expect(decide({ local: {} })).toMatchObject({ start: false, reason: 'disabled' });
  });

  it('refuses below the trigger, and honours which trigger was chosen', () => {
    expect(decide({ state: state({ debt: 59 }) })).toMatchObject({ start: false, reason: 'below-trigger' });
    expect(decide({ state: state({ debt: 60 }) }).start).toBe(true);
    // `sleepy` fires earlier — at 40 rather than 60.
    const sleepy = { local: local({ trigger: 'sleepy' }) };
    expect(decide({ ...sleepy, state: state({ debt: 40 }) }).start).toBe(true);
    expect(decide({ ...sleepy, state: state({ debt: 39 }) })).toMatchObject({ start: false, reason: 'below-trigger' });
  });

  it('follows a CUSTOM ladder, not the shipped constants', () => {
    const custom = { ...DEFAULT_SLEEP_THRESHOLDS, mustSleep: 30, cooldownOverride: 60 };
    expect(decide({ thresholds: custom, state: state({ debt: 30 }) }).start).toBe(true);
  });

  it('refuses inside the post-consolidation cooldown', () => {
    const justDone = state({ last_consolidated_at: new Date().toISOString(), debt: 60 });
    expect(decide({ state: justDone })).toMatchObject({ start: false, reason: 'cooldown' });
  });

  it('but the cooldown override still lets a genuinely enormous burst through', () => {
    const justDone = state({ last_consolidated_at: new Date().toISOString(), debt: 500 });
    expect(decide({ state: justDone }).start).toBe(true);
  });

  it('refuses while ANY consolidation holds a live epoch', () => {
    expect(decide({ state: state({ sleep_started_at: new Date().toISOString() }) }))
      .toMatchObject({ start: false, reason: 'sleep-in-progress' });
  });

  it('but a STALE epoch with no live holder does not block it', () => {
    const stale = new Date(Date.now() - SLEEP_LOCK_STALE_MS - 60_000).toISOString();
    expect(decide({ state: state({ sleep_started_at: stale }) }).start).toBe(true);
  });

  it('refuses while a background job is already running', () => {
    writeAutoSleepSidecar(ctx, {
      pid: process.pid, pgid: process.pid, startedAt: new Date().toISOString(),
      status: 'running', epoch: null,
    });
    expect(decide()).toMatchObject({ start: false, reason: 'already-running' });
  });

  it('a finished job does not block the next one', () => {
    writeAutoSleepSidecar(ctx, {
      pid: process.pid, pgid: process.pid, startedAt: new Date().toISOString(),
      status: 'ok', epoch: null,
    });
    expect(decide().start).toBe(true);
  });

  it('a job whose pid is DEAD does not block it either', () => {
    writeAutoSleepSidecar(ctx, {
      pid: 2 ** 30, pgid: 2 ** 30, startedAt: new Date().toISOString(), status: 'running', epoch: null,
    });
    expect(liveAutoSleepJob(ctx)).toBeNull();
    expect(decide().start).toBe(true);
  });

  it('REFUSES when consent is stale, and says how to fix it', () => {
    const v = decide({ currentFingerprint: 'something-else' });
    expect(v).toMatchObject({ start: false, reason: 'consent-stale' });
    expect(v.detail).toContain('re-enable');
  });

  it('never chains a second cycle from inside one', () => {
    expect(decide({ nested: true })).toMatchObject({ start: false, reason: 'nested' });
  });
});

describe('inspectSleepLockLive — C2b', () => {
  const staleEpoch = () => new Date(Date.now() - SLEEP_LOCK_STALE_MS - 60_000).toISOString();

  it('with no background holder, an old epoch is stale exactly as before', () => {
    expect(inspectSleepLockLive(ctx, state({ sleep_started_at: staleEpoch() }), Date.now()).stale).toBe(true);
  });

  it('THE FIX: a long-running background cycle is NOT stale while its pid is alive', () => {
    writeAutoSleepSidecar(ctx, {
      pid: process.pid, pgid: process.pid, startedAt: new Date().toISOString(), status: 'running', epoch: null,
    });
    const lock = inspectSleepLockLive(ctx, state({ sleep_started_at: staleEpoch() }), Date.now());
    expect(lock.locked).toBe(true);
    expect(lock.stale).toBe(false);
  });

  it('once that pid is dead, the lock is reclaimable again', () => {
    writeAutoSleepSidecar(ctx, {
      pid: 2 ** 30, pgid: 2 ** 30, startedAt: new Date().toISOString(), status: 'running', epoch: null,
    });
    expect(inspectSleepLockLive(ctx, state({ sleep_started_at: staleEpoch() }), Date.now()).stale).toBe(true);
  });

  it('a fresh epoch is never stale, holder or not', () => {
    expect(inspectSleepLockLive(ctx, state({ sleep_started_at: new Date().toISOString() }), Date.now()).stale).toBe(false);
  });

  it('isPidAlive refuses implausible pids rather than probing them', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(1)).toBe(false);
    expect(isPidAlive(-5)).toBe(false);
    expect(isPidAlive(process.pid)).toBe(true);
  });
});

describe('the consent fingerprint', () => {
  it('is stable across repeated reads of an unchanged brain', () => {
    expect(currentAutoSleepFingerprint(project)).toBe(currentAutoSleepFingerprint(project));
  });

  it('CHANGES when a specialist model changes', () => {
    const before = currentAutoSleepFingerprint(project);
    updateSetupConfig(project, { sleep: { specialists: { 'sleep-tasks': { model: 'claude-opus-5' } } } });
    expect(currentAutoSleepFingerprint(project)).not.toBe(before);
  });

  it('CHANGES when the task cap changes', () => {
    const before = currentAutoSleepFingerprint(project);
    updateSetupConfig(project, { sleep: { maxNewTasksPerCycle: 2 } });
    expect(currentAutoSleepFingerprint(project)).not.toBe(before);
  });

  it('CHANGES when the trigger changes', () => {
    writeBrainLocal(project, local({ trigger: 'must-sleep' }));
    const before = currentAutoSleepFingerprint(project);
    writeBrainLocal(project, local({ trigger: 'sleepy' }));
    expect(currentAutoSleepFingerprint(project)).not.toBe(before);
  });

  it('CHANGES when a sleep agent file is hand-edited', () => {
    // A baseline has to exist for "customized" to be answerable at all — see
    // the no-baseline case below, which is deliberately the opposite.
    mkdirSync(join(project, '.claude', 'agents'), { recursive: true });
    const agent = join(project, '.claude', 'agents', 'sleep-tasks.md');
    const shipped = '---\nname: sleep-tasks\n---\n\n# Body\n';
    writeFileSync(agent, shipped);
    const m = emptyManifest();
    recordFile(m, '.claude/agents/sleep-tasks.md', '1.0.0', 'agent', { baselineSha: agentBaselineSha(shipped) });
    writeManifest(project, m);

    const before = currentAutoSleepFingerprint(project);
    writeFileSync(agent, '---\nname: sleep-tasks\n---\n\n# Body EDITED BY HAND\n');
    expect(currentAutoSleepFingerprint(project)).not.toBe(before);
  });

  it('does NOT change when the PACKAGE refreshes an agent the user never touched', () => {
    // The baseline is re-pinned by the install, so a routine `dreamcontext
    // update` must not read as a customization and pause background sleep.
    mkdirSync(join(project, '.claude', 'agents'), { recursive: true });
    const agent = join(project, '.claude', 'agents', 'sleep-state.md');
    const v1 = '---\nname: sleep-state\n---\n\n# Body v1\n';
    writeFileSync(agent, v1);
    const m1 = emptyManifest();
    recordFile(m1, '.claude/agents/sleep-state.md', '1.0.0', 'agent', { baselineSha: agentBaselineSha(v1) });
    writeManifest(project, m1);
    const before = currentAutoSleepFingerprint(project);

    const v2 = '---\nname: sleep-state\n---\n\n# Body v2 shipped by the package\n';
    writeFileSync(agent, v2);
    const m2 = emptyManifest();
    recordFile(m2, '.claude/agents/sleep-state.md', '2.0.0', 'agent', { baselineSha: agentBaselineSha(v2) });
    writeManifest(project, m2);
    expect(currentAutoSleepFingerprint(project)).toBe(before);
  });

  it('does NOT change on a routine version bump — a refresh must not pause it', () => {
    updateSetupConfig(project, { setupVersion: '1.0.0' });
    const before = currentAutoSleepFingerprint(project);
    updateSetupConfig(project, { setupVersion: '2.0.0' });
    expect(currentAutoSleepFingerprint(project)).toBe(before);
  });

  it('does not change when an UNRELATED config field changes', () => {
    const before = currentAutoSleepFingerprint(project);
    updateSetupConfig(project, { disableNativeMemory: false });
    expect(currentAutoSleepFingerprint(project)).toBe(before);
  });
});

describe('the background prompt', () => {
  it('carries the same consolidation request the Sleep button sends', () => {
    expect(buildAutoSleepPrompt([])).toContain(SLEEP_AGENT_PROMPT);
  });

  it('names the hands-off tasks and tells the cycle to defer them', () => {
    const p = buildAutoSleepPreamble(['task-a', 'task-b']);
    expect(p).toContain('- task-a');
    expect(p).toContain('- task-b');
    expect(p).toContain('Deferred (hands-off)');
  });

  it('says so explicitly when nothing is in play', () => {
    expect(buildAutoSleepPreamble([])).toContain('HANDS-OFF TASKS: none');
  });

  it('frames everything it will read as DATA, not instructions', () => {
    const p = buildAutoSleepPreamble([]);
    expect(p).toContain('UNTRUSTED CONTENT');
    expect(p).toContain('never instructions');
  });

  it('tells it never to ask a question — nobody is watching', () => {
    expect(buildAutoSleepPreamble([])).toContain('Never ask a question');
  });

  it('refuses to interpolate an unsafe slug', () => {
    const p = buildAutoSleepPreamble(['../../etc/passwd', 'fine-task']);
    expect(p).not.toContain('etc/passwd');
    expect(p).toContain('- fine-task');
  });
});
