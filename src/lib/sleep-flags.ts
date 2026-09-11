/**
 * sleep-flags — per-cycle recidivism tracking for the sleep report (AC6).
 *
 * A "flag" is a recurring problem a sleep specialist observed this cycle
 * (a chronically-todo task, a stale ceiling-blocked decision, etc). Storage is
 * its OWN file (`state/.sleep-flags.json`) — deliberately NOT `.sleep.json`
 * (rewritten by the latency-sensitive Stop hook on every turn) and NOT
 * `.sleep-history.json` (a bare 90-entry array with dependent readers:
 * `sleep history`, the dashboard, the audit's own stats). Pure reducer +
 * thin disk I/O; no side effects beyond the two read/write functions.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonArray, writeJsonArray } from './json-file.js';
import { DEFAULT_STATUSES, isTerminal, type StatusDef } from './task-status.js';

export interface SleepFlag {
  /** Stable identity for the recurring problem, e.g. `recurring-task:<slug>`. */
  key: string;
  label: string;
  task_slug: string | null;
  /** ISO timestamp this flag was first observed. Preserved across cycles. */
  first_seen: string;
  /** ISO timestamp this flag was most recently observed. */
  last_seen: string;
  /** Consecutive cycles this flag has been observed. Resets to 1 if a cycle
   *  passes without it being re-observed (see `reconcileFlags`). */
  consecutive_cycles: number;
}

/** Consecutive-cycle threshold that trips escalation (inclusive). */
export const RECIDIVISM_ESCALATION_CYCLES = 3;

/** Orphan-tag count that auto-creates/refreshes the curator task (inclusive). */
export const ORPHAN_TAG_CURATOR_THRESHOLD = 150;

export const CURATOR_TASK_SLUG = 'curator-pass-orphan-tags';

function getSleepFlagsPath(root: string): string {
  return join(root, 'state', '.sleep-flags.json');
}

/** Read flags from `state/.sleep-flags.json`. Missing/malformed → []. */
export function readSleepFlags(root: string): SleepFlag[] {
  const filePath = getSleepFlagsPath(root);
  if (!existsSync(filePath)) return [];
  try {
    return readJsonArray<SleepFlag>(filePath);
  } catch {
    return [];
  }
}

/** Write flags to `state/.sleep-flags.json`. */
export function writeSleepFlags(root: string, flags: SleepFlag[]): void {
  writeJsonArray(getSleepFlagsPath(root), flags);
}

/**
 * Reconcile the previous cycle's flags against this cycle's observations.
 *
 * A key present in `observed`: bumps `consecutive_cycles` (or starts at 1 if
 * new), preserves `first_seen`, stamps `last_seen`. A key from `prev` that is
 * ABSENT from `observed` is DROPPED — the streak is CONSECUTIVE by contract,
 * so a problem that goes quiet for one cycle starts over at 1 if it recurs.
 *
 * Pure — never touches disk.
 */
export function reconcileFlags(
  prev: SleepFlag[],
  observed: Array<Pick<SleepFlag, 'key' | 'label' | 'task_slug'>>,
  nowISO: string,
): SleepFlag[] {
  const prevByKey = new Map(prev.map((f) => [f.key, f]));
  return observed.map((obs) => {
    const existing = prevByKey.get(obs.key);
    if (existing) {
      return {
        key: obs.key,
        label: obs.label,
        task_slug: obs.task_slug,
        first_seen: existing.first_seen,
        last_seen: nowISO,
        consecutive_cycles: existing.consecutive_cycles + 1,
      };
    }
    return {
      key: obs.key,
      label: obs.label,
      task_slug: obs.task_slug,
      first_seen: nowISO,
      last_seen: nowISO,
      consecutive_cycles: 1,
    };
  });
}

// ─── Deferred task candidates (`task-candidate:<key>`) ───────────────────────
//
// A cycle that saw only INDIRECT evidence for a piece of work ("it was
// discussed") must not file a task for it — that is the wrong-task failure this
// family exists to close — but it must not lose it either. So the candidate
// rides the recidivism store as a flag whose key carries this prefix, and
// `sleep-tasks` files it only once a LATER cycle independently re-observes it:
// confidence by repetition, with no interactive step.
//
// The streak contract is `reconcileFlags`', unchanged — a candidate that is not
// re-emitted next cycle is simply dropped. What differs is ESCALATION: a
// candidate has NO TASK, so there is no priority to bump and nobody to hand an
// "escalate?" ask to. `sleep done` prints one summary line instead (see
// `renderTaskCandidateLine`).

/** Flag-key prefix for an indirect task candidate deferred to a later cycle. */
export const TASK_CANDIDATE_PREFIX = 'task-candidate:';

/** Cycles a candidate must have been seen for to count as RECURRING in the
 *  summary line: one prior cycle plus this one — the point at which the
 *  `sleep-tasks` grooming rule allows it to be filed. */
const CANDIDATE_RECURRENCE_CYCLES = 2;

/** Is this flag a deferred task candidate rather than a recurring problem?
 *  Tolerates a malformed on-disk entry (`readSleepFlags` casts, it does not
 *  validate element shape) rather than throwing on the `sleep done` path. */
export function isTaskCandidateFlag(flag: Pick<SleepFlag, 'key'>): boolean {
  return typeof flag.key === 'string' && flag.key.startsWith(TASK_CANDIDATE_PREFIX);
}

/** The deferred task candidates among this cycle's reconciled flags. */
export function taskCandidates(flags: SleepFlag[]): SleepFlag[] {
  return flags.filter(isTaskCandidateFlag);
}

