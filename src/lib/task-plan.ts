import { join } from 'node:path';
import { today } from './id.js';
import type { TaskBackend } from './task-backend/types.js';
import { loadFamily, type Family, type TaskBrief } from './task-parent.js';
import { isCancelled, isDone, type StatusDef } from './task-status.js';
import { readCycles, resolveCycleRef, type CycleView } from './cycles.js';
import { bucketOf, derivedParentPlacement, rankWrites, type Placement } from './task-order.js';
import { loadStatuses } from './overrides.js';

/**
 * Planning on the "when?" axis (C3), shared by the CLI (`tasks plan`, `tasks rank`,
 * `cycle close`) and the dashboard routes (plan r3 § W4). Moved out of
 * cli/commands/tasks-plan.ts unchanged, so both surfaces move cards the same way.
 * Nothing here writes priority, urgency or a version.
 */

export const RANK_STEP = 10;

export function isOpen(defs: readonly StatusDef[], b: TaskBrief): boolean {
  return !isDone(defs, b.status) && !isCancelled(defs, b.status);
}

export function describePlacement(p: Placement, cycles: CycleView[]): string {
  if (p.cycle) {
    const c = cycles.find((x) => x.id === p.cycle);
    return c ? `cycle #${c.number}${c.status === 'active' ? ' (now)' : ''}` : `cycle ${p.cycle} (not yet synced)`;
  }
  return p.queue === 'later' ? 'Later' : 'Next';
}

/** The rank that puts a card at the end of `bucket`. */
function endRank(family: Family, bucket: string, except: Set<string>): number {
  let max = 0;
  for (const b of family.bySlug.values()) {
    if (except.has(b.slug) || bucketOf(b) !== bucket) continue;
    if (b.rank !== null && b.rank > max) max = b.rank;
  }
  return max + RANK_STEP;
}

/**
 * Move cards to a placement, appending each at the end of its new bucket and
 * journaling the move. Cards already there keep their rank. Returns the slugs
 * that moved.
 */
export async function applyPlacement(
  backend: TaskBackend,
  family: Family,
  slugs: string[],
  placement: Placement,
  note: string,
): Promise<string[]> {
  const moved: string[] = [];
  const target = bucketOf(placement);
  let rank = endRank(family, target, new Set(slugs));
  for (const slug of slugs) {
    const brief = family.bySlug.get(slug);
    if (!brief) continue;
    if ((brief.cycle ?? null) === placement.cycle && (brief.queue ?? null) === placement.queue) continue;
    const fields: Record<string, unknown> = { cycle: placement.cycle, queue: placement.queue, updated_at: today() };
    if (bucketOf(brief) !== target || brief.rank === null) {
      fields.rank = rank;
      rank += RANK_STEP;
    }
    await backend.updateFields(slug, fields);
    await backend.addJournal(slug, { kind: 'log', label: 'planned', body: `- ${note}` });
    moved.push(slug);
  }
  return moved;
}

/**
 * Re-derive each parent's placement from its open children (a parent's cycle
 * is derived, never planned on its own). Silent when nothing changes.
 */
export async function syncParentPlacements(
  backend: TaskBackend,
  stateDir: string,
  defs: readonly StatusDef[],
  cycles: CycleView[],
  parents: Iterable<string>,
): Promise<void> {
  const family = loadFamily(stateDir);
  for (const parent of new Set(parents)) {
    const p = family.bySlug.get(parent);
    if (!p || !isOpen(defs, p)) continue;
    const kids = (family.children.get(parent) ?? []).filter((c) => isOpen(defs, c));
    const derived = derivedParentPlacement(kids, cycles);
    if (!derived) continue;
    if ((p.cycle ?? null) === derived.cycle && (p.queue ?? null) === derived.queue) continue;
    await backend.updateFields(parent, { cycle: derived.cycle, queue: derived.queue, updated_at: today() });
  }
}

// ─── plan ────────────────────────────────────────────────────────────────────

export type PlanRefusal = 'unknown_target' | 'closed_cycle' | 'not_found' | 'not_open';

export type PlanResult =
  | {
    ok: true;
    placement: Placement;
    where: string;
    /** Every slug that moved: the open sub-tasks first, then the task itself. */
    moved: string[];
    kidMoves: string[];
    selfMoved: string[];
    parent: string | null;
  }
  | { ok: false; code: PlanRefusal; message: string };

/** Resolve `now | next | later | <cycle id or number>` to a placement, or a refusal. */
export function resolvePlanTarget(cycles: CycleView[], targetRef: string): { ok: true; placement: Placement } | { ok: false; code: PlanRefusal; message: string } {
  const t = targetRef.trim().toLowerCase();
  if (t === 'next' || t === 'later') return { ok: true, placement: { cycle: null, queue: t } };
  const cycle = resolveCycleRef(cycles, targetRef);
  if (!cycle) {
    return {
      ok: false,
      code: 'unknown_target',
      message: t === 'now'
        ? 'No cycle is active. Start one: dreamcontext cycle new --goal "..." && dreamcontext cycle start <n>'
        : `No cycle "${targetRef}". See: dreamcontext cycle list`,
    };
  }
  if (cycle.status === 'closed') {
    return { ok: false, code: 'closed_cycle', message: `Cycle #${cycle.number} is closed; plan into the active or a planned cycle.` };
  }
  return { ok: true, placement: { cycle: cycle.id, queue: null } };
}

