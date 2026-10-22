import { describe, it, expect } from 'vitest';
import { childrenOf, validateParentLink, type ParentLinkTask } from '../../src/lib/task-parent.js';

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
