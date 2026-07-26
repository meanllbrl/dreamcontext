import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureGitignoreEntries } from '../gitignore.js';
import { acquireFileLock, releaseFileLock } from '../file-lock.js';
import { claudeAwarePath, findClaudeBin } from '../claude-path.js';
import { inspectSleepLock } from '../sleep-consolidation.js';
import { readSleepState } from '../../cli/commands/sleep.js';
import { checkApproval } from './registry.js';
import {
  clearRunSidecar,
  getAutomation,
  lockPathFor,
  outputDirFor,
  outputRootDir,
  readRunSidecar,
  recordRun,
  writeRunSidecar,
} from './store.js';
import {
  AUTOMATIONS_GITIGNORE_ENTRIES,
  AUTOMATIONS_GITIGNORE_ENTRIES_ROOT,
  AutomationError,
  KILL_GRACE_MS,
  MAX_PROMPT_BYTES,
  MAX_STDOUT_BYTES,
  SIDECAR_PID_REUSE_WINDOW_MS,
  STDERR_TAIL_BYTES,
  type AutomationCache,
  type AutomationManifest,
  type RunEvent,
  type RunStatus,
} from './types.js';

/**
 * Automations runner — the ONLY code in this subsystem that ever spawns
 * `claude`. Every step below is numbered to match the plan's "Ordered
 * sequence" (§A6): the order is load-bearing (approval before the orphan
 * guard, the orphan guard before the file lock) and was arrived at only after
 * four rounds of adversarial review reproduced real defects in earlier
 * drafts — do not reorder without re-reading that history.
 *
 * `killRunGroup` is the sole EXCEPTION to "runner never kills automatically":
 * it is CLI-only, invoked by a human via `automations kill <slug>`, and is
 * never called from `runAutomation` or `tick`.
 */

// ─── Preamble / prompt composition ──────────────────────────────────────────

export function buildPreamble(m: AutomationManifest, projectRoot: string, fireAt: Date, outputPath: string): string {
  return (
    `You are scheduled dreamcontext automation "${m.title}" in ${projectRoot}. ` +
    'NO user available: never ask, finish autonomously. ' +
    `Fire time ${fireAt.toISOString()}. ` +
    'Brain lives in `_dream_context/`; use the dreamcontext CLI as needed. ' +
    `OUTPUT CONTRACT: your final message is saved verbatim to ${outputPath} — ` +
    'write one complete, self-contained markdown document, with no meta-commentary.'
  );
}

/** Strip NULs, cap at MAX_PROMPT_BYTES. Deliberately does NOT flatten newlines
 *  (unlike `sanitizePrompt` in agent-spawn-shared.ts, which exists for a
 *  readline auto-submit context) — `-p` takes a genuine multi-line argument,
 *  and collapsing it would destroy the manifest author's structure. */
export function sanitizeAutomationPrompt(s: string): string {
  const stripped = s.replace(/\u0000/g, '');
  const buf = Buffer.from(stripped, 'utf-8');
  if (buf.length <= MAX_PROMPT_BYTES) return stripped;
  return buf.subarray(0, MAX_PROMPT_BYTES).toString('utf-8');
}

export function composePrompt(m: AutomationManifest, projectRoot: string, fireAt: Date, outputPath: string): string {
  const parts = [buildPreamble(m, projectRoot, fireAt, outputPath), '', m.prompt.trim()];
  if (m.outputInstructions.trim()) {
    parts.push('', 'Output instructions:', m.outputInstructions.trim());
  }
  return sanitizeAutomationPrompt(parts.join('\n'));
}

/** Local-calendar YYYY-MM-DD (schedules are explicitly machine-local
 *  wall-clock — see the Schedule type — so the output filename's date must
 *  agree with what the user's own clock says "today" is, not UTC). */
