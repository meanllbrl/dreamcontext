/**
 * `disjointRounds` splits du's paths into rounds where no path sits inside another. It used to
 * compare every pair, which froze the dashboard server for ~3 minutes (`super state` measures the
 * leftovers in the background) once $TMPDIR held tens of thousands of old test folders.
 */
import { describe, it, expect } from 'vitest';
import { join, sep } from 'node:path';
import { disjointRounds } from '../../src/lib/super/disk-leftovers.js';

const root = join(sep, 'tmp', 'dc-rounds');

describe('disjointRounds', () => {
  it('puts a path after every path it sits inside, and siblings together', () => {
    const wt = join(root, 'wt');
    const target = join(wt, 'desktop', 'target');
    const deeper = join(target, 'debug');
    const other = join(root, 'other');
    const rounds = disjointRounds([deeper, target, wt, other, wt]);
    expect(rounds).toEqual([[wt, other], [target], [deeper]]);
  });

  it('treats a trailing separator as the same folder and never a prefix of a sibling name', () => {
    const a = join(root, 'a');
    const ab = join(root, 'ab');
    const inner = join(a, 'x');
    const rounds = disjointRounds([`${a}${sep}`, ab, inner]);
    expect(rounds[0]).toEqual([`${a}${sep}`, ab]);
    expect(rounds[1]).toEqual([inner]);
  });

  it('handles 50,000 sibling folders in well under a second', () => {
    const many = Array.from({ length: 50_000 }, (_, i) => join(root, `dc-test-mcp-home-${String(i).padStart(6, '0')}`));
    const t = Date.now();
    const rounds = disjointRounds(many);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toHaveLength(50_000);
  });
});
