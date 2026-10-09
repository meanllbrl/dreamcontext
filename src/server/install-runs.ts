import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { runFix, type FixOptions, type FixOutcome, type RunSink } from '../lib/onboarding/fixes.js';
import { runPendingGitInits } from '../lib/onboarding/pending-git.js';
import { invalidateReadiness, markFixActive, markFixDone } from '../lib/onboarding/readiness.js';
import { defaultProbeRunner, resolveProbeUrl } from '../lib/onboarding/runner.js';
import type { FixId, ProbeContext, Surface } from '../lib/onboarding/types.js';

/**
 * The one store for background installs: the in-app installer (`/api/agent/install`) and
 * the onboarding checklist (`/api/onboarding/fix`) both start a run here and the UI polls
 * `/api/agent/install/status?id=` for it. Pulled out of agent-terminal.ts so the two
 * surfaces cannot grow two copies of the start-then-poll machinery.
 *
 * In memory on purpose: a run is a few minutes of one process's work, and the readiness
 * probe (not this store) is what says whether the software actually landed.
 */

export type RunState = 'running' | 'done' | 'error';

export interface InstallRun {
  state: RunState;
  /** The legacy install target or the onboarding fix id. */
  target: string;
  /** Combined output tail, shown under "Show details" and as the failure text. */
  output: string;
  startedAt: number;
  endedAt?: number;
  /** Why a fix run did not succeed (`canceled`, `offline`, …). */
  outcome?: FixOutcome['reason'];
  /** The run is waiting on the person: a browser sign-in or a macOS dialog. */
  awaiting?: 'browser' | 'system-dialog' | null;
  progress?: { received: number; total: number | null };
  /** A GitHub device code to show. Never a token. */
  deviceCode?: { userCode: string; verificationUri: string; expiresAt: number };
  /** The fix this run belongs to, when it is an onboarding fix run. */
  fixId?: FixId;
}

/** What `GET /api/agent/install/status` returns for a known run. */
export interface RunStatusView {
  state: RunState;
  target: string;
  output: string;
  outcome?: FixOutcome['reason'];
  awaiting?: 'browser' | 'system-dialog' | null;
  progress?: { received: number; total: number | null };
  deviceCode?: { userCode: string; verificationUri: string; expiresAt: number };
}

/**
 * The probe context for this server process. `ptyPresent` is passed only on the desktop
 * surface (the built-in terminal is a desktop feature); a browser tab never sees that row.
 */
export function serverProbeContext(surface: Surface, ptyPresent?: () => boolean): ProbeContext {
  return {
    surface,
    platform: process.platform,
    arch: process.arch,
    home: homedir(),
    execPath: process.execPath,
    runner: defaultProbeRunner,
    probeUrl: resolveProbeUrl(),
    ...(surface === 'desktop' && ptyPresent ? { ptyPresent } : {}),
  };
}

const RUN_TTL_MS = 10 * 60 * 1000;
const RUNS_MAX = 20;
const OUTPUT_CAP = 8_000;
/** Ceiling for any fix run. The longest recipe (the macOS developer tools wait) is 30 min. */
const FIX_CEILING_MS = 40 * 60 * 1000;

const runs = new Map<string, InstallRun>();
/** Cancel handles live beside the run, never on it, so a run is always plain data. */
const controls = new Map<string, { controller: AbortController; kills: Array<() => void> }>();
/** One active run per fix id. */
const activeByFix = new Map<FixId, string>();

/**
 * Drop ended runs past their TTL, then trim to the cap by evicting the oldest ENDED runs.
 * A run that is still going is never evicted: its id is what the UI is polling, and
 * dropping it would turn a working install into "the run expired".
 */
export function pruneInstallRuns(now: number = Date.now()): void {
  for (const [id, run] of runs) {
    if (run.endedAt !== undefined && now - run.endedAt > RUN_TTL_MS) runs.delete(id);
  }
  if (runs.size <= RUNS_MAX) return;
  for (const [id, run] of runs) {
    if (runs.size <= RUNS_MAX) break;
    if (run.state !== 'running') runs.delete(id);
  }
}

/** Mint a running run for `target`. */
export function createRun(target: string, output = ''): { id: string; run: InstallRun } {
  pruneInstallRuns();
  const id = randomUUID();
  const run: InstallRun = { state: 'running', target, output, startedAt: Date.now() };
  runs.set(id, run);
  return { id, run };
}

export function appendOutput(run: InstallRun, chunk: string): void {
  run.output = (run.output + chunk).slice(-OUTPUT_CAP);
}

/** Mark a run ended. Idempotent: the first end wins. */
export function finishRun(run: InstallRun, ok: boolean, output?: string): void {
  if (run.state !== 'running') return;
  run.state = ok ? 'done' : 'error';
  if (output !== undefined) run.output = output.slice(-OUTPUT_CAP);
  run.awaiting = null;
  run.endedAt = Date.now();
}

export function getRun(id: string): InstallRun | undefined {
  return runs.get(id);
}

