import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readActiveTaskSlug } from './bookmark-task-link.js';
import { isSafeTaskSlug } from './task-backend/local.js';
import {
  inspectSleepCooldown,
  inspectSleepLock,
  type SleepState,
  type SleepThresholds,
} from './sleep-consolidation.js';
import { effectiveDebt } from './sleep-consolidation.js';
import { readSetupConfig, readBrainLocal, SLEEP_SPECIALISTS, type BrainLocalState } from './setup-config.js';
import { resolveMaxNewTasksPerCycle } from './sleep-settings.js';
import { readManifest } from './manifest.js';
import { agentBaselineSha, isCustomizedAgent } from './sleep-specialist-frontmatter.js';

/**
 * auto-sleep — the pure decisions behind running a consolidation in the
 * background while the user keeps working.
 *
 * D1 lives here: the HANDS-OFF SET. The per-file lock (D2) stops two writers
 * corrupting one file, but it cannot stop them disagreeing — a background cycle
 * that "reconciles" the very task the user is editing in the foreground
 * produces a coherent file whose contents are wrong. So the cycle is TOLD which
 * tasks not to touch, and reports them as deferred rather than silently
 * skipping them.
 *
 * Only sleep-tasks needs this list: sleep-state and sleep-product own file
 * domains that do not include `state/*.md`.
 */

/**
 * How recently a session must have been active for its tasks to count as
 * in-play. Claude Code's Stop hook fires at the end of every assistant turn, so
 * a session that stopped two minutes ago is almost certainly mid-conversation;
 * 30 minutes is deliberately generous, because the cost of deferring a task for
 * one cycle is nil and the cost of fighting the user over it is a lost edit.
 */
export const HANDS_OFF_WINDOW_MS = 30 * 60 * 1000;

function readSleepStateSafe(contextRoot: string): SleepState | null {
  const path = join(contextRoot, 'state', '.sleep.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as SleepState;
  } catch {
    return null;
  }
}

/**
 * The task slugs a background cycle must not write to, as of `nowMs`.
 *
 * The union of:
 *  - `state/.active-task` — the explicit "this is what I'm on" pointer;
 *  - every `task_slugs` entry of a session that stopped inside
 *    {@link HANDS_OFF_WINDOW_MS} (including sessions still running, which have
 *    no `stopped_at` at all — those are the MOST live).
 *
 * Sorted and de-duplicated so the prompt it feeds is stable between cycles
 * (a set that reorders itself churns the prompt for no reason).
 */
export function activeTaskSet(contextRoot: string, nowMs: number = Date.now()): string[] {
  const slugs = new Set<string>();

  const active = readActiveTaskSlug(contextRoot);
  if (active) slugs.add(active);

  const state = readSleepStateSafe(contextRoot);
  for (const session of state?.sessions ?? []) {
    // A session with no `stopped_at` is still running — the most in-play of all.
    if (session.stopped_at) {
      const stoppedMs = Date.parse(session.stopped_at);
      if (Number.isFinite(stoppedMs) && nowMs - stoppedMs > HANDS_OFF_WINDOW_MS) continue;
    }
    for (const slug of session.task_slugs ?? []) {
      // Validated before it can reach a prompt — these slugs are interpolated
      // into the text handed to a headless session.
      if (typeof slug === 'string' && isSafeTaskSlug(slug)) slugs.add(slug);
    }
  }

  return [...slugs].sort();
}

// ─── The background-sleep job sidecar ────────────────────────────────────────

export type AutoSleepStatus = 'running' | 'ok' | 'failed' | 'timeout' | 'cancelled' | 'aborted';

/**
 * The live record of a background cycle. Machine-local (gitignored): it holds
 * PIDs, and a synced one would read as "running" on every other machine.
 */
export interface AutoSleepSidecar {
  pid: number;
  pgid: number;
  startedAt: string;
  status: AutoSleepStatus;
  /** The `.sleep.json` epoch this run owns — how the changelog entry stays idempotent. */
  epoch: string | null;
  heartbeatAt?: string;
  sessionId?: string | null;
  summary?: string | null;
  finishedAt?: string | null;
  error?: string | null;
}

