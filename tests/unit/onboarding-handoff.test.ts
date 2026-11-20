import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  canStartClaude,
  entryStage,
  gitTrackState,
  handoffAction,
  launcherOnboardingMode,
  remainingSetupCount,
  onboardingSteps,
  BAR_CHECKS,
} from '../../dashboard/src/pages/onboarding/handoffPlan.js';
import { createAgentGate, gateSteps } from '../../dashboard/src/hooks/useOnboarding.js';
import type { ReadinessCheck, ReadinessReport } from '../../dashboard/src/lib/onboardingTypes.js';

/**
 * The onboarding flow's pure decisions: where the hand-off sends the start request, when
 * "Start with Claude" may be offered, and what the Launcher shows.
 */

function check(id: ReadinessCheck['id'], status: ReadinessCheck['status'], extra: Partial<ReadinessCheck> = {}): ReadinessCheck {
  return {
    id,
    tier: extra.tier ?? 'required',
    scopes: extra.scopes ?? ['machine'],
    status,
    dependsOn: [],
    fix: null,
    ...extra,
  };
}

function report(checks: ReadinessCheck[], extra: Partial<ReadinessReport> = {}): ReadinessReport {
  return {
    version: 1,
    platform: 'darwin',
    arch: 'arm64',
    surface: 'desktop',
    generatedAt: 0,
    ready: true,
    online: true,
    plan: [],
    next: null,
    activeFixes: [],
    checks,
    ...extra,
  };
}

const READY = report([
  check('claude', 'ok', { scopes: ['machine', 'agent'] }),
  check('claude-auth', 'ok', { scopes: ['machine', 'agent'] }),
  check('terminal', 'missing', { tier: 'optional', scopes: ['agent'] }),
  check('git', 'ok', { tier: 'recommended' }),
]);
const CHAT = { enabled: true, chatView: true };
const signedIn = () => READY;
const signedOut = () => report([
  check('claude', 'ok', { scopes: ['machine', 'agent'] }),
  check('claude-auth', 'missing', { scopes: ['machine', 'agent'] }),
]);

describe('handoffAction', () => {
  it('sends the start intent as an event only to an already-open window', () => {
    expect(handoffAction('focused')).toBe('emit-start-intent');
    expect(handoffAction('created')).toBe('done');
    expect(handoffAction('browser')).toBe('done');
  });
});

describe('canStartClaude', () => {
  it('offers Start with Claude when the agent surface would take the request', () => {
    expect(canStartClaude(READY, CHAT)).toBe(true);
  });

  it('counts an unverifiable sign-in as fine and a Claude found off PATH as present', () => {
    const r = report([
      check('claude', 'needs-action', { reason: 'not-on-path' }),
      check('claude-auth', 'unknown'),
    ]);
    expect(canStartClaude(r, CHAT)).toBe(true);
  });

  it('refuses when signed out, when Claude is missing, or before the data is known', () => {
    expect(canStartClaude(report([check('claude', 'ok'), check('claude-auth', 'missing', { reason: 'signed-out' })]), CHAT)).toBe(false);
    expect(canStartClaude(report([check('claude', 'missing'), check('claude-auth', 'blocked')]), CHAT)).toBe(false);
    expect(canStartClaude(undefined, CHAT)).toBe(false);
    expect(canStartClaude(READY, undefined)).toBe(false);
  });

  it('asks the same question as the agent surface: switched off, browser tab, or terminal screen without the terminal', () => {
    expect(canStartClaude(READY, { enabled: false, chatView: true })).toBe(false);
    expect(canStartClaude({ ...READY, surface: 'browser' }, CHAT)).toBe(false);
    expect(canStartClaude(READY, { enabled: true, chatView: false })).toBe(false);
    const withTerminal = report([...READY.checks.filter((c) => c.id !== 'terminal'), check('terminal', 'ok', { tier: 'optional' })]);
    expect(canStartClaude(withTerminal, { enabled: true, chatView: false })).toBe(true);
    expect(canStartClaude({ ...withTerminal, platform: 'win32' }, { enabled: true, chatView: false })).toBe(false);
  });
});

