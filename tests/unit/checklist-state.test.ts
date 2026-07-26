/**
 * Unit tests for the pinned checklist window's pure reducer (chat-interactive-
 * views plan §1.13, T3). No localStorage, no Tauri, no React — just the state
 * transitions a checklist window dispatches as the user ticks items, types
 * notes, and attaches files.
 */
import { describe, it, expect } from 'vitest';
import {
  checklistReducer, emptyState, doneCount, MAX_NOTE_CHARS,
  type ChecklistState,
} from '../../dashboard/src/lib/checklistState.js';
import type { ChecklistViewSpec } from '../../dashboard/src/lib/chatViewSpec.js';

// A minimal, structurally-valid ChecklistViewSpec fixture. `type` is erased by
// `import type` at build time, so this plain object needs no runtime import of
// chatViewSpec.ts to satisfy the type — only `tsc --noEmit` checks the shape.
function spec(items: Array<{ id: string; wants?: 'note' | 'file' | 'secret' }>): ChecklistViewSpec {
  return {
    type: 'checklist',
    id: 'test-checklist',
    title: 'Test checklist',
    items: items.map((i) => ({ id: i.id, text: `Step ${i.id}`, wants: i.wants })),
  };
}

describe('emptyState', () => {
  it('seeds every current item as unchecked, with no notes or files', () => {
    const s = emptyState(spec([{ id: 'a' }, { id: 'b' }]));
    expect(s.checked).toEqual({ a: false, b: false });
    expect(s.notes).toEqual({});
    expect(s.files).toEqual({});
    expect(s.v).toBe(1);
  });
});

describe('checklistReducer — toggle', () => {
  it('is deterministic: applying it twice independently from the same state yields the same result', () => {
    const s0 = emptyState(spec([{ id: 'a' }]));
    const r1 = checklistReducer(s0, { t: 'toggle', id: 'a' });
    const r2 = checklistReducer(s0, { t: 'toggle', id: 'a' });
    expect(r1.checked).toEqual(r2.checked);
    expect(r1.checked.a).toBe(true);
  });

  it('flips back to the original value on a second sequential toggle', () => {
    const s0 = emptyState(spec([{ id: 'a' }]));
    const s1 = checklistReducer(s0, { t: 'toggle', id: 'a' });
    const s2 = checklistReducer(s1, { t: 'toggle', id: 'a' });
    expect(s2.checked.a).toBe(false);
  });

  it('does not mutate ids other than the one toggled', () => {
    const s0 = emptyState(spec([{ id: 'a' }, { id: 'b' }]));
    const s1 = checklistReducer(s0, { t: 'toggle', id: 'a' });
    expect(s1.checked.b).toBe(false);
  });
});

describe('checklistReducer — setNote', () => {
  it('caps note text at MAX_NOTE_CHARS', () => {
    const s0 = emptyState(spec([{ id: 'a' }]));
    const long = 'x'.repeat(MAX_NOTE_CHARS + 500);
    const s1 = checklistReducer(s0, { t: 'setNote', id: 'a', text: long });
    expect(s1.notes.a.length).toBe(MAX_NOTE_CHARS);
  });

  it('leaves a shorter note untouched', () => {
    const s0 = emptyState(spec([{ id: 'a' }]));
    const s1 = checklistReducer(s0, { t: 'setNote', id: 'a', text: 'found it under Keys' });
    expect(s1.notes.a).toBe('found it under Keys');
  });

  it('clearing a note back to empty removes the entry rather than storing ""', () => {
    const s0 = emptyState(spec([{ id: 'a' }]));
    const s1 = checklistReducer(s0, { t: 'setNote', id: 'a', text: 'something' });
    const s2 = checklistReducer(s1, { t: 'setNote', id: 'a', text: '' });
    expect(s2.notes.a).toBeUndefined();
  });
});

describe('checklistReducer — addFile', () => {
  it('dedupes: adding the same path twice keeps only one entry', () => {
    const s0 = emptyState(spec([{ id: 'a', wants: 'file' }]));
    const s1 = checklistReducer(s0, { t: 'addFile', id: 'a', paths: ['/tmp/key.p8'] });
    const s2 = checklistReducer(s1, { t: 'addFile', id: 'a', paths: ['/tmp/key.p8'] });
    expect(s2.files.a).toEqual(['/tmp/key.p8']);
  });

  it('appends a genuinely new path alongside an existing one', () => {
    const s0 = emptyState(spec([{ id: 'a', wants: 'file' }]));
    const s1 = checklistReducer(s0, { t: 'addFile', id: 'a', paths: ['/tmp/a.png'] });
    const s2 = checklistReducer(s1, { t: 'addFile', id: 'a', paths: ['/tmp/b.png'] });
    expect(s2.files.a).toEqual(['/tmp/a.png', '/tmp/b.png']);
  });
});

describe('checklistReducer — removeFile', () => {
  it('is a no-op for an item id with no files attached (unknown item id ignored)', () => {
    const s0 = emptyState(spec([{ id: 'a' }]));
    const s1 = checklistReducer(s0, { t: 'removeFile', id: 'never-attached', path: '/tmp/x.png' });
    expect(s1.files).toEqual({});
  });

  it('is a no-op for a path that was never attached to a real item', () => {
    const s0 = emptyState(spec([{ id: 'a', wants: 'file' }]));
    const s1 = checklistReducer(s0, { t: 'addFile', id: 'a', paths: ['/tmp/a.png'] });
    const s2 = checklistReducer(s1, { t: 'removeFile', id: 'a', path: '/tmp/other.png' });
    expect(s2.files.a).toEqual(['/tmp/a.png']);
  });

  it('removes exactly the named path, leaving siblings intact', () => {
    const s0 = emptyState(spec([{ id: 'a', wants: 'file' }]));
    const s1 = checklistReducer(s0, { t: 'addFile', id: 'a', paths: ['/tmp/a.png', '/tmp/b.png'] });
    const s2 = checklistReducer(s1, { t: 'removeFile', id: 'a', path: '/tmp/a.png' });
    expect(s2.files.a).toEqual(['/tmp/b.png']);
  });
});

describe('checklistReducer — reset', () => {
  it('clears every field back to empty', () => {
    const s0 = emptyState(spec([{ id: 'a' }]));
    const s1 = checklistReducer(s0, { t: 'toggle', id: 'a' });
    const s2 = checklistReducer(s1, { t: 'reset' });
    expect(s2.checked).toEqual({});
    expect(s2.notes).toEqual({});
    expect(s2.files).toEqual({});
  });
});

describe('doneCount', () => {
  it('counts only items ticked in the current spec', () => {
    const sp = spec([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    let s: ChecklistState = emptyState(sp);
    s = checklistReducer(s, { t: 'toggle', id: 'a' });
    s = checklistReducer(s, { t: 'toggle', id: 'c' });
    expect(doneCount(sp, s)).toBe(2);
  });

  it('ignores a stale/unknown id sitting in state.checked that is not part of the spec', () => {
    const sp = spec([{ id: 'a' }]);
    const s: ChecklistState = {
      v: 1,
      updatedAt: 0,
      checked: { a: false, 'stale-removed-item': true },
      notes: {},
      files: {},
    };
    expect(doneCount(sp, s)).toBe(0);
  });

  it('is zero for a fresh empty state', () => {
    const sp = spec([{ id: 'a' }, { id: 'b' }]);
    expect(doneCount(sp, emptyState(sp))).toBe(0);
  });
});
