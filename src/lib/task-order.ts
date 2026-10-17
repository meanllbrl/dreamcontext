import type { Cycle } from './cycles.js';

/**
 * The one "when?" axis: Now (the active cycle), Next (the queue the next
 * cycle is planned from), Later. Importance is the rank inside a bucket.
 * Priority, urgency and BACKLOG are retired: kept readable on old cards, never
 * written by these paths, and mapped to a remote's priority (lossy, see below).
 *
 * On a card: `cycle: cy_<id> | null`, `queue: next | later | null` (only read
 * when `cycle` is null; null reads as next), `rank: <number>`.
 */

export type Order = 'now' | 'next' | 'later';
export type Queue = 'next' | 'later';

export interface Placement {
  cycle: string | null;
  queue: Queue | null;
}

export interface Placed {
  cycle?: string | null;
  queue?: string | null;
}

export function isQueue(v: unknown): v is Queue {
  return v === 'next' || v === 'later';
}

/** The cycle id a card points at (trimmed), or null. */
export function cycleOfCard(t: Placed): string | null {
  return typeof t.cycle === 'string' && t.cycle.trim() ? t.cycle.trim() : null;
}

/**
 * Where a card sits on the axis. In the active cycle → now. In any other cycle
 * (planned, closed, or not yet synced) → next: it is not being worked this
 * cycle. Otherwise its queue (null → next).
 */
export function orderOf(t: Placed, activeCycleId: string | null): Order {
  const c = cycleOfCard(t);
  if (c) return c === activeCycleId ? 'now' : 'next';
  return t.queue === 'later' ? 'later' : 'next';
}

/** The bucket a rank is ordered within: one cycle, or one queue. */
export function bucketOf(t: Placed): string {
  const c = cycleOfCard(t);
  if (c) return `cycle:${c}`;
  return `queue:${t.queue === 'later' ? 'later' : 'next'}`;
}

/** True when a card carries the new model (a cycle or a queue), as opposed to only legacy priority. */
export function hasPlacement(t: Placed): boolean {
  return cycleOfCard(t) !== null || isQueue(t.queue);
}

/**
 * A parent's placement is derived from its open children: the earliest place
 * any of them holds (active cycle, then planned cycles by start, then a cycle
 * not yet synced, then Next, then Later). Null when it has no open children.
 */
export function derivedParentPlacement(openChildren: Placed[], cycles: Cycle[]): Placement | null {
  if (openChildren.length === 0) return null;
  const byId = new Map(cycles.map((c) => [c.id, c]));
  const weight = (t: Placed): [number, string] => {
    const c = cycleOfCard(t);
    if (c) {
      const cy = byId.get(c);
      if (!cy) return [2, c];
      if (cy.status === 'active') return [0, cy.start];
      if (cy.status === 'planned') return [1, cy.start];
      return [3, cy.start];
    }
    return t.queue === 'later' ? [5, ''] : [4, ''];
  };
  const best = [...openChildren].sort((a, b) => {
    const [wa, sa] = weight(a);
    const [wb, sb] = weight(b);
    return wa - wb || sa.localeCompare(sb);
  })[0];
  const c = cycleOfCard(best);
  return c ? { cycle: c, queue: null } : { cycle: null, queue: best.queue === 'later' ? 'later' : 'next' };
}

// ─── Remote priority (lossy, both directions) ───────────────────────────────

/**
 * Placement → a remote's priority. GitHub labels speak critical/high/medium/low,
 * ClickUp numbers urgent(1)/high(2)/normal(3)/low(4). A task in ANY cycle
 * (active or planned, or one not yet synced) → high; the Next queue → normal
 * (medium); Later → low. Nothing maps to urgent/critical.
 *
 * Owner decision 2026-10-17: in a cycle is always high, not "high only when
 * the cycle is active". Which cycle is active is read from each machine's own
 * core/CYCLES.json, and a machine whose copy is behind would otherwise send
 * normal for a task in the active cycle, which the other machine reads as
 * "take it out". No machine ever sends normal for a task that is in a cycle.
 */
export function priorityForPlacement(t: Placed): 'high' | 'medium' | 'low' {
  if (cycleOfCard(t)) return 'high';
  return t.queue === 'later' ? 'low' : 'medium';
}

/**
 * A remote priority → order. urgent / critical / high → now when the task is
 * in the active cycle, else next (a remote cannot put a task INTO a cycle);
 * normal / medium → next; low → later. Unknown or absent → null (no signal).
 */
export function orderFromPriority(priority: string | null | undefined, inActiveCycle: boolean): Order | null {
  const p = String(priority ?? '').trim().toLowerCase();
  if (p === 'urgent' || p === 'critical' || p === 'high' || p === '1' || p === '2') return inActiveCycle ? 'now' : 'next';
  if (p === 'normal' || p === 'medium' || p === '3') return 'next';
  if (p === 'low' || p === '4') return 'later';
  return null;
}

