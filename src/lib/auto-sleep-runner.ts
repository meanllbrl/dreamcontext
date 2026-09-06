import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { acquireFileLock, releaseFileLock } from './file-lock.js';
import { executeClaudeDetached, sanitizeAutomationPrompt } from './automations/runner.js';
import { notifyViaBundle } from './automations/notifier.js';
import { buildAutoSleepPrompt } from './sleep-prompt.js';
import {
  activeTaskSet,
  autoSleepSidecarPath,
  readAutoSleepSidecar,
  isPidAlive,
  AUTO_SLEEP_LOCK_REL,
  type AutoSleepSidecar,
  type AutoSleepStatus,
} from './auto-sleep.js';
import { SLEEP_LOCK_STALE_MS } from './sleep-consolidation.js';
import { join } from 'node:path';

/**
 * auto-sleep-runner — the dispatcher for a background consolidation.
 *
 * Everything about spawning is REUSED, not re-implemented: `executeClaudeDetached`
 * (process group, timeout → SIGTERM → SIGKILL, output collection) and
 * `sanitizeAutomationPrompt` come from the automations runner, which has already
 * paid for those edge cases once. What is new here is only what is specific to a
 * sleep: the lock, the sidecar, the hands-off list, and the idempotent close.
 */

/** A six-specialist cycle is slow. Well past that, and bounded — not unbounded. */
export const AUTO_SLEEP_TIMEOUT_MS = 40 * 60 * 1000;

/** Heartbeat cadence. Two purposes only: the dashboard job card, and gap detection. */
export const HEARTBEAT_MS = 60_000;

/**
 * A wall-clock gap larger than this between heartbeats means the machine slept.
 * On the next tick the dispatcher re-verifies it still owns the run rather than
 * blindly resuming writes into a brain something else may have taken over.
 */
export const SUSPEND_GAP_MS = 5 * 60_000;

/**
 * The tool budget. File tools, Bash (the CLI) and Agent (the fan-out) are what
 * the flow needs; web and MCP are not. An unsupervised `bypassPermissions` run
 * gets no wider reach than the job requires — and unlike a read-only ask, this one
 * keeps the Agent tool, because the fan-out IS the flow.
 */
export const AUTO_SLEEP_DISALLOWED_TOOLS = 'WebFetch,WebSearch,mcp__*';

export function autoSleepLockPath(contextRoot: string): string {
  return join(contextRoot, AUTO_SLEEP_LOCK_REL);
}

export function writeAutoSleepSidecar(contextRoot: string, sidecar: AutoSleepSidecar): void {
  const path = autoSleepSidecarPath(contextRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(sidecar, null, 2) + '\n', 'utf-8');
}

export function patchAutoSleepSidecar(
  contextRoot: string,
  patch: Partial<AutoSleepSidecar>,
): AutoSleepSidecar | null {
  const current = readAutoSleepSidecar(contextRoot);
  if (!current) return null;
  const next = { ...current, ...patch };
  writeAutoSleepSidecar(contextRoot, next);
  return next;
}

/** The `.sleep.json` epoch, read directly (no CLI import — this runs detached). */
function readEpoch(contextRoot: string): string | null {
  const path = join(contextRoot, 'state', '.sleep.json');
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, 'utf-8')) as { sleep_started_at?: unknown };
    return typeof state.sleep_started_at === 'string' ? state.sleep_started_at : null;
  } catch {
    return null;
  }
}

export interface RunAutoSleepOptions {
  /** Injected in tests so nothing actually spawns. */
  execImpl?: typeof executeClaudeDetached;
  notifyImpl?: (title: string, body: string) => void;
  now?: () => Date;
  /** Injected so a test can drive gap detection without waiting a real minute. */
  heartbeatMs?: number;
}

export interface RunAutoSleepResult {
  started: boolean;
  status: AutoSleepStatus | 'refused';
  detail: string;
  sessionId?: string | null;
}

/**
 * Run one background consolidation to completion.
 *
 * Called by `dreamcontext sleep auto-run`, which the Stop hook spawns detached —
 * so THIS function is already off the user's turn and may take 40 minutes.
 */