describe('the first-run flow (plan ilk-acilis C1, C2, C5)', () => {
  it('first run is welcome then Open a project; Add Project is the project screen alone', () => {
    expect(onboardingSteps('first-run')).toEqual(['welcome', 'project']);
    expect(onboardingSteps('new-project')).toEqual(['project']);
    expect(onboardingSteps('setup')).toEqual(['machine']);
  });

  it('the bar counts what a first chat needs and nothing else', () => {
    expect([...BAR_CHECKS].sort()).toEqual(['claude', 'claude-auth', 'cli', 'node']);
    expect(BAR_CHECKS).not.toContain('git');
  });

  it('the Claude gate is install (or PATH) then sign-in, never Git', () => {
    const missing = report([check('claude', 'missing'), check('claude-auth', 'missing'), check('git', 'missing')], { ready: false });
    expect(gateSteps(missing, 'claude')).toEqual(['claude-install', 'claude-signin']);
    const offPath = report([check('claude', 'needs-action', { reason: 'not-on-path' } as Partial<ReadinessCheck>), check('claude-auth', 'ok')], { ready: false });
    expect(gateSteps(offPath, 'claude')).toEqual(['claude-path']);
    expect(gateSteps(READY, 'claude')).toEqual([]);
    for (const agent of ['claude', 'codex', 'antigravity'] as const) {
      expect(gateSteps(missing, agent)).not.toContain('git-install');
    }
    expect(gateSteps(missing, 'antigravity')).toEqual(['antigravity-signin']);
  });

  it('the gate never reads a missing report as "signed out": it waits for the first answer', async () => {
    // gateSteps(undefined) counts every check missing, so the gate must not run on no report.
    expect(gateSteps(undefined, 'claude')).toContain('claude-signin');
    let report: ReadinessReport | undefined;
    const started: string[] = [];
    const gate = createAgentGate({
      report: () => report, start: async (fix) => { started.push(fix); return { fix, runId: 'r', phase: 'done', status: null }; },
      pick: async () => undefined, set: () => undefined, tickMs: 5,
    });
    const done = gate.run('claude');
    await new Promise((r) => setTimeout(r, 20));
    report = signedIn();
    expect(await done).toBe(true);
    expect(started).toEqual([]);
  });

  it('Cancel while waiting for the first answer starts nothing and writes nothing more', async () => {
    let report: ReadinessReport | undefined;
    const started: string[] = [];
    const states: string[] = [];
    const gate = createAgentGate({
      report: () => report, start: async (fix) => { started.push(fix); return { fix, runId: 'r', phase: 'done', status: null }; },
      pick: async () => undefined, set: (s) => states.push(s.kind), tickMs: 5,
    });
    const done = gate.run('claude');
    await new Promise((r) => setTimeout(r, 15));
    gate.reset();
    report = signedOut();
    expect(await done).toBe(false);
    expect(started).toEqual([]);
    expect(states.at(-1)).toBe('idle');
  });

  it('Open again (Cancel then run) starts a new sign-in after the old one settles; the old one writes nothing', async () => {
    const report = signedOut();
    const releases: Array<() => void> = [];
    const started: string[] = [];
    const states: string[] = [];
    const gate = createAgentGate({
      report: () => report,
      start: (fix) => new Promise((resolve) => {
        started.push(fix);
        const n = started.length;
        // The first run ends as the cancel lands (not finished); the second signs in.
        releases.push(() => resolve({ fix, runId: `r${n}`, phase: n === 1 ? 'error' : 'done', status: null }));
      }),
      pick: async () => undefined, set: (s) => states.push(s.kind),
    });
    const first = gate.run('claude');
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(['claude-signin']);
    expect(await gate.run('claude')).toBe(false); // a double click is not a restart
    gate.reset();
    const second = gate.run('claude');
    releases[0]();
    expect(await first).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(['claude-signin', 'claude-signin']);
    expect(states).not.toContain('not-finished');
    releases[1]();
    expect(await second).toBe(true);
    expect(states.at(-1)).toBe('idle');
  });
});

describe('Launcher decisions', () => {
  const notReady = report([check('claude', 'missing'), check('git', 'missing', { tier: 'recommended' }), check('terminal', 'missing', { tier: 'optional', scopes: ['agent'] })], { ready: false });

  it('takes over at zero projects, shows the bar when not ready, otherwise nothing', () => {
    expect(launcherOnboardingMode(0, READY)).toBe('takeover');
    expect(launcherOnboardingMode(0, undefined)).toBe('takeover');
    expect(launcherOnboardingMode(3, notReady)).toBe('bar');
    expect(launcherOnboardingMode(3, READY)).toBe('none');
    expect(launcherOnboardingMode(3, undefined)).toBe('none');
  });

  // Plan ilk-acilis C5: the bar counts only what blocks a first chat (Claude, its sign-in, the
  // CLI, Node); Git is no longer a setup step, it comes with the first clone.
  it('counts only the checks a first chat needs, never Git, optional or agent-only ones', () => {
    expect(remainingSetupCount(notReady)).toBe(1);
    const signedOut = report([check('claude', 'ok'), check('claude-auth', 'missing'), check('cli', 'missing'), check('git', 'missing', { tier: 'recommended' })], { ready: false });
    expect(remainingSetupCount(signedOut)).toBe(2);
    expect(remainingSetupCount(report([check('git', 'missing', { tier: 'recommended' })], { ready: false }))).toBe(0);
    expect(remainingSetupCount(READY)).toBe(0);
    expect(remainingSetupCount(undefined)).toBe(0);
  });

  it('never counts Codex in "N left": it is optional (owner 2026-11-03)', () => {
    const codexMissing = report([
      ...READY.checks,
      check('codex', 'missing', { tier: 'optional', scopes: ['machine'] }),
      check('codex-auth', 'blocked', { tier: 'optional', scopes: ['machine'] }),
    ]);
    expect(remainingSetupCount(codexMissing)).toBe(0);
  });

  it('opens at the project step when ready or when the machine cannot be read', () => {
    expect(entryStage(READY, false)).toBe('project');
    expect(entryStage(notReady, false)).toBe('machine');
    expect(entryStage(undefined, false)).toBe('machine');
    expect(entryStage(undefined, true)).toBe('project');
  });
});

describe('gitTrackState', () => {
  it('maps the folder and the Git check onto the Track changes choice', () => {
    expect(gitTrackState(READY, true)).toBe('already-repo');
    expect(gitTrackState(READY, false)).toBe('available');
    const installing = report([check('git', 'missing', { tier: 'recommended' })], { activeFixes: ['git-install'] });
    expect(gitTrackState(installing, false)).toBe('pending');
    expect(gitTrackState(report([check('git', 'missing', { tier: 'recommended' })]), false)).toBe('need-install');
    expect(gitTrackState(undefined, undefined)).toBe('available');
  });
});
