/**
 * The board's Now / Next / Later columns and the saved-view normalisation (plan r3 § 5b, with
 * the C4 critic fix): a finished or cancelled card that was never planned is never in Next or
 * Later, a done card is in Now only while it is in the active cycle, and every other done card
 * waits in the closed Done lane. Stored views move to configVersion 2.
 */
import { describe, it, expect } from 'vitest';
import {
  CONFIG_VERSION, defaultViews, groupByOrder, nestByParent, normConfig, normLocalBoard, normSharedBoard,
} from '../../dashboard/src/components/tasks/boardModel';
import { buildStatusModel, DEFAULT_STATUSES } from '../../dashboard/src/lib/statusModel';
import type { Task } from '../../dashboard/src/hooks/useTasks';

const ACTIVE = 'cy_active01';
const sm = buildStatusModel([
  ...DEFAULT_STATUSES,
  { key: 'cancelled', label: 'Cancelled', kind: 'cancelled', order: 99 } as (typeof DEFAULT_STATUSES)[number],
]);

function task(slug: string, over: Partial<Task> = {}): Task {
  return {
    slug, id: `task_${slug}`, name: slug, description: '', priority: 'medium', urgency: 'medium', status: 'todo',
    created_at: '2026-10-01', updated_at: '2026-10-01', tags: [], parent_task: null, related_feature: null,
    version: null, rice: null, cycle: null, queue: null, rank: null,
    criteria: { total: 0, done: 0 }, children: null, bytes: 100, ...over,
  };
}

const TASKS: Task[] = [
  task('open-now', { cycle: ACTIVE, rank: 20 }),
  task('done-now', { cycle: ACTIVE, status: 'completed', rank: 10 }),
  task('open-next', { queue: 'next' }),
  task('open-unplaced'),
  task('open-later', { queue: 'later' }),
  task('open-planned-cycle', { cycle: 'cy_planned01' }),
  task('done-unplaced', { status: 'completed' }),
  task('done-later', { status: 'completed', queue: 'later' }),
  task('done-closed-cycle', { status: 'completed', cycle: 'cy_closed001' }),
  task('cancelled-unplaced', { status: 'cancelled' }),
  task('cancelled-later', { status: 'cancelled', queue: 'later' }),
  task('cancelled-now', { status: 'cancelled', cycle: ACTIVE }),
];

const lanes = (active: string | null) =>
  Object.fromEntries(groupByOrder(TASKS, active, sm).map((g) => [g.key, g.tasks.map((t) => t.slug)]));

describe('groupByOrder', () => {
  it('completed and cancelled unplaced tasks are absent from Next and Later', () => {
    const l = lanes(ACTIVE);
    for (const slug of ['done-unplaced', 'done-later', 'done-closed-cycle', 'cancelled-unplaced', 'cancelled-later']) {
      expect(l.next, slug).not.toContain(slug);
      expect(l.later, slug).not.toContain(slug);
    }
    expect(l.next).toEqual(['open-next', 'open-planned-cycle', 'open-unplaced']);
    expect(l.later).toEqual(['open-later']);
  });

  it('a completed task in the active cycle is in Now, ranked with the open ones', () => {
    expect(lanes(ACTIVE).now).toEqual(['done-now', 'open-now']);
  });

  it('the Done lane holds every other done card; cancelled cards are nowhere', () => {
    const l = lanes(ACTIVE);
    expect(l.done.sort()).toEqual(['done-closed-cycle', 'done-later', 'done-unplaced']);
    const all = Object.values(l).flat();
    for (const slug of ['cancelled-unplaced', 'cancelled-later', 'cancelled-now']) expect(all).not.toContain(slug);
  });

  it('with no active cycle, nothing is in Now and every done card is in Done', () => {
    const l = lanes(null);
    expect(l.now).toEqual([]);
    expect(l.done).toContain('done-now');
    expect(l.next).toContain('open-now');
  });

  it('a cancelled card is hidden even when this machine has not declared the status', () => {
    const shipped = buildStatusModel(DEFAULT_STATUSES);
    const all = groupByOrder([task('x', { status: 'cancelled', queue: 'next' })], null, shipped).flatMap((g) => g.tasks);
    expect(all).toEqual([]);
  });

  it('the columns are Now, Next, Later and Done, in that order', () => {
    expect(groupByOrder([], ACTIVE, sm).map((g) => g.key)).toEqual(['now', 'next', 'later', 'done']);
  });
});

