import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { claudeAuthStatus } from '../claude-auth.js';
import { resolveConfigDir } from '../claude-accounts.js';
import { findClaudeBin } from '../claude-path.js';
import {
  readGlobalGitHubLogin, readGlobalGitHubNeedsReconnect, readGlobalGitHubToken,
} from '../git-sync/auth-store.js';
import { evaluateChecks } from './checks.js';
import { nextNeedingUser, planFixes } from './plan.js';
import { detectLinuxPackageManager, managedNpmGlobal } from './platform.js';
import { SHELL_FACTS_SCRIPT, parseShellFacts } from './runner.js';
import type { ExtraFacts, FixId, ProbeContext, ReadinessReport } from './types.js';

const SHELL_TIMEOUT_MS = 15_000;
const NETWORK_TIMEOUT_MS = 3_000;
const GH_AUTH_TIMEOUT_MS = 8_000;
const MEMO_MS = 5_000;
const FRESH_MIN_GAP_MS = 2_000;
const CLI_DEFER_WINDOW_MS = 60_000;

/** The probes `probeReadiness` makes outside the injected runner. Injectable for tests. */
export interface ReadinessDeps {
  /** Claude's sign-in for a config folder (`resolveConfigDir(null)`: the account new sessions use). */
  claudeAuth(configDir: string): Promise<{ loggedIn: boolean | null; email?: string }>;
  preferredConfigDir(): string;
  findClaudeBin(): string | null;
  github(home: string): ExtraFacts['github'];
  exists(path: string): boolean;
  linuxPm(): ReturnType<typeof detectLinuxPackageManager>;
  now(): number;
}

export const defaultReadinessDeps: ReadinessDeps = {
  claudeAuth: async (configDir) => {
    const s = await claudeAuthStatus(configDir);
    return { loggedIn: s.loggedIn, ...(s.email ? { email: s.email } : {}) };
  },
  preferredConfigDir: () => resolveConfigDir(null),
  findClaudeBin,
  github: (home) => ({
    connected: readGlobalGitHubToken(home) !== null,
    needsReconnect: readGlobalGitHubNeedsReconnect(home),
    login: readGlobalGitHubLogin(home),
  }),
  exists: existsSync,
  linuxPm: () => detectLinuxPackageManager(),
  now: Date.now,
};

// ─── Active fixes (in-process registry) ─────────────────────────────────────────

const active = new Set<FixId>();

/** A fix run started (server: the run store; CLI: its own session). */
export function markFixActive(id: FixId): void { active.add(id); }
/** A fix run ended, whatever its outcome. */
export function markFixDone(id: FixId): void { active.delete(id); }
export function isFixActive(id: FixId): boolean { return active.has(id); }
export function activeFixes(): FixId[] { return [...active]; }

// ─── Probe ─────────────────────────────────────────────────────────────────────

/**
 * Probe this machine once and build the full report. One login shell answers every
 * "can a new Terminal find X" question; the rest (network, Claude sign-in, GitHub,
 * node-pty) run alongside it. Never throws: a failed probe reads as "not found".
 */
export async function probeReadiness(
  ctx: ProbeContext,
  deps: ReadinessDeps = defaultReadinessDeps,
): Promise<ReadinessReport> {
  const shell = process.env.SHELL || '/bin/zsh';
  const [shellOut, online] = await Promise.all([
    ctx.runner.loginShell(SHELL_FACTS_SCRIPT, SHELL_TIMEOUT_MS),
    ctx.runner.fetchOk(ctx.probeUrl, NETWORK_TIMEOUT_MS),
  ]);
  const facts = parseShellFacts(shellOut.stdout, shell);
  const claudeBin = deps.findClaudeBin();

  const [claudeAuth, ghAuthed] = await Promise.all([
    facts.claude || claudeBin ? deps.claudeAuth(deps.preferredConfigDir()).catch(() => null) : Promise.resolve(null),
    facts.gh
      ? ctx.runner.exec(facts.gh, ['auth', 'status', '--hostname', 'github.com'], { timeoutMs: GH_AUTH_TIMEOUT_MS })
        .then((r) => (r.ok ? true : online ? false : null))
      : Promise.resolve(null),
  ]);

  const nodeDir = dirname(ctx.execPath);
  const extra: ExtraFacts = {
    online,
    runningNodeVersion: process.versions.node,
    npmBesideExec: deps.exists(join(nodeDir, 'npm')),
    claudeBin,
    cliBinOffPath: [join(managedNpmGlobal(ctx.home), 'bin', 'dreamcontext'), join(nodeDir, 'dreamcontext')]
      .find((p) => deps.exists(p)) ?? null,
    claudeAuth,
    ghAuthed,
    github: deps.github(ctx.home),
    ptyPresent: ctx.ptyPresent ? ctx.ptyPresent() : null,
  };

  const checks = evaluateChecks(facts, extra, {
    surface: ctx.surface,
    platform: ctx.platform,
    linuxPm: ctx.platform === 'linux' ? deps.linuxPm() : null,
  });
  return {
    version: 1,
    platform: ctx.platform,
    arch: ctx.arch,
    surface: ctx.surface,
    generatedAt: deps.now(),
    ready: checks.every((c) => c.tier !== 'required' || c.status === 'ok' || c.status === 'unknown'),
    online,
    plan: planFixes(checks),
    next: nextNeedingUser(checks),
    activeFixes: activeFixes(),
    checks,
  };
}