/** The status payload. Only plain fields: never a cancel handle, never a token. */
export function runStatusView(run: InstallRun): RunStatusView {
  return {
    state: run.state,
    target: run.target,
    output: run.output.trim(),
    ...(run.outcome ? { outcome: run.outcome } : {}),
    ...(run.awaiting !== undefined ? { awaiting: run.awaiting } : {}),
    ...(run.progress ? { progress: run.progress } : {}),
    ...(run.deviceCode && run.state === 'running' ? { deviceCode: run.deviceCode } : {}),
  };
}

/**
 * A run that wraps one async task (the Claude update check): the task's message becomes
 * the output, its `ok` the state. Never throws.
 */
export function startTaskRun(
  target: string,
  task: () => Promise<{ ok: boolean; message: string }>,
  opts: { initialOutput?: string; failMessage?: string } = {},
): string {
  const { id, run } = createRun(target, opts.initialOutput ?? '');
  void task()
    .then((r) => finishRun(run, r.ok, r.message))
    .catch(() => finishRun(run, false, opts.failMessage ?? 'The run did not finish.'));
  return id;
}

/** The active run id for a fix, if one is going. */
export function activeRunFor(id: FixId): string | null {
  const runId = activeByFix.get(id);
  if (!runId) return null;
  const run = runs.get(runId);
  if (!run || run.state !== 'running') {
    activeByFix.delete(id);
    return null;
  }
  return runId;
}

export interface FixRunDeps {
  runFix: typeof runFix;
  runPendingGitInits: () => string[];
}

const defaultFixRunDeps: FixRunDeps = {
  runFix,
  runPendingGitInits: () => runPendingGitInits(),
};

export interface FixRunOptions {
  fixOptions?: FixOptions;
  /** The label the status route reports. Defaults to the fix id; the legacy route passes its own target. */
  target?: string;
  /** Called after the outcome is recorded, before the run reads as ended. */
  onDone?: (outcome: FixOutcome, run: InstallRun) => void;
  deps?: Partial<FixRunDeps>;
}

function sinkFor(run: InstallRun, kills: Array<() => void>): RunSink {
  return {
    output: (chunk) => appendOutput(run, chunk),
    progress: (received, total) => { run.progress = { received, total }; },
    awaiting: (kind) => { run.awaiting = kind; },
    deviceCode: (c) => { run.deviceCode = c; },
    onCancel: (kill) => { kills.push(kill); },
  };
}

/**
 * Start one onboarding fix in the background and return its run id. If the same fix is
 * already running, that run's id comes back with `existing: true` and nothing new starts.
 *
 * The run owns the active-fix bookkeeping: `markFixActive` on start, `markFixDone` and a
 * readiness invalidation on end, whatever the outcome. A `git-install` that ends ok then
 * runs the pending `git init`s straight away (the readiness route is only the fallback).
 */
export function startFixRun(
  id: FixId,
  ctx: ProbeContext,
  opts: FixRunOptions = {},
): { runId: string; existing: boolean } {
  const existing = activeRunFor(id);
  if (existing) return { runId: existing, existing: true };

  const deps: FixRunDeps = { ...defaultFixRunDeps, ...opts.deps };
  const { id: runId, run } = createRun(opts.target ?? id);
  run.fixId = id;
  const controller = new AbortController();
  const kills: Array<() => void> = [];
  controls.set(runId, { controller, kills });
  activeByFix.set(id, runId);
  markFixActive(id);

  const ceiling = setTimeout(() => controller.abort(), FIX_CEILING_MS);
  ceiling.unref?.();

  void (async () => {
    let outcome: FixOutcome;
    try {
      outcome = await deps.runFix(id, ctx, sinkFor(run, kills), controller.signal, opts.fixOptions ?? {});
    } catch (err) {
      outcome = { ok: false, reason: 'failed', detail: (err as Error).message };
    }
    clearTimeout(ceiling);
    if (!outcome.ok) run.outcome = outcome.reason ?? 'failed';
    if (outcome.detail) appendOutput(run, `${run.output ? '\n' : ''}${outcome.detail}`);
    try {
      opts.onDone?.(outcome, run);
    } catch (err) {
      console.error(`[install-runs] after-run step for ${id} failed:`, err);
    }
    finishRun(run, outcome.ok);
    controls.delete(runId);
    if (activeByFix.get(id) === runId) activeByFix.delete(id);
    markFixDone(id);
    invalidateReadiness();
    if (id === 'git-install' && outcome.ok) {
      try {
        deps.runPendingGitInits();
      } catch (err) {
        console.error('[install-runs] pending git init after the developer tools install failed:', err);
      }
    }
  })();

  return { runId, existing: false };
}

/**
 * Ask a running fix to stop. The run ends as `error` with outcome `canceled` once its
 * recipe returns. False when there is nothing running under that id.
 */
export function cancelRun(runId: string): boolean {
  const run = runs.get(runId);
  const control = controls.get(runId);
  if (!run || run.state !== 'running' || !control) return false;
  control.controller.abort();
  for (const kill of control.kills) {
    try { kill(); } catch { /* already gone */ }
  }
  return true;
}

/** Test-only: forget every run. */
export function resetInstallRunsForTests(): void {
  for (const c of controls.values()) c.controller.abort();
  runs.clear();
  controls.clear();
  activeByFix.clear();
}
