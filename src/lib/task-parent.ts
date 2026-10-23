/**
 * The sub-task link (`parent_task`), in ONE place.
 *
 * A task may sit under one parent, and the tree is TWO levels deep at most: a parent cannot
 * itself be a child, and a task that already has children cannot be put under another task.
 * A closed (done- or cancelled-kind) task takes no new children: reopen it first.
 * The field is local-only (task-backend/local-only.ts), so nothing here talks to a remote.
 * Pure: callers hand in the task list they already read. The CLI, `POST /api/tasks`, the
 * PATCH route and the objection engine all call the same functions.
 *
 * A parent's WAVES are sub-tasks too: a plan with two or more waves opens one child per wave
 * (`filed_by: plan`, named "Wave N: …" or "N. dalga: …"), and {@link waveChildren} is the
 * single definition of which children those are and in what order.
 */

import { DEFAULT_STATUSES, isTerminal, type StatusDef } from './task-status.js';

/** The fields this module reads from a task. `status` is optional for callers that have none. */
export interface ParentLinkTask {
  slug: string;
  parent_task: string | null;
  status?: string;
}

export type ParentLinkError = 'self' | 'parent_missing' | 'parent_is_child' | 'child_has_children' | 'parent_closed';

export type ParentLinkVerdict = { ok: true } | { ok: false; code: ParentLinkError; message: string };

/** The tasks whose `parent_task` names `slug`, in list order. */
export function childrenOf<T extends ParentLinkTask>(tasks: readonly T[], slug: string): T[] {
  return tasks.filter((t) => t.parent_task === slug);
}

/**
 * The children of `slug` that are still open: not done, not cancelled. These are what keep a
 * parent from closing; a cancelled child never blocks.
 */
export function openChildren<T extends ParentLinkTask>(
  tasks: readonly T[],
  slug: string,
  defs: readonly StatusDef[] = DEFAULT_STATUSES,
): T[] {
  return childrenOf(tasks, slug).filter((t) => !isTerminal(defs, t.status ?? 'todo'));
}

/**
 * May `childSlug` be put under `parentSlug`? `null` (clearing the link) is always fine.
 * The parent must exist, must not be the child itself, must not be a child of another task,
 * must still be open, and the child must not already have children of its own (two levels max).
 */
export function validateParentLink(
  tasks: readonly ParentLinkTask[],
  childSlug: string,
  parentSlug: string | null,
  defs: readonly StatusDef[] = DEFAULT_STATUSES,
): ParentLinkVerdict {
  if (parentSlug === null) return { ok: true };
  if (parentSlug === childSlug) {
    return { ok: false, code: 'self', message: 'A task cannot be its own parent.' };
  }
  const parent = tasks.find((t) => t.slug === parentSlug);
  if (!parent) {
    return { ok: false, code: 'parent_missing', message: `Parent task not found: ${parentSlug}` };
  }
  // A parent link naming a task that no longer exists (deleted from the CLI, by hand, or by a
  // teammate) is dangling: that task reads as top-level, so it may take subtasks.
  if (parent.parent_task && parent.parent_task !== parent.slug && tasks.some((t) => t.slug === parent.parent_task)) {
    return {
      ok: false,
      code: 'parent_is_child',
      message: `"${parentSlug}" is itself a subtask of "${parent.parent_task}"; subtasks go two levels deep at most.`,
    };
  }
  if (parent.status !== undefined && isTerminal(defs, parent.status)) {
    return {
      ok: false,
      code: 'parent_closed',
      message: `"${parentSlug}" is ${parent.status}; a closed task takes no new subtasks. Reopen it first.`,
    };
  }
  if (childrenOf(tasks, childSlug).length > 0) {
    return {
      ok: false,
      code: 'child_has_children',
      message: `"${childSlug}" has subtasks of its own, so it cannot become a subtask; subtasks go two levels deep at most.`,
    };
  }
  return { ok: true };
}

/** What a new subtask takes from its parent when the caller names none. */
export interface ParentInheritance {
  version: string | null;
  related_feature: string | null;
  /** The Why a subtask gets when it brings none: being part of the parent IS why it exists. */
  why: string;
}

export function inheritFromParent(parent: {
  slug: string;
  name: string;
  version: string | null;
  related_feature: string | null;
}): ParentInheritance {
  return {
    version: parent.version ?? null,
    related_feature: parent.related_feature ?? null,
    why: `Part of ${parent.name} (\`${parent.slug}\`).`,
  };
}

