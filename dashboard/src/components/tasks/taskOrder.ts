/**
 * MIRROR of the "when?" axis in src/lib/task-order.ts (`Order`, `cycleOfCard`,
 * `orderOf`, `bucketOf`): the dashboard cannot import from src/. Kept identical by
 * tests/unit/task-order-mirror.test.ts, which runs both on one case table; change
 * them together.
 *
 * Now (the active cycle), Next (the queue the next cycle is planned from), Later.
 * Importance is the rank inside a bucket.
 */

export type Order = 'now' | 'next' | 'later';
export const ORDERS: readonly Order[] = ['now', 'next', 'later'];

export interface Placed {
  cycle?: string | null;
  queue?: string | null;
}

/** The cycle id a card points at (trimmed), or null. */
export function cycleOfCard(t: Placed): string | null {
  return typeof t.cycle === 'string' && t.cycle.trim() ? t.cycle.trim() : null;
}

/**
 * Where a card sits on the axis. In the active cycle → now. In any other cycle
 * (planned, closed, or not yet synced) → next. Otherwise its queue (null → next).
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