function localDateString(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

/** Same-day re-run suffixes `-2`, `-3`, …; never clobbers a prior day's output. */
export function outputPathFor(contextRoot: string, m: AutomationManifest, fireAt: Date): string {
  const { dir } = outputDirFor(contextRoot, m);
  const date = localDateString(fireAt);
  let candidate = join(dir, `${date}.md`);
  let n = 2;
  while (existsSync(candidate)) {
    candidate = join(dir, `${date}-${n}.md`);
    n += 1;
  }
  return candidate;
}

// ─── claude -p --output-format json parsing ─────────────────────────────────

export interface ClaudeResult {
  raw: string;
  parsed: boolean;
  result: string | null;
  isError: boolean;
  sessionId: string | null;
  costUsd: number | null;
  numTurns: number | null;
  durationMs: number | null;
  permissionDenials: number;
  subtype: string | null;
}

const UNPARSEABLE: Omit<ClaudeResult, 'raw'> = {
  parsed: false,
  result: null,
  isError: true,
  sessionId: null,
  costUsd: null,
  numTurns: null,
  durationMs: null,
  permissionDenials: 0,
  subtype: null,
};

/** PURE — never throws. Unparseable JSON or a missing/non-string `result`
 *  both degrade to the same "not parsed" shape; the caller writes the RAW
 *  stdout tail to the output file in that case so nothing is silently lost. */
export function parseClaudeJson(stdout: string): ClaudeResult {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { raw: stdout, ...UNPARSEABLE };
    }
    const p = parsed as Record<string, unknown>;
    const result = typeof p.result === 'string' ? p.result : null;
    if (result === null) return { raw: stdout, ...UNPARSEABLE };
    return {
      raw: stdout,
      parsed: true,
      result,
      isError: p.is_error === true,
      sessionId: typeof p.session_id === 'string' ? p.session_id : null,
      costUsd: typeof p.total_cost_usd === 'number' ? p.total_cost_usd : null,
      numTurns: typeof p.num_turns === 'number' ? p.num_turns : null,
      durationMs: typeof p.duration_ms === 'number' ? p.duration_ms : null,
      permissionDenials: Array.isArray(p.permission_denials) ? p.permission_denials.length : 0,
      subtype: typeof p.subtype === 'string' ? p.subtype : null,
    };
  } catch {
    return { raw: stdout, ...UNPARSEABLE };
  }
}

function buildClaudeArgs(m: AutomationManifest, prompt: string): string[] {
  const args = ['-p', prompt, '--permission-mode', 'bypassPermissions', '--output-format', 'json'];
  if (m.model) args.push('--model', m.model);
  // `effort` is hashed alongside `model` (both execution-envelope levers on an
  // already-approved prompt) and, like `model`, is OMITTED ENTIRELY when
  // null — never a placeholder token — so `claude` picks its own default.
  if (m.effort) args.push('--effort', m.effort);
  return args;
}

// ─── macOS best-effort notification (agent-terminal.ts:169,225 idiom) ───────

function escapeForAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function defaultNotify(title: string, body: string): void {
  if (process.platform !== 'darwin') return;
  try {
    const appleScript = `display notification "${escapeForAppleScript(body)}" with title "${escapeForAppleScript(title)}"`;
    nodeSpawn('osascript', ['-e', appleScript], { stdio: 'ignore' }).on('error', () => { /* best-effort */ });
  } catch {
    /* best-effort */
  }
}

// ─── Output collection + timeout/kill matrix ────────────────────────────────

type KillImpl = (pid: number, signal: NodeJS.Signals | 0) => void;

function attachOutputCollectors(child: ChildProcess) {
  let stdout = Buffer.alloc(0);
  let stderrTail = Buffer.alloc(0);
  child.stdout?.on('data', (chunk: Buffer) => {
    if (stdout.length >= MAX_STDOUT_BYTES) return;
    const room = MAX_STDOUT_BYTES - stdout.length;
    stdout = Buffer.concat([stdout, chunk.subarray(0, room)]);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-STDERR_TAIL_BYTES);
  });
  return {
    getStdout: () => stdout.toString('utf-8'),
    getStderrTail: () => stderrTail.toString('utf-8'),
  };
}

