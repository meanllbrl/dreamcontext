import { describe, it, expect } from 'vitest';
import {
  PRIORITY_BANDS as UI_BANDS, priorityBand, bandRange, taskLanes, objectiveLanes, laneRow, taskCardsFor, mapGeometry,
  stackInBand, logFrac, UNLINKED, TASK_CARD_H, TASK_CARD_GAP, fmtScore, rankObjectives,
  type PriorityObjective, type PriorityTask, type RiceValues,
} from '../../dashboard/src/components/roadmap/priorityModel';
import { PRIORITY_BANDS as SERVER_BANDS, computeRiceScore } from '../../src/lib/rice.js';
import { nestChildren } from '../../dashboard/src/components/tasks/boardModel';
import { topLevelOf } from '../../src/lib/scoring-work.js';
import type { Task } from '../../dashboard/src/hooks/useTasks';

/** The priority board's pure model (W2): bands per level, columns, placement, map geometry. */

import { obj, task, NO_RICE } from './priority-fixtures';

function scored(score: number): Pick<PriorityTask, 'rice' | 'score'> {
  // reach 10, impact 5, confidence 100 → value 50; effort = 50/score.
  return { rice: { reach: 10, impact: 5, confidence: 100, effort: 50 / score }, score };
}

describe('bands: the dashboard mirror equals the server (drift)', () => {
  it('PRIORITY_BANDS is identical on both sides', () => {
    expect(UI_BANDS).toEqual(SERVER_BANDS);
  });

  it('boundaries per level: task 20 Now, 8 Next; objective 5 Now, 2 Next', () => {
    expect(priorityBand('task', 20)).toBe('now');
    expect(priorityBand('task', 19.99)).toBe('next');
    expect(priorityBand('task', 8)).toBe('next');
    expect(priorityBand('task', 7.99)).toBe('later');
    expect(priorityBand('objective', 5)).toBe('now');
    expect(priorityBand('objective', 4.99)).toBe('next');
    expect(priorityBand('objective', 2)).toBe('next');
    expect(priorityBand('objective', 1.99)).toBe('later');
    expect(bandRange('task', 'next')).toBe('8 to 20');
    expect(bandRange('objective', 'later')).toBe('under 2');
  });

  it('I=5, E=4, R=7, C=75 lands in Now at the objective level', () => {
    const s = computeRiceScore({ reach: 7, impact: 5, confidence: 75, effort: 4 })!;
    expect(s).toBe(6.56);
    const lanes = objectiveLanes([obj('tilki', { reach: 7, impact: 5, confidence: 75, effort: 4, score: s })]);
    expect(lanes.bands.now.map((c) => c.item.slug)).toEqual(['tilki']);
    expect(fmtScore(s)).toBe('6.6');
  });
});

describe('the top-level rule cannot drift between the server and the Tasks board', () => {
  it('server topLevelOf and boardModel nestChildren pick the same cards', () => {
    const rows = [
      { slug: 'p', parent_task: null },
      { slug: 'c', parent_task: 'p' },
      { slug: 'orphan', parent_task: 'closed' },
      { slug: 'grand', parent_task: 'c' },
      { slug: 'self', parent_task: 'self' },
      { slug: 'q', parent_task: null },
      { slug: 'q1', parent_task: 'q' },
    ];
    const asTasks = rows.map((r) => ({ slug: r.slug, parent_task: r.parent_task } as unknown as Task));
    expect(topLevelOf(rows).map((r) => r.slug)).toEqual(nestChildren(asTasks).top.map((t) => t.slug));
  });
});

