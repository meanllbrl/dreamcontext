import { describe, it, expect } from 'vitest';
import { diffLines, diffStats } from '../../dashboard/src/lib/lineDiff.js';

const doc = (...lines: string[]) => lines.join('\n');

describe('diffLines', () => {
  it('returns no hunks for identical text', () => {
    expect(diffLines('a\nb\nc', 'a\nb\nc')).toEqual([]);
  });

  it('reports a single-line change with surrounding context', () => {
    const oldText = doc('one', 'two', 'three', 'four', 'five', 'six', 'seven');
    const newText = doc('one', 'two', 'three', 'FOUR', 'five', 'six', 'seven');
    const hunks = diffLines(oldText, newText);
    expect(hunks).toHaveLength(1);
    const kinds = hunks[0].lines.map((l) => l.kind);
    expect(kinds).toEqual(['ctx', 'ctx', 'ctx', 'del', 'add', 'ctx', 'ctx', 'ctx']);
    expect(hunks[0].lines.find((l) => l.kind === 'del')?.text).toBe('four');
    expect(hunks[0].lines.find((l) => l.kind === 'add')?.text).toBe('FOUR');
  });

  it('numbers lines like git: old numbers skip adds, new numbers skip dels', () => {
    const hunks = diffLines(doc('a', 'b', 'c'), doc('a', 'x', 'c'));
    const del = hunks[0].lines.find((l) => l.kind === 'del')!;
    const add = hunks[0].lines.find((l) => l.kind === 'add')!;
    expect(del.oldNo).toBe(2);
    expect(del.newNo).toBeUndefined();
    expect(add.newNo).toBe(2);
    expect(add.oldNo).toBeUndefined();
    expect(hunks[0].header).toBe('@@ -1,3 +1,3 @@');
  });

  it('splits far-apart changes into separate hunks', () => {
    const base = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const changed = base.slice();
    changed[2] = 'CHANGED-TOP';
    changed[27] = 'CHANGED-BOTTOM';
    const hunks = diffLines(base.join('\n'), changed.join('\n'));
    expect(hunks).toHaveLength(2);
  });

  it('handles pure insertion into an empty document', () => {
    const hunks = diffLines('', doc('', 'new line'));
    const stats = diffStats(hunks);
    expect(stats.added).toBeGreaterThan(0);
    expect(stats.removed).toBe(0);
  });

  it('degrades to a whole-block replace past the DP cap without hanging', () => {
    // Middles > 3000 lines with NO common prefix/suffix force the fallback path.
    const oldText = Array.from({ length: 3200 }, (_, i) => `old ${i}`).join('\n');
    const newText = Array.from({ length: 3200 }, (_, i) => `new ${i}`).join('\n');
    const hunks = diffLines(oldText, newText);
    const stats = diffStats(hunks);
    expect(stats.removed).toBe(3200);
    expect(stats.added).toBe(3200);
  });
});

describe('diffStats', () => {
  it('counts adds and removes across hunks', () => {
    const hunks = diffLines(doc('a', 'b', 'c'), doc('a', 'x', 'y', 'c'));
    expect(diffStats(hunks)).toEqual({ added: 2, removed: 1 });
  });
});
