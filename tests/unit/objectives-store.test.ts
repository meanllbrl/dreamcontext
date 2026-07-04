import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createObjective,
  updateObjective,
  updateObjectiveMetric,
  deleteObjective,
  addDependency,
  removeDependency,
  getObjective,
  listObjectives,
  parseMetric,
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

describe('objectives store — Key Result metric', () => {
  const mrr = { label: 'MRR', unit: 'USD', baseline: 0, target: 2000, current: 850 };

  it('creates an objective with a metric and round-trips it through frontmatter', () => {
    createObjective(root, { slug: 'mrr', title: '2000 USD MRR', metric: mrr });
    expect(getObjective(root, 'mrr')!.metric).toEqual(mrr);
  });

  it('merges a partial metric patch (the common --current nudge)', () => {
    createObjective(root, { slug: 'mrr', title: 'MRR', metric: mrr });
    const o = updateObjectiveMetric(root, 'mrr', { current: 1200 });
    expect(o.metric).toEqual({ ...mrr, current: 1200 });
  });

  it('seeds a fresh metric when none exists, defaulting current to baseline', () => {
    createObjective(root, { slug: 'x', title: 'X' });
    const o = updateObjectiveMetric(root, 'x', { label: 'Users', target: 100, baseline: 10 });
    expect(o.metric).toEqual({ label: 'Users', unit: null, baseline: 10, target: 100, current: 10 });
  });

  it('rejects a metric whose target equals its baseline', () => {
    createObjective(root, { slug: 'x', title: 'X' });
    expect(() => updateObjectiveMetric(root, 'x', { label: 'M', baseline: 5, target: 5 })).toThrow(ObjectiveError);
  });

  it('clears the metric via updateObjective(metric: null)', () => {
    createObjective(root, { slug: 'mrr', title: 'MRR', metric: mrr });
    const o = updateObjective(root, 'mrr', { metric: null });
    expect(o.metric).toBeNull();
  });

  it('parseMetric degrades malformed / incomplete metrics to null', () => {
    expect(parseMetric({ label: 'M', target: 100, baseline: 0, current: 5 })).not.toBeNull();
    expect(parseMetric({ label: '', target: 100 })).toBeNull();       // no label
    expect(parseMetric({ label: 'M' })).toBeNull();                    // no target
    expect(parseMetric({ label: 'M', target: 5, baseline: 5 })).toBeNull(); // div-by-zero
    expect(parseMetric('nonsense')).toBeNull();
  });
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

describe('hardening — review fixes', () => {
  const objDir = () => join(root, 'core', 'objectives');

  it('coerces an UNQUOTED YAML date (parsed as a Date object) to a calendar string on read', () => {
    mkdirSync(objDir(), { recursive: true });
    // Hand-authored frontmatter with an unquoted date — js-yaml parses this as a Date.
    writeFileSync(join(objDir(), 'x.md'), '---\ntitle: X\nstart_date: 2026-07-03\ntarget_date: 2026-08-01\n---\nbody\n');
    const o = getObjective(root, 'x');
    expect(o?.start_date).toBe('2026-07-03');
    expect(o?.target_date).toBe('2026-08-01');
  });

  it('nulls a non-calendar date string on read instead of propagating garbage', () => {
    mkdirSync(objDir(), { recursive: true });
    writeFileSync(join(objDir(), 'y.md'), '---\ntitle: Y\nstart_date: "not-a-date"\ntarget_date: "2026-13-40"\n---\nbody\n');
    const o = getObjective(root, 'y');
    expect(o?.start_date).toBeNull();
    expect(o?.target_date).toBeNull();
  });

  it('deleteObjective strips the slug from a task\'s objectives list and reports no unhealed tasks', () => {
    createObjective(root, { slug: 'obj', title: 'Obj' });
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(join(root, 'state', 't.md'), '---\nname: T\nstatus: todo\nobjectives:\n  - obj\n  - other\n---\nbody\n');
    const res = deleteObjective(root, 'obj');
    expect(res.unhealedTasks).toEqual([]);
    const healed = readFileSync(join(root, 'state', 't.md'), 'utf8');
    expect(healed).not.toMatch(/- obj\b/);
    expect(healed).toMatch(/other/); // unrelated slug preserved
  });

  it('deleteObjective reports a task it could not heal (unparseable frontmatter)', () => {
    createObjective(root, { slug: 'obj', title: 'Obj' });
    mkdirSync(join(root, 'state'), { recursive: true });
    // Broken YAML — cannot be parsed to check/heal its objectives list.
    writeFileSync(join(root, 'state', 'bad.md'), '---\nname: [unterminated\nobjectives: : :\n---\nbody\n');
    const res = deleteObjective(root, 'obj');
    expect(res.unhealedTasks).toContain('bad.md');
  });
});