describe('objective lanes', () => {
  it('orders cards left to right by score, the gap growing with the score drop; unscored go to NOT SCORED', () => {
    const lanes = objectiveLanes([
      obj('a', { score: 24 }), obj('b', { score: 20.5 }), obj('c', { score: 9.6 }), obj('d', { score: 3.2 }),
      obj('e', { score: 1.1 }), obj('none'),
    ]);
    // Objective thresholds: Now ≥ 5, Next ≥ 2.
    expect(lanes.bands.now.map((c) => c.item.slug)).toEqual(['a', 'b', 'c']);
    expect(lanes.bands.next.map((c) => c.item.slug)).toEqual(['d']);
    expect(lanes.bands.later.map((c) => c.item.slug)).toEqual(['e']);
    expect(lanes.unscored.map((o) => o.slug)).toEqual(['none']);
    const row = laneRow([{ item: 'x', place: { score: 10, suggested: false } }, { item: 'y', place: { score: 9, suggested: false } }, { item: 'z', place: { score: 1, suggested: false } }]);
    expect(row[0].gapBefore).toBe(0);
    expect(row[2].gapBefore).toBeGreaterThan(row[1].gapBefore);
  });

  it('a suggestion that completes the score places the card dashed at its suggested position', () => {
    const o = obj('s', { impact: 5, effort: 4, effective_suggestion: { at: 'x', why: 'w', rice: { reach: 7, confidence: 75 }, objective: null } });
    const lanes = objectiveLanes([o]);
    expect(lanes.bands.now[0].place).toEqual({ score: 6.56, suggested: true });
  });

  it('ties keep a stable order by title', () => {
    expect(rankObjectives([obj('b', { score: 3 }), obj('a', { score: 3 })]).map((o) => o.slug)).toEqual(['a', 'b']);
  });
});

describe('task lanes', () => {
  const objectives = [obj('mrr', { score: 24 }), obj('mkt', { score: 9.6 }), obj('none-scored'), obj('done', { status: 'done', score: 50 })];

  it('columns: objectives in rank order, unscored after, done excluded, Unlinked last', () => {
    const m = taskLanes(objectives, [], '');
    expect(m.columns.map((c) => c.slug)).toEqual(['mrr', 'mkt', 'none-scored', UNLINKED]);
  });

  it('every task appears exactly once per effective link, or once in Unlinked', () => {
    const tasks = [
      task('two', { ...scored(30), links: ['mrr', 'mkt'], all_links: ['mrr', 'mkt'] }),
      task('one', { ...scored(10), links: ['mkt'], all_links: ['mkt'] }),
      task('dead', { ...scored(5), links: [], all_links: ['done'], mark: 'objective done' }),
      task('missing', { links: [], all_links: ['gone'], mark: 'objective missing' }),
      task('loose', { ...scored(112.5) }),
      task('ghost', { ...scored(27), effective_suggestion: { at: 'x', why: 'w', rice: null, objective: 'mrr' } }),
    ];
    const m = taskLanes(objectives, tasks, '');
    const where = new Map<string, string[]>();
    for (const c of m.columns) {
      for (const card of [...c.bands.now, ...c.bands.next, ...c.bands.later, ...c.notScored]) {
        where.set(card.task.slug, [...(where.get(card.task.slug) ?? []), c.slug]);
      }
    }
    expect(where.get('two')).toEqual(['mrr', 'mkt']);
    expect(where.get('one')).toEqual(['mkt']);
    expect(where.get('dead')).toEqual([UNLINKED]);
    expect(where.get('missing')).toEqual([UNLINKED]);
    expect(where.get('loose')).toEqual([UNLINKED]);
    expect(where.get('ghost')).toEqual(['mrr']); // the suggested link shows ONLY in the suggested column
    const ghost = m.columns[0].bands.now.find((c) => c.task.slug === 'ghost')!;
    expect(ghost.linkGhost).toBe(true);
    expect(new Set(m.columns.flatMap((c) => [...c.bands.now, ...c.bands.next, ...c.bands.later, ...c.notScored].map((k) => k.key))).size)
      .toBe(7);
  });

  it('a link to a done or missing objective is never a column', () => {
    expect(taskCardsFor(task('x', { links: [], all_links: ['done'] }), new Set(['mrr']))).toEqual([{ column: UNLINKED, linkGhost: false }]);
  });

  it('cards follow log score inside their band, pushed apart, never out of it; bands grow to the fullest column', () => {
    const many = Array.from({ length: 6 }, (_, i) => task(`t${i}`, { ...scored(25 + i), links: ['mrr'], all_links: ['mrr'] }));
    const m = taskLanes(objectives, many, '');
    const now = m.columns[0].bands.now;
    expect(now.map((c) => c.task.slug)).toEqual(['t5', 't4', 't3', 't2', 't1', 't0']);
    for (let i = 1; i < now.length; i++) expect(now[i].y - now[i - 1].y).toBeGreaterThanOrEqual(TASK_CARD_H + TASK_CARD_GAP);
    expect(now[now.length - 1].y + TASK_CARD_H).toBeLessThanOrEqual(m.bandHeight.now);
    expect(m.bandHeight.now).toBeGreaterThanOrEqual(6 * (TASK_CARD_H + TASK_CARD_GAP));
    const ys = stackInBand([10, 10, 10], 200);
    expect(ys[2] + TASK_CARD_H).toBeLessThanOrEqual(200);
    expect(logFrac(0, 20, 8)).toBe(1);
    expect(logFrac(-5, 20, 8)).toBe(1);
    expect(logFrac(100, 20, 8)).toBe(0);
  });

  it('search filters at the Tasks level and opens a collapsed Not scored row that holds a hit', () => {
    const m = taskLanes(objectives, [task('find-me', { links: ['mrr'], all_links: ['mrr'] }), task('other', { links: ['mrr'], all_links: ['mrr'] })], 'find');
    expect(m.columns[0].notScored.map((c) => c.task.slug)).toEqual(['find-me']);
    expect(m.columns[0].notScoredHit).toBe(true);
  });
});

