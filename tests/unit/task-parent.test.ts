import { describe, it, expect } from 'vitest';
import {
  childrenOf,
  inheritFromParent,
  isMappedWaveChild,
  latestWaveMap,
  openChildren,
  validateParentLink,
  waveChildren,
  waveCount,
  type ParentLinkTask,
} from '../../src/lib/task-parent.js';
import { DEFAULT_STATUSES } from '../../src/lib/task-status.js';

/** The sub-task link rules: two levels max, the parent must exist, null always clears. */
const tasks: ParentLinkTask[] = [
  { slug: 'parent', parent_task: null },
  { slug: 'child-a', parent_task: 'parent' },
  { slug: 'child-b', parent_task: 'parent' },
  { slug: 'loner', parent_task: null },
  { slug: 'other', parent_task: null },
];

describe('validateParentLink', () => {
  it('null clears the link, always', () => {
    expect(validateParentLink(tasks, 'child-a', null)).toEqual({ ok: true });
    expect(validateParentLink(tasks, 'parent', null)).toEqual({ ok: true });
  });

  it('accepts a top-level parent for a task with no children', () => {
    expect(validateParentLink(tasks, 'loner', 'parent')).toEqual({ ok: true });
    expect(validateParentLink(tasks, 'child-a', 'other')).toEqual({ ok: true });
  });

  it('self', () => {
    const v = validateParentLink(tasks, 'loner', 'loner');
    expect(v.ok === false && v.code).toBe('self');
  });

  it('parent_missing', () => {
    const v = validateParentLink(tasks, 'loner', 'ghost');
    expect(v.ok === false && v.code).toBe('parent_missing');
  });

  it('parent_is_child: a subtask cannot have subtasks (two levels max)', () => {
    const v = validateParentLink(tasks, 'loner', 'child-a');
    expect(v.ok === false && v.code).toBe('parent_is_child');
  });

  it('child_has_children: a task with subtasks cannot become a subtask', () => {
    const v = validateParentLink(tasks, 'parent', 'other');
    expect(v.ok === false && v.code).toBe('child_has_children');
  });
});

describe('childrenOf', () => {
  it('lists the tasks whose parent_task names the slug, in order', () => {
    expect(childrenOf(tasks, 'parent').map((t) => t.slug)).toEqual(['child-a', 'child-b']);
    expect(childrenOf(tasks, 'loner')).toEqual([]);
  });
});

describe('a dangling parent link', () => {
  it('a task whose parent_task names a missing task is top-level and may take subtasks', () => {
    const t: ParentLinkTask[] = [{ slug: 'stuck', parent_task: 'deleted-parent' }, { slug: 'new', parent_task: null }];
    expect(validateParentLink(t, 'new', 'stuck')).toEqual({ ok: true });
  });
});

describe('closed parents, open children, inheritance', () => {
  const tasks = [
    { slug: 'open-parent', parent_task: null, status: 'in_progress' },
    { slug: 'done-parent', parent_task: null, status: 'completed' },
    { slug: 'gone-parent', parent_task: null, status: 'cancelled' },
    { slug: 'kid-open', parent_task: 'open-parent', status: 'todo' },
    { slug: 'kid-done', parent_task: 'open-parent', status: 'completed' },
    { slug: 'kid-cancelled', parent_task: 'open-parent', status: 'cancelled' },
    { slug: 'loner', parent_task: null, status: 'todo' },
  ];
  const defs = [
    ...DEFAULT_STATUSES,
    { key: 'cancelled', label: 'Cancelled', kind: 'cancelled' as const, order: 99 },
  ];

  it('refuses a done- or cancelled-kind parent with parent_closed', () => {
    const done = validateParentLink(tasks, 'loner', 'done-parent', defs);
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.code).toBe('parent_closed');
    const cancelled = validateParentLink(tasks, 'loner', 'gone-parent', defs);
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) expect(cancelled.code).toBe('parent_closed');
    expect(validateParentLink(tasks, 'loner', 'open-parent', defs)).toEqual({ ok: true });
  });

  it('a task with no status (old callers) is never treated as closed', () => {
    expect(validateParentLink([{ slug: 'p', parent_task: null }], 'c', 'p')).toEqual({ ok: true });
  });

  it('openChildren skips done and cancelled children', () => {
    expect(openChildren(tasks, 'open-parent', defs).map((t) => t.slug)).toEqual(['kid-open']);
    expect(openChildren(tasks, 'loner', defs)).toEqual([]);
  });

  it('inheritFromParent carries version, feature and a Why', () => {
    expect(inheritFromParent({ slug: 'p', name: 'The Parent', version: '1.0', related_feature: 'f' }))
      .toEqual({ version: '1.0', related_feature: 'f', why: 'Part of The Parent (`p`).' });
  });
});

describe('waves (waveChildren, latestWaveMap, isMappedWaveChild)', () => {
  const oldMap = 'WAVE MAP: EXECUTION: lead | W1 (a.ts) | W2 (b.ts)';
  const newMap = '- WAVE MAP: EXECUTION: lead | W1 1-dalga-api (a.ts) | W2 2-dalga-ui (b.ts) | also run: x.test.ts';
  const parent = { technical_details: `Plan prose mentioning the WAVE MAP: inline is not a map.\n\n${oldMap}\n\n${newMap}\n` };
  const kids = [
    { slug: 'sleep-found-bug', name: 'A bug sleep found', filed_by: 'sleep' },
    { slug: '2-dalga-ui', name: '2. dalga: ui', filed_by: 'plan' },
    { slug: '1-dalga-api', name: '1. dalga: api', filed_by: 'plan' },
    { slug: '1-dalga-api-extra', name: 'Something', filing_basis: { kind: 'plan' } },
  ];

  it('the newest map is the LAST anchored line; prose never matches', () => {
    expect(latestWaveMap(parent.technical_details)).toBe(newMap);
    expect(waveCount(parent.technical_details)).toBe(2);
    expect(latestWaveMap('nothing here')).toBeNull();
  });

  it('plan children only, numbered from the map by whole-token slug, sleep children ignored', () => {
    const waves = waveChildren(parent, kids);
    expect(waves.map((w) => [w.child.slug, w.wave])).toEqual([
      ['1-dalga-api', 1],
      ['2-dalga-ui', 2],
      // a plan child the map does not name and whose name has no number: last, unnumbered
      ['1-dalga-api-extra', null],
    ]);
  });

  it('falls back to the "N. dalga" number in the name when the map names no slug', () => {
    const waves = waveChildren({ technical_details: oldMap }, kids);
    expect(waves.find((w) => w.child.slug === '2-dalga-ui')?.wave).toBe(2);
  });

  it('only a plan child the newest map names is a mapped wave (the eval-gate exemption)', () => {
    expect(isMappedWaveChild(parent, { slug: '1-dalga-api', filed_by: 'plan' })).toBe(true);
    expect(isMappedWaveChild(parent, { slug: '1-dalga-api', filed_by: 'sleep' })).toBe(false);
    expect(isMappedWaveChild(parent, { slug: 'not-on-map', filed_by: 'plan' })).toBe(false);
    expect(isMappedWaveChild({ technical_details: oldMap }, { slug: '1-dalga-api', filed_by: 'plan' })).toBe(false);
  });
});