export const AUTO_SLEEP_SIDECAR_REL = 'state/.auto-sleep.json';
export const AUTO_SLEEP_LOCK_REL = 'state/.auto-sleep.lock';

export function autoSleepSidecarPath(contextRoot: string): string {
  return join(contextRoot, AUTO_SLEEP_SIDECAR_REL);
}

export function readAutoSleepSidecar(contextRoot: string): AutoSleepSidecar | null {
  const path = autoSleepSidecarPath(contextRoot);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AutoSleepSidecar>;
    if (typeof parsed.pid !== 'number' || typeof parsed.startedAt !== 'string') return null;
    return parsed as AutoSleepSidecar;
  } catch {
    return null;
  }
}

/** Is a recorded pid still alive? ESRCH → dead; EPERM → alive but not ours. */
export function isPidAlive(pid: number, kill: (p: number, sig: number) => void = process.kill): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}

/** A background cycle that is genuinely still running (recorded AND its pid alive). */
export function liveAutoSleepJob(contextRoot: string): AutoSleepSidecar | null {
  const sidecar = readAutoSleepSidecar(contextRoot);
  if (!sidecar || sidecar.status !== 'running') return null;
  return isPidAlive(sidecar.pid) ? sidecar : null;
}

// ─── Consent = a fingerprint, not a boolean ──────────────────────────────────

/**
 * The envelope a user approves when they turn background sleep on.
 *
 * WHAT IS IN IT, and why each: the specialist model/effort map and the task cap
 * (a teammate can change these in the synced config — approving "sleep runs
 * itself" is not approving "…on whatever model somebody else picks"), the
 * trigger, and a per-agent customization digest (a hand-edited specialist is a
 * different program than the one that was approved).
 *
 * WHAT IS DELIBERATELY OUT: anything dreamcontext itself ships — the prompt
 * text, the agent bodies, the version. The user already delegated that trust to
 * `dreamcontext update`, and hashing it would pause background sleep silently
 * after every routine refresh, which trains people to re-approve without
 * looking. That is the failure mode a consent check exists to avoid.
 */
export function currentAutoSleepFingerprint(projectRoot: string): string {
  try {
    const config = readSetupConfig(projectRoot);
    const local = readBrainLocal(projectRoot);
    const manifest = readManifest(projectRoot);

    const specialists: Record<string, unknown> = {};
    for (const name of SLEEP_SPECIALISTS) {
      const override = config?.sleep?.specialists?.[name] ?? {};
      const relPath = `.claude/agents/${name}.md`;
      const installedPath = join(projectRoot, relPath);
      // 'none' when the file is ours as installed; the canonical hash when a
      // human edited it. SAME predicate `applySleepSpecialistOverrides` uses, so
      // the two can never disagree about what counts as a customization.
      let digest = 'none';
      if (existsSync(installedPath)) {
        const installed = readFileSync(installedPath, 'utf-8');
        const baseline = manifest?.files[relPath]?.baselineSha;
        if (isCustomizedAgent(installed, baseline)) digest = agentBaselineSha(installed);
      } else {
        digest = 'missing';
      }
      specialists[name] = { model: override.model ?? null, effort: override.effort ?? null, digest };
    }

    const payload = JSON.stringify({
      specialists,
      cap: resolveMaxNewTasksPerCycle(config?.sleep),
      trigger: local?.autoSleep?.trigger ?? 'must-sleep',
    });
    return createHash('sha256').update(payload, 'utf-8').digest('hex');
  } catch {
    // A sentinel that compares unequal to any stored fingerprint. Failing to
    // COMPUTE consent must read as "consent is stale" (auto-sleep pauses, the
    // user is told), never as a crashed Stop hook or a silent approval.
    return `unavailable-${Date.now()}`;
  }
}

// ─── C1: should a Stop hook start one? ───────────────────────────────────────

export type AutoSleepRefusal =
  | 'disabled' | 'below-trigger' | 'cooldown' | 'sleep-in-progress'
  | 'already-running' | 'consent-stale' | 'nested';

export interface AutoSleepDecision {
  start: boolean;
  reason: AutoSleepRefusal | 'start';
  /** A line the hook/CLI can show verbatim. */
  detail: string;
}

