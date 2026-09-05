import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendTombstone, readTombstones, writeTombstones, findTombstone, resolveTombstone,
  MAX_TOMBSTONES, TOMBSTONES_REL_PATH,
} from '../../src/lib/task-tombstones.js';
import { planCuratorTask, ORPHAN_TAG_CURATOR_THRESHOLD, CURATOR_TASK_SLUG } from '../../src/lib/sleep-flags.js';

/**
 * B3. The bug in one sentence: `planCuratorTask` looked its chore up by fixed
 * slug, so a chore that was MERGED into another task and deleted came back as a
 * fresh empty template on the very next cycle. Observed on this brain every
 * cycle from 2026-07-18 to 2026-08-23.
 */

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-tomb-'));
  mkdirSync(join(root, 'state'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const stamp = '2026-09-06T10:00:00.000Z';

describe('the tombstone ledger', () => {
  it('starts empty and never throws on a missing file', () => {
    expect(readTombstones(root)).toEqual([]);
    expect(findTombstone(root, 'anything')).toBeNull();
  });

  it('records and reads back a deletion', () => {
    appendTombstone(root, { slug: 'old-chore', deletedAt: stamp, absorbedBy: 'the-real-task', reason: 'merged' });
    expect(findTombstone(root, 'old-chore')).toEqual({
      slug: 'old-chore', deletedAt: stamp, absorbedBy: 'the-real-task', reason: 'merged',
    });
  });

  it('is newest-first and REPLACES a re-recorded slug rather than duplicating it', () => {
    appendTombstone(root, { slug: 'a', deletedAt: '2026-01-01T00:00:00.000Z', absorbedBy: 'old-target' });
    appendTombstone(root, { slug: 'b', deletedAt: '2026-02-01T00:00:00.000Z' });
    appendTombstone(root, { slug: 'a', deletedAt: '2026-03-01T00:00:00.000Z', absorbedBy: 'new-target' });
    const all = readTombstones(root);
    expect(all.map((t) => t.slug)).toEqual(['a', 'b']);
    expect(all[0].absorbedBy).toBe('new-target');
  });

  it('caps at MAX_TOMBSTONES, keeping the newest', () => {
    writeTombstones(root, Array.from({ length: MAX_TOMBSTONES + 50 }, (_, i) => ({
      slug: `s${i}`, deletedAt: stamp,
    })));
    const all = readTombstones(root);
    expect(all).toHaveLength(MAX_TOMBSTONES);
    expect(all[0].slug).toBe('s0');
  });

  it('a corrupt ledger degrades to empty instead of breaking every delete', () => {
    writeFileSync(join(root, TOMBSTONES_REL_PATH), '{not json');
    expect(() => readTombstones(root)).not.toThrow();
    expect(readTombstones(root)).toEqual([]);
  });

  it('drops malformed entries but keeps the good ones', () => {
    writeFileSync(join(root, TOMBSTONES_REL_PATH), JSON.stringify([
      { slug: 'good', deletedAt: stamp }, { nope: true }, null, 'string',
    ]));
    expect(readTombstones(root).map((t) => t.slug)).toEqual(['good']);
  });
});

describe('resolveTombstone follows the chain', () => {
  it('resolves a single hop to the living task', () => {
    appendTombstone(root, { slug: 'a', deletedAt: stamp, absorbedBy: 'b' });
    const r = resolveTombstone(root, 'a');
    expect(r.livingSlug).toBe('b');
    expect(r.chain).toEqual(['a', 'b']);
  });

  it('resolves TRANSITIVELY through two hops', () => {
    appendTombstone(root, { slug: 'a', deletedAt: stamp, absorbedBy: 'b' });
    appendTombstone(root, { slug: 'b', deletedAt: stamp, absorbedBy: 'c' });
    const r = resolveTombstone(root, 'a');
    expect(r.livingSlug).toBe('c');
    expect(r.chain).toEqual(['a', 'b', 'c']);
  });

  it('a dead end (everything deleted, nothing absorbed it) resolves to null', () => {
    appendTombstone(root, { slug: 'a', deletedAt: stamp, absorbedBy: 'b' });
    appendTombstone(root, { slug: 'b', deletedAt: stamp });   // dropped, not merged
    expect(resolveTombstone(root, 'a').livingSlug).toBeNull();
  });

  it('an untombstoned slug resolves to nothing', () => {
    expect(resolveTombstone(root, 'never-deleted')).toEqual({ tombstone: null, livingSlug: null, chain: ['never-deleted'] });
  });

  it('a CYCLE stops instead of spinning forever', () => {
    appendTombstone(root, { slug: 'a', deletedAt: stamp, absorbedBy: 'b' });
    appendTombstone(root, { slug: 'b', deletedAt: stamp, absorbedBy: 'a' });
    const r = resolveTombstone(root, 'a');
    expect(r.livingSlug).toBeNull();
    expect(r.chain).toEqual(['a', 'b']);
  });

  it('a runaway chain stops at the hop limit', () => {
    for (let i = 0; i < 30; i++) appendTombstone(root, { slug: `s${i}`, deletedAt: stamp, absorbedBy: `s${i + 1}` });
    expect(() => resolveTombstone(root, 's0')).not.toThrow();
    expect(resolveTombstone(root, 's0').chain.length).toBeLessThanOrEqual(11);
  });
});

describe('planCuratorTask no longer resurrects a merged-away chore', () => {
  const OVER = ORPHAN_TAG_CURATOR_THRESHOLD;

  it('files nothing below the threshold', () => {
    expect(planCuratorTask(OVER - 1, null).action).toBe('none');
  });

  it('refreshes its own open chore (unchanged behaviour)', () => {
    expect(planCuratorTask(OVER, { slug: CURATOR_TASK_SLUG, status: 'todo' }).action).toBe('refresh');
  });

  it('creates when nothing exists and nothing absorbed it (unchanged behaviour)', () => {
    expect(planCuratorTask(OVER, null).action).toBe('create');
    expect(planCuratorTask(OVER, null, null).action).toBe('create');
  });

  it('THE BUG: an absorbed chore logs on the absorbing task instead of re-filing', () => {
    const plan = planCuratorTask(OVER, null, { slug: 'the-real-orphan-tag-task', status: 'todo' });
    expect(plan.action).toBe('refresh-absorbing');
    expect(plan.slug).toBe('the-real-orphan-tag-task');
  });

  it('but a COMPLETED absorbing task frees it to be filed again', () => {
    // The absorbing work shipped, orphans recurred — nothing open owns it now.
    expect(planCuratorTask(OVER, null, { slug: 'shipped', status: 'completed' }).action).toBe('create');
  });

  it('an existing completed chore with no absorber still re-files (recurrence)', () => {
    expect(planCuratorTask(OVER, { slug: CURATOR_TASK_SLUG, status: 'completed' }).action).toBe('create');
  });

  it('always carries a real description — never an empty template', () => {
    for (const plan of [planCuratorTask(OVER, null), planCuratorTask(OVER, null, { slug: 'x', status: 'todo' })]) {
      expect(plan.description.length).toBeGreaterThan(40);
      expect(plan.description).toContain('orphan tag');
    }
  });
});
