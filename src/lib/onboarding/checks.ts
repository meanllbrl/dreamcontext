import { manualCommand, type LinuxPackageManager } from './platform.js';
import {
  CHECK_DEPS, CHECK_IDS, CHECK_SCOPES, CHECK_TIERS, MIN_NODE_MAJOR,
  type CheckId, type CheckStatus, type ExtraFacts, type FixId, type FixKind, type FixPlan,
  type ReadinessCheck, type ReasonCode, type ShellFacts, type Surface,
} from './types.js';

/** What `evaluateChecks` needs to know about where it runs. */
export interface EvaluateContext {
  surface: Surface;
  platform: NodeJS.Platform;
  /** Linux only: the package manager manual commands are written for. */
  linuxPm?: LinuxPackageManager | null;
}

/** Fixes that append a line to the user's shell startup file. */
const EDITS_SHELL_PROFILE: ReadonlySet<FixId> = new Set<FixId>([
  'node-shell-path', 'cli-shell-path', 'claude-path', 'claude-install', 'gh-install',
]);

/** Statuses that make a dependant `blocked` (a blocked dependency blocks in turn). */
const BLOCKING: ReadonlySet<CheckStatus> = new Set<CheckStatus>(['missing', 'needs-action', 'unsupported', 'blocked']);

/** `v24.9.0` / `24.9.0` → 24; anything unparseable → null. */
export function nodeMajor(version: string | undefined): number | null {
  const m = /^v?(\d+)\./.exec((version ?? '').trim());
  return m ? Number(m[1]) : null;
}

/** How a fix runs on this platform, given what the shell can see. */
function fixKindFor(id: FixId, platform: NodeJS.Platform, facts: ShellFacts): FixKind {
  switch (id) {
    case 'claude-signin': return 'browser';
    case 'github-signin':
    case 'gh-signin': return 'device-code';
    case 'git-install': return platform === 'darwin' ? 'system-dialog' : 'manual';
    case 'gh-install': return platform === 'darwin' || (platform === 'linux' && !!facts.brew) ? 'auto' : 'manual';
    case 'claude-install':
    case 'node-shell-path':
    case 'cli-shell-path':
    case 'claude-path': return platform === 'win32' ? 'manual' : 'auto';
    default: return 'auto';
  }
}

function fixPlan(id: FixId, facts: ShellFacts, ctx: EvaluateContext): FixPlan {
  const kind = fixKindFor(id, ctx.platform, facts);
  const manual = manualCommand(id, ctx.platform, ctx.linuxPm ?? null);
  return {
    id,
    kind,
    runnable: ctx.surface !== 'browser' && kind !== 'manual',
    ...(manual ? { manual } : {}),
    editsShellProfile: EDITS_SHELL_PROFILE.has(id),
  };
}

type Verdict = { status: CheckStatus; reason?: ReasonCode; fix?: FixId; version?: string; account?: string };

