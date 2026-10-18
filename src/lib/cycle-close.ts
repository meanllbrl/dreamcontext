import { join } from 'node:path';
import { today } from './id.js';
import { loadStatuses } from './overrides.js';
import type { TaskBackend } from './task-backend/types.js';
import { loadFamily, type Family } from './task-parent.js';
import { isCancelled, type StatusDef } from './task-status.js';
import {
  activeCycle,
  carryCount,
  cycleProgress,
  markClosing,
  nextPlannedCycle,
  readCycles,
  recordClose,
  resolveCycleRef,
  type ClosePlan,
  type CycleView,
} from './cycles.js';
import { applyPlacement, syncParentPlacements } from './task-plan.js';

/**
 * Closing a cycle (C3; the Close deck, plan r3 § W4): every unfinished leaf is carried
 * into the next cycle, sent back to the Next queue, or cancelled. Extracted from the
 * `cycle close` CLI action unchanged, so the CLI and the dashboard close a cycle the
 * same way: the decisions are recorded on the cycle BEFORE any card moves
 * (`markClosing`), so a close that stops halfway resumes with exactly those decisions.
 */

export type CloseAction = 'carry' | 'back' | 'cancel';
export const CLOSE_ACTIONS: readonly CloseAction[] = ['carry', 'back', 'cancel'];

export class CloseError extends Error {
  constructor(message: string, readonly code: 'not_found' | 'closed' | 'bad_target' | 'no_cancel_status' | 'undecided' | 'missing_into', readonly slugs: string[] = []) {
    super(message);
  }
}

function label(c: CycleView): string {
  return `#${c.number}`;
}

/** The cycle to close: `ref` (number or id), or the active one. Throws when there is none or it is closed. */
export function closableCycle(contextRoot: string, ref?: string): { cycle: CycleView; cycles: CycleView[] } {
  const { cycles } = readCycles(contextRoot);
  const c = ref ? resolveCycleRef(cycles, ref) : activeCycle(cycles);
  if (!c) throw new CloseError(ref ? `No cycle "${ref}". See: dreamcontext cycle list` : 'No cycle is active; name the one to close.', 'not_found');
  if (c.status === 'closed') throw new CloseError(`Cycle ${label(c)} is already closed.`, 'closed');
  return { cycle: c, cycles };
}

export interface ClosePlanView {
  cycle: CycleView;
  /** Where carried work goes: the recorded target of a resumed close, else the next planned cycle. */
  into: CycleView | null;
  groups: Array<{ parent: { slug: string; name: string } | null; leaves: Array<{ slug: string; name: string; status: string; carried: number }> }>;
  /** True when a close stopped halfway: its recorded decisions will be finished as they are. */
  resuming: boolean;
}

/** What the Close deck shows: the unfinished leaves, grouped by parent, with their carry counts. */
export function closePlanView(contextRoot: string, cycleRef: string): ClosePlanView {
  const { cycle, cycles } = closableCycle(contextRoot, cycleRef);
  const defs = loadStatuses(contextRoot);
  const family = loadFamily(join(contextRoot, 'state'));
  const open = cycleProgress(family, defs, cycle.id).open;
  const groups = new Map<string, ClosePlanView['groups'][number]>();
  for (const b of open) {
    const parentSlug = family.parentOf.get(b.slug) ?? '';
    const parent = parentSlug ? family.bySlug.get(parentSlug) ?? null : null;
    const g = groups.get(parentSlug) ?? { parent: parent ? { slug: parent.slug, name: parent.name } : null, leaves: [] };
    g.leaves.push({ slug: b.slug, name: b.name, status: b.status, carried: carryCount(cycles, b.slug) });
    groups.set(parentSlug, g);
  }
  const into = cycle.closing?.into
    ? cycles.find((x) => x.id === cycle.closing!.into) ?? null
    : nextPlannedCycle(cycles, cycle.id);
  const ordered = [...groups.values()].sort((a, b) => (a.parent ? 0 : 1) - (b.parent ? 0 : 1) || (a.parent?.slug ?? '').localeCompare(b.parent?.slug ?? ''));
  return { cycle, into, groups: ordered, resuming: !!cycle.closing };
}

/**
 * Build and RECORD a close's plan from a decision for every unfinished leaf. Throws a
 * {@link CloseError} naming the undecided leaves, a bad carry target, or a cancel in a
 * project with no cancelled-kind status. Nothing has moved when it throws.
 */
export function decideClose(
  contextRoot: string,
  cycle: CycleView,
  cycles: CycleView[],
  family: Family,
  defs: readonly StatusDef[],
  decisions: ReadonlyMap<string, CloseAction>,
  intoRef?: string,
): ClosePlan {
  const progress = cycleProgress(family, defs, cycle.id);
  const undecided = progress.open.filter((b) => !decisions.has(b.slug));
  if (undecided.length > 0) {
    throw new CloseError(`Cycle ${label(cycle)} has ${undecided.length} unfinished leaf/leaves without a decision.`, 'undecided', undecided.map((b) => b.slug));
  }
  const want = (a: CloseAction) => progress.open.filter((b) => decisions.get(b.slug) === a).map((b) => b.slug);
  const plan: ClosePlan = { carried: want('carry'), backed: want('back'), cancelled: want('cancel'), result: { done: progress.done, total: progress.total }, into: null };
  if (plan.carried.length > 0) {
    const target = intoRef ? resolveCycleRef(cycles, intoRef) : nextPlannedCycle(cycles, cycle.id);
    if (!target) {
      throw new CloseError(intoRef
        ? `No cycle "${intoRef}" to carry into.`
        : 'No planned cycle to carry into. Open one first: dreamcontext cycle new --goal "..."', 'bad_target');
    }
    if (target.id === cycle.id || target.status === 'closed') {
      throw new CloseError(`Cannot carry into cycle ${label(target)} (${target.id === cycle.id ? 'the one closing' : 'closed'}).`, 'bad_target');
    }
    plan.into = target.id;
  }
  if (plan.cancelled.length > 0 && !defs.find((d) => d.kind === 'cancelled')) {
    throw new CloseError('This project declares no cancelled-kind status (overrides/task.md); carry or send these back instead.', 'no_cancel_status');
  }
  // Decisions first, cards second: a close that stops halfway resumes from here.
  markClosing(contextRoot, cycle.id, plan);
  return plan;
}

