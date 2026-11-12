import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
export function renderStaleRemoteLine(depth: TaskQueueDepth): string {
  const queued = depth.ops > 0
    ? `${depth.ops} change(s) to ${depth.tasks} task(s) queued${depth.oldest ? ` since ${depth.oldest}` : ''}`
    : 'nothing queued yet';
  return `Task sync skipped: the remote board refused the token, so it is stale (${queued}). Renew the task backend token, then run \`dreamcontext tasks sync\`.`;
}