// ─── Memo + coalescing ─────────────────────────────────────────────────────────

let cached: { report: ReadinessReport; at: number } | null = null;
let inflight: { promise: Promise<ReadinessReport>; generation: number } | null = null;
let lastFreshAt = -Infinity;
/**
 * Bumped by {@link invalidateReadiness}. A probe remembers the generation it started in
 * and only writes the cache if nothing invalidated it meanwhile: a probe that began
 * before a fix finished describes the machine BEFORE the fix, and must never land on top
 * of the invalidation (it would report "Claude missing" right after Claude installed).
 */
let generation = 0;

function withLiveActive(report: ReadinessReport): ReadinessReport {
  return { ...report, activeFixes: activeFixes() };
}

/**
 * The report, probed at most once at a time and reused for 5 s. `fresh` skips the memo,
 * but at most once per 2 s: a burst of fresh requests (several windows polling) shares
 * one probe. `activeFixes` is always the live registry, even on a reused report.
 * Requests only ever join a probe of the current generation (see {@link generation}).
 */
export async function getReadiness(
  ctx: ProbeContext,
  o: { fresh?: boolean } = {},
  deps: ReadinessDeps = defaultReadinessDeps,
): Promise<ReadinessReport> {
  const now = deps.now();
  if (inflight && inflight.generation === generation) return withLiveActive(await inflight.promise);
  const freshAllowed = o.fresh === true && now - lastFreshAt >= FRESH_MIN_GAP_MS;
  if (cached && !freshAllowed && now - cached.at < MEMO_MS) return withLiveActive(cached.report);
  if (cached && o.fresh && !freshAllowed) return withLiveActive(cached.report);
  if (o.fresh) lastFreshAt = now;
  const startedIn = generation;
  const entry = { promise: probeReadiness(ctx, deps), generation: startedIn };
  inflight = entry;
  try {
    const report = await entry.promise;
    if (generation === startedIn) cached = { report, at: deps.now() };
    return withLiveActive(report);
  } finally {
    if (inflight === entry) inflight = null;
  }
}

/**
 * Drop the memo so the next read probes again (a fix just finished). Also forgets the
 * in-flight probe and the fresh clock, and bumps the generation so a probe already
 * running cannot write its pre-fix result back into the cache when it lands.
 */
export function invalidateReadiness(): void {
  generation++;
  cached = null;
  inflight = null;
  lastFreshAt = -Infinity;
}

/** The last report, without probing (null when none is cached). */
export function cachedReadiness(): ReadinessReport | null {
  return cached ? withLiveActive(cached.report) : null;
}

/**
 * Should a caller skip installing the CLI itself and leave it to onboarding? True while
 * a `cli-install` run is active, or when a report from the last minute shows the CLI
 * still not ok (onboarding owns that row). The launcher's scaffold uses this so creating
 * a project never blocks on a second, parallel npm install.
 */
export function cliInstallDeferred(now: number = Date.now()): boolean {
  if (isFixActive('cli-install')) return true;
  if (!cached || now - cached.at > CLI_DEFER_WINDOW_MS) return false;
  const cli = cached.report.checks.find((c) => c.id === 'cli');
  return !!cli && cli.status !== 'ok';
}

/** Test-only: forget the memo, the in-flight probe, the fresh clock and the registry. */
export function resetReadinessForTests(): void {
  cached = null;
  inflight = null;
  lastFreshAt = -Infinity;
  generation = 0;
  active.clear();
}
