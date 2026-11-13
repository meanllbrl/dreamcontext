import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import matter from 'gray-matter';
import { findPackageDir } from './catalog.js';
import { SLEEP_SPECIALISTS, type SleepSpecialist } from './setup-config.js';
import { TASKS_QUEUE_REL } from './task-backend/paths.js';

/**
 * Small deterministic helpers for one sleep cycle: what each specialist runs on
 * (`sleep start` prints it so the dispatcher passes exactly that), how long each
 * phase of `sleep done` took, the detached embedding refresh, and the task-sync
 * queue a failed remote leaves behind.
 */

// ─── Dispatch table (SL-12) ───────────────────────────────────────────────────

export interface SpecialistDispatchRow {
  name: SleepSpecialist;
  /** The model id in the agent file's frontmatter, or null when it pins none. */
  model: string | null;
  /** The Agent tool's `model` value for it (`opus`, `sonnet`, `haiku`), or null. */
  alias: string | null;
  effort: string | null;
}

/** Agent tool model alias for a full id: `claude-sonnet-5` → `sonnet`. Unknown → null. */
export function agentModelAlias(model: string | null): string | null {
  if (!model) return null;
  const m = model.toLowerCase();
  for (const alias of ['opus', 'sonnet', 'haiku', 'fable']) {
    if (m === alias || m.includes(alias)) return alias;
  }
  return null;
}

function readAgentPins(path: string): { model: string | null; effort: string | null } | null {
  try {
    const data = matter(readFileSync(path, 'utf-8')).data as Record<string, unknown>;
    return {
      model: typeof data.model === 'string' && data.model.trim() ? data.model.trim() : null,
      effort: typeof data.effort === 'string' && data.effort.trim() ? data.effort.trim() : null,
    };
  } catch {
    return null;
  }
}

/**
 * What each specialist is configured to run on, read from the INSTALLED agent file
 * (`.claude/agents/<name>.md`, where the brain's Sleep settings are already applied),
 * else the packaged copy. A specialist with no readable file gets a row of nulls:
 * the table says "no pin" rather than guessing.
 */
export function specialistDispatchTable(
  projectRoot: string,
  packagedAgentsDir: string | null = findPackageDir('agents'),
): SpecialistDispatchRow[] {
  return SLEEP_SPECIALISTS.map((name) => {
    const installed = join(projectRoot, '.claude', 'agents', `${name}.md`);
    const packaged = packagedAgentsDir ? join(packagedAgentsDir, `${name}.md`) : null;
    const pins = (existsSync(installed) ? readAgentPins(installed) : null)
      ?? (packaged && existsSync(packaged) ? readAgentPins(packaged) : null)
      ?? { model: null, effort: null };
    return { name, model: pins.model, alias: agentModelAlias(pins.model), effort: pins.effort };
  });
}

/** One line per specialist, for `sleep start`'s human output. */
export function renderDispatchTable(rows: SpecialistDispatchRow[]): string[] {
  const lines = ['Dispatch each specialist on the model its agent file pins (pass exactly this as the Agent tool `model`):'];
  for (const r of rows) {
    const model = r.alias ? `model "${r.alias}"` : 'no model pinned (pass none)';
    const effort = r.effort ? `, effort ${r.effort}` : '';
    lines.push(`  ${r.name}: ${model}${effort}${r.model && r.alias ? ` (${r.model})` : ''}`);
  }
  return lines;
}

// ─── Phase timing (SL-11) ─────────────────────────────────────────────────────

export interface PhaseTimer {
  /** Close the phase that ran since the previous lap (or creation) under `name`. */
  lap(name: string): void;
  phases(): Array<{ name: string; ms: number }>;
  /** `Phases (41ms): state 12ms · flags 3ms · …` — null when nothing was lapped. */
  line(): string | null;
}

export function createPhaseTimer(now: () => number = () => performance.now()): PhaseTimer {
  const recorded: Array<{ name: string; ms: number }> = [];
  let last = now();
  return {
    lap(name: string) {
      const t = now();
      recorded.push({ name, ms: Math.round(t - last) });
      last = t;
    },
    phases: () => recorded.slice(),
    line() {
      if (recorded.length === 0) return null;
      const total = recorded.reduce((a, p) => a + p.ms, 0);
      return `Phases (${total}ms): ${recorded.map((p) => `${p.name} ${p.ms}ms`).join(' · ')}`;
    },
  };
}

// ─── Detached embedding refresh (SL-11) ───────────────────────────────────────

/**
 * Start `embed refresh --force --if-present` as a detached child and return at once.
 * `sleep done` used to await this (seconds of model load and embedding); recall
 * refreshes lazily per query anyway, so a few seconds of staleness right after a
 * sleep costs nothing. The child env drops tab identity, like the cloud refresh.
 */
