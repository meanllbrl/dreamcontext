import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectSleepLock, type SleepState } from './sleep-consolidation.js';
import { readSetupConfig } from './setup-config.js';
import { resolveMaxNewTasksPerCycle } from './sleep-settings.js';
import { resolveTombstone } from './task-tombstones.js';

/**
 * task-filing-bar — the ONE gate every writer passes before a sleep cycle is
 * allowed to open a new task.
 *
 * WHY A DETERMINISTIC GATE AT ALL. `agents/sleep-tasks.md` describes the bar in
 * prose, and prose is necessary — judging whether a task is worth filing is a
 * judgement. But prose is not SUFFICIENT: a specialist that forgets the rule,
 * or a future one that never read it, still writes to disk. So the rule that
 * can be checked mechanically is checked mechanically.
 *
 * WHAT THE NUMBERS MEAN. B0 audited all 116 tasks this brain created since
 * 2026-08-01: the thinnest REAL task carries 146 characters of justification,
 * the median 2,532, and exactly ONE task had none at all — the auto-filed
 * curator chore, born from an empty template and resurrected every cycle. So
 * the 40-character floor here is deliberately far below the observed floor of
 * real work: it is a guard against the EMPTY TEMPLATE, not a quality judge.
 * Quality is the prompt's job; this is the thing prose cannot guarantee.
 *
 * ONE CHOKE POINT, BY CONSTRUCTION. Both `dreamcontext tasks create` and the
 * dashboard's `POST /api/tasks` call this. `LocalTaskBackend.create` stays
 * actor-free — it is the storage layer. A THIRD caller that files tasks must
 * call this too; there is no other enforcement point.
 */

/** Minimum justification for a task filed by a sleep cycle. See the note above. */
export const MIN_SLEEP_WHY_CHARS = 40;

export type FilingActor = 'human' | 'sleep' | 'unknown';

export interface FilingBarInput {
  /** The brain root (`_dream_context/`). */
  contextRoot: string;
  /** Who is filing. `unknown` is treated as sleep WHEN a cycle is live. */
  actor: FilingActor;
  /** The justification prose (`--why`). */
  why?: string | null;
  /** The slug this task would land on, when it is already known. */
  slug?: string;
  /** Injected for tests; defaults to now. */
  nowMs?: number;
}

export interface FilingBarVerdict {
  allowed: boolean;
  /** Present when `allowed` is false — a message that names the rule AND the escape hatch. */
  reason?: string;
  /** True when the bar actually applied (a cycle is live / the env flag is set). */
  underBar: boolean;
}

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
 * Is a sleep cycle running right now?
 *
 * Liveness-aware: a STALE epoch (the owning sleep crashed before `sleep done`)
 * does not count, or a crash would leave the bar switched on forever.
 */
export function isSleepCycleLive(contextRoot: string, nowMs = Date.now()): boolean {
  if (process.env.DREAMCONTEXT_AUTO_SLEEP === '1') return true;
  const state = readSleepStateSafe(contextRoot);
  if (!state) return false;
  const lock = inspectSleepLock(state, nowMs);
  return lock.locked && !lock.stale;
}

/** How many tasks THIS cycle has already filed under the bar. */
export function cycleTasksFiled(contextRoot: string): string[] {
  const state = readSleepStateSafe(contextRoot) as (SleepState & { cycle_tasks_filed?: unknown }) | null;
  const filed = state?.cycle_tasks_filed;
  return Array.isArray(filed) ? filed.filter((s): s is string => typeof s === 'string') : [];
}

/**
 * Decide whether this task may be filed.
 *
 * The bar applies when a sleep cycle is LIVE (or `DREAMCONTEXT_AUTO_SLEEP=1`)
 * UNLESS the caller is an explicit human. That deliberately catches a
 * specialist that forgot to pass `--by sleep` — the lock is the evidence, not
 * the flag — while a person working during a cycle gets ONE clear refusal
 * naming the escape hatch rather than a silent block.
 */
