/**
 * The dashboard's copy of the "when?" axis (dashboard/src/components/tasks/taskOrder.ts)
 * equals src/lib/task-order.ts on one case table (mirror-with-drift-test pattern): the
 * board's Now / Next / Later columns and the server agree on where every card sits.
 */
import { describe, it, expect } from 'vitest';
import * as server from '../../src/lib/task-order.js';
import * as dash from '../../dashboard/src/components/tasks/taskOrder.js';

const ACTIVE = 'cy_active01';

const CASES: Array<{ cycle?: string | null; queue?: string | null }> = [
  {},
  { cycle: null, queue: null },
  { queue: 'next' },
  { queue: 'later' },
  { queue: 'someday' },
  { cycle: ACTIVE },
  { cycle: ` ${ACTIVE} ` },
  { cycle: 'cy_planned1' },
  { cycle: 'cy_planned1', queue: 'later' },
  { cycle: '   ', queue: 'later' },
  { cycle: '', queue: 'next' },
];

describe('the dashboard order axis mirrors the server', () => {
  it('orderOf agrees for every case, with and without an active cycle', () => {
    for (const c of CASES) {
      for (const active of [ACTIVE, null, 'cy_other0001']) {
        expect(dash.orderOf(c, active), JSON.stringify({ c, active })).toBe(server.orderOf(c, active));
      }
    }
  });

  it('cycleOfCard and bucketOf agree for every case', () => {
    for (const c of CASES) {
      expect(dash.cycleOfCard(c), JSON.stringify(c)).toBe(server.cycleOfCard(c));
      expect(dash.bucketOf(c), JSON.stringify(c)).toBe(server.bucketOf(c));
    }
  });

  it('the order names are the same three, in board order', () => {
    const names: server.Order[] = ['now', 'next', 'later'];
    expect([...dash.ORDERS]).toEqual(names);
  });
});
