import { describe, it, expect } from 'vitest';
import {
  toTaskRecord,
  filterTasks,
  groupTasks,
  collectTags,
  type TaskRecord,
} from '../../src/lib/task-query.js';

function rec(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    id: null,
    name: 'task',
    description: 'task',
    status: 'todo',
    priority: 'medium',
    urgency: 'medium',
    tags: [],
    version: null,
    related_feature: null,
    parent_task: null,
    rice: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-02',
    file: '',
    ...overrides,
  };
}

describe('toTaskRecord', () => {
  it('normalizes frontmatter into a TaskRecord', () => {
    const r = toTaskRecord(
      {
        id: 'task_1',
        name: 'demo',
        description: 'A demo task',
        status: 'in_progress',
        priority: 'high',
        urgency: 'low',
        tags: ['memoryos', 'backend'],
        version: 'S5',
        related_feature: 'recall-engine',
        parent_task: null,
        created_at: '2026-01-01',
        updated_at: '2026-02-02',
      },
      'demo',
      '/abs/demo.md',
    );
    expect(r).toMatchObject({
      id: 'task_1',
      name: 'demo',
      status: 'in_progress',
      priority: 'high',
      tags: ['memoryos', 'backend'],
      version: 'S5',
      related_feature: 'recall-engine',
      file: '/abs/demo.md',
    });
  });

  it('falls back when fields are missing', () => {
    const r = toTaskRecord({}, 'bare');
    expect(r.status).toBe('unknown');
    expect(r.priority).toBe('-');
    expect(r.tags).toEqual([]);
    expect(r.version).toBeNull();
    expect(r.related_feature).toBeNull();
    // updated_at falls back to created_at, then '-'
    expect(r.updated_at).toBe('-');
  });

  it('updated_at falls back to created_at', () => {
    const r = toTaskRecord({ created_at: '2026-03-03' }, 'x');
    expect(r.updated_at).toBe('2026-03-03');
  });

  it('parses comma-string tags and treats the literal "null" version as null', () => {
    const r = toTaskRecord({ tags: 'a, b ,c', version: 'null' }, 'x');
    expect(r.tags).toEqual(['a', 'b', 'c']);
    expect(r.version).toBeNull();
  });

  it('computes a RICE score when rice fields are present', () => {
    const r = toTaskRecord(
      { rice: { reach: 5, impact: 3, confidence: 100, effort: 3 } },
      'x',
    );
    expect(r.rice?.score).toBe(5);
  });
});

describe('filterTasks — status visibility', () => {
  const tasks = [
    rec({ name: 'a', status: 'todo' }),
    rec({ name: 'b', status: 'in_progress' }),
    rec({ name: 'c', status: 'completed' }),
  ];

  it('hides completed by default', () => {
    expect(filterTasks(tasks).map((t) => t.name)).toEqual(['a', 'b']);
  });

  it('--all includes completed', () => {
    expect(filterTasks(tasks, { all: true }).map((t) => t.name)).toEqual(['a', 'b', 'c']);
  });

  it('--status filters exactly and overrides --all', () => {
    expect(filterTasks(tasks, { status: 'completed', all: false }).map((t) => t.name)).toEqual(['c']);
  });

  it('status match is case-insensitive', () => {
    expect(filterTasks(tasks, { status: 'IN_PROGRESS' }).map((t) => t.name)).toEqual(['b']);
  });

  it('preserves input order', () => {
    const reordered = [tasks[1], tasks[0]];
    expect(filterTasks(reordered).map((t) => t.name)).toEqual(['b', 'a']);
  });
});

describe('filterTasks — tags', () => {
  const tasks = [
    rec({ name: 'a', tags: ['memoryos', 'backend'] }),
    rec({ name: 'b', tags: ['memoryos'] }),
    rec({ name: 'c', tags: ['lina', 'frontend'] }),
  ];

  it('--tag is AND across repeated values', () => {
    expect(filterTasks(tasks, { tags: ['memoryos', 'backend'] }).map((t) => t.name)).toEqual(['a']);
  });

  it('single --tag matches any task carrying it', () => {
    expect(filterTasks(tasks, { tags: ['memoryos'] }).map((t) => t.name)).toEqual(['a', 'b']);
  });

  it('--any-tag is OR across values', () => {
    expect(filterTasks(tasks, { anyTags: ['backend', 'frontend'] }).map((t) => t.name)).toEqual(['a', 'c']);
  });

  it('tag matching is case-insensitive', () => {
    expect(filterTasks(tasks, { tags: ['MemoryOS'] }).map((t) => t.name)).toEqual(['a', 'b']);
  });

  it('composes --tag (AND) with --any-tag (OR)', () => {
    const t2 = [
      rec({ name: 'a', tags: ['memoryos', 'backend'] }),
      rec({ name: 'b', tags: ['memoryos', 'frontend'] }),
      rec({ name: 'c', tags: ['lina', 'backend'] }),
    ];
    expect(
      filterTasks(t2, { tags: ['memoryos'], anyTags: ['backend', 'frontend'] }).map((t) => t.name),
    ).toEqual(['a', 'b']);
  });
});