/**
 * Await the child's exit, enforcing the timeout half of the kill matrix
 * (§1.4): SIGTERM at `timeoutMs`, SIGKILL after a further `KILL_GRACE_MS` —
 * the ONLY path that escalates gradually. Every other kill trigger (server
 * shutdown, foreground Ctrl-C, operator `kill`) is an immediate group SIGKILL,
 * implemented at its own call site, not here.
 */
function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
  killFn: KillImpl,
  log: (line: string) => void,
): Promise<{ timedOut: boolean; code: number | null }> {
  return new Promise((resolveWait) => {
    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const pid = child.pid as number;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      log(`automation exceeded its timeout — sending SIGTERM to process group ${pid}`);
      try {
        killFn(-pid, 'SIGTERM');
      } catch {
        /* ESRCH — already gone */
      }
      killTimer = setTimeout(() => {
        try {
          killFn(-pid, 'SIGKILL');
        } catch {
          /* ESRCH — already gone */
        }
      }, KILL_GRACE_MS);
    }, timeoutMs);

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolveWait({ timedOut, code });
    };

    child.on('close', (code) => finish(code));
    // The 'error' event fires asynchronously (agent-terminal.ts:803 precedent);
    // a listener MUST exist regardless, or Node treats an unhandled 'error' on
    // an EventEmitter as an uncaught exception and crashes the whole process.
    child.on('error', () => finish(null));
  });
}

// ─── RunOptions (host discriminated union — see runAutomation) ─────────────

export type SpawnImpl = typeof import('node:child_process').spawn;

interface RunOptionsBase {
  now?: () => Date;
  spawnImpl?: SpawnImpl;
  home?: string;
  /** Bypasses DUENESS (checked by the caller, not here) and sleep-lock
   *  deference ONLY. Never approval, never the orphan guard. */
  force?: boolean;
  fireAt?: Date;
  killImpl?: KillImpl;
  log?: (line: string) => void;
  notify?: (title: string, body: string) => void;
}

type RunHostOpts =
  | { host?: 'cli' }
  | { host: 'server'; registerChild: (killGroup: () => void) => () => void };

export type RunOptions = RunOptionsBase & RunHostOpts;

export interface RunOutcome {
  slug: string;
  status: RunStatus;
  outputPath: string | null;
  error: string | null;
  durationMs: number;
  event: RunEvent | null;
  cache: AutomationCache | null;
  denials: number;
  costUsd: number | null;
}

/**
 * Fixed, non-interpolated — mirrors `OUTPUT_DIR_DEGRADE_REASON` in store.ts.
 * A Node fs error's `.message` (ENOENT/EACCES/ENOSPC) embeds the FULL
 * ABSOLUTE PATH being written to, and this string lands in `RunEvent.error`,
 * a brain-synced record — interpolating it would leak the local OS username
 * and directory layout to every teammate who pulls the brain. The real
 * message goes to `logFn` (machine-local) instead; never here.
 */
export const OUTPUT_WRITE_FAILURE_REASON = 'could not write output file — see the dispatcher log for details';

/**
 * Run one automation to completion (or to whichever gate stops it first).
 * NEVER throws for an operational outcome — every documented disposition
 * (`ok`/`failed`/`timeout`/`blocked`/`deferred`/`orphaned`) is a RESOLVED
 * RunOutcome, so a caller looping over many automations (`tick`) never needs
 * a try/catch around a normal run. It DOES reject (throw, for an async
 * function) on the two precondition violations below — a wrong platform or a
 * broken `host` contract are programmer errors, not run outcomes.
 */
