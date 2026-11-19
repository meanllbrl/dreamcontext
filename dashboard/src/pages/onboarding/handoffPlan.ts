import { agentSurfaceSettings } from '../../lib/agentSettings';
import { agentCanSpawn } from '../../lib/agentReady';
import type { AgentSettingsLite, ReadinessCheck, ReadinessReport } from '../../lib/onboardingTypes';

/**
 * The onboarding flow's decisions, kept pure (no React, no window API) so they are pinned by
 * `tests/unit/onboarding-handoff.test.ts` rather than by clicking through the app.
 */

export type OnboardingStage = 'welcome' | 'machine' | 'project';

/** Who the flow is for (see `Onboarding`). */
export type OnboardingPurpose = 'first-run' | 'new-project' | 'setup';

/**
 * The screens each purpose walks (plan ilk-acilis C1): the app's first project is Welcome then
 * Project, then the landing; "+ Add Project" is Project then the landing; the "Finish setting up"
 * bar keeps the Mac checklist. No purpose ever shows an "is ready" screen or the checklist on
 * the way to a first project.
 */
export function onboardingSteps(purpose: OnboardingPurpose): OnboardingStage[] {
  if (purpose === 'first-run') return ['welcome', 'project'];
  if (purpose === 'new-project') return ['project'];
  return ['machine'];
}

/** What `openVaultWindow` answered. */
export type OpenWindowResult = 'focused' | 'created' | 'browser';

/**
 * After opening the project window with a `start` intent (`super-landing` from onboarding):
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
    chatView: agentSurfaceSettings(settings).chatView,
    embeddedTerminal: terminal?.status === 'ok' && report.platform !== 'win32',
    enabled: agentSurfaceSettings(settings).enabled,
  });
}

/** Where the flow opens: straight to the project when this machine is ready (or cannot be read). */
export function entryStage(report: ReadinessReport | undefined, readinessFailed: boolean): OnboardingStage {
  if (readinessFailed) return 'project';
  return report?.ready ? 'project' : 'machine';
}

/**
 * The checks the "Finish setting up" bar counts (C5): the ones a first chat needs. The checks the
 * first run deliberately skips (`git`, `gh`, `github`, `codex`, `terminal`: Git comes with a
 * clone, the rest from Settings) never bring the bar back.
 */
export const BAR_CHECKS: readonly ReadinessCheck['id'][] = ['claude', 'claude-auth', 'cli', 'node'];

/** Bar checks still to do: those of {@link BAR_CHECKS} that are not ok (or unknown). */
export function remainingSetupCount(report: ReadinessReport | undefined): number {
  if (!report) return 0;
  return report.checks.filter(
    (c) => BAR_CHECKS.includes(c.id) && c.status !== 'ok' && c.status !== 'unknown',
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
  if (remainingSetupCount(report) > 0) return 'bar';
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

// ─── Small text helpers of the project and clone screens ─────────────────────

/** `~/…` for a path inside home, else the path. */
export function homeShort(path: string, home: string | undefined): string {
  if (home && (path === home || path.startsWith(home.replace(/\/+$/, '') + '/'))) return '~' + path.slice(home.replace(/\/+$/, '').length);
  return path;
}

/** `owner/name` from a pasted github.com link, else null. */
export function repoFromLink(text: string): string | null {
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(text.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** "146 MB", "2.3 GB": GitHub's size (KB) or bytes, decimal units as Finder shows them. */
export function sizeLabel(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
