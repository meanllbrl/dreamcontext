import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import fg from 'fast-glob';
import { readFrontmatter } from './frontmatter.js';
import { gateStatus } from './task-evidence.js';
import {
  isCancelled,
  isDone,
  isTerminal,
  PARENT_BY_KIND,
  statusKind,
  type StatusDef,
  type StatusKind,
} from './task-status.js';

/**
 * Sub-tasks: exactly two levels. A feature is an AREA (open-ended), a parent
 * task is a DELIVERABLE with an end, a child is one STEP of it. A parent carries
 * the goal, the Why and the decisions that bind every child; a child inherits
 * its objectives, feature and cycle.
 *
 * `parent_task` holds the parent's SLUG (canonical). A legacy card may carry
 * the parent's frontmatter id; it resolves on read. Every invariant here is a
 * rule the code enforces, not advice:
 *  - a parent has no parent, a child has no children, nothing parents itself;
 *  - a closed (done/cancelled) task takes no new children;
 *  - a parent cannot reach a done-kind status while a child is open;
 *  - a parent with a live child cannot be deleted;
 *  - cancelling a parent needs a decision for every open child;
 *  - the parent's status is computed from its children and stored, so every
 *    surface (and the remote, on sync) sees a real value.
 */

export interface TaskBrief {
  slug: string;
  id: string | null;
  name: string;
  status: string;
  parent: string | null;
  rank: number | null;
}

/** A `parent_task` value as written by people, YAML folding or a remote: a slug or null. */
export function normalizeParentRef(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v || v === 'null') return null;
  // A slug never holds whitespace, a separator, a NUL or a dot-segment.
  if (!/^[^\s/\\\0]+$/.test(v) || v === '.' || v === '..') return null;
  return v;
}

/** Every task card's frontmatter brief (top-level `state/*.md`; journals and archive excluded). */
export function loadTaskBriefs(stateDir: string): TaskBrief[] {
  if (!existsSync(stateDir)) return [];
  const out: TaskBrief[] = [];
  for (const file of fg.sync('*.md', { cwd: stateDir, absolute: true })) {
    try {
      const { data } = readFrontmatter<Record<string, unknown>>(file);
      const slug = basename(file, '.md');
      out.push({
        slug,
        id: typeof data.id === 'string' ? data.id : null,
        name: String(data.name ?? slug).replace(/\s+/g, ' ').trim() || slug,
        status: String(data.status ?? 'todo'),
        parent: normalizeParentRef(data.parent_task),
        rank: typeof data.rank === 'number' && Number.isFinite(data.rank) ? data.rank : null,
      });
    } catch { /* unreadable card: not part of any family */ }
  }
  return out;
}

export interface Family {
  /** slug → brief */
  bySlug: Map<string, TaskBrief>;
  /** parent slug → its children (rank, then name order) */
  children: Map<string, TaskBrief[]>;
  /** child slug → its parent's slug (resolved: an id ref maps to the slug) */
  parentOf: Map<string, string>;
}

/** Resolve every `parent_task` (slug or legacy id) to a live parent slug. */
export function buildFamily(briefs: TaskBrief[]): Family {
  const bySlug = new Map(briefs.map((b) => [b.slug, b]));
  const byId = new Map<string, TaskBrief>();
  for (const b of briefs) if (b.id) byId.set(b.id, b);
  const children = new Map<string, TaskBrief[]>();
  const parentOf = new Map<string, string>();
  for (const b of briefs) {
    if (!b.parent) continue;
    const parent = bySlug.get(b.parent) ?? byId.get(b.parent);
    if (!parent || parent.slug === b.slug) continue;
    parentOf.set(b.slug, parent.slug);
    const arr = children.get(parent.slug) ?? [];
    arr.push(b);
    children.set(parent.slug, arr);
  }
  for (const arr of children.values()) {
    arr.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.name.localeCompare(b.name));
  }
  return { bySlug, children, parentOf };
}

export function loadFamily(stateDir: string): Family {
  return buildFamily(loadTaskBriefs(stateDir));
}

export interface Rollup {
  /** Children that are not cancelled. */
  total: number;
  done: number;
  open: TaskBrief[];
}

/** Leaf progress of a parent: done / all non-cancelled children. */
export function rollupOf(children: TaskBrief[], defs: readonly StatusDef[]): Rollup {
  const live = children.filter((c) => !isCancelled(defs, c.status));
  return {
    total: live.length,
    done: live.filter((c) => isDone(defs, c.status)).length,
    open: children.filter((c) => !isTerminal(defs, c.status)),
  };
}

export type ParentCheck = { ok: true; parent: string } | { ok: false; reason: string };

/**
 * May `childSlug` sit under `parentRef`? The parent must exist, be top-level,
 * not be closed, and not be the child; the child must not itself have children.
 */