export interface ShouldStartAutoSleepInput {
  contextRoot: string;
  state: SleepState;
  local: BrainLocalState | null;
  thresholds: SleepThresholds;
  nowMs: number;
  /** The fingerprint as it is RIGHT NOW; injected so this stays pure/testable. */
  currentFingerprint: string;
  /** True inside an auto-sleep session's own hooks — must never chain a second. */
  nested?: boolean;
}

/**
 * Every condition that must hold before a Stop hook may dispatch a background
 * consolidation. Pure: the caller does the disk reads and passes them in.
 *
 * Order matters for the MESSAGE, not the logic — the first refusal returned is
 * the one a user is shown, so the cheapest and most likely ("it's off") comes
 * first and the subtle ones come last.
 */
export function shouldStartAutoSleep(input: ShouldStartAutoSleepInput): AutoSleepDecision {
  const { contextRoot, state, local, thresholds, nowMs, currentFingerprint } = input;

  if (input.nested) {
    return { start: false, reason: 'nested', detail: 'This session IS a background sleep — never chain another.' };
  }
  if (!local?.autoSleep?.enabled) {
    return { start: false, reason: 'disabled', detail: 'Background sleep is off for this machine.' };
  }

  const trigger = local.autoSleep.trigger === 'sleepy' ? thresholds.sleepy : thresholds.mustSleep;
  const debt = effectiveDebt(state).effective;
  if (debt < trigger) {
    return { start: false, reason: 'below-trigger', detail: `Debt ${debt} is below the ${local.autoSleep.trigger} trigger (${trigger}).` };
  }

  // The cooldown's own override (debt ≥ 2× Must Sleep) is honoured here exactly
  // as it is for directives — a genuinely enormous burst is never held.
  const cooldown = inspectSleepCooldown(state, nowMs, debt, thresholds);
  if (cooldown.active) {
    return { start: false, reason: 'cooldown', detail: 'A consolidation completed recently — cooling down.' };
  }

  // A live sleep of ANY kind (someone's interactive cycle, or a background one)
  // owns the brain. Liveness-aware: see `inspectSleepLockLive`.
  const lock = inspectSleepLockLive(contextRoot, state, nowMs);
  if (lock.locked && !lock.stale) {
    return { start: false, reason: 'sleep-in-progress', detail: `A consolidation is already running (started ${lock.startedAt}).` };
  }
  if (liveAutoSleepJob(contextRoot)) {
    return { start: false, reason: 'already-running', detail: 'A background sleep is already running.' };
  }

  if (local.autoSleep.approvedFingerprint !== currentFingerprint) {
    return {
      start: false,
      reason: 'consent-stale',
      detail: 'Background sleep is paused — the settings changed since you approved it. '
        + 'Review and re-enable in Settings › Sleep or with `dreamcontext sleep auto on`.',
    };
  }

  return { start: true, reason: 'start', detail: `Debt ${debt} reached the ${local.autoSleep.trigger} trigger (${trigger}).` };
}

/**
 * C2b — `inspectSleepLock`, but aware of a live background holder.
 *
 * THE BUG THIS FIXES: `SLEEP_LOCK_STALE_MS` is 30 minutes, and a real
 * six-specialist cycle can run longer. Without this, a background sleep at
 * minute 31 has its epoch declared stale — `sleep start` would happily take it
 * over, and the task-filing bar (which keys off "is a cycle live?") would switch
 * OFF mid-cycle. Liveness is the PID, not a timer: a laptop that slept for two
 * hours resumes with the pid intact and nothing was reclaimed meanwhile, while a
 * hung-but-alive run is bounded by the dispatcher's own kill matrix — after
 * which the pid is dead and the lock is reclaimable again.
 *
 * With no background holder this is byte-for-byte today's rule.
 */
export function inspectSleepLockLive(contextRoot: string, state: SleepState, nowMs: number) {
  const base = inspectSleepLock(state, nowMs);
  if (!base.locked || !base.stale) return base;
  const holder = liveAutoSleepJob(contextRoot);
  return holder ? { ...base, stale: false } : base;
}

/** `projectRoot` from a contextRoot (`<project>/_dream_context`). */
export function projectRootOf(contextRoot: string): string {
  return dirname(contextRoot);
}