/** Plan a task (a parent brings its open sub-tasks) into a cycle or a queue. */
export async function planTask(contextRoot: string, backend: TaskBackend, slug: string, targetRef: string): Promise<PlanResult> {
  const stateDir = join(contextRoot, 'state');
  const defs = loadStatuses(contextRoot);
  const { cycles } = readCycles(contextRoot);
  const target = resolvePlanTarget(cycles, targetRef);
  if (!target.ok) return target;
  const placement = target.placement;
  const family = loadFamily(stateDir);
  const brief = family.bySlug.get(slug);
  if (!brief) return { ok: false, code: 'not_found', message: `Task not found: ${slug}` };
  if (!isOpen(defs, brief)) return { ok: false, code: 'not_open', message: `${slug} is ${brief.status}; only open work is planned.` };
  const where = describePlacement(placement, cycles);
  const openKids = (family.children.get(slug) ?? []).filter((c) => isOpen(defs, c));
  // A parent brings its open children; their move is journaled one by one.
  const kidMoves = await applyPlacement(backend, family, openKids.map((c) => c.slug), placement,
    `planned into ${where} with its parent ${slug}`);
  const selfMoved = await applyPlacement(backend, family, [slug], placement, `planned into ${where}`);
  const parent = family.parentOf.get(slug) ?? null;
  if (parent) await syncParentPlacements(backend, stateDir, defs, cycles, [parent]);
  return { ok: true, placement, where, moved: [...kidMoves, ...selfMoved], kidMoves, selfMoved, parent };
}

// ─── rank ────────────────────────────────────────────────────────────────────

export type RankRefusal = 'bad_anchor' | 'not_found';

export type RankResult =
  | {
    ok: true;
    /** The task's rank after the move. */
    rank: number | null;
    /** How many cards had their rank rewritten (0 = it was already there). */
    changed: number;
    /** 1-based position of the task in its bucket after the move. */
    position: number;
    /** Open cards in the bucket, the task included. */
    of: number;
  }
  | { ok: false; code: RankRefusal; message: string };

/** Order a task just before or after another open task of the same cycle or queue. */
export async function rankTask(
  contextRoot: string,
  backend: TaskBackend,
  slug: string,
  anchor: { before: string } | { after: string },
): Promise<RankResult> {
  const after = 'after' in anchor;
  const other = after ? (anchor as { after: string }).after : (anchor as { before: string }).before;
  if (other === slug) return { ok: false, code: 'bad_anchor', message: 'A task cannot be ranked against itself.' };
  const family = loadFamily(join(contextRoot, 'state'));
  const me = family.bySlug.get(slug);
  const them = family.bySlug.get(other);
  if (!me || !them) return { ok: false, code: 'not_found', message: 'Task not found.' };
  if (bucketOf(me) !== bucketOf(them)) {
    const { cycles } = readCycles(contextRoot);
    const where = (b: TaskBrief) => describePlacement({ cycle: b.cycle ?? null, queue: b.queue === 'later' ? 'later' : b.cycle ? null : 'next' }, cycles);
    return {
      ok: false,
      code: 'bad_anchor',
      message: `${slug} is in ${where(me)} and ${other} in ${where(them)}; rank orders within one cycle or queue. Plan it there first: dreamcontext tasks plan ${slug} <target>`,
    };
  }
  const bucket = bucketOf(me);
  // Only open cards are ordered: done, cancelled and legacy closed cards in
  // the same bucket are never rewritten (each write is a push on a remote).
  const defs = loadStatuses(contextRoot);
  const peers = [...family.bySlug.values()]
    .filter((b) => bucketOf(b) === bucket && b.slug !== slug && isOpen(defs, b))
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.slug.localeCompare(b.slug));
  if (!peers.some((b) => b.slug === other)) return { ok: false, code: 'bad_anchor', message: `${other} is not open; rank orders open work.` };
  const writes = rankWrites(peers, slug, other, after, RANK_STEP);
  let changed = 0;
  let rank: number | null = me.rank;
  for (const [s2, r] of writes) {
    if (s2 === slug) rank = r;
    if (family.bySlug.get(s2)?.rank === r) continue;
    await backend.updateFields(s2, { rank: r });
    changed++;
  }
  const position = peers.findIndex((b) => b.slug === other) + (after ? 1 : 0) + 1;
  return { ok: true, rank, changed, position, of: peers.length + 1 };
}