export function checkParentLink(
  family: Family,
  defs: readonly StatusDef[],
  childSlug: string,
  parentRef: string,
): ParentCheck {
  const ref = normalizeParentRef(parentRef);
  if (!ref) return { ok: false, reason: `Invalid parent reference: "${parentRef}".` };
  const parent = family.bySlug.get(ref) ?? [...family.bySlug.values()].find((b) => b.id === ref);
  if (!parent) return { ok: false, reason: `No task "${ref}" to be the parent.` };
  if (parent.slug === childSlug) return { ok: false, reason: 'A task cannot be its own parent.' };
  const grand = family.parentOf.get(parent.slug);
  if (grand) {
    return {
      ok: false,
      reason: `"${parent.slug}" is itself a sub-task of "${grand}". Sub-tasks are two levels only: put it under "${grand}" instead.`,
    };
  }
  if (isTerminal(defs, parent.status)) {
    return { ok: false, reason: `"${parent.slug}" is ${parent.status}; a closed task takes no new sub-tasks.` };
  }
  const kids = family.children.get(childSlug) ?? [];
  if (kids.length > 0) {
    return {
      ok: false,
      reason: `"${childSlug}" has ${kids.length} sub-task(s) of its own, so it is a parent; sub-tasks are two levels only.`,
    };
  }
  return { ok: true, parent: parent.slug };
}

/** Refusal text when a parent would close (done-kind) with open children, else null. */
export function parentCloseBlock(
  family: Family,
  defs: readonly StatusDef[],
  slug: string,
  targetStatus: string,
): string | null {
  if (!isDone(defs, targetStatus)) return null;
  const open = rollupOf(family.children.get(slug) ?? [], defs).open;
  if (open.length === 0) return null;
  return [
    `${slug} has ${open.length} open sub-task(s); a parent closes after its children:`,
    ...open.map((c) => `  - ${c.slug} [${c.status}]`),
  ].join('\n');
}

/** The live (non-terminal) children that block deleting a parent. */
export function liveChildren(family: Family, defs: readonly StatusDef[], slug: string): TaskBrief[] {
  return (family.children.get(slug) ?? []).filter((c) => !isTerminal(defs, c.status));
}

/**
 * The status a parent's children imply, or null when it should stay as it is.
 * No started child → open; some started → active; every live child done →
 * review when the parent's own criteria pass the review gate, else active.
 * Never done: closing a parent is still its own (evidence-gated) move. A closed
 * parent is never reopened here, and a parent with no live child keeps its own.
 */
export function rolledUpStatus(
  defs: readonly StatusDef[],
  parentStatus: string,
  parentBody: string,
  children: TaskBrief[],
): string | null {
  const live = children.filter((c) => !isCancelled(defs, c.status));
  if (live.length === 0) return null;
  const current = statusKind(defs, parentStatus);
  if (current === 'done' || current === 'cancelled') return null;
  const started = (k: StatusKind | null): boolean => k === 'active' || k === 'review' || k === 'done';
  let target: StatusKind;
  if (live.every((c) => isDone(defs, c.status))) {
    target = gateStatus(parentBody, 'review').ok ? 'review' : 'active';
  } else if (live.some((c) => started(statusKind(defs, c.status)))) {
    target = 'active';
  } else {
    target = 'open';
  }
  if (current === target) return null;
  return PARENT_BY_KIND[target];
}

/** What happens to one open child when its parent is cancelled. */
export type ChildDecision = { kind: 'cancel' } | { kind: 'detach' } | { kind: 'move'; to: string };

export function parseChildDecision(raw: string): ChildDecision | null {
  const v = raw.trim();
  if (v === 'cancel') return { kind: 'cancel' };
  if (v === 'detach') return { kind: 'detach' };
  const m = /^(?:move:|under:)?(.+)$/.exec(v);
  const to = m ? normalizeParentRef(m[1]) : null;
  return to ? { kind: 'move', to } : null;
}

/** `state/<slug>.md` of a sibling card. */
export function cardPath(stateDir: string, slug: string): string {
  return join(stateDir, `${slug}.md`);
}

export interface RemoteParentResolution {
  /** The parent to store locally, or null to leave the child's link as it is. */
  parent: string | null;
  warning?: string;
}

/**
 * A remote tracker can nest deeper than two levels. Map what it says onto the
 * local rule: a grandchild flattens onto its top-level ancestor (and warns); a
 * child that is itself a local parent keeps no remote parent (dropped, warned).
 * A remote that says nothing is never a reason to clear a local link: callers
 * only call this for a parent the remote DOES name.
 */
export function resolveRemoteParent(family: Family, childSlug: string, remoteParentSlug: string): RemoteParentResolution {
  if (remoteParentSlug === childSlug) return { parent: null };
  if ((family.children.get(childSlug) ?? []).length > 0) {
    return {
      parent: null,
      warning: `${childSlug} has sub-tasks of its own here, so its remote parent ${remoteParentSlug} was not applied (two levels only).`,
    };
  }
  const grand = family.parentOf.get(remoteParentSlug);
  if (grand) {
    if (grand === childSlug) return { parent: null };
    return {
      parent: grand,
      warning: `${childSlug} is nested three levels deep on the remote (under ${remoteParentSlug}, under ${grand}); flattened onto ${grand}.`,
    };
  }
  return { parent: remoteParentSlug };
}