/**
 * Flags that have crossed the escalation threshold this cycle.
 *
 * Task candidates are EXCLUDED. Escalation means bumping the linked task's
 * priority and printing an ask; a candidate that was deliberately never filed
 * has no task to bump, so escalating it would ask the user about a task that
 * does not exist.
 */
export function escalations(flags: SleepFlag[]): SleepFlag[] {
  return flags.filter(
    (f) => !isTaskCandidateFlag(f) && f.consecutive_cycles >= RECIDIVISM_ESCALATION_CYCLES,
  );
}

/** One human-readable escalation ask per flag, for the sleep report. */
export function renderEscalationAsks(flags: SleepFlag[]): string[] {
  return flags.map((f) => {
    const slugPart = f.task_slug ? ` (task: ${f.task_slug})` : '';
    return `⚠ "${f.label}" has recurred ${f.consecutive_cycles} consecutive cycles${slugPart} — escalate?`;
  });
}

/**
 * One summary line for the deferred task candidates, or null when there are
 * none — the quiet counterpart to {@link renderEscalationAsks}. Names how many
 * are already recurring, because those are the ones a later cycle may file.
 */
export function renderTaskCandidateLine(flags: SleepFlag[]): string | null {
  const candidates = taskCandidates(flags);
  if (candidates.length === 0) return null;
  const recurring = candidates.filter(
    (f) => f.consecutive_cycles >= CANDIDATE_RECURRENCE_CYCLES,
  ).length;
  return `Deferred task candidates: ${candidates.length} (${recurring} seen ≥${CANDIDATE_RECURRENCE_CYCLES} cycles — sleep-tasks files them when re-observed).`;
}

const PRIORITY_ORDER = ['low', 'medium', 'high', 'critical'] as const;

/** Bump a task priority one tier (low→medium→high→critical). Caps at critical;
 *  an unrecognized value is returned unchanged rather than guessed at. */
export function bumpPriority(priority: string): string {
  const idx = PRIORITY_ORDER.indexOf(priority as (typeof PRIORITY_ORDER)[number]);
  if (idx === -1) return priority;
  return PRIORITY_ORDER[Math.min(idx + 1, PRIORITY_ORDER.length - 1)];
}

/**
 * Parse a `--flag key::label[::task-slug]` CLI option. Returns null for any
 * malformed input (missing `::`, empty key, or empty label) — callers filter
 * nulls rather than fail the whole `sleep done` invocation on a typo.
 */
export function parseFlagOption(raw: string): Pick<SleepFlag, 'key' | 'label' | 'task_slug'> | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.split('::');
  if (parts.length < 2) return null;
  const key = parts[0].trim();
  const label = parts[1].trim();
  if (!key || !label) return null;
  const task_slug = parts[2]?.trim() || null;
  return { key, label, task_slug };
}

export interface CuratorTaskPlan {
  /**
   * `refresh-absorbing` — the chore was merged into ANOTHER task that is still
   * open; log the orphan count there instead of re-filing a duplicate.
   */
  action: 'create' | 'refresh' | 'refresh-absorbing' | 'none';
  slug: string;
  name: string;
  description: string;
}

/**
 * Decide whether the orphan-tag count warrants a curator task, and whether an
 * existing one should be refreshed (still open) or recreated (a prior pass
 * completed but orphans recurred). Pure — the caller owns the actual
 * create/update task-backend call.
 *
 * THE TOMBSTONE ARGUMENT IS THE BUG FIX. This used to look the chore up by
 * fixed slug ONLY. When somebody merged it into another task and deleted the
 * file, the lookup missed and the next cycle filed a brand-new, entirely-empty
 * copy — observed on this brain every cycle from 2026-07-18 to 2026-08-23, and
 * B0's audit found it is the only zero-justification task in 116. Passing the
 * resolved tombstone lets a deliberate consolidation actually stick.
 *
 * The resolution is TRANSITIVE (A merged into B, B renamed to C ⇒ C), and a
 * chain that dead-ends — everything in it deleted, or the absorbing task
 * COMPLETED — allows `create` again: nothing open owns the work any more, so
 * re-filing is the right answer rather than a duplicate.
 */
export function planCuratorTask(
  orphanCount: number,
  existing: { slug: string; status: string } | null,
  absorbing?: { slug: string; status: string } | null,
  statuses: readonly StatusDef[] = DEFAULT_STATUSES,
): CuratorTaskPlan {
  const slug = CURATOR_TASK_SLUG;
  const name = 'Curator pass: orphan tags';
  const description = `${orphanCount} orphan tag(s) detected across the corpus (>= ${ORPHAN_TAG_CURATOR_THRESHOLD} threshold) — run the curator skill to reconcile the taxonomy.`;

  if (orphanCount < ORPHAN_TAG_CURATOR_THRESHOLD) {
    return { action: 'none', slug, name, description };
  }
  // TERMINAL by kind: a cancelled curator task is as closed as a completed one —
  // it is recreated, never "refreshed" back to life.
  if (existing && !isTerminal(statuses, existing.status)) {
    return { action: 'refresh', slug, name, description };
  }
  // The chore's own file is gone or done — but if the work was ABSORBED by a
  // task that is still open, that task is where the count belongs.
  if (absorbing && !isTerminal(statuses, absorbing.status)) {
    return { action: 'refresh-absorbing', slug: absorbing.slug, name, description };
  }
  return { action: 'create', slug, name, description };
}