describe('nestByParent', () => {
  it('nests a sub-task under its parent in the same column, and heads a lone one with its parent', () => {
    const parent = task('epic');
    const kid = task('kid', { parent_task: 'epic' });
    const lone = task('lone', { parent_task: 'elsewhere' });
    const other = task('elsewhere', { name: 'Elsewhere epic' });
    const items = nestByParent([parent, kid, lone], [parent, kid, lone, other]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'card', node: { task: { slug: 'epic' }, children: [{ slug: 'kid' }] } });
    expect(items[1]).toMatchObject({ kind: 'orphans', parent: { slug: 'elsewhere', name: 'Elsewhere epic' }, nodes: [{ task: { slug: 'lone' } }] });
  });
});

describe('saved views normalise to configVersion 2', () => {
  it('the built-in views ship grouped by order', () => {
    for (const v of defaultViews()) {
      expect(v.config.groupBy).toBe('order');
      expect(v.config.configVersion).toBe(CONFIG_VERSION);
    }
  });

  it('stored `all` (status) and `atrisk` (priority) views become order', () => {
    const shared = normSharedBoard({
      views: [
        { id: 'all', name: 'All Tasks', removable: false, config: { groupBy: 'status', layout: 'board' } },
        { id: 'atrisk', name: 'At Risk', config: { groupBy: 'priority', sortBy: 'due', filters: { due: 'risk' } } },
      ],
    });
    expect(shared.views.map((v) => v.config.groupBy)).toEqual(['order', 'order']);
    expect(shared.views[1].config.filters.due).toBe('risk');
    expect(shared.views.every((v) => v.config.configVersion === CONFIG_VERSION)).toBe(true);
  });

  it('a user view grouped by status stays as it is', () => {
    const shared = normSharedBoard({ views: [{ id: 'mine', name: 'Mine', config: { groupBy: 'status', subGroupBy: 'assignee' } }] });
    expect(shared.views[0].config).toMatchObject({ groupBy: 'status', subGroupBy: 'assignee' });
  });

  it('retired layouts open on the board; priority and urgency move to order and rank; their filters drop', () => {
    for (const layout of ['eisenhower', 'scatter', 'calendar', 'heatmap']) {
      expect(normConfig({ layout }).layout, layout).toBe('board');
    }
    expect(normConfig({ layout: 'timeline' }).layout).toBe('timeline');
    const c = normConfig({
      groupBy: 'urgency', subGroupBy: 'priority', sortBy: 'priority',
      filters: { priority: { inc: ['high'], exc: [] }, urgency: { inc: [], exc: ['low'] }, minRice: 6, tags: { inc: ['ui'], exc: [] } },
    }, 'mine');
    expect(c).toMatchObject({ groupBy: 'order', subGroupBy: 'none', sortBy: 'rank' });
    expect(c.filters).toEqual({ status: { inc: [], exc: [] }, tags: { inc: ['ui'], exc: [] }, version: { inc: [], exc: [] }, assignee: { inc: [], exc: [] }, due: 'all' });
    expect(normConfig({ sortBy: 'rice' }).sortBy).toBe('rank');
  });

  it('a private override of the built-in view migrates by its view id too', () => {
    const local = normLocalBoard({ overrides: { all: { groupBy: 'status' }, mine: { groupBy: 'status' } } });
    expect(local.overrides.all.groupBy).toBe('order');
    expect(local.overrides.mine.groupBy).toBe('status');
  });

  it('a version 2 config is kept as saved, status grouping included', () => {
    expect(normConfig({ configVersion: 2, groupBy: 'status' }, 'all').groupBy).toBe('status');
  });
});