export async function runAutomation(contextRoot: string, slug: string, opts: RunOptions = {}): Promise<RunOutcome> {
  if (process.platform === 'win32') {
    throw new AutomationError(
      'Automations require POSIX process-group signalling (detached spawn + negative-PID kill); Windows is not supported.',
    );
  }
  if (opts.host === 'server' && typeof opts.registerChild !== 'function') {
    throw new AutomationError('host:"server" requires registerChild.');
  }

  const nowFn = opts.now ?? (() => new Date());
  const spawnFn: SpawnImpl = opts.spawnImpl ?? nodeSpawn;
  const killFn: KillImpl = opts.killImpl ?? ((pid, signal) => { process.kill(pid, signal); });
  const logFn = opts.log ?? (() => {});
  const notifyFn = opts.notify ?? defaultNotify;
  const fireAt = opts.fireAt ?? nowFn();
  const home = opts.home;

  // Step 1 — no manifest, no cache write (never manufacture brain-synced state
  // out of a typo'd slug).
  const manifest = getAutomation(contextRoot, slug);
  if (!manifest) {
    return {
      slug,
      status: 'failed',
      outputPath: null,
      error: 'no such automation',
      durationMs: 0,
      event: null,
      cache: null,
      denials: 0,
      costUsd: null,
    };
  }

  const projectRoot = dirname(contextRoot);
  const lockPath = lockPathFor(contextRoot, slug);

  const finalize = (params: {
    status: RunStatus;
    error: string | null;
    outputPath: string | null;
    exitCode: number | null;
    sessionId: string | null;
    costUsd: number | null;
    numTurns: number | null;
    permissionDenials: number;
    startedAt: Date;
    finishedAt: Date;
    durationMs: number;
    advanceWatermark: boolean;
    notify: boolean;
  }): RunOutcome => {
    const event: RunEvent = {
      firedAt: fireAt.toISOString(),
      startedAt: params.startedAt.toISOString(),
      finishedAt: params.finishedAt.toISOString(),
      status: params.status,
      durationMs: params.durationMs,
      outputPath: params.outputPath,
      error: params.error,
      exitCode: params.exitCode,
      sessionId: params.sessionId,
      costUsd: params.costUsd,
      numTurns: params.numTurns,
      permissionDenials: params.permissionDenials,
    };
    const cache = recordRun(contextRoot, slug, event, { advanceWatermark: params.advanceWatermark });
    logFn(`automation "${slug}": ${params.status}${params.error ? ` — ${params.error}` : ''}`);
    if (params.notify && params.status !== 'ok') {
      notifyFn('dreamcontext automation failed', `"${manifest.title}" ${params.status}${params.error ? `: ${params.error}` : ''}`);
    }
    return {
      slug,
      status: params.status,
      outputPath: params.outputPath,
      error: params.error,
      durationMs: params.durationMs,
      event,
      cache,
      denials: params.permissionDenials,
      costUsd: params.costUsd,
    };
  };

  const shortCircuit = (status: RunStatus, error: string): RunOutcome => {
    const n = nowFn();
    return finalize({
      status,
      error,
      outputPath: null,
      exitCode: null,
      sessionId: null,
      costUsd: null,
      numTurns: null,
      permissionDenials: 0,
      startedAt: n,
      finishedAt: n,
      durationMs: 0,
      advanceWatermark: false,
      notify: false,
    });
  };

  // Step 2 — approval. `run --force` bypasses dueness/sleep-deference only —
  // NEVER this gate.
  const approval = checkApproval(projectRoot, manifest, home);
  if (!approval.approved) {
    return shortCircuit(
      'blocked',
      `not approved (${approval.reason}) — run \`dreamcontext automations approve ${slug}\``,
    );
  }

  // Step 3 — sleep-lock deference (skipped under --force).
  if (!opts.force) {
    const lockStatus = inspectSleepLock(readSleepState(contextRoot), nowFn().getTime());
    if (lockStatus.locked && !lockStatus.stale) {
      return shortCircuit('deferred', 'a sleep consolidation is in progress');
    }
  }

  // Step 4 — orphan guard, BEFORE the file lock. `file-lock.ts`'s staleness
  // check is age-based and runs before its own liveness probe, so a dead
  // runner's lock stays unreclaimable for ~20–65 min (timeoutMinutes + 5min).
  // A guard placed AFTER the lock would report a misleading `deferred` for
  // that whole window instead of the truth — this ordering was the single
  // most-reviewed invariant in this file's design history.
  const sidecar = readRunSidecar(contextRoot, slug);
  if (sidecar) {
    let childAlive = false;
    try {
      killFn(sidecar.childPgid, 0);
      childAlive = true;
    } catch {
      childAlive = false;
    }
    let runnerAlive = true;
    try {
      killFn(sidecar.runnerPid, 0);
    } catch (err) {
      runnerAlive = (err as NodeJS.ErrnoException)?.code !== 'ESRCH';
    }
    if (childAlive && !runnerAlive) {
      return shortCircuit(
        'orphaned',
        `previous run's child group (pgid ${sidecar.childPgid}) is still alive — run \`dreamcontext automations kill ${slug}\` first`,
      );
    }
  }

  // Step 5 — the per-slug run lock (self-overlap guard).
  const staleMs = manifest.timeoutMinutes * 60_000 + 300_000;
  const gotLock = acquireFileLock(lockPath, nowFn().getTime(), staleMs, { verifyPidLiveness: true });
  if (!gotLock) {
    return shortCircuit('deferred', 'a run for this automation is already in progress');
  }

  let untrackFn: (() => void) | null = null;
  let sigintHandler: (() => void) | null = null;
  let sigtermHandler: (() => void) | null = null;

  try {
    // Step 6 — governing .gitignore (best-effort; a hand-synced manifest may
    // never have gone through `createAutomation`) + mkdir the output dir.
    const { dir: outDir, degradeReason } = outputDirFor(contextRoot, manifest);
    try {
      ensureGitignoreEntries(contextRoot, AUTOMATIONS_GITIGNORE_ENTRIES, {
        comment: 'dreamcontext automations — machine-local run state (never commit)',
      });
      ensureGitignoreEntries(projectRoot, AUTOMATIONS_GITIGNORE_ENTRIES_ROOT, {
        comment: 'dreamcontext automations — machine-local run state (never commit)',
      });
    } catch (err) {
      logFn(`warning: could not ensure automations gitignore entries: ${(err as Error).message}`);
    }
    mkdirSync(outDir, { recursive: true });
    mkdirSync(outputRootDir(contextRoot), { recursive: true });

    const outputPath = outputPathFor(contextRoot, manifest, fireAt);
    const prompt = composePrompt(manifest, projectRoot, fireAt, outputPath);

    // Step 7 — spawn. Reuses the agent-terminal.ts template exactly: direct
    // bin when found, else a login shell with the prompt as a positional
    // (never string-interpolated) — plus claudeAwarePath() so a claude that
    // only ~/.local/bin knows about still resolves.
    const claudeBin = findClaudeBin();
    const claudeArgs = buildClaudeArgs(manifest, prompt);
    const spawnOptions: Parameters<SpawnImpl>[2] = {
      cwd: projectRoot,
      env: { ...process.env, PATH: claudeAwarePath() },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    };
    const child: ChildProcess = claudeBin
      ? spawnFn(claudeBin, claudeArgs, spawnOptions)
      : spawnFn(process.env.SHELL || '/bin/zsh', ['-ilc', 'exec claude "$@"', 'claude', ...claudeArgs], spawnOptions);
    // Async 'error' events (agent-terminal.ts:803) must always have a
    // listener even though spawn-failure detection below is synchronous —
    // an unhandled 'error' event crashes the whole Node process.
    child.on('error', () => { /* handled via the pid check + waitForExit below */ });

    const startedAt = nowFn();

    // Step 8 — spawn-failure gate. Synchronous, immediately after spawnFn
    // returns: `child.pid` is `undefined` when the exec itself failed. Given
    // §1.1's whole premise, a stale/broken binary is the LIKELY case here,
    // not an edge case.
    if (child.pid == null) {
      return finalize({
        status: 'failed',
        error: 'spawn failed — the claude binary could not be launched',
        outputPath: null,
        exitCode: null,
        sessionId: null,
        costUsd: null,
        numTurns: null,
        permissionDenials: 0,
        startedAt,
        finishedAt: nowFn(),
        durationMs: 0,
        advanceWatermark: false,
        notify: true,
      });
    }

    // Step 9 — success: write the sidecar SYNCHRONOUSLY, before any await, so
    // an orphan is findable no matter how soon afterward the runner itself
    // might die.
    const timeoutMs = manifest.timeoutMinutes * 60_000;
    const timeoutAt = new Date(startedAt.getTime() + timeoutMs);
    writeRunSidecar(contextRoot, slug, {
      slug,
      runnerPid: process.pid,
      childPid: child.pid,
      childPgid: child.pid, // detached ⇒ setsid() ⇒ pgid === pid
      fireAt: fireAt.toISOString(),
      startedAt: startedAt.toISOString(),
      timeoutAt: timeoutAt.toISOString(),
    });

    // Step 10 — host wiring.
    if (opts.host === 'server') {
      const killGroup = (): void => {
        try {
          killFn(-(child.pid as number), 'SIGKILL');
        } catch {
          /* ESRCH — already gone */
        }
      };
      untrackFn = opts.registerChild(killGroup);
    } else {
      sigintHandler = () => {
        try {
          killFn(-(child.pid as number), 'SIGKILL');
        } catch {
          /* ESRCH */
        }
        releaseFileLock(lockPath);
        process.exit(130);
      };
      sigtermHandler = () => {
        try {
          killFn(-(child.pid as number), 'SIGKILL');
        } catch {
          /* ESRCH */
        }
        releaseFileLock(lockPath);
        process.exit(143);
      };
      process.on('SIGINT', sigintHandler);
      process.on('SIGTERM', sigtermHandler);
    }

    // Steps 11–12 — collect output, wait (with the timeout half of the kill
    // matrix), then parse.
    const collectors = attachOutputCollectors(child);
    const { timedOut, code } = await waitForExit(child, timeoutMs, killFn, logFn);
    const finishedAt = nowFn();
    const measuredMs = finishedAt.getTime() - startedAt.getTime();

    let status: RunStatus;
    let error: string | null = null;
    let claudeResult: ClaudeResult | null = null;
    let finalOutputPath: string | null = null;
    let durationMs = measuredMs;

    if (timedOut) {
      status = 'timeout';
      error = `automation exceeded its ${manifest.timeoutMinutes}-minute timeout`;
      // No coherent document exists (the child was force-killed mid-flight,
      // same reasoning as the operator-kill path) — outputPath stays null.
    } else {
      claudeResult = parseClaudeJson(collectors.getStdout());
      if (!claudeResult.parsed) {
        status = 'failed';
        error = 'unparseable CLI output';
        try {
          writeFileSync(outputPath, collectors.getStdout(), 'utf-8');
          finalOutputPath = outputPath;
        } catch (err) {
          logFn(`warning: could not write raw output for "${slug}": ${(err as Error).message}`);
        }
      } else {
        status = claudeResult.isError ? 'failed' : 'ok';
        if (status === 'failed') {
          error = collectors.getStderrTail() || 'claude reported is_error: true';
        }
        try {
          writeFileSync(outputPath, claudeResult.result ?? '', 'utf-8');
          finalOutputPath = outputPath;
        } catch (err) {
          status = 'failed';
          error = OUTPUT_WRITE_FAILURE_REASON;
          logFn(`automation "${slug}": output write failed: ${(err as Error).message}`);
        }
        if (typeof claudeResult.durationMs === 'number') durationMs = claudeResult.durationMs;
      }
    }

    // `outputDir` is an approval-hashed field, so an approved value is
    // trusted forever — a run-time containment rejection degrades to the
    // default rather than failing the whole run, but must still be
    // SURFACED, not silently absorbed. It rides `error` even on an otherwise
    // `ok` run (dashboard badges key off `status`, never `error != null`).
    if (degradeReason) {
      error = error ? `${degradeReason} | ${error}` : degradeReason;
    }

    return finalize({
      status,
      error,
      outputPath: finalOutputPath,
      exitCode: code,
      sessionId: claudeResult?.sessionId ?? null,
      costUsd: claudeResult?.costUsd ?? null,
      numTurns: claudeResult?.numTurns ?? null,
      permissionDenials: claudeResult?.permissionDenials ?? 0,
      startedAt,
      finishedAt,
      durationMs,
      advanceWatermark: true,
      notify: true,
    });
  } finally {
    if (opts.host === 'server') {
      untrackFn?.();
    } else {
      if (sigintHandler) process.off('SIGINT', sigintHandler);
      if (sigtermHandler) process.off('SIGTERM', sigtermHandler);
    }
    releaseFileLock(lockPath);
    // Clear the sidecar ONLY when it is this exact invocation's own record.
    // A spawn-failure return above never wrote one (runnerPid never matches),
    // so this never erases a DIFFERENT, still-live orphan's only record.
    const currentSidecar = readRunSidecar(contextRoot, slug);
    if (currentSidecar && currentSidecar.runnerPid === process.pid) {
      clearRunSidecar(contextRoot, slug);
    }
  }
}