// ─── Waves ───────────────────────────────────────────────────────────────────

/** A `WAVE MAP:` line, optionally as a list item. Anchored so prose mentioning it never matches. */
const WAVE_MAP_LINE = /^\s*(?:-\s*)?WAVE MAP:/;

/**
 * The NEWEST wave map in a task's Technical Details, or null. `tasks insert … technical_details`
 * appends at the END of the section (section-insert.ts), so the newest map is the LAST matching
 * line; every older map is ignored.
 */
export function latestWaveMap(technicalDetails: string | null | undefined): string | null {
  const lines = (technicalDetails ?? '').split('\n').filter((l) => WAVE_MAP_LINE.test(l));
  return lines.length > 0 ? lines[lines.length - 1].trim() : null;
}

/** The `WN …` parts of a wave map line, in order: `{ wave: N, text }`. */
export function waveMapParts(mapLine: string | null): Array<{ wave: number; text: string }> {
  if (!mapLine) return [];
  const parts: Array<{ wave: number; text: string }> = [];
  for (const raw of mapLine.replace(WAVE_MAP_LINE, '').split('|')) {
    const m = /^\s*W(\d+)\b/.exec(raw);
    if (m) parts.push({ wave: Number(m[1]), text: raw.trim() });
  }
  return parts;
}

/** How many waves the newest map names (`goal-live --waves M`). */
export function waveCount(technicalDetails: string | null | undefined): number {
  return waveMapParts(latestWaveMap(technicalDetails)).length;
}

/** `slug` as a whole token: `a-b` never matches inside `a-b-c`. */
function mentionsSlug(text: string, slug: string): boolean {
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`).test(text);
}

/** The wave number the newest map gives `slug`, or null when it is not on the map. */
export function waveOnMap(technicalDetails: string | null | undefined, slug: string): number | null {
  for (const part of waveMapParts(latestWaveMap(technicalDetails))) {
    if (mentionsSlug(part.text, slug)) return part.wave;
  }
  return null;
}

/** "2. dalga: …" or "Wave 2: …" → 2. */
function waveFromName(name: string): number | null {
  const m = /^\s*(\d+)\.\s*dalga\b/i.exec(name) ?? /^\s*wave\s+(\d+)\b/i.exec(name);
  return m ? Number(m[1]) : null;
}

/** The fields {@link waveChildren} reads from a child. */
export interface WaveChildInput {
  slug: string;
  name: string;
  filed_by?: string | null;
  filing_basis?: { kind?: unknown } | null;
}

/** Was this child opened by a plan (a wave), rather than by sleep, the owner or an agent? */
export function isPlanChild(child: Pick<WaveChildInput, 'filed_by' | 'filing_basis'>): boolean {
  return child.filed_by === 'plan' || child.filing_basis?.kind === 'plan';
}

/**
 * THE definition of a parent's waves: its plan children (`filed_by: plan`), each with the wave
 * number the parent's newest WAVE MAP gives its slug, else the "Wave N" / "N. dalga" number in its name,
 * else null. Ordered by wave, unnumbered last. Pass ALL the parent's children, closed ones too:
 * a wave's number must not shift when an earlier wave closes.
 * Other children (filed by sleep, the owner or an agent) are not waves; they still keep the
 * parent from closing (see {@link openChildren}).
 */
export function waveChildren<T extends WaveChildInput>(
  parent: { technical_details?: string | null },
  children: readonly T[],
): Array<{ child: T; wave: number | null }> {
  const out = children
    .filter(isPlanChild)
    .map((child) => ({ child, wave: waveOnMap(parent.technical_details, child.slug) ?? waveFromName(child.name) }));
  return out.sort((a, b) => (a.wave ?? Number.MAX_SAFE_INTEGER) - (b.wave ?? Number.MAX_SAFE_INTEGER));
}

/**
 * Is `child` a wave the parent's newest map names? Only those are exempt from the sleep-eval
 * close gate: `filed_by: plan` alone is not enough (`tasks basis --basis plan` would be an
 * escape hatch otherwise).
 */
export function isMappedWaveChild(
  parent: { technical_details?: string | null },
  child: Pick<WaveChildInput, 'slug' | 'filed_by' | 'filing_basis'>,
): boolean {
  return isPlanChild(child) && waveOnMap(parent.technical_details, child.slug) !== null;
}