/**
 * The priority a push sends for a card: its legacy `priority` verbatim while it
 * is only on the old model (a priority and no cycle or queue), else the one its
 * placement maps to ({@link priorityForPlacement}). A card with neither reads as Next and sends medium, so a pull
 * after the push sees the value it sent and changes nothing.
 */
export function wirePriority(
  t: Placed & { priority?: unknown },
  // Kept for callers: the mapping no longer depends on which cycle is active.
  _activeCycleId: string | null,
): string {
  const legacy = typeof t.priority === 'string' && t.priority.trim() ? t.priority.trim() : null;
  if (legacy && !hasPlacement(t)) return legacy;
  return priorityForPlacement(t);
}

/**
 * Apply a remote order to a card's placement. `now` is only reachable for a
 * task already in the active cycle, so it changes nothing; `next` takes a task
 * out of the active cycle (a planned cycle already reads as next and is kept);
 * `later` always leaves its cycle.
 */
export function placementForOrder(current: Placed, order: Order, activeCycleId: string | null): Placement {
  const c = cycleOfCard(current);
  const queue: Queue | null = isQueue(current.queue) ? current.queue : null;
  if (order === 'now') return { cycle: c, queue };
  if (order === 'next') {
    if (c && c !== activeCycleId) return { cycle: c, queue: null };
    return { cycle: null, queue: 'next' };
  }
  return { cycle: null, queue: 'later' };
}

type Winner = 'local' | 'remote' | 'none';
type Scalar = <T>(base: T | undefined, local: T, remote: T) => { value: T; winner: Winner };

export interface OrderMergeInput {
  /** The last synced frontmatter (null when there is no base). */
  base: Record<string, unknown> | null;
  local: Record<string, unknown>;
  /** The remote's cycle id; `undefined` when this remote does not carry cycles. */
  remoteCycle?: string | null;
  /** The remote's priority as it actually is (null: none set, no signal). */
  remotePriority: string | null;
  activeCycleId: string | null;
  /**
   * The priority the remote held at the last sync (what the last pull read or
   * the last push sent; the ledger's `remote_priority`). "The remote moved" is
   * judged against THIS, never against what this machine would map today: two
   * machines can disagree on which cycle is active, and that must not read as
   * an edit. Absent (a pre-cycle ledger): falls back to the base card's mapping.
   */
  lastRemotePriority?: string | null;
  scalar: Scalar;
}

export interface OrderMergeResult {
  /** False for a card still only on legacy priority: the caller keeps its priority merge. */
  newModel: boolean;
  cycle: string | null;
  queue: Queue | null;
  cycleWinner: Winner;
  orderWinner: Winner;
}

/** A card's placement as stored (cycle, queue), normalised. */
export function placementOf(t: Placed): Placement {
  return { cycle: cycleOfCard(t), queue: isQueue(t.queue) ? t.queue : null };
}

export function samePlacement(a: Placement, b: Placement): boolean {
  return a.cycle === b.cycle && a.queue === b.queue;
}

function normPriority(p: unknown): string | null {
  return typeof p === 'string' && p.trim() ? p.trim().toLowerCase() : null;
}

/** True when a card is on the new model: it has a cycle or a queue, or holds no legacy priority. */
export function onNewModel(t: Placed & { priority?: unknown }): boolean {
  return hasPlacement(t) || normPriority(t.priority) === null;
}

/**
 * Merge a pulled task's cycle and order. The cycle merges three-way like any
 * scalar (an id this machine does not know yet is still a value). The order:
 * the remote moved when its priority differs from what it held at the last
 * sync; this machine moved when the card's placement differs from the base.
 * Only a remote move maps back through {@link orderFromPriority} (lossy: a
 * remote can take a task out of the active cycle, never put it in); both moved
 * → last write wins. A card that only has a legacy priority stays on the
 * legacy path (`newModel: false`).
 */
export function mergeOrder(i: OrderMergeInput): OrderMergeResult {
  const localPl = placementOf(i.local);
  const carries = i.remoteCycle !== undefined;
  const newModel = onNewModel(i.local) || (i.base !== null && hasPlacement(i.base)) || (carries && !!i.remoteCycle);
  if (!newModel) return { newModel, cycle: localPl.cycle, queue: localPl.queue, cycleWinner: 'none', orderWinner: 'none' };

  const cycleM = carries
    ? i.scalar<string | null>(i.base ? cycleOfCard(i.base) : undefined, localPl.cycle, i.remoteCycle ?? null)
    : { value: localPl.cycle, winner: 'none' as Winner };
  let placement: Placement = { cycle: cycleM.value, queue: localPl.queue };

  const remoteWire = normPriority(i.remotePriority);
  const remoteRef = normPriority(i.lastRemotePriority) ?? (i.base ? wirePriority(i.base, i.activeCycleId) : null);
  // No base (a first link): a remote priority that differs from this card's own mapping counts as the remote's.
  const remoteMoved = remoteWire !== null && remoteWire !== (remoteRef ?? wirePriority(i.local, i.activeCycleId));
  const localMoved = i.base !== null && !samePlacement(placementOf(i.base), localPl);
  let orderWinner: Winner = remoteMoved && localMoved
    ? i.scalar<string>('base', 'local', 'remote').winner
    : remoteMoved ? 'remote' : localMoved ? 'local' : 'none';
  if (orderWinner === 'remote' && cycleM.winner === 'remote' && placement.cycle !== null) {
    // The remote's cycle label just put the card into this cycle; the priority
    // that came with it is what a machine reading that cycle as planned (its
    // CYCLES.json behind) sends, never a request to leave the cycle again.
    orderWinner = 'none';
  }
  if (orderWinner === 'remote') {
    const order = orderFromPriority(remoteWire, placement.cycle !== null && placement.cycle === i.activeCycleId);
    if (order) placement = placementForOrder(placement, order, i.activeCycleId);
    else orderWinner = 'none';
  }
  return { newModel, cycle: placement.cycle, queue: placement.queue, cycleWinner: cycleM.winner, orderWinner };
}

