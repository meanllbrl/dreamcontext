import { describe, it, expect } from 'vitest';
import { liveParentOf, parentsFirst, pulledParent, type PulledParentInput } from '../../src/lib/task-backend/subtask-link.js';

const ids: Record<string, string> = { r1: 'parent-a', r2: 'parent-b', r3: 'nested' };
const base = (over: Partial<PulledParentInput>): PulledParentInput => ({
  slug: 'kid',
  localParent: null,
  baseParent: null,
  remoteParentId: undefined,
  lastRemoteParent: undefined,
  slugForRemoteId: (id) => ids[id] ?? null,
  parentOfLocal: (s) => (s === 'nested' ? 'parent-a' : null),
  hasLocalChildren: () => false,
  ...over,
});

describe('subtask-link', () => {
  it('liveParentOf drops a self or dangling link', () => {
    const exists = (s: string) => s === 'parent-a';
    expect(liveParentOf('kid', { parent_task: 'parent-a' }, exists)).toBe('parent-a');
    expect(liveParentOf('kid', { parent_task: 'gone' }, exists)).toBeNull();
    expect(liveParentOf('kid', { parent_task: 'kid' }, () => true)).toBeNull();
    expect(liveParentOf('kid', {}, exists)).toBeNull();
  });

  it('parentsFirst puts a parent ahead of its children and keeps order otherwise', () => {
    const parents: Record<string, string> = { a: 'z', b: 'outside' };
    expect(parentsFirst(['a', 'b', 'z'], (s) => parents[s] ?? null)).toEqual(['b', 'z', 'a']);
  });

  it('pulledParent: unknown remote parent never changes the local link', () => {
    expect(pulledParent(base({ localParent: 'parent-a', baseParent: 'parent-a' })).parent).toBe('parent-a');
  });

  it('pulledParent: a top-level remote item never clears a local link it was never seen under', () => {
    expect(pulledParent(base({ localParent: 'parent-a', baseParent: 'parent-a', remoteParentId: null })).parent).toBe('parent-a');
  });

  it('pulledParent: taken out of its parent remotely after we saw it there → cleared', () => {
    expect(pulledParent(base({ localParent: 'parent-a', baseParent: 'parent-a', remoteParentId: null, lastRemoteParent: 'r1' })).parent).toBeNull();
  });

  it('pulledParent: moved remotely → follows; a local move awaiting push wins', () => {
    expect(pulledParent(base({ localParent: 'parent-a', baseParent: 'parent-a', remoteParentId: 'r2', lastRemoteParent: 'r1' })).parent).toBe('parent-b');
    expect(pulledParent(base({ localParent: 'parent-a', baseParent: 'parent-b', remoteParentId: 'r2', lastRemoteParent: 'r1' })).parent).toBe('parent-a');
  });

  it('pulledParent: an unmapped or too-deep remote parent is reported and left alone', () => {
    const unmapped = pulledParent(base({ remoteParentId: 'r9' }));
    expect(unmapped.parent).toBeNull();
    expect(unmapped.warning).toContain('not synced');
    const deep = pulledParent(base({ remoteParentId: 'r3' }));
    expect(deep.parent).toBeNull();
    expect(deep.warning).toContain('two levels');
  });

  it('pulledParent: a task with its own sub-tasks is never put under another (three levels)', () => {
    const res = pulledParent(base({ remoteParentId: 'r1', hasLocalChildren: (s) => s === 'kid' }));
    expect(res.parent).toBeNull();
    expect(res.warning).toContain('sub-tasks of its own');
  });
});
