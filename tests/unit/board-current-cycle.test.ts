/**
 * `@current` is the CURRENT CYCLE (owner decision 2026-10-19). 0.33.0 retired planning versions,
 * so a shared "Current Version" view (`version: { inc: ['@current'] }`) matched nothing and the
 * board said "No tasks match these filters". The token now matches a task in the active cycle,
 * by the board's own rule (the Now column), and nothing while no cycle runs; the toolbar offers
 * it as "Current cycle" while one runs; an empty "Current" view with no cycle offers to plan one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  emptyFilters, filterTasks, groupByOrder, inActiveCycle, versionTokenMatches, VV_CURRENT, type VersionMeta,
} from '../../dashboard/src/components/tasks/boardModel';
import { buildStatusModel, DEFAULT_STATUSES } from '../../dashboard/src/lib/statusModel';
import type { Task } from '../../dashboard/src/hooks/useTasks';

const SRC = join(import.meta.dirname, '..', '..', 'dashboard', 'src');
const read = (p: string): string => readFileSync(join(SRC, p), 'utf-8');

const ACTIVE = 'cy_active01';
const sm = buildStatusModel([
  ...DEFAULT_STATUSES,
  { key: 'cancelled', label: 'Cancelled', kind: 'cancelled', order: 99 } as (typeof DEFAULT_STATUSES)[number],
]);

function task(slug: string, over: Partial<Task> = {}): Task {
  return {
    slug, id: `task_${slug}`, name: slug, description: '', priority: 'medium', urgency: 'medium', status: 'todo',
    created_at: '2026-10-01', updated_at: '2026-10-01', tags: [], parent_task: null, related_feature: null,
    version: null, rice: null, cycle: null, queue: null, rank: null,
    criteria: { total: 0, done: 0 }, children: null, bytes: 100, ...over,
  };
}

const TASKS: Task[] = [
  task('in-cycle', { cycle: ACTIVE }),
  task('done-in-cycle', { cycle: ACTIVE, status: 'completed' }),
  // A legacy planning version that once was "current" plays no part any more.
  task('in-cycle-with-version', { cycle: ACTIVE, version: 'S5 (Jul 13 - Jul 17)' }),
  task('next', { queue: 'next', version: 'S5 (Jul 13 - Jul 17)' }),
  task('later', { queue: 'later' }),
  task('unplaced'),
  task('other-cycle', { cycle: 'cy_planned02' }),
];

const currentView = () => ({ ...emptyFilters(), version: { inc: [VV_CURRENT], exc: [] } });
const slugs = (ts: Task[]) => ts.map((t) => t.slug).sort();

describe('@current is the active cycle', () => {
  it('with a cycle running: exactly the tasks in it match (done ones too); Next, Later, unplaced and other cycles do not', () => {
    const meta: VersionMeta = { activeCycle: ACTIVE, released: [] };
    expect(slugs(filterTasks(TASKS, currentView(), '', meta, sm))).toEqual(['done-in-cycle', 'in-cycle', 'in-cycle-with-version']);
    expect(versionTokenMatches('', VV_CURRENT, meta, { cycle: ACTIVE })).toBe(true);
    expect(versionTokenMatches('', VV_CURRENT, meta, { queue: 'next' })).toBe(false);
    expect(versionTokenMatches('', VV_CURRENT, meta, { queue: 'later' })).toBe(false);
    expect(versionTokenMatches('', VV_CURRENT, meta, { cycle: 'cy_planned02' })).toBe(false);
  });

  it('it is the Now column\'s own membership (no second rule)', () => {
    const meta: VersionMeta = { activeCycle: ACTIVE, released: [] };
    const now = groupByOrder(TASKS, ACTIVE, sm).find((g) => g.key === 'now')!.tasks;
    expect(slugs(filterTasks(TASKS, currentView(), '', meta, sm))).toEqual(slugs(now));
  });

  it('excluding @current keeps everything outside the active cycle', () => {
    const meta: VersionMeta = { activeCycle: ACTIVE, released: [] };
    const f = { ...emptyFilters(), version: { inc: [], exc: [VV_CURRENT] } };
    expect(slugs(filterTasks(TASKS, f, '', meta, sm))).toEqual(['later', 'next', 'other-cycle', 'unplaced']);
  });

  it('with no cycle running: nothing matches, whatever version a task carries', () => {
    const meta: VersionMeta = { activeCycle: null, released: [] };
    expect(filterTasks(TASKS, currentView(), '', meta, sm)).toEqual([]);
    expect(versionTokenMatches('S5 (Jul 13 - Jul 17)', VV_CURRENT, meta, { cycle: ACTIVE })).toBe(false);
    expect(inActiveCycle({ cycle: ACTIVE }, null)).toBe(false);
  });
});

describe('the toolbar chip and the empty state', () => {
  it('the "Current cycle" chip is offered while a cycle runs, counted by the same rule', () => {
    const src = read('components/tasks/BoardToolbar.tsx');
    expect(src).toContain("if (activeCycleId) versionVirtuals.push({ value: VV_CURRENT, label: t('board.filter.currentCycle'), color: 'var(--color-accent)', count: allTasks.filter((t) => inActiveCycle(t, activeCycleId)).length });");
    expect(src).not.toMatch(/activeVersion/);
    // The count the chip shows for the fixture: the three tasks in the active cycle.
    expect(TASKS.filter((t) => inActiveCycle(t, ACTIVE))).toHaveLength(3);
    expect(TASKS.filter((t) => inActiveCycle(t, null))).toHaveLength(0);
  });

  it('the board passes the active cycle to the filter and the toolbar', () => {
    const src = read('components/tasks/KanbanBoard.tsx');
    expect(src).toContain('() => ({ activeCycle: activeCycleId, released: releasedVersions }),');
    expect(src).toContain('activeCycleId={activeCycleId}');
    expect(src).not.toMatch(/useActiveVersion/);
  });

  it('an empty "Current" view with no cycle says so and offers "Plan a cycle"', () => {
    const src = read('components/tasks/KanbanBoard.tsx');
    expect(src).toContain('noCycle={cycles !== undefined && !activeCycleId && s.filters.version.inc.includes(VV_CURRENT)}');
    expect(src).toContain("{t(noCycle ? 'board.cycle.none' : 'board.empty.title')}");
    expect(src).toMatch(/noCycle && onOpenPlanning && \(\s*<button type="button" className="bd-chip" onClick=\{onOpenPlanning\} style=\{chip\}>\{t\('board\.cycle\.plan'\)\}<\/button>/);
  });

  // review7 F1: cycles still loading (or failed) is not "no cycle". The board waits for /cycles as
  // it waits for the tasks, and only a known answer with no active cycle draws the no-cycle state.
  it('the board treats cycles not known yet as loading, and never says "no cycle" without an answer', () => {
    const src = read('components/tasks/KanbanBoard.tsx');
    expect(src).toContain('const { data: cycles, isLoading: cyclesLoading } = useCycles();');
    expect(src).toContain('if (!s.ready || isLoading || cyclesLoading) {');
    expect(src).not.toMatch(/noCycle=\{!activeCycleId/);
  });

  it('the new strings exist in English and Turkish', () => {
    const i18n = read('context/I18nContext.tsx');
    const tr = i18n.indexOf('const TR_PARTIAL');
    for (const [key, en, trText] of [
      ['board.filter.currentCycle', 'Current cycle', 'Şu anki döngü'],
      ['board.empty.noCycleBody', 'This view shows the tasks of the current cycle. Plan a cycle to fill it.', 'Bu görünüm şu anki döngünün görevlerini gösterir. Doldurmak için bir döngü planla.'],
    ]) {
      expect(i18n.slice(0, tr)).toContain(`'${key}': '${en}'`);
      expect(i18n.slice(tr)).toContain(`'${key}': '${trText}'`);
    }
  });
});