/**
 * The priority a push sends. A legacy card sends its own. A card on the new
 * model sends the priority its order maps to only when its placement moved
 * since the last sync (or it never synced); otherwise it carries through what
 * the remote already holds. A machine whose CYCLES.json is behind (it reads a
 * teammate's active cycle as planned or unknown) therefore never rewrites a
 * teammate's "high" to "medium" just by pushing some other change.
 */
export function pushPriority(
  card: Placed & { priority?: unknown },
  base: Record<string, unknown> | null,
  lastRemotePriority: string | null | undefined,
  activeCycleId: string | null,
): string {
  if (!onNewModel(card)) return wirePriority(card, activeCycleId);
  const last = normPriority(lastRemotePriority);
  const moved = base === null || !samePlacement(placementOf(base), placementOf(card));
  if (!moved && last) return last;
  return wirePriority(card, activeCycleId);
}

/**
 * The placement the remote's own state stands for (the base a pull records
 * when local changes are kept for the next push), so the following pull
 * compares like with like.
 */
export function remotePlacement(
  local: Record<string, unknown>,
  remoteCycle: string | null | undefined,
  remotePriority: string | null,
  activeCycleId: string | null,
): Placement {
  const start: Placement = {
    cycle: remoteCycle !== undefined ? remoteCycle : cycleOfCard(local),
    queue: isQueue(local.queue) ? local.queue : null,
  };
  const order = orderFromPriority(remotePriority, start.cycle !== null && start.cycle === activeCycleId);
  return order ? placementForOrder(start, order, activeCycleId) : start;
}

/**
 * Whether the merged placement disagrees with the cycle label the remote
 * shows, so a push must follow the pull (a half-consistent remote edit, a
 * cycle label left on a task someone set to low, would otherwise bounce).
 * Priority alone never forces a push: the mapping is lossy, and a priority this
 * machine cannot place (another machine's active cycle) is carried, not fixed.
 */
export function orderNeedsPush(merged: Placement, remoteCycle: string | null | undefined): boolean {
  return remoteCycle !== undefined && merged.cycle !== (remoteCycle ?? null);
}

/**
 * The rank writes that place `me` before or after `anchor` among `peers` (the
 * OPEN cards of one bucket, without `me`, in display order: ranked ascending,
 * then unranked). Gap ranks: normally only `me` is written, at the midpoint of
 * its new neighbours. Unranked cards up to the insertion point get a rank first
 * (they sort after every ranked one, so only that prefix needs one), and the
 * ranked cards are renumbered only when a gap is used up.
 */
export function rankWrites(
  peers: Array<{ slug: string; rank: number | null }>,
  me: string,
  anchor: string,
  after: boolean,
  step = 10,
): Map<string, number> {
  const writes = new Map<string, number>();
  const idx = peers.findIndex((p) => p.slug === anchor);
  if (idx < 0) return writes;
  const at = idx + (after ? 1 : 0);
  const rankOf = (i: number): number | null => writes.get(peers[i].slug) ?? peers[i].rank;
  let last: number | null = null;
  for (let i = 0; i < at; i++) {
    const r = rankOf(i);
    if (r === null) {
      const assigned: number = last === null ? step : last + step;
      writes.set(peers[i].slug, assigned);
      last = assigned;
    } else {
      last = r;
    }
  }
  const lo = at > 0 ? rankOf(at - 1) : null;
  const hi = at < peers.length ? rankOf(at) : null;
  let mine: number;
  if (lo === null && hi === null) mine = step;
  else if (lo === null) mine = hi! - step;
  else if (hi === null) mine = lo + step;
  else mine = (lo + hi) / 2;
  if (lo !== null && hi !== null && hi - lo <= 1e-6) {
    // The gap is used up: renumber the ranked cards around the insertion.
    const ranked = peers.map((p, i) => ({ slug: p.slug, r: rankOf(i) })).filter((p) => p.r !== null);
    const order = [...ranked.slice(0, at).map((p) => p.slug), me, ...ranked.slice(at).map((p) => p.slug)];
    writes.clear();
    order.forEach((slug, i) => writes.set(slug, (i + 1) * step));
    return writes;
  }
  writes.set(me, mine);
  return writes;
}
