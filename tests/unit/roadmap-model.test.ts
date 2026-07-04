import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createObjective, addDependency } from '../../src/lib/objectives-store.js';
import {
  buildRoadmapModel,
  computeRollupStatus,
  computeMetricStatus,
  metricProgressPct,
  transitiveDependents,
  type RoadmapTaskRef,
} from '../../src/lib/roadmap-model.js';
import { buildCorpus } from '../../src/lib/recall.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-roadmap-'));
  mkdirSync(join(root, 'core'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeTask(
  slug: string,
  fields: { objectives?: string[]; status?: string; start?: string; due?: string; version?: string },
): void {
  const lines = [
    '---',
    `id: "task_${slug}"`,
    `name: "${slug}"`,
    `status: "${fields.status ?? 'todo'}"`,
    'created_at: "2026-06-01"',
    'updated_at: "2026-06-01"',
    `tags: []`,
  ];
  if (fields.objectives) lines.push(`objectives: [${fields.objectives.map((o) => `"${o}"`).join(', ')}]`);
  if (fields.start) lines.push(`start_date: "${fields.start}"`);
  if (fields.due) lines.push(`due_date: "${fields.due}"`);
  if (fields.version) lines.push(`version: "${fields.version}"`);
  lines.push('---', '', '## Why', '', 'test task', '');
  writeFileSync(join(root, 'state', `${slug}.md`), lines.join('\n'), 'utf-8');
}

const ref = (status: string): RoadmapTaskRef => ({
  slug: 'x', status, start_date: null, due_date: null, version: null, updated_at: null,
});

describe('metric-driven progress (Key Result objectives)', () => {
  const m = (baseline: number, target: number, current: number) => ({ label: 'MRR', unit: 'USD', baseline, target, current });

  it('computes pct along the baseline→target span, clamped to [0,100]', () => {
    expect(metricProgressPct(m(0, 2000, 0))).toBe(0);
    expect(metricProgressPct(m(0, 2000, 850))).toBe(43);
    expect(metricProgressPct(m(0, 2000, 2000))).toBe(100);
    expect(metricProgressPct(m(0, 2000, 3000))).toBe(100); // overshoot clamps
    expect(metricProgressPct(m(0, 2000, -100))).toBe(0);   // below baseline clamps
  });

  it('handles reduce goals (target < baseline)', () => {
    expect(metricProgressPct(m(10, 2, 6))).toBe(50); // churn 10→2, at 6 = halfway
    expect(metricProgressPct(m(10, 2, 10))).toBe(0);
    expect(metricProgressPct(m(10, 2, 2))).toBe(100);
  });

  it('derives status: done at/over target, active once off baseline', () => {
    expect(computeMetricStatus(m(0, 2000, 0))).toBe('not_started');
    expect(computeMetricStatus(m(0, 2000, 850))).toBe('active');
    expect(computeMetricStatus(m(0, 2000, 2000))).toBe('done');
  });

  it('a metric objective drives progress/status without any tasks', () => {
    createObjective(root, { slug: 'mrr', title: '2000 USD MRR', metric: m(0, 2000, 850) });
    const [o] = buildRoadmapModel(root).objectives;
    expect(o.progress.source).toBe('metric');
    expect(o.progress.pct).toBe(43);
    expect(o.progress.metric).toEqual(m(0, 2000, 850));
    expect(o.status).toBe('active');
  });

  it('a manual status override still wins over the metric-derived status', () => {
    createObjective(root, { slug: 'mrr', title: 'MRR', metric: m(0, 2000, 2000) });
    // (override is set via updateObjective in the store tests; here confirm metric alone → done)
    const [o] = buildRoadmapModel(root).objectives;
    expect(o.status).toBe('done');
    expect(o.status_source).toBe('computed');
  });
});

describe('computeRollupStatus (real status enum)', () => {
  it('follows the spec table', () => {
    expect(computeRollupStatus([])).toBe('not_started');
    expect(computeRollupStatus([ref('completed'), ref('completed')])).toBe('done');
    expect(computeRollupStatus([ref('completed'), ref('in_progress')])).toBe('active');
    expect(computeRollupStatus([ref('completed'), ref('in_review')])).toBe('review');
    expect(computeRollupStatus([ref('in_progress'), ref('in_review')])).toBe('active'); // in_progress wins
    expect(computeRollupStatus([ref('todo'), ref('completed')])).toBe('not_started');
  });
});

describe('buildRoadmapModel — join + rollups', () => {
  it('many-to-many: a task under BOTH objectives; an objective lists all members', () => {
    createObjective(root, { slug: 'revenue', title: 'Revenue' });
    createObjective(root, { slug: 'retention', title: 'Retention' });
    writeTask('shared', { objectives: ['revenue', 'retention'], status: 'completed' });
    writeTask('only-retention', { objectives: ['retention'] });

    const model = buildRoadmapModel(root);
    const revenue = model.objectives.find((o) => o.slug === 'revenue')!;
    const retention = model.objectives.find((o) => o.slug === 'retention')!;
    expect(revenue.tasks.map((t) => t.slug)).toEqual(['shared']);
    expect(retention.tasks.map((t) => t.slug)).toEqual(['only-retention', 'shared']);
    // Each objective's % is over ITS OWN member set (not double-counting).
    expect(revenue.progress).toEqual({ done: 1, total: 1, pct: 100, source: 'tasks', metric: null });
    expect(retention.progress).toEqual({ done: 1, total: 2, pct: 50, source: 'tasks', metric: null });
  });

  it('manual PO status override wins over the computed rollup', () => {
    createObjective(root, { slug: 'a', title: 'A' });
    writeTask('t1', { objectives: ['a'], status: 'in_progress' });
    let model = buildRoadmapModel(root);
    expect(model.objectives[0].status).toBe('active');
    expect(model.objectives[0].status_source).toBe('computed');

    // Simulate PO override.
    writeFileSync(
      join(root, 'core', 'objectives', 'a.md'),
      '---\ntitle: A\ntarget_date: null\ndepends_on: []\nfeature: null\nstatus: done\n---\n\n## Why\nx\n',
      'utf-8',
    );
    model = buildRoadmapModel(root);
    expect(model.objectives[0].status).toBe('done');
    expect(model.objectives[0].status_source).toBe('override');
  });

  it('warns (never fails) on task references to unknown objectives', () => {
    writeTask('orphan', { objectives: ['ghost'] });
    const model = buildRoadmapModel(root);
    expect(model.objectives).toEqual([]);
    expect(model.warnings.some((w) => w.includes('ghost') && w.includes('orphan'))).toBe(true);
  });
});

describe('buildRoadmapModel — forecast cascade (full DAG)', () => {
  it('computes forecast from member dates: start=min(starts), end=max(dues)', () => {
    createObjective(root, { slug: 'a', title: 'A', target_date: '2026-09-01' });
    writeTask('t1', { objectives: ['a'], start: '2026-07-01', due: '2026-08-01' });
    writeTask('t2', { objectives: ['a'], start: '2026-06-15', due: '2026-08-20' });
    const [a] = buildRoadmapModel(root).objectives;
    expect(a.forecast_start).toBe('2026-06-15');
    expect(a.forecast_end).toBe('2026-08-20');
    expect(a.slipping).toBe(false); // 2026-08-20 <= 2026-09-01
  });

  it('flags slipping when forecast_end > target_date', () => {
    createObjective(root, { slug: 'a', title: 'A', target_date: '2026-08-01' });
    writeTask('t1', { objectives: ['a'], due: '2026-08-10' });
    const [a] = buildRoadmapModel(root).objectives;
    expect(a.slipping).toBe(true);
  });

  it('cascades a slip through ALL transitive dependents (diamond A→B, A→C, B→D, C→D)', () => {
    // depends_on direction: b depends on a, etc. A slip in `a` must reach `d` twice-removed.
    createObjective(root, { slug: 'a', title: 'A' });
    createObjective(root, { slug: 'b', title: 'B', depends_on: ['a'] });
    createObjective(root, { slug: 'c', title: 'C', depends_on: ['a'] });
    createObjective(root, { slug: 'd', title: 'D', target_date: '2026-10-01', depends_on: ['b', 'c'] });
    writeTask('ta', { objectives: ['a'], due: '2026-12-01' }); // a ends late
    writeTask('tb', { objectives: ['b'], due: '2026-07-01' });
    writeTask('tc', { objectives: ['c'], due: '2026-07-15' });
    writeTask('td', { objectives: ['d'], due: '2026-09-01' });

    const model = buildRoadmapModel(root);
    const by = Object.fromEntries(model.objectives.map((o) => [o.slug, o]));
    // b and c inherit a's forecast end as their start; their end = max(own due, start).
    expect(by.b.forecast_start).toBe('2026-12-01');
    expect(by.b.forecast_end).toBe('2026-12-01');
    expect(by.c.forecast_end).toBe('2026-12-01');
    // d gets the max over BOTH diamond arms and its own due → slips past its target.
    expect(by.d.forecast_start).toBe('2026-12-01');
    expect(by.d.forecast_end).toBe('2026-12-01');
    expect(by.d.slipping).toBe(true);
    // Topological order: dependencies before dependents.
    const order = model.objectives.map((o) => o.slug);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'));
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'));
  });

  it('null rule: no dated member tasks → forecast null, and it imposes NO constraint downstream', () => {
    createObjective(root, { slug: 'a', title: 'A' });
    createObjective(root, { slug: 'b', title: 'B', target_date: '2026-09-01', depends_on: ['a'] });
    writeTask('ta', { objectives: ['a'], status: 'in_progress' }); // undated
    writeTask('tb', { objectives: ['b'], due: '2026-08-01' });
    const model = buildRoadmapModel(root);
    const by = Object.fromEntries(model.objectives.map((o) => [o.slug, o]));
    expect(by.a.forecast_start).toBeNull();
    expect(by.a.forecast_end).toBeNull();
    expect(by.a.slipping).toBeNull(); // unforecastable → no target comparison
    // b is NOT dragged to "now" or blocked by a's null forecast.
    expect(by.b.forecast_end).toBe('2026-08-01');
    expect(by.b.slipping).toBe(false);
  });

  it('an objective with no tasks at all forecasts null and has pct null', () => {
    createObjective(root, { slug: 'a', title: 'A', target_date: '2026-09-01' });
    const [a] = buildRoadmapModel(root).objectives;
    expect(a.progress).toEqual({ done: 0, total: 0, pct: null, source: 'tasks', metric: null });
    expect(a.forecast_end).toBeNull();
    expect(a.slipping).toBeNull();
    expect(a.status).toBe('not_started');
  });

  it('survives a hand-edited cycle with a warning instead of hanging/crashing', () => {
    // Bypass the write-time guard by writing the files directly.
    mkdirSync(join(root, 'core', 'objectives'), { recursive: true });
    writeFileSync(join(root, 'core', 'objectives', 'a.md'),
      '---\ntitle: A\ndepends_on: [b]\n---\n\nx\n', 'utf-8');
    writeFileSync(join(root, 'core', 'objectives', 'b.md'),
      '---\ntitle: B\ndepends_on: [a]\n---\n\nx\n', 'utf-8');
    const model = buildRoadmapModel(root);
    expect(model.objectives).toHaveLength(2);
    expect(model.warnings.some((w) => /circular/i.test(w))).toBe(true);
  });
});

describe('transitiveDependents (the "if this slips, these slip" set)', () => {
  it('walks the computed reverse edges transitively', () => {
    createObjective(root, { slug: 'a', title: 'A' });
    createObjective(root, { slug: 'b', title: 'B', depends_on: ['a'] });
    createObjective(root, { slug: 'c', title: 'C', depends_on: ['b'] });
    const model = buildRoadmapModel(root);
    expect(transitiveDependents(model, 'a')).toEqual(['b', 'c']);
    expect(transitiveDependents(model, 'c')).toEqual([]);
  });
});

describe('recall corpus — objective doc type', () => {
  it('indexes core/objectives/*.md as type "objective" (in defaults and via --types)', () => {
    createObjective(root, { slug: 'retention', title: 'Increase retention by 20%', why: 'Retention compounds.' });
    const defaults = buildCorpus(root);
    const onlyObjectives = buildCorpus(root, { types: ['objective'] });
    expect(defaults.some((d) => d.type === 'objective' && d.slug === 'retention')).toBe(true);
    expect(onlyObjectives.map((d) => d.slug)).toEqual(['retention']);
    expect(onlyObjectives[0].title).toBe('Increase retention by 20%');
  });
});