export function assertTaskFilingBar(input: FilingBarInput): FilingBarVerdict {
  const { contextRoot, actor, why, slug } = input;
  const nowMs = input.nowMs ?? Date.now();

  // An explicit human is never under the bar, cycle or not.
  if (actor === 'human') return { allowed: true, underBar: false };
  if (!isSleepCycleLive(contextRoot, nowMs) && actor !== 'sleep') {
    return { allowed: true, underBar: false };
  }
  // `--by sleep` outside a live cycle: still hold the bar. A specialist that
  // names itself is taken at its word.
  if (!isSleepCycleLive(contextRoot, nowMs) && actor === 'sleep') {
    return checkContent({ contextRoot, why, slug, cap: capFor(contextRoot), filed: cycleTasksFiled(contextRoot), actor });
  }

  return checkContent({ contextRoot, why, slug, cap: capFor(contextRoot), filed: cycleTasksFiled(contextRoot), actor });
}

function capFor(contextRoot: string): number {
  // contextRoot is `<project>/_dream_context`; the config lives under it.
  return resolveMaxNewTasksPerCycle(readSetupConfig(join(contextRoot, '..'))?.sleep);
}

function checkContent(args: {
  contextRoot: string;
  why?: string | null;
  slug?: string;
  cap: number;
  filed: string[];
  actor: FilingActor;
}): FilingBarVerdict {
  const { contextRoot, why, slug, cap, filed, actor } = args;
  const hatch = actor === 'unknown'
    ? ' If this is your OWN task and not the cycle\'s, pass `--by human`.'
    : '';

  // 1. The cap. Checked FIRST so a cycle at its limit gets the cap message
  //    rather than being told to write a better Why for a task it cannot file.
  if (filed.length >= cap) {
    return {
      allowed: false,
      underBar: true,
      reason: cap === 0
        ? 'This brain files no tasks during sleep (max new tasks per cycle = 0). '
          + 'List the candidate in your report instead.' + hatch
        : `Cap reached — this cycle has already filed ${filed.length}/${cap} tasks. `
          + 'List the candidate in your report under "Candidates NOT filed (cap)" rather than dropping it. '
          + 'Raise the cap with `dreamcontext sleep config set max-new-tasks <n>`.' + hatch,
    };
  }

  // 2. A justification that is actually there.
  const trimmed = (why ?? '').trim();
  if (trimmed.length < MIN_SLEEP_WHY_CHARS) {
    return {
      allowed: false,
      underBar: true,
      reason: `A task filed during a sleep cycle needs a --why of at least ${MIN_SLEEP_WHY_CHARS} characters `
        + `naming the user, the friction and the cost (got ${trimmed.length}). `
        + 'A task nobody can justify is one nobody will do — record it as a bookmark or a memory instead.' + hatch,
    };
  }

  // 3. Nothing that was deliberately consolidated away.
  if (slug) {
    const resolved = resolveTombstone(contextRoot, slug);
    if (resolved.tombstone && resolved.livingSlug) {
      return {
        allowed: false,
        underBar: true,
        reason: `"${slug}" was retired and its work absorbed by "${resolved.livingSlug}" `
          + `(${resolved.chain.join(' → ')}). Log there instead of re-filing it. `
          + 'See `dreamcontext tasks tombstones`.' + hatch,
      };
    }
  }

  return { allowed: true, underBar: true };
}

/**
 * Record that a task was filed UNDER THE BAR, so the cap counts it.
 *
 * Written into `.sleep.json` `cycle_tasks_filed` — the same file the cycle's
 * epoch lives in, so the counter and the lock are cleared together by
 * `sleep done` and can never disagree about which cycle is current.
 *
 * Best-effort: the task is already on disk, and failing to count it must not
 * fail the create. Workstream D wraps this in the sleep-state lock.
 */
export function recordCycleTaskFiled(contextRoot: string, slug: string): void {
  const path = join(contextRoot, 'state', '.sleep.json');
  if (!existsSync(path)) return;
  try {
    const state = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const filed = Array.isArray(state.cycle_tasks_filed)
      ? (state.cycle_tasks_filed as unknown[]).filter((s): s is string => typeof s === 'string')
      : [];
    if (filed.includes(slug)) return;
    state.cycle_tasks_filed = [...filed, slug];
    writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  } catch {
    /* counting is not worth losing the task that was already written */
  }
}