export function spawnEmbeddingRefresh(
  projectRoot: string,
  launch: (cliEntry: string, cwd: string, env: NodeJS.ProcessEnv) => void = defaultEmbedLaunch,
  cliEntry: string | undefined = process.argv[1],
): boolean {
  if (!cliEntry) return false;
  const env = { ...process.env };
  delete env.DREAMCONTEXT_TAB_SESSION;
  delete env.CLAUDE_CODE_SESSION_ID;
  launch(cliEntry, projectRoot, env);
  return true;
}

function defaultEmbedLaunch(cliEntry: string, cwd: string, env: NodeJS.ProcessEnv): void {
  const child = spawn(process.execPath, [cliEntry, 'embed', 'refresh', '--force', '--if-present'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd,
    env,
  });
  child.unref();
}

// ─── Task-sync queue (SL-7) ───────────────────────────────────────────────────

export interface TaskQueueDepth {
  ops: number;
  tasks: number;
  /** ISO date (YYYY-MM-DD) of the oldest queued op, or null for an empty queue. */
  oldest: string | null;
}

/** How much local task work is waiting for the remote board. Never throws. */
export function readTaskQueueDepth(contextRoot: string): TaskQueueDepth {
  try {
    const path = join(contextRoot, TASKS_QUEUE_REL);
    if (!existsSync(path)) return { ops: 0, tasks: 0, oldest: null };
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    const ops = Array.isArray(parsed) ? parsed.filter((o) => o && typeof o === 'object') as Array<{ slug?: unknown; ts?: unknown }> : [];
    const slugs = new Set(ops.map((o) => (typeof o.slug === 'string' ? o.slug : '')).filter(Boolean));
    const stamps = ops.map((o) => (typeof o.ts === 'number' && Number.isFinite(o.ts) ? o.ts : null)).filter((t): t is number => t !== null);
    const oldest = stamps.length ? new Date(Math.min(...stamps)).toISOString().slice(0, 10) : null;
    return { ops: ops.length, tasks: slugs.size, oldest };
  } catch {
    return { ops: 0, tasks: 0, oldest: null };
  }
}

/**
 * True when a sync error message is the remote refusing the CREDENTIAL: a 401, or
 * a 403 that names bad credentials. A 403 about a rate limit (GitHub answers its
 * limits with 403) or one repo's permission is not a dead token.
 */
export function isSyncAuthFailure(message: string): boolean {
  if (/rate limit|abuse/i.test(message)) return false;
  return /Authentication failed \(401\)/.test(message)
    || /\b401\b.*(credential|unauthori[sz]ed)/i.test(message)
    || /\b403\b.*bad credentials/i.test(message);
}

/**
 * The remote refused the token for the WHOLE sync: nothing moved either way and
 * every error is a credential refusal. Only then is a retry pointless; a single
 * task's refusal keeps the normal retry and error report.
 */
export function isTokenRefused(report: { errors: string[]; pushed: number; created: number; pulled: number }): boolean {
  return report.errors.length > 0
    && report.pushed + report.created + report.pulled === 0
    && report.errors.every(isSyncAuthFailure);
}

/** The line `sleep done` prints when the remote refused the token. */
export function renderStaleRemoteLine(depth: TaskQueueDepth, backend?: string, source?: 'project' | 'global' | 'env' | null): string {
  const queued = depth.ops > 0
    ? `${depth.ops} change(s) to ${depth.tasks} task(s) queued${depth.oldest ? ` since ${depth.oldest}` : ''}`
    : 'nothing queued yet';
  if (backend === 'github') {
    // No token to create, no command to run: the sign-in heals it and the queue drains itself.
    // Name the credential GitHub refused (task criterion 1): the sign-in, the project's own
    // token (no working sign-in took over), or a token set outside the app.
    const refused = source === 'project' ? "this project's own GitHub token"
      : source === 'env' ? 'the GitHub token set outside the app'
      : 'your GitHub sign-in';
    return `Task sync stopped: GitHub no longer accepts ${refused}, so the board is stale (${queued}). Reconnect in Settings → GitHub → Reconnect; the queue syncs on its own after.`;
  }
  return `Task sync skipped: the remote board refused the token, so it is stale (${queued}). Renew the task backend token, then run \`dreamcontext tasks sync\`.`;
}

// ─── Closing-step bound and the background task sync ─────────────────────────

/**
 * How long `sleep done` may spend, in total, on its closing steps that wait on
 * something outside this process (the task backend, git, the marketing lock).
 * The debt is already recorded by then: past this budget a step is reported as
 * skipped and `sleep done` prints its report and exits, instead of going silent.
 * `DREAMCONTEXT_SLEEP_DONE_BUDGET_MS` overrides it (tests, a slow machine).
 */
export const SLEEP_DONE_BUDGET_MS = 90_000;

export function sleepDoneBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.DREAMCONTEXT_SLEEP_DONE_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : SLEEP_DONE_BUDGET_MS;
}

export type BoundedResult<T> = { done: true; value: T } | { done: false };

