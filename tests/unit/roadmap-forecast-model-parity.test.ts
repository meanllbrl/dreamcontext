import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createObjective, addDependency } from '../../src/lib/objectives-store.js';
import { buildRoadmapModel } from '../../src/lib/roadmap-model.js';
// The dashboard's pure engine — the live cascade under the interactive timeline.
import { buildForecasts, type ForecastInput } from '../../dashboard/src/components/roadmap/roadmap-forecast';

/**
 * Cross-engine PARITY: the timeline (`roadmap-forecast.ts`) and the CLI/snapshot
 * (`roadmap-model.ts`) must compute the SAME forecast. They diverged for a rollup that
 * both `depends_on` sub-objectives AND shares their member tasks: the server used the
 * task span (schedule of record), the timeline re-added the rollup's effort after the
 * dependency finish → an inflated phantom slip. This test drives real scratch vaults
 * through BOTH engines (feeding the frontend the exact inputs `useRoadmapItems` builds
 * from the server model) and asserts forecast_end + slipping agree, so the two can't
 * silently drift again. (Bare-target-no-start objectives are intentionally excluded —
 * the two engines deliberately differ there; see the per-engine unit tests.)
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-parity-'));
  mkdirSync(join(root, 'core'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeTask(slug: string, f: { objectives?: string[]; status?: string; start?: string; due?: string }): void {
  const lines = ['---', `id: "task_${slug}"`, `name: "${slug}"`, `status: "${f.status ?? 'todo'}"`,
    'created_at: "2026-06-01"', 'updated_at: "2026-06-01"', 'tags: []'];
  if (f.objectives) lines.push(`objectives: [${f.objectives.map((o) => `"${o}"`).join(', ')}]`);
  if (f.start) lines.push(`start_date: "${f.start}"`);
  if (f.due) lines.push(`due_date: "${f.due}"`);
  lines.push('---', '', '## Why', '', 'test task', '');
  writeFileSync(join(root, 'state', `${slug}.md`), lines.join('\n'), 'utf-8');
}

/** Mirror `useRoadmapItems`: feed the frontend engine exactly what the model exposes. */
function toForecastInputs(root: string): ForecastInput[] {
  return buildRoadmapModel(root).objectives.map((o) => ({
    slug: o.slug,
    start_date: o.start_date,
    target_date: o.target_date,
    effort: o.effort,
    depends_on: o.depends_on,
    tasks: o.tasks.map((t) => ({ start_date: t.start_date, due_date: t.due_date })),
  }));
}

function assertParity(root: string): void {
  const model = buildRoadmapModel(root);
  const frontend = buildForecasts(toForecastInputs(root));
  for (const o of model.objectives) {
    const f = frontend.get(o.slug)!;
    expect(f, `missing frontend forecast for ${o.slug}`).toBeTruthy();
    expect(f.forecast_end, `forecast_end mismatch for ${o.slug}`).toBe(o.forecast_end);
    // Server slipping is boolean|null (null when unforecastable / no target); the frontend
    // collapses those to false. Compare on the truthy signal.
    expect(!!f.slipping, `slipping mismatch for ${o.slug}`).toBe(o.slipping === true);
  }
}

describe('roadmap forecast parity — timeline engine vs CLI/model engine', () => {
  it('THE FIX: a rollup that depends_on a sub-objective AND shares its member task agrees with the CLI', () => {
    createObjective(root, { slug: 'child', title: 'Child', start_date: '2026-07-01', target_date: '2026-08-01' });
    createObjective(root, { slug: 'rollup', title: 'Rollup', start_date: '2026-07-01', target_date: '2026-08-15', effort: 4 });
    addDependency(root, 'rollup', 'child');
    // ONE dated task assigned to BOTH — the shared work of the rollup and its dependency.
    writeTask('shared', { objectives: ['child', 'rollup'], start: '2026-07-01', due: '2026-08-01' });

    const model = buildRoadmapModel(root);
    const rollup = model.objectives.find((o) => o.slug === 'rollup')!;
    // Sanity: the CLI reads on track at Aug 1 (task span), NOT slipping to late Aug from effort.
    expect(rollup.forecast_end).toBe('2026-08-01');
    expect(rollup.slipping).toBe(false);

    assertParity(root); // timeline now computes the same — no phantom slip
  });

  it('parity holds for a genuinely slipping task-bearing objective (own tasks overrun target)', () => {
    createObjective(root, { slug: 'a', title: 'A', start_date: '2026-07-01', target_date: '2026-08-01', effort: 3 });
    writeTask('t', { objectives: ['a'], start: '2026-07-01', due: '2026-08-11' });
    const a = buildRoadmapModel(root).objectives[0];
    expect(a.slipping).toBe(true);
    expect(a.forecast_end).toBe('2026-08-11'); // task due, not start+effort
    assertParity(root);
  });

  it('parity holds for an on-time committed-window dependency chain (no tasks)', () => {
    createObjective(root, { slug: 'app', title: 'App', start_date: '2026-07-01', target_date: '2026-07-16' });
    createObjective(root, { slug: 'live', title: 'Live', start_date: '2026-07-10', target_date: '2026-07-25' });
    addDependency(root, 'live', 'app');
    assertParity(root);
  });

  it('parity holds when an upstream task slip cascades into a task-bearing dependent', () => {
    createObjective(root, { slug: 'up', title: 'Up', start_date: '2026-07-01', target_date: '2026-08-01' });
    createObjective(root, { slug: 'down', title: 'Down', start_date: '2026-07-01', target_date: '2026-09-01' });
    addDependency(root, 'down', 'up');
    writeTask('tu', { objectives: ['up'], start: '2026-07-01', due: '2026-12-01' }); // up ends very late
    writeTask('td', { objectives: ['down'], start: '2026-07-01', due: '2026-08-01' });
    const by = Object.fromEntries(buildRoadmapModel(root).objectives.map((o) => [o.slug, o]));
    expect(by.down.slipping).toBe(true); // dragged past Sep 1 by up's Dec 1 finish
    assertParity(root);
  });
});
