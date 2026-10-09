/**
 * The dashboard's copy of the machine-readiness model's ids and API shapes.
 *
 * The source of truth is `src/lib/onboarding/types.ts`; the dashboard is a separate bundle
 * and cannot import it, so the ids are MIRRORED here and `tests/unit/onboarding-mirror.test.ts`
 * fails the moment the two disagree. The response types follow the HTTP contract of
 * `GET /api/onboarding/readiness`, `POST /api/onboarding/fix` and `/api/agent/install/status`.
 */

export const CHECK_IDS = ['network', 'node', 'npm', 'cli', 'claude', 'claude-auth', 'git', 'github', 'gh', 'terminal'] as const;
export type CheckId = typeof CHECK_IDS[number];

export const FIX_IDS = [
  'node-shell-path', 'cli-install', 'cli-shell-path', 'claude-install', 'claude-path', 'claude-signin',
  'git-install', 'gh-install', 'github-signin', 'gh-signin', 'pty-install',
] as const;
export type FixId = typeof FIX_IDS[number];

/** Runtime list of the reason codes, so the mirror test can compare it with the lib's copy keys. */
export const REASON_CODES = [
  'not-installed', 'too-old', 'not-on-path', 'signed-out', 'unverifiable', 'offline', 'needs-dialog',
  'no-npm', 'desktop-only', 'platform', 'symlink', 'unsafe-path',
] as const;
export type ReasonCode = typeof REASON_CODES[number];

export type CheckTier = 'required' | 'recommended' | 'optional';
export type CheckScope = 'machine' | 'agent';
export type CheckStatus = 'ok' | 'missing' | 'needs-action' | 'blocked' | 'unknown' | 'unsupported';
export type FixKind = 'auto' | 'browser' | 'device-code' | 'system-dialog' | 'manual';
export type Surface = 'desktop' | 'browser' | 'cli';

export interface FixPlan {
  id: FixId;
  kind: FixKind;
  /** Can this surface run it? False in a plain browser tab and for manual fixes. */
  runnable: boolean;
  /** The command a person can run instead, when there is one. */
  manual?: string;
  editsShellProfile: boolean;
}

export interface ReadinessCheck {
  id: CheckId;
  tier: CheckTier;
  scopes: CheckScope[];
  status: CheckStatus;
  reason?: ReasonCode;
  dependsOn: CheckId[];
  blockedBy?: CheckId[];
  version?: string;
  /** Email or login of a signed-in account. Never a token. */
  account?: string;
  fix: FixPlan | null;
}

export interface ReadinessReport {
  version: 1;
  platform: string;
  arch: string;
  surface: Surface;
  generatedAt: number;
  /** Every required check is `ok` or `unknown`. */
  ready: boolean;
  online: boolean;
  /** Fixes to run, in order. Recomputed by the server after every fix. */
  plan: FixId[];
  /** The first check that needs the person rather than an automatic fix. */
  next: CheckId | null;
  activeFixes: FixId[];
  checks: ReadinessCheck[];
}

/** `POST /api/onboarding/fix` → 200. */
export interface FixStartResponse {
  ok: true;
  runId: string;
}

/** Why a fix ended badly (`FixOutcome['reason']` on the server). */
export type FixOutcomeReason = 'offline' | 'permission' | 'checksum' | 'timeout' | 'canceled' | 'refused' | 'failed';

export interface DeviceCode {
  userCode: string;
  verificationUri: string;
  /** Epoch ms. */
  expiresAt: number;
}

export type AwaitingKind = 'browser' | 'system-dialog';

/** `GET /api/agent/install/status?id=` — the one status endpoint for every install and fix run. */
export interface InstallRunStatus {
  state: 'running' | 'done' | 'error' | 'unknown';
  target?: string;
  output: string;
  outcome?: FixOutcomeReason;
  awaiting?: AwaitingKind | null;
  progress?: { received: number; total: number | null };
  deviceCode?: DeviceCode;
}

/** `POST /api/onboarding/fix/cancel` → 200. */
export interface FixCancelResponse {
  ok: true;
  canceled: boolean;
}

/** The machine-readable `error` slugs `POST /api/onboarding/fix` answers with. */
export type FixErrorCode = 'bad_fix' | 'forbidden' | 'blocked' | 'in_progress' | 'manual_only';

/** `GET /api/launcher/agent-settings`: only the fields onboarding reads. */
export interface AgentSettingsLite {
  enabled: boolean;
  chatView: boolean;
}

/** The checks shown for a scope, in report order. */
export function checksForScope(report: ReadinessReport, scope: CheckScope): ReadinessCheck[] {
  return report.checks.filter((c) => c.scopes.includes(scope));
}

/** True while a run waits on the person, but must not hold up the rest of the plan. */
export function isBackgroundWait(kind: FixKind | undefined): boolean {
  return kind === 'system-dialog';
}
