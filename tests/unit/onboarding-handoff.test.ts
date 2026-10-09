import { describe, it, expect } from 'vitest';
import {
  canStartClaude,
  entryStage,
  gitTrackState,
  handoffAction,
  launcherOnboardingMode,
  remainingSetupCount,
} from '../../dashboard/src/pages/onboarding/handoffPlan.js';
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

describe('Launcher decisions', () => {
  const notReady = report([check('claude', 'missing'), check('git', 'missing', { tier: 'recommended' }), check('terminal', 'missing', { tier: 'optional', scopes: ['agent'] })], { ready: false });

  it('takes over at zero projects, shows the bar when not ready, otherwise nothing', () => {
    expect(launcherOnboardingMode(0, READY)).toBe('takeover');
    expect(launcherOnboardingMode(0, undefined)).toBe('takeover');
    expect(launcherOnboardingMode(3, notReady)).toBe('bar');
    expect(launcherOnboardingMode(3, READY)).toBe('none');
    expect(launcherOnboardingMode(3, undefined)).toBe('none');
  });

  it('counts required and recommended machine checks still to do, never optional or agent-only ones', () => {
    expect(remainingSetupCount(notReady)).toBe(2);
    expect(remainingSetupCount(READY)).toBe(0);
    expect(remainingSetupCount(undefined)).toBe(0);
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