export async function runAutoSleep(
  contextRoot: string,
  opts: RunAutoSleepOptions = {},
): Promise<RunAutoSleepResult> {
  const exec = opts.execImpl ?? executeClaudeDetached;
  const now = opts.now ?? (() => new Date());
  const notify = opts.notifyImpl ?? ((title: string, body: string) => { notifyViaBundle(title, body); });
  const projectRoot = dirname(contextRoot);

  // ONE background cycle per brain. The lock outlives the timeout window so a
  // crashed dispatcher cannot be raced instantly, and pid-liveness means a slow
  // but ALIVE run is never reclaimed out from under itself.
  const lockPath = autoSleepLockPath(contextRoot);
  if (!acquireFileLock(lockPath, Date.now(), SLEEP_LOCK_STALE_MS + AUTO_SLEEP_TIMEOUT_MS, { verifyPidLiveness: true })) {
    return { started: false, status: 'refused', detail: 'Another background sleep holds the lock.' };
  }

  let heartbeat: NodeJS.Timeout | undefined;
  try {
    // The hands-off list is captured NOW, at dispatch — the set of tasks the
    // user is holding as the cycle begins.
    const handsOff = activeTaskSet(contextRoot, Date.now());
    const prompt = sanitizeAutomationPrompt(buildAutoSleepPrompt(handsOff));

    const startedAt = now();
    const epochAtSpawn = readEpoch(contextRoot);

    const execution = await exec(
      [
        '-p', prompt,
        '--permission-mode', 'bypassPermissions',
        '--output-format', 'json',
        '--disallowedTools', AUTO_SLEEP_DISALLOWED_TOOLS,
      ],
      {
        cwd: projectRoot,
        timeoutMs: AUTO_SLEEP_TIMEOUT_MS,
        // DREAMCONTEXT_AUTO_SLEEP is the guard that stops this session's own
        // Stop hooks chaining a second background sleep, AND switches the
        // task-filing bar on for everything it runs.
        env: { DREAMCONTEXT_AUTO_SLEEP: '1' },
        // Written SYNCHRONOUSLY at spawn: a sidecar written after an await can
        // be missed by a dispatcher that dies in between, leaving an orphaned
        // process group with no record — the one failure with no recovery.
        onSpawned: (child, at) => {
          writeAutoSleepSidecar(contextRoot, {
            pid: child.pid as number,
            pgid: child.pid as number,   // detached ⇒ the child leads its own group
            startedAt: at.toISOString(),
            status: 'running',
            epoch: epochAtSpawn,
            heartbeatAt: at.toISOString(),
          });
          let lastTick = Date.now();
          // The epoch is stamped by the CYCLE (its own `sleep start`), seconds
          // AFTER we spawn — so `epochAtSpawn` is null for every cycle that was
          // not already in progress. Learn it on the first tick that sees one,
          // and from then on that is the epoch this run owns.
          let ownedEpoch: string | null = epochAtSpawn;
          heartbeat = setInterval(() => {
            const tick = Date.now();
            const gap = tick - lastTick;
            lastTick = tick;
            if (ownedEpoch === null) {
              const seen = readEpoch(contextRoot);
              if (seen) {
                ownedEpoch = seen;
                patchAutoSleepSidecar(contextRoot, { epoch: seen });
              }
            }
            // GAP DETECTION — the machine slept. Re-verify ownership instead of
            // resuming writes into a brain something else may now own.
            if (gap > SUSPEND_GAP_MS) {
              // Ownership = the sidecar still names OUR pid, and the epoch is
              // still the one we spawned against. Either changing means another
              // process took the brain over while this machine was suspended.
              const mine = readAutoSleepSidecar(contextRoot);
              const stillOurs = mine?.pid === child.pid && readEpoch(contextRoot) === ownedEpoch;
              if (!stillOurs) {
                patchAutoSleepSidecar(contextRoot, { status: 'aborted', finishedAt: new Date(tick).toISOString(), error: 'ownership lost across a machine suspend' });
                try { process.kill(-(child.pid as number), 'SIGKILL'); } catch { /* already gone */ }
                return;
              }
            }
            patchAutoSleepSidecar(contextRoot, { heartbeatAt: new Date(tick).toISOString() });
          }, opts.heartbeatMs ?? HEARTBEAT_MS);
          heartbeat.unref?.();
        },
      },
    );

    if (heartbeat) clearInterval(heartbeat);

    if (!execution.spawned) {
      patchAutoSleepSidecar(contextRoot, { status: 'failed', finishedAt: now().toISOString(), error: 'claude failed to spawn' });
      notify('Auto sleep failed', 'The background consolidation could not start (claude did not spawn).');
      return { started: false, status: 'failed', detail: 'claude did not spawn' };
    }

    // A cancel that landed while we were waiting wins — do not overwrite it with
    // the exit status of the process the human just killed.
    const current = readAutoSleepSidecar(contextRoot);
    if (current?.status === 'cancelled' || current?.status === 'aborted') {
      return { started: true, status: current.status, detail: `Run ended as ${current.status}.` };
    }

    if (execution.timedOut) {
      patchAutoSleepSidecar(contextRoot, { status: 'timeout', finishedAt: now().toISOString(), error: execution.stderrTail || null });
      notify('Auto sleep timed out', `The background consolidation ran past ${Math.round(AUTO_SLEEP_TIMEOUT_MS / 60000)} minutes and was stopped.`);
      return { started: true, status: 'timeout', detail: 'timed out' };
    }

    const result = execution.result;
    const failed = !result || result.isError || execution.exitCode !== 0;
    if (failed) {
      const tail = execution.stderrTail?.trim().slice(-400) || result?.result?.slice(0, 400) || 'no output';
      patchAutoSleepSidecar(contextRoot, { status: 'failed', finishedAt: now().toISOString(), error: tail, sessionId: result?.sessionId ?? null });
      notify('Auto sleep failed', `The background consolidation did not finish cleanly: ${tail.slice(0, 160)}`);
      return { started: true, status: 'failed', detail: tail, sessionId: result?.sessionId ?? null };
    }

    const summary = (result.result ?? '').trim();
    patchAutoSleepSidecar(contextRoot, {
      status: 'ok',
      finishedAt: now().toISOString(),
      summary: summary.slice(0, 2000),
      sessionId: result.sessionId,
    });
    // Key on the epoch this run OWNED (learned above), falling back to the
    // sidecar's own startedAt — unique per dispatch and always present, so a
    // short cycle that finished before the first heartbeat still gets its line.
    const closing = readAutoSleepSidecar(contextRoot);
    recordAutoSleepChangelog(contextRoot, closing?.epoch ?? closing?.startedAt ?? null, summary);
    notify('Sleep complete', summary.slice(0, 300) || 'The brain consolidated in the background.');
    return { started: true, status: 'ok', detail: summary, sessionId: result.sessionId };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    releaseFileLock(lockPath);
  }
}