/**
 * Wait for `work` at most `ms`. A step that is still running then is LEFT running
 * (it cannot be cancelled from here) and reported as not done; its later failure
 * is swallowed so it never surfaces as an unhandled rejection. The timer is
 * unref'd, so a step that finishes early never holds the process open.
 */
export async function runBounded<T>(work: () => Promise<T>, ms: number): Promise<BoundedResult<T>> {
  const running = Promise.resolve().then(work);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<BoundedResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), Math.max(0, ms));
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([running.then((value) => ({ done: true as const, value })), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    running.catch(() => { /* reported by the caller's own try, or abandoned past the budget */ });
  }
}

/** Where the background post-sleep sync writes its report (overwritten each run). */
export const POST_SLEEP_SYNC_LOG_REL = join('tmp', 'sleep', 'sync.log');

/** The line the child prints between the brain sync's report and the task sync's. */
export const BRAIN_SYNC_DONE_MARK = '· brain sync finished ·';

export interface PostSleepSyncChild {
  logPath: string;
  /** True while the child process has not exited. */
  running: () => boolean;
}

/**
 * Start the post-sleep syncs (`sleep sync-after`: brain sync, then the task sync)
 * as ONE detached child whose output goes to {@link POST_SLEEP_SYNC_LOG_REL}, and
 * return at once. Neither may hold `sleep done` open: git runs synchronously under
 * multi-minute ceilings, and a remote board paces a backlog of a few hundred tasks
 * under its rate limit for many minutes. Awaited in-process, an agent's command
 * timeout killed `sleep done` before it printed anything and before the backlog
 * could ever drain. Null when no CLI entry is known (then nothing was started).
 */
export function spawnPostSleepSync(
  projectRoot: string,
  contextRoot: string,
  launch: (cliEntry: string, cwd: string, env: NodeJS.ProcessEnv, logPath: string) => () => boolean = defaultPostSleepSyncLaunch,
  cliEntry: string | undefined = process.argv[1],
): PostSleepSyncChild | null {
  if (!cliEntry) return null;
  const logPath = join(contextRoot, POST_SLEEP_SYNC_LOG_REL);
  const env = { ...process.env };
  delete env.DREAMCONTEXT_TAB_SESSION;
  delete env.CLAUDE_CODE_SESSION_ID;
  return { logPath, running: launch(cliEntry, projectRoot, env, logPath) };
}

function defaultPostSleepSyncLaunch(cliEntry: string, cwd: string, env: NodeJS.ProcessEnv, logPath: string): () => boolean {
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'w');
  try {
    const child = spawn(process.execPath, [cliEntry, 'sleep', 'sync-after'], {
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      cwd,
      env,
    });
    let exited = false;
    child.once('exit', () => { exited = true; });
    child.once('error', () => { exited = true; });
    child.unref();
    return () => !exited;
  } finally {
    closeSync(fd);
  }
}

function readLog(logPath: string): string {
  try {
    // eslint-disable-next-line no-control-regex
    return existsSync(logPath) ? readFileSync(logPath, 'utf-8').replace(/\u001b\[[0-9;]*m/g, '') : '';
  } catch {
    return '';
  }
}

/**
 * Wait, without blocking the event loop, until the child has printed
 * {@link BRAIN_SYNC_DONE_MARK} (`done`), exited without it (`exited`), or the
 * deadline passed (`timeout`: the child is LEFT running and finishes on its own).
 */
export async function waitForBrainSync(
  logPath: string,
  deadline: number,
  running: () => boolean,
  pollMs = 200,
  now: () => number = () => Date.now(),
): Promise<'done' | 'exited' | 'timeout'> {
  for (;;) {
    if (readLog(logPath).includes(BRAIN_SYNC_DONE_MARK)) return 'done';
    if (!running()) return readLog(logPath).includes(BRAIN_SYNC_DONE_MARK) ? 'done' : 'exited';
    if (now() >= deadline) return 'timeout';
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** The brain sync's report lines: what the child printed before the mark, minus its start line. */
export function readBrainSyncSection(logPath: string): string[] {
  const text = readLog(logPath);
  const cut = text.indexOf(BRAIN_SYNC_DONE_MARK);
  return (cut >= 0 ? text.slice(0, cut) : text)
    .split('\n')
    .filter((l) => l.trim() && !/Post-sleep sync started/.test(l));
}

/**
 * What the PREVIOUS background sync reported that the owner must not miss: its
 * warning and error lines (a brain sync that failed after \`sleep done\` stopped
 * waiting, a refused token, an incomplete push). ANSI stripped; empty when the log
 * is missing or the run was clean.
 */
export function readPostSleepSyncFindings(contextRoot: string, max = 6): string[] {
  return readLog(join(contextRoot, POST_SLEEP_SYNC_LOG_REL))
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && /^[✗⚠]|INCOMPLETE|stopped|skipped|error|stale/i.test(l))
    .slice(0, max);
}