/** One check's verdict, before blocking is applied. Pure. */
function judge(id: CheckId, facts: ShellFacts, extra: ExtraFacts): Verdict {
  switch (id) {
    case 'network':
      return extra.online ? { status: 'ok' } : { status: 'missing', reason: 'offline' };
    case 'node': {
      if ((nodeMajor(extra.runningNodeVersion) ?? 0) < MIN_NODE_MAJOR) {
        return { status: 'missing', reason: 'too-old', version: extra.runningNodeVersion };
      }
      if (!facts.node) return { status: 'needs-action', reason: 'not-on-path', fix: 'node-shell-path', version: extra.runningNodeVersion };
      const major = nodeMajor(facts.nodeVersion);
      if (major === null || major < MIN_NODE_MAJOR) {
        return { status: 'needs-action', reason: 'too-old', fix: 'node-shell-path', version: facts.nodeVersion };
      }
      return { status: 'ok', version: facts.nodeVersion };
    }
    case 'npm':
      return facts.npm || extra.npmBesideExec ? { status: 'ok' } : { status: 'missing', reason: 'no-npm' };
    case 'cli':
      if (facts.dreamcontext) return { status: 'ok' };
      if (extra.cliBinOffPath) return { status: 'needs-action', reason: 'not-on-path', fix: 'cli-shell-path' };
      return { status: 'missing', reason: 'not-installed', fix: 'cli-install' };
    case 'claude':
      if (facts.claude) return { status: 'ok' };
      if (extra.claudeBin) return { status: 'needs-action', reason: 'not-on-path', fix: 'claude-path' };
      return { status: 'missing', reason: 'not-installed', fix: 'claude-install' };
    case 'claude-auth': {
      const auth = extra.claudeAuth;
      // Not probed means there is no Claude to ask yet: the sign-in is still to do (and
      // `applyBlocking` parks it behind the Claude row), never a "may be fine" unknown.
      if (!auth) return { status: 'needs-action', reason: 'signed-out', fix: 'claude-signin' };
      if (auth.loggedIn === null) return { status: 'unknown', reason: 'unverifiable' };
      if (auth.loggedIn) return { status: 'ok', ...(auth.email ? { account: auth.email } : {}) };
      return { status: 'needs-action', reason: 'signed-out', fix: 'claude-signin' };
    }
    case 'git':
      if (facts.git) return { status: 'ok' };
      return { status: 'missing', reason: facts.cltInstalled === false ? 'needs-dialog' : 'not-installed', fix: 'git-install' };
    case 'github': {
      const gh = extra.github;
      if (gh.connected && !gh.needsReconnect) return { status: 'ok', ...(gh.login ? { account: gh.login } : {}) };
      return { status: 'needs-action', reason: 'signed-out', fix: 'github-signin' };
    }
    case 'gh':
      if (!facts.gh) return { status: 'missing', reason: 'not-installed', fix: 'gh-install' };
      if (extra.ghAuthed === null) return { status: 'unknown', reason: 'unverifiable' };
      return extra.ghAuthed ? { status: 'ok' } : { status: 'needs-action', reason: 'signed-out', fix: 'gh-signin' };
    case 'terminal':
      if (extra.ptyPresent === null) return { status: 'unsupported', reason: 'desktop-only' };
      return extra.ptyPresent ? { status: 'ok' } : { status: 'missing', reason: 'not-installed', fix: 'pty-install' };
  }
}

/**
 * Every check's verdict from the gathered facts, in {@link CHECK_IDS} order, with
 * blocking applied. Pure: the same facts always give the same report.
 */
export function evaluateChecks(facts: ShellFacts, extra: ExtraFacts, ctx: EvaluateContext): ReadinessCheck[] {
  const checks = CHECK_IDS.map((id): ReadinessCheck => {
    const v = judge(id, facts, extra);
    return {
      id,
      tier: CHECK_TIERS[id],
      scopes: [...CHECK_SCOPES[id]],
      status: v.status,
      ...(v.reason ? { reason: v.reason } : {}),
      dependsOn: [...CHECK_DEPS[id]],
      ...(v.version ? { version: v.version } : {}),
      ...(v.account ? { account: v.account } : {}),
      fix: v.fix ? fixPlan(v.fix, facts, ctx) : null,
    };
  });
  return applyBlocking(checks);
}

/**
 * A check that still needs a fix (`missing` or `needs-action`), and depends on a check
 * that is `missing`, `needs-action`, `unsupported` or itself `blocked`, becomes `blocked`
 * with `blockedBy`. Every other status is left alone: an `ok` check stays ok (Claude
 * installed while offline is still installed) and an `unknown` one stays unknown (there
 * is nothing to fix, only nothing to tell). Relies on {@link CHECK_IDS} being
 * dependency-ordered, so blocking cascades in one pass.
 */
export function applyBlocking(checks: ReadinessCheck[]): ReadinessCheck[] {
  const status = new Map<CheckId, CheckStatus>();
  return checks.map((c) => {
    let out = c;
    if (c.status === 'missing' || c.status === 'needs-action') {
      const blockedBy = c.dependsOn.filter((d) => BLOCKING.has(status.get(d) ?? 'ok'));
      if (blockedBy.length > 0) out = { ...c, status: 'blocked', blockedBy };
    }
    status.set(out.id, out.status);
    return out;
  });
}