/**
 * Cancel a running background cycle — HUMAN-INVOKED only.
 *
 * Mirrors `killRunGroup`'s stance rather than adding a second one: refuse an
 * implausible pgid, refuse to kill ourselves, and let a person confirm what they
 * are about to kill (the caller does that). There is deliberately no automatic
 * reaper: an unattended negative-PID SIGKILL driven by file contents alone would
 * need identity probes this subsystem has already decided not to build.
 */
export interface CancelAutoSleepResult {
  found: boolean;
  killed: boolean;
  pgid: number | null;
  refusedReason: string | null;
}

export function cancelAutoSleep(
  contextRoot: string,
  opts: { killImpl?: (pid: number, sig: NodeJS.Signals | number) => void } = {},
): CancelAutoSleepResult {
  const kill = opts.killImpl ?? ((pid: number, sig: NodeJS.Signals | number) => { process.kill(pid, sig); });
  const sidecar = readAutoSleepSidecar(contextRoot);
  if (!sidecar) return { found: false, killed: false, pgid: null, refusedReason: null };
  if (sidecar.status !== 'running') {
    return { found: true, killed: false, pgid: sidecar.pgid, refusedReason: `the recorded run already ended (${sidecar.status})` };
  }
  if (!Number.isInteger(sidecar.pgid) || sidecar.pgid <= 1) {
    return { found: true, killed: false, pgid: sidecar.pgid, refusedReason: 'invalid process-group id recorded in the sidecar — refusing to kill' };
  }
  if (sidecar.pgid === process.pid) {
    return { found: true, killed: false, pgid: sidecar.pgid, refusedReason: 'the recorded process group matches the caller itself — refusing to kill' };
  }
  if (!isPidAlive(sidecar.pid)) {
    patchAutoSleepSidecar(contextRoot, { status: 'failed', finishedAt: new Date().toISOString(), error: 'process was already gone when cancel ran' });
    return { found: true, killed: false, pgid: sidecar.pgid, refusedReason: 'that process is already gone — the sidecar has been closed out' };
  }

  try { kill(-sidecar.pgid, 'SIGTERM'); } catch { /* already gone */ }
  try { kill(-sidecar.pgid, 'SIGKILL'); } catch { /* already gone */ }
  patchAutoSleepSidecar(contextRoot, { status: 'cancelled', finishedAt: new Date().toISOString() });
  return { found: true, killed: true, pgid: sidecar.pgid, refusedReason: null };
}


/**
 * Leave one changelog line for a completed background cycle, keyed by the epoch
 * it owned.
 *
 * IDEMPOTENT BY EPOCH: a retry, a resumed dispatcher, or two runners that
 * somehow both reach the end of the same cycle must not append twice. The epoch
 * is the natural key — it is stamped once per cycle and cleared by `sleep done`.
 *
 * Best-effort: the consolidation already happened and its own specialists wrote
 * the real changelog entries. This is the "and it happened while you were away"
 * line, not the record of what changed.
 */
export function recordAutoSleepChangelog(
  contextRoot: string,
  /** The epoch the run owned, or its dispatch `startedAt` — either is unique per cycle. */
  epoch: string | null,
  summary: string,
): boolean {
  if (!epoch) return false;
  const path = join(contextRoot, 'core', 'CHANGELOG.json');
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    const entries: Record<string, unknown>[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.entries) ? parsed.entries : [];
    // Already recorded for this epoch → nothing to do.
    if (entries.some((e) => e && (e as { auto_sleep_epoch?: unknown }).auto_sleep_epoch === epoch)) return false;

    const entry = {
      date: new Date().toISOString().slice(0, 10),
      type: 'chore',
      summary: `Auto sleep: ${summary.replace(/\s+/g, ' ').trim().slice(0, 300) || 'background consolidation completed'}`,
      auto_sleep_epoch: epoch,
    };
    if (Array.isArray(parsed)) {
      writeFileSync(path, JSON.stringify([entry, ...entries], null, 2) + '\n', 'utf-8');
    } else {
      writeFileSync(path, JSON.stringify({ ...parsed, entries: [entry, ...entries] }, null, 2) + '\n', 'utf-8');
    }
    return true;
  } catch {
    return false;
  }
}
