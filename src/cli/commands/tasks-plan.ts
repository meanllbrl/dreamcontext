import type { Command } from 'commander';
import { join } from 'node:path';
import { ensureContextRoot } from '../../lib/context-path.js';
import { error, info, success } from '../../lib/format.js';
import { today } from '../../lib/id.js';
import { loadStatuses } from '../../lib/overrides.js';
import { getTaskBackend, type TaskBackend } from '../../lib/task-backend/index.js';
import { loadFamily, type Family, type TaskBrief } from '../../lib/task-parent.js';
import { isCancelled, isDone, type StatusDef } from '../../lib/task-status.js';
import { readCycles, resolveCycleRef, type CycleView } from '../../lib/cycles.js';
import { bucketOf, derivedParentPlacement, rankWrites, type Placement } from '../../lib/task-order.js';

/**
 * Planning verbs: `tasks plan` puts a task (and, for a parent, its open
 * children) into a cycle or a queue; `tasks rank` orders it inside its bucket.
 * Neither writes priority, urgency or a version.
 */

const RANK_STEP = 10;

async function resolve(backend: TaskBackend, name: string): Promise<string | null> {
  const res = await backend.resolveSlug(name);
  if (res.kind === 'match') return res.slug;
  if (res.kind === 'ambiguous') error(`Ambiguous task name "${name}". Did you mean: ${res.candidates.join(', ')}?`);
  error(`Task not found: ${name}`);
  process.exitCode = 1;
  return null;
}

function isOpen(defs: readonly StatusDef[], b: TaskBrief): boolean {
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

export function registerTaskPlanCommands(tasks: Command): void {
  tasks
    .command('plan')
    .argument('<task>', 'Task name or slug')
    .argument('<target>', 'now (the active cycle) | next | later | a cycle id (cy_…) or number')
    .description('Plan a task into a cycle or a queue (Now / Next / Later). A parent brings its open sub-tasks with it')
    .action(async (name: string, targetRef: string) => {
      const root = ensureContextRoot();
      const stateDir = join(root, 'state');
      const defs = loadStatuses(root);
      const backend = getTaskBackend();
      const slug = await resolve(backend, name);
      if (!slug) return;
      const { cycles } = readCycles(root);
      const t = targetRef.trim().toLowerCase();
      let placement: Placement;
      if (t === 'next' || t === 'later') {
        placement = { cycle: null, queue: t };
      } else {
        const cycle = resolveCycleRef(cycles, targetRef);
        if (!cycle) {
          error(t === 'now'
            ? 'No cycle is active. Start one: dreamcontext cycle new --goal "..." && dreamcontext cycle start <n>'
            : `No cycle "${targetRef}". See: dreamcontext cycle list`);
          process.exitCode = 1;
          return;
        }
        if (cycle.status === 'closed') {
          error(`Cycle #${cycle.number} is closed; plan into the active or a planned cycle.`);
          process.exitCode = 1;
          return;
        }
        placement = { cycle: cycle.id, queue: null };
      }
      const family = loadFamily(stateDir);
      const brief = family.bySlug.get(slug);
      if (!brief) { error(`Task not found: ${slug}`); process.exitCode = 1; return; }
      if (!isOpen(defs, brief)) {
        error(`${slug} is ${brief.status}; only open work is planned.`);
        process.exitCode = 1;
        return;
      }
      const where = describePlacement(placement, cycles);
      const openKids = (family.children.get(slug) ?? []).filter((c) => isOpen(defs, c));
      // A parent brings its open children; their move is journaled one by one.
      const kidMoves = await applyPlacement(backend, family, openKids.map((c) => c.slug), placement,
        `planned into ${where} with its parent ${slug}`);
      const selfMoved = await applyPlacement(backend, family, [slug], placement, `planned into ${where}`);
      const parent = family.parentOf.get(slug);
      if (parent) await syncParentPlacements(backend, stateDir, defs, cycles, [parent]);
      if (selfMoved.length === 0 && kidMoves.length === 0) {
        info(`${slug} is already in ${where}.`);
        return;
      }
      success(`${slug} → ${where}${kidMoves.length > 0 ? ` (with ${kidMoves.length} open sub-task(s))` : ''}.`);
      if (parent) info(`Shown under its parent ${parent}.`);
    });

  tasks
    .command('rank')
    .argument('<task>', 'Task name or slug')
    .option('--before <task>', 'Place it just before this task (same cycle or queue)')
    .option('--after <task>', 'Place it just after this task (same cycle or queue)')
    .description('Order a task inside its cycle or queue (importance is rank, not priority)')
    .action(async (name: string, opts: { before?: string; after?: string }) => {
      if ((opts.before ? 1 : 0) + (opts.after ? 1 : 0) !== 1) {
        error('Give exactly one of --before <task> or --after <task>.');
        process.exitCode = 1;
        return;
      }
      const root = ensureContextRoot();
      const backend = getTaskBackend();
      const slug = await resolve(backend, name);
      if (!slug) return;
      const anchor = await resolve(backend, (opts.before ?? opts.after)!);
      if (!anchor) return;
      if (anchor === slug) { error('A task cannot be ranked against itself.'); process.exitCode = 1; return; }
      const family = loadFamily(join(root, 'state'));
      const me = family.bySlug.get(slug);
      const other = family.bySlug.get(anchor);
      if (!me || !other) { error('Task not found.'); process.exitCode = 1; return; }
      if (bucketOf(me) !== bucketOf(other)) {
        const { cycles } = readCycles(root);
        const where = (b: TaskBrief) => describePlacement({ cycle: b.cycle ?? null, queue: b.queue === 'later' ? 'later' : b.cycle ? null : 'next' }, cycles);
        error(`${slug} is in ${where(me)} and ${anchor} in ${where(other)}; rank orders within one cycle or queue. Plan it there first: dreamcontext tasks plan ${slug} <target>`);
        process.exitCode = 1;
        return;
      }
      const bucket = bucketOf(me);
      // Only open cards are ordered: done, cancelled and legacy closed cards in
      // the same bucket are never rewritten (each write is a push on a remote).
      const defs = loadStatuses(root);
      const peers = [...family.bySlug.values()]
        .filter((b) => bucketOf(b) === bucket && b.slug !== slug && isOpen(defs, b))
        .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.slug.localeCompare(b.slug));
      if (!peers.some((b) => b.slug === anchor)) {
        error(`${anchor} is not open; rank orders open work.`);
        process.exitCode = 1;
        return;
      }
      const writes = rankWrites(peers, slug, anchor, !!opts.after, RANK_STEP);
      let changed = 0;
      for (const [s2, rank] of writes) {
        if (family.bySlug.get(s2)?.rank === rank) continue;
        await backend.updateFields(s2, { rank });
        changed++;
      }
      const at = peers.findIndex((b) => b.slug === anchor) + (opts.after ? 1 : 0);
      if (changed === 0) { info(`${slug} is already ${opts.before ? 'before' : 'after'} ${anchor}.`); return; }
      success(`${slug} ranked ${opts.before ? 'before' : 'after'} ${anchor} (${at + 1} of ${peers.length + 1}).`);
    });
}
