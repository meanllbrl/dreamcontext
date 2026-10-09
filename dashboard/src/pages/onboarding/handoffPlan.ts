import { agentCanSpawn } from '../../lib/agentReady';
import type { AgentSettingsLite, ReadinessCheck, ReadinessReport } from '../../lib/onboardingTypes';

/**
 * The onboarding flow's decisions, kept pure (no React, no window API) so they are pinned by
 * `tests/unit/onboarding-handoff.test.ts` rather than by clicking through the app.
 */

export type OnboardingStage = 'machine' | 'project' | 'handoff';

/** What `openVaultWindow` answered. */
export type OpenWindowResult = 'focused' | 'created' | 'browser';

/**
 * After opening the project window with `start=initializer`:
 * - `created` / `browser`: the new window read the intent off its URL, nothing more to do;
 * - `focused`: the window was ALREADY open and never sees a URL param, so the intent has to be
 *   sent to it as an event instead.
 */
export function handoffAction(result: OpenWindowResult): 'done' | 'emit-start-intent' {
  return result === 'focused' ? 'emit-start-intent' : 'done';
}

function check(report: ReadinessReport | undefined, id: ReadinessCheck['id']): ReadinessCheck | undefined {
  return report?.checks.find((c) => c.id === id);
}

/**
 * May the hand-off offer "Start with Claude"? Exactly the question the project window's agent
 * surface asks before it takes the request (`agentCanSpawn`), plus the sign-in: a surface that
 * spawns Claude signed out would fail at its first turn. `unknown` sign-in counts as fine, as it
 * does everywhere else (a Bedrock or API-key setup cannot be probed).
 */
export function canStartClaude(report: ReadinessReport | undefined, settings: AgentSettingsLite | undefined): boolean {
  if (!report || !settings) return false;
  const claude = check(report, 'claude');
  const auth = check(report, 'claude-auth');
  const terminal = check(report, 'terminal');
  const claudeCli = claude?.status === 'ok' || (claude?.status === 'needs-action' && claude.reason === 'not-on-path');
  const signedIn = auth?.status === 'ok' || auth?.status === 'unknown';
  return signedIn && agentCanSpawn({
    desktop: report.surface === 'desktop',
    claudeCli,
    chatView: settings.chatView,
    embeddedTerminal: terminal?.status === 'ok' && report.platform !== 'win32',
    enabled: settings.enabled,
  });
}

/** Where the flow opens: straight to the project when this machine is ready (or cannot be read). */
export function entryStage(report: ReadinessReport | undefined, readinessFailed: boolean): OnboardingStage {
  if (readinessFailed) return 'project';
  return report?.ready ? 'project' : 'machine';
}

/** Machine-scope checks still to do: required and recommended ones that are not ok. */
export function remainingSetupCount(report: ReadinessReport | undefined): number {
  if (!report) return 0;
  return report.checks.filter(
    (c) => c.scopes.includes('machine') && c.tier !== 'optional' && c.status !== 'ok' && c.status !== 'unknown',
  ).length;
}

/**
 * What the Launcher shows: the full takeover when there are no projects yet, a slim "Finish
 * setting up" bar when projects exist but required pieces are missing, otherwise nothing.
 */
export function launcherOnboardingMode(
  vaultCount: number,
  report: ReadinessReport | undefined,
): 'takeover' | 'bar' | 'none' {
  if (vaultCount === 0) return 'takeover';
  if (report && !report.ready) return 'bar';
  return 'none';
}

/** The "Track changes with Git" choice for a folder. */
export type GitTrackState = 'available' | 'pending' | 'need-install' | 'already-repo';

/**
 * - `already-repo`: nothing to do;
 * - `available`: Git works, offer it checked;
 * - `pending`: the Git install is running in the background, keep it checked (the server runs
 *   `git init` when the install finishes);
 * - `need-install`: unchecked and disabled.
 * An unread report is treated as `available`: the server answers `skipped: 'no-git'` harmlessly.
 */
export function gitTrackState(report: ReadinessReport | undefined, isGitRepo: boolean | undefined): GitTrackState {
  if (isGitRepo) return 'already-repo';
  if (!report) return 'available';
  if (check(report, 'git')?.status === 'ok') return 'available';
  if (report.activeFixes.includes('git-install')) return 'pending';
  return 'need-install';
}