describe('map geometry', () => {
  it('scored tasks are dots at their true position; the top 20 carry a card; unscored are counted', () => {
    const items = Array.from({ length: 25 }, (_, i) => {
      const t = task(`t${i}`, scored(i + 1));
      return { item: t, key: t.slug, rice: t.rice, place: { score: t.score, suggested: false } };
    });
    items.push({ item: task('u'), key: 'u', rice: NO_RICE, place: { score: null, suggested: false } });
    const g = mapGeometry('task', items, 1000, 500);
    expect(g.points).toHaveLength(25);
    expect(g.points.filter((p) => p.labelled)).toHaveLength(20);
    expect(g.points.find((p) => p.key === 't0')!.labelled).toBe(false);
    expect(g.unscored).toBe(1);
    // Same value, more effort → further right.
    const a = g.points.find((p) => p.key === 't9')!;
    const b = g.points.find((p) => p.key === 't0')!;
    expect(b.x).toBeGreaterThan(a.x);
  });

  it('band lines are value = threshold × effort, slope 1 on log axes', () => {
    const g = mapGeometry('task', [], 1000, 1000);
    const now = g.lines.find((l) => l.band === 'now')!;
    // Same log span on both axes per pixel → a 45° segment in this square box... scaled by the domains.
    const ex = Math.log(52 / 0.1) / 1000;
    const vy = Math.log(50 / 0.1) / 1000;
    expect(((now.y1 - now.y2) * vy) / ((now.x2 - now.x1) * ex)).toBeCloseTo(1, 5);
  });

  it('zero or negative values clamp to the axis instead of NaN', () => {
    const t = task('z', { rice: { reach: 0, impact: 1, confidence: 25, effort: 0 }, score: 0 });
    const g = mapGeometry('task', [{ item: t, key: 'z', rice: t.rice, place: { score: 0, suggested: false } }], 400, 400);
    expect(Number.isFinite(g.points[0].x)).toBe(true);
    expect(Number.isFinite(g.points[0].y)).toBe(true);
  });
});
