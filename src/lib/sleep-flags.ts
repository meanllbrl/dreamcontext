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

/** Flags that have crossed the escalation threshold this cycle. */
export function escalations(flags: SleepFlag[]): SleepFlag[] {
  return flags.filter((f) => f.consecutive_cycles >= RECIDIVISM_ESCALATION_CYCLES);
}

/** One human-readable escalation ask per flag, for the sleep report. */
export function renderEscalationAsks(flags: SleepFlag[]): string[] {
  return flags.map((f) => {
    const slugPart = f.task_slug ? ` (task: ${f.task_slug})` : '';
    return `⚠ "${f.label}" has recurred ${f.consecutive_cycles} consecutive cycles${slugPart} — escalate?`;
  });
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
  action: 'create' | 'refresh' | 'none';
  slug: string;
  name: string;
  description: string;
}

/**
 * Decide whether the orphan-tag count warrants a curator task, and whether an
 * existing one should be refreshed (still open) or recreated (a prior pass
 * completed but orphans recurred). Pure — the caller owns the actual
 * create/update task-backend call.
 */
export function planCuratorTask(
  orphanCount: number,
  existing: { slug: string; status: string } | null,
): CuratorTaskPlan {
  const slug = CURATOR_TASK_SLUG;
  const name = 'Curator pass: orphan tags';
  const description = `${orphanCount} orphan tag(s) detected across the corpus (>= ${ORPHAN_TAG_CURATOR_THRESHOLD} threshold) — run the curator skill to reconcile the taxonomy.`;

  if (orphanCount < ORPHAN_TAG_CURATOR_THRESHOLD) {
    return { action: 'none', slug, name, description };
  }
  if (existing && existing.status !== 'completed') {
    return { action: 'refresh', slug, name, description };
  }
  return { action: 'create', slug, name, description };
}