// ─── killRunGroup — CLI-ONLY, never called by runAutomation or tick ────────

export interface KillRunResult {
  found: boolean;
  killed: boolean;
  childPgid: number | null;
  ageMs: number | null;
  runnerAlive: boolean;
  groupAlive: boolean;
  refusedReason: string | null;
}

/**
 * The operator's `automations kill <slug>` — the ONLY path in this subsystem
 * that ever kills a process group without a human directly invoking it right
 * now. There is deliberately no automatic reaper (see §1.4): an unattended
 * process issuing a negative-PID SIGKILL from file contents alone would need
 * a `ps` identity probe, `/proc` start-time parsing, and a lockfile around
 * its own cache write — three mechanisms defending one. A human confirming
 * what they are about to kill replaces all three.
 */
export function killRunGroup(
  contextRoot: string,
  slug: string,
  opts?: { killImpl?: KillImpl; nowMs?: number; force?: boolean; log?: (l: string) => void },
): KillRunResult {
  const killFn: KillImpl = opts?.killImpl ?? ((pid, signal) => { process.kill(pid, signal); });
  const nowMs = opts?.nowMs ?? Date.now();
  const logFn = opts?.log ?? (() => {});

  const sidecar = readRunSidecar(contextRoot, slug);
  if (!sidecar) {
    return { found: false, killed: false, childPgid: null, ageMs: null, runnerAlive: false, groupAlive: false, refusedReason: null };
  }

  // Guard 2 — defence in depth. `readRunSidecar` already enforces this
  // (childPgid/runnerPid are integers > 1) before ever returning non-null;
  // re-asserted here so this function stays safe even if that upstream
  // guarantee is ever loosened. Node has no portable `getpgid`, so "the
  // caller's own pgid" is checked as `=== process.pid` only (a detached
  // child's pgid equals its own pid, so this still catches the direct
  // self-reference case without shelling out to `ps` for a full pgid probe).
  if (!Number.isInteger(sidecar.childPgid) || sidecar.childPgid <= 1) {
    return {
      found: true,
      killed: false,
      childPgid: sidecar.childPgid,
      ageMs: null,
      runnerAlive: false,
      groupAlive: false,
      refusedReason: 'invalid process-group id recorded in the sidecar — refusing to kill',
    };
  }
  if (sidecar.childPgid === process.pid) {
    return {
      found: true,
      killed: false,
      childPgid: sidecar.childPgid,
      ageMs: null,
      runnerAlive: false,
      groupAlive: false,
      refusedReason: 'the recorded process group matches the caller itself — refusing to kill',
    };
  }

  const probe = (pid: number): boolean => {
    try {
      killFn(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException)?.code !== 'ESRCH';
    }
  };
  const runnerAlive = probe(sidecar.runnerPid);
  const groupAlive = probe(sidecar.childPgid);
  const startedMs = Date.parse(sidecar.startedAt);
  const ageMs = Number.isFinite(startedMs) ? nowMs - startedMs : null;

  // Guard 3 — lock-pid cross-check. The same legitimate runner wrote both the
  // lock and the sidecar, near-simultaneously, so a mismatch means forged or
  // stale content. KNOWN RESIDUAL: if the lock is already gone (the runner
  // released it but died before clearing the sidecar), this check is
  // skipped — inherent, covered by the human confirming pgid/age below.
  const lockPath = lockPathFor(contextRoot, slug);
  if (existsSync(lockPath)) {
    let lockPid: number | null = null;
    try {
      const info = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid?: unknown };
      if (typeof info.pid === 'number') lockPid = info.pid;
    } catch {
      /* unreadable lock — treat as no cross-check available */
    }
    if (lockPid !== null && lockPid !== sidecar.runnerPid) {
      return {
        found: true,
        killed: false,
        childPgid: sidecar.childPgid,
        ageMs,
        runnerAlive,
        groupAlive,
        refusedReason: 'the sidecar does not match the current run lock — refusing to kill',
      };
    }
  }

  // Guard 4 — age / --force (a recorded pgid past this window may have been
  // recycled by the OS to an unrelated process).
  if (ageMs !== null && ageMs > SIDECAR_PID_REUSE_WINDOW_MS && !opts?.force) {
    return {
      found: true,
      killed: false,
      childPgid: sidecar.childPgid,
      ageMs,
      runnerAlive,
      groupAlive,
      refusedReason: `the sidecar is ${Math.round(ageMs / 60_000)} minutes old — the recorded pgid may have been recycled; pass --force to kill anyway`,
    };
  }

  // Guard 5 — kill. ESRCH (already gone) is swallowed, same as everywhere else.
  try {
    killFn(-sidecar.childPgid, 'SIGKILL');
  } catch {
    /* already gone */
  }

  // Guard 6 — record. Every RunEvent field pinned explicitly (12 required,
  // strict:true — no partial literal compiles).
  const event: RunEvent = {
    firedAt: sidecar.fireAt,
    startedAt: sidecar.startedAt,
    finishedAt: new Date(nowMs).toISOString(),
    status: 'failed', // not 'timeout' — no deadline elapsed; a human intervened
    durationMs: Number.isFinite(startedMs) ? nowMs - startedMs : 0,
    outputPath: null, // the runner only writes output after a normal exit + parse
    error: 'run group killed by operator',
    exitCode: null, // the runner that would have observed the exit is dead
    sessionId: null, // lives in stdout JSON, never collected
    costUsd: null,
    numTurns: null,
    permissionDenials: 0, // "not collected", never "none occurred" on this path
  };
  recordRun(contextRoot, slug, event, { advanceWatermark: true });
  logFn(`automation "${slug}": operator killed process group ${sidecar.childPgid}`);

  // Guard 7 — clear.
  clearRunSidecar(contextRoot, slug);

  return { found: true, killed: true, childPgid: sidecar.childPgid, ageMs, runnerAlive, groupAlive, refusedReason: null };
}
