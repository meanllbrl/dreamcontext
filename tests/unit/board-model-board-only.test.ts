import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CARD_PROPS, OLD_DEFAULT_CARD_PROPS, dimGroups, emptyFilters, filterTasks, nestChildren, normCardProps,
  normConfig, normLocalBoard, normSharedBoard, subtaskProgress, criteriaCount,
} from '../../dashboard/src/components/tasks/boardModel';
import type { Task } from '../../dashboard/src/hooks/useTasks';
import { buildStatusModel, DEFAULT_STATUSES } from '../../dashboard/src/lib/statusModel';

/** The board-only Tasks screen's model (AC1, AC3, AC6, AC7). */

function task(slug: string, over: Partial<Task> = {}): Task {
  return {
    slug, id: slug, name: slug, description: '', priority: 'medium', urgency: 'medium', status: 'todo',
    created_at: '2026-10-01', updated_at: '2026-10-01', tags: [], parent_task: null, related_feature: null,
    version: null, rice: null, why: '', user_stories: '', acceptance_criteria: '', constraints: '',
    technical_details: '', notes: '', changelog: '', sections: [], body: '', ...over,
  } as Task;
}

describe('a saved view always opens as the status board', () => {
  it.each(['list', 'eisenhower', 'scatter', 'timeline', 'calendar', 'heatmap', 'bogus'])('layout %s → board', (layout) => {
    const cfg = normConfig({ layout, groupBy: 'priority', subGroupBy: 'version', sortBy: 'due' });
    expect(cfg.layout).toBe('board');
    expect(cfg.groupBy).toBe('status');
    expect(cfg.subGroupBy).toBe('none');
    expect(cfg.sortBy).toBe('due');
  });

  it('applies to shared views and local overrides, without touching the stored blob', () => {
    const stored = { views: [{ id: 'v1', name: 'Old list', config: { layout: 'list', groupBy: 'assignee' } }] };
    const before = JSON.stringify(stored);
    const shared = normSharedBoard(stored);
    expect(shared.views[0].config.layout).toBe('board');
    expect(shared.views[0].config.groupBy).toBe('status');
    const local = normLocalBoard({ overrides: { v1: { layout: 'timeline', subGroupBy: 'priority' } } });
    expect(local.overrides.v1.layout).toBe('board');
    expect(local.overrides.v1.subGroupBy).toBe('none');
    expect(JSON.stringify(stored)).toBe(before);
  });
});

describe('the feature filter', () => {
  const tasks = [task('a', { related_feature: 'checkout' }), task('b', { related_feature: 'search' }), task('c')];
  it('includes, excludes and matches "none"', () => {
    const f = emptyFilters();
    expect(filterTasks(tasks, { ...f, feature: { inc: ['checkout'], exc: [] } }, '').map((t) => t.slug)).toEqual(['a']);
    expect(filterTasks(tasks, { ...f, feature: { inc: [], exc: ['checkout'] } }, '').map((t) => t.slug)).toEqual(['b', 'c']);
    expect(filterTasks(tasks, { ...f, feature: { inc: ['none'], exc: [] } }, '').map((t) => t.slug)).toEqual(['c']);
  });
  it('an older stored filter without `feature` reads as empty', () => {
    expect(normConfig({ filters: { status: { inc: ['todo'], exc: [] } } }).filters.feature).toEqual({ inc: [], exc: [] });
  });
});

describe('card property defaults', () => {
  it('a stored object equal to the OLD defaults reads as the new defaults', () => {
    expect(normCardProps({ ...OLD_DEFAULT_CARD_PROPS })).toEqual(DEFAULT_CARD_PROPS);
    expect(DEFAULT_CARD_PROPS).toMatchObject({ description: false, tags: false, urgency: false, due: false, priority: true, version: true, subtasks: true, attachments: true });
  });
  it('a customised object is kept, with the new keys added at their defaults', () => {
    const custom = { ...OLD_DEFAULT_CARD_PROPS, tags: false, rice: true };
    expect(normCardProps(custom)).toEqual({ ...OLD_DEFAULT_CARD_PROPS, tags: false, rice: true, subtasks: true, attachments: true });
  });
  it('a stored choice of the new keys is kept', () => {
    expect(normCardProps({ ...OLD_DEFAULT_CARD_PROPS, subtasks: false })?.subtasks).toBe(false);
  });
});

describe('nestChildren', () => {
  const parent = task('p', { status: 'in_progress' });
  const kids = [task('k1', { parent_task: 'p', status: 'completed' }), task('k2', { parent_task: 'p' }), task('k3', { parent_task: 'p', status: 'cancelled' })];
  const orphan = task('o', { parent_task: 'gone' });

  it('folds children under a visible parent; column counts equal the cards drawn', () => {
    const { top, childrenByParent } = nestChildren([parent, ...kids, orphan]);
    expect(top.map((t) => t.slug)).toEqual(['p', 'o']);
    expect(childrenByParent.get('p')?.map((t) => t.slug)).toEqual(['k1', 'k2', 'k3']);
    const cols = dimGroups('status', top, { versionOrder: [], assignees: [] });
    expect(cols.reduce((n, c) => n + c.tasks.length, 0)).toBe(top.length);
  });

  it('a child whose parent is filtered out is a card of its own', () => {
    const { top } = nestChildren(kids);
    expect(top.map((t) => t.slug)).toEqual(['k1', 'k2', 'k3']);
  });

  it('two levels max: a grandchild under a nested child stays visible as a card', () => {
    const grand = task('g', { parent_task: 'k2' });
    const { top } = nestChildren([parent, ...kids, grand]);
    expect(top.map((t) => t.slug)).toContain('g');
  });

  it('n/m counts done children over children that are not cancelled', () => {
    const sm = buildStatusModel([...DEFAULT_STATUSES, { key: 'cancelled', label: 'Cancelled', kind: 'cancelled', order: 40 }]);
    expect(subtaskProgress(kids, sm)).toEqual({ done: 1, total: 2 });
  });
});

describe('criteriaCount', () => {
  it('counts checkboxes outside fenced code', () => {
    const t = task('x', { acceptance_criteria: '- [x] one\n- [ ] two\n```\n- [ ] fenced\n```\n- [X] three' });
    expect(criteriaCount(t)).toEqual({ done: 2, total: 3 });
  });
});