/** The recorded plan of a close that stopped halfway, optionally re-targeted (the one thing a resume may change). */
export function resumeClose(contextRoot: string, cycle: CycleView, cycles: CycleView[], intoRef?: string): ClosePlan {
  let plan = cycle.closing!;
  if (intoRef && plan.carried.length > 0) {
    const target = resolveCycleRef(cycles, intoRef);
    if (!target || target.id === cycle.id || target.status === 'closed') {
      throw new CloseError(`Cannot carry into "${intoRef}": no open cycle by that number or id.`, 'bad_target');
    }
    plan = { ...plan, into: target.id };
    markClosing(contextRoot, cycle.id, plan);
  }
  return plan;
}

export interface CloseResult {
  cycle: CycleView;
  into: CycleView | null;
  moved: { carry: string[]; back: string[]; cancel: string[] };
  result: { done: number; total: number };
}

/** Carry out a recorded plan (idempotent moves), then close the cycle. */
export async function executeClose(
  contextRoot: string,
  backend: TaskBackend,
  cycle: CycleView,
  cycles: CycleView[],
  family: Family,
  defs: readonly StatusDef[],
  plan: ClosePlan,
): Promise<CloseResult> {
  const stateDir = join(contextRoot, 'state');
  const cancelKey = defs.find((d) => d.kind === 'cancelled')?.key ?? null;
  const carry = plan.carried;
  const back = plan.backed;
  const cancel = plan.cancelled;
  const into: CycleView | null = plan.into ? cycles.find((x) => x.id === plan.into) ?? null : null;
  if (carry.length > 0 && (!into || into.status === 'closed')) {
    throw new CloseError(`The cycle this close carries into (${plan.into ?? 'none'}) is missing or closed. Open one (dreamcontext cycle new --goal "...") and finish with: dreamcontext cycle close ${cycle.number} --into <n>`, 'missing_into');
  }
  for (const slug of carry) {
    const n = carryCount(cycles, slug) + 1;
    await applyPlacement(backend, family, [slug], { cycle: into!.id, queue: null },
      `carried from cycle ${label(cycle)} into ${label(into!)} (carried ${n}×)`);
  }
  await applyPlacement(backend, family, back, { cycle: null, queue: 'next' }, `back to Next at the close of cycle ${label(cycle)}`);
  for (const slug of cancel) {
    const brief = family.bySlug.get(slug);
    if (!brief) continue;
    const note = `- cancelled at the close of cycle ${label(cycle)}`;
    if (isCancelled(defs, brief.status)) {
      // A resumed close whose cancel wrote the status and stopped before the journal entry:
      // write the entry now. One already there means this step finished: skip it.
      if ((await backend.readJournal(slug)).some((e) => e.kind === 'status' && e.body === note)) continue;
    } else {
      await backend.updateFields(slug, { status: cancelKey!, updated_at: today() });
    }
    await backend.addJournal(slug, { kind: 'status', label: cancelKey!, body: note });
  }
  const parents = [...carry, ...back, ...cancel].map((s) => family.parentOf.get(s)).filter((p): p is string => !!p);
  await syncParentPlacements(backend, stateDir, defs, readCycles(contextRoot).cycles, parents);
  const closed = recordClose(contextRoot, cycle.id, { carried: carry, backed: back, cancelled: cancel, result: plan.result });
  return { cycle: closed, into, moved: { carry, back, cancel }, result: plan.result };
}

/**
 * The dashboard's close (`POST /api/cycles/:id/close`): a decision per unfinished leaf.
 * Decisions for slugs that are not unfinished leaves of this cycle are ignored. A close
 * that stopped halfway finishes its recorded decisions and ignores new ones.
 */
export async function closeCycle(
  contextRoot: string,
  backend: TaskBackend,
  cycleRef: string,
  decisions: Record<string, unknown>,
  intoRef?: string,
): Promise<CloseResult> {
  const { cycle, cycles } = closableCycle(contextRoot, cycleRef);
  const defs = loadStatuses(contextRoot);
  const family = loadFamily(join(contextRoot, 'state'));
  let plan: ClosePlan;
  if (cycle.closing) {
    plan = resumeClose(contextRoot, cycle, cycles, intoRef);
  } else {
    const leaves = new Set(cycleProgress(family, defs, cycle.id).open.map((b) => b.slug));
    const map = new Map<string, CloseAction>();
    for (const [slug, action] of Object.entries(decisions ?? {})) {
      if (!leaves.has(slug)) continue;
      if (CLOSE_ACTIONS.includes(action as CloseAction)) map.set(slug, action as CloseAction);
    }
    plan = decideClose(contextRoot, cycle, cycles, family, defs, map, intoRef);
  }
  return executeClose(contextRoot, backend, cycle, readCycles(contextRoot).cycles, family, defs, plan);
}
