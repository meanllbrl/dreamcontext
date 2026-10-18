/**
 * Second-pass review, Minor 9: `t(key).replace('{name}', value)` read `$&`, `` $` ``, `$'` and
 * `$$` in the value as replacement patterns, so a task, tag, agent or actor name with a `$`
 * was drawn wrong. Every placeholder in the dashboard now goes through `fill` (lib/fill.ts),
 * which inserts values literally and in one pass.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fill } from '../../dashboard/src/lib/fill';

const ROOT = join(import.meta.dirname, '..', '..');

describe('fill', () => {
  it('inserts a value with $ patterns as typed', () => {
    expect(fill('Delete {name}?', { name: "Fix $' rounding, $` too, $& and $$ cash" })).toBe("Delete Fix $' rounding, $` too, $& and $$ cash?");
  });

  it('fills in one pass, every occurrence, and leaves a placeholder with no value', () => {
    expect(fill('{a} and {b}', { a: '{b}', b: 'B' })).toBe('{b} and B');
    expect(fill('{n} of {n}', { n: 3 })).toBe('3 of 3');
    expect(fill('{done}/{total}', { done: '1' })).toBe('1/{total}');
  });
});

describe('the dashboard fills placeholders only through fill', () => {
  it("no `.replace('{…}', …)` is left in dashboard/src", () => {
    let hits = '';
    try {
      hits = execFileSync('git', ['grep', '-n', "\\.replace('{", '--', 'dashboard/src'], { cwd: ROOT, encoding: 'utf-8' });
    } catch (err) {
      // git grep exits 1 when nothing matches: that is the pass.
      if ((err as { status?: number }).status !== 1) throw err;
    }
    expect(hits).toBe('');
  });
});
