import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createObjective,
  updateObjective,
  deleteObjective,
  addDependency,
  removeDependency,
  getObjective,
  listObjectives,
  wouldCreateCycle,
  isSafeObjectiveSlug,
  ObjectiveError,
} from '../../src/lib/objectives-store.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-objectives-'));
  mkdirSync(join(root, 'core'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('objectives store — CRUD', () => {
  it('creates an objective file under core/objectives/<slug>.md with frontmatter', () => {
    const o = createObjective(root, {
      slug: 'increase-retention-20',
      title: 'Increase retention by 20%',
      target_date: '2026-09-30',
    });
    expect(o.slug).toBe('increase-retention-20');
    expect(o.title).toBe('Increase retention by 20%');
    expect(o.target_date).toBe('2026-09-30');
    expect(o.depends_on).toEqual([]);
    expect(o.status).toBeNull();
    expect(existsSync(join(root, 'core', 'objectives', 'increase-retention-20.md'))).toBe(true);
  });

  it('persists independently of any task and reads back via get/list', () => {
    createObjective(root, { slug: 'a', title: 'A' });
    createObjective(root, { slug: 'b', title: 'B' });
    expect(listObjectives(root).map((o) => o.slug)).toEqual(['a', 'b']);
    expect(getObjective(root, 'a')?.title).toBe('A');
    expect(getObjective(root, 'missing')).toBeNull();
  });

  it('rejects duplicate slugs, invalid slugs, and invalid target dates', () => {
    createObjective(root, { slug: 'a', title: 'A' });
    expect(() => createObjective(root, { slug: 'a', title: 'again' })).toThrow(ObjectiveError);
    expect(() => createObjective(root, { slug: 'Not Valid', title: 'x' })).toThrow(/kebab-case/);
    expect(() => createObjective(root, { slug: 'b', title: 'B', target_date: '2026-13-40' })).toThrow(/YYYY-MM-DD/);
  });

  it('rejects unknown depends_on at create time', () => {
    expect(() => createObjective(root, { slug: 'a', title: 'A', depends_on: ['ghost'] }))
      .toThrow(/Unknown dependency "ghost"/);
  });

  it('edits title/target/status and clears them back to null', () => {
    createObjective(root, { slug: 'a', title: 'A', target_date: '2026-08-01' });
    updateObjective(root, 'a', { title: 'A2', status: 'done' });
    let o = getObjective(root, 'a')!;
    expect(o.title).toBe('A2');
    expect(o.status).toBe('done');
    updateObjective(root, 'a', { target_date: null, status: null });
    o = getObjective(root, 'a')!;
    expect(o.target_date).toBeNull();
    expect(o.status).toBeNull();
  });

  it('rejects an invalid manual status override', () => {
    createObjective(root, { slug: 'a', title: 'A' });
    expect(() => updateObjective(root, 'a', { status: 'banana' as never })).toThrow(/must be one of/);
  });

  it('delete removes the file AND heals other objectives depends_on', () => {
    createObjective(root, { slug: 'a', title: 'A' });
    createObjective(root, { slug: 'b', title: 'B', depends_on: ['a'] });
    deleteObjective(root, 'a');
    expect(getObjective(root, 'a')).toBeNull();
    expect(getObjective(root, 'b')!.depends_on).toEqual([]);
  });

  it('preserves the PO-authored body across frontmatter updates', () => {
    createObjective(root, { slug: 'a', title: 'A', why: 'Because retention pays for everything.' });
    updateObjective(root, 'a', { status: 'active' });
    const raw = readFileSync(join(root, 'core', 'objectives', 'a.md'), 'utf-8');
    expect(raw).toContain('Because retention pays for everything.');
  });
});

describe('objectives store — dependency DAG guard', () => {
  it('adds and removes dependency edges', () => {
    createObjective(root, { slug: 'a', title: 'A' });
    createObjective(root, { slug: 'b', title: 'B' });
    addDependency(root, 'b', 'a');
    expect(getObjective(root, 'b')!.depends_on).toEqual(['a']);
    removeDependency(root, 'b', 'a');
    expect(getObjective(root, 'b')!.depends_on).toEqual([]);
  });

  it('rejects a circular dependency at WRITE time (direct + transitive + self)', () => {
    createObjective(root, { slug: 'a', title: 'A' });
    createObjective(root, { slug: 'b', title: 'B' });
    createObjective(root, { slug: 'c', title: 'C' });
    addDependency(root, 'b', 'a'); // b → a
    addDependency(root, 'c', 'b'); // c → b → a
    expect(() => addDependency(root, 'a', 'c')).toThrow(/circular/i); // transitive close
    expect(() => addDependency(root, 'a', 'b')).toThrow(/circular/i); // 2-cycle
    expect(() => addDependency(root, 'a', 'a')).toThrow(/circular/i); // self
    // ...and legitimate edges still work after rejections (diamond shape).
    createObjective(root, { slug: 'd', title: 'D' });
    addDependency(root, 'd', 'b');
    addDependency(root, 'd', 'a'); // diamond a←b←d + a←d is fine, not a cycle
    expect(getObjective(root, 'd')!.depends_on).toEqual(['b', 'a']);
  });

  it('rejects duplicate edges and unknown slugs', () => {
    createObjective(root, { slug: 'a', title: 'A' });
    createObjective(root, { slug: 'b', title: 'B' });
    addDependency(root, 'b', 'a');
    expect(() => addDependency(root, 'b', 'a')).toThrow(/already depends/);
    expect(() => addDependency(root, 'b', 'ghost')).toThrow(/not found/);
    expect(() => removeDependency(root, 'b', 'ghost')).toThrow(/does not depend/);
  });

  it('wouldCreateCycle is pure and matches the write-time guard', () => {
    createObjective(root, { slug: 'a', title: 'A' });
    createObjective(root, { slug: 'b', title: 'B', depends_on: ['a'] });
    const objectives = listObjectives(root);
    expect(wouldCreateCycle(objectives, 'a', 'b')).toBe(true);
    expect(wouldCreateCycle(objectives, 'b', 'a')).toBe(false); // duplicate, not a cycle
    expect(wouldCreateCycle(objectives, 'a', 'a')).toBe(true);
  });
});

describe('objective slug validation', () => {
  it('accepts kebab-case and rejects unsafe shapes', () => {
    expect(isSafeObjectiveSlug('increase-retention-20')).toBe(true);
    expect(isSafeObjectiveSlug('a')).toBe(true);
    expect(isSafeObjectiveSlug('Has Spaces')).toBe(false);
    expect(isSafeObjectiveSlug('../escape')).toBe(false);
    expect(isSafeObjectiveSlug('double--dash')).toBe(false);
    expect(isSafeObjectiveSlug('trailing-')).toBe(false);
    expect(isSafeObjectiveSlug('')).toBe(false);
  });
});