describe('filterTasks — version / priority / feature', () => {
  const tasks = [
    rec({ name: 'a', version: 'S5', priority: 'critical', related_feature: 'recall' }),
    rec({ name: 'b', version: 'S5', priority: 'low', related_feature: null }),
    rec({ name: 'c', version: 'BACKLOG', priority: 'critical', related_feature: 'sleep' }),
  ];

  it('--version matches exactly (case-insensitive)', () => {
    expect(filterTasks(tasks, { version: 's5' }).map((t) => t.name)).toEqual(['a', 'b']);
  });

  it('--priority matches exactly', () => {
    expect(filterTasks(tasks, { priority: 'critical' }).map((t) => t.name)).toEqual(['a', 'c']);
  });

  it('--feature matches related_feature', () => {
    expect(filterTasks(tasks, { feature: 'recall' }).map((t) => t.name)).toEqual(['a']);
  });

  it('a task with no version never matches a --version filter', () => {
    const t = [rec({ name: 'x', version: null })];
    expect(filterTasks(t, { version: 'S5' })).toEqual([]);
  });

  it('composes filters with AND semantics', () => {
    expect(
      filterTasks(tasks, { version: 'S5', priority: 'critical' }).map((t) => t.name),
    ).toEqual(['a']);
  });
});

describe('groupTasks', () => {
  it('groups by version with the empty bucket last', () => {
    const tasks = [
      rec({ name: 'a', version: 'S5' }),
      rec({ name: 'b', version: null }),
      rec({ name: 'c', version: 'BACKLOG' }),
    ];
    const groups = groupTasks(tasks, 'version');
    expect(groups.map((g) => g.key)).toEqual(['BACKLOG', 'S5', '(no version)']);
    expect(groups.find((g) => g.key === 'S5')!.tasks.map((t) => t.name)).toEqual(['a']);
  });

  it('groups by priority in vocab order', () => {
    const tasks = [
      rec({ name: 'a', priority: 'low' }),
      rec({ name: 'b', priority: 'critical' }),
      rec({ name: 'c', priority: 'medium' }),
    ];
    expect(groupTasks(tasks, 'priority').map((g) => g.key)).toEqual(['critical', 'medium', 'low']);
  });

  it('groups by status in lifecycle order', () => {
    const tasks = [
      rec({ name: 'a', status: 'completed' }),
      rec({ name: 'b', status: 'todo' }),
      rec({ name: 'c', status: 'in_review' }),
    ];
    expect(groupTasks(tasks, 'status').map((g) => g.key)).toEqual(['todo', 'in_review', 'completed']);
  });

  it('groups by tag — a multi-tagged task appears under each tag', () => {
    const tasks = [
      rec({ name: 'a', tags: ['memoryos', 'backend'] }),
      rec({ name: 'b', tags: ['memoryos'] }),
      rec({ name: 'c', tags: [] }),
    ];
    const groups = groupTasks(tasks, 'tag');
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g.tasks.map((t) => t.name)]));
    expect(byKey['memoryos']).toEqual(['a', 'b']);
    expect(byKey['backend']).toEqual(['a']);
    expect(byKey['(untagged)']).toEqual(['c']);
    // (untagged) sorts last
    expect(groups[groups.length - 1].key).toBe('(untagged)');
  });
});

describe('collectTags', () => {
  it('counts distinct tags, sorted by count then name', () => {
    const tasks = [
      rec({ tags: ['memoryos', 'backend'] }),
      rec({ tags: ['memoryos'] }),
      rec({ tags: ['lina'] }),
    ];
    expect(collectTags(tasks)).toEqual([
      { tag: 'memoryos', count: 2 },
      { tag: 'backend', count: 1 },
      { tag: 'lina', count: 1 },
    ]);
  });

  it('returns [] when no tasks carry tags', () => {
    expect(collectTags([rec({ tags: [] })])).toEqual([]);
  });
});
