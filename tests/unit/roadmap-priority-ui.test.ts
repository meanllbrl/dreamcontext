import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import matter from 'gray-matter';
import { mergePrefs, DEFAULT_ROADMAP_PREFS } from '../../dashboard/src/hooks/roadmapPrefs';
import {
  agentButtonState, applyMoveLocal, pendingItems, planDrop, segmentValues, taskLanes, UNLINKED,
  type PriorityPayload, type PriorityTask,
} from '../../dashboard/src/components/roadmap/priorityModel';
import { buildPriorityPayload } from '../../src/server/routes/roadmap-priority.js';
import { createObjective, getObjective, suggestObjective, acceptObjectiveSuggestion, dismissObjectiveSuggestion } from '../../src/lib/objectives-store.js';
import { LocalTaskBackend } from '../../src/lib/task-backend/local.js';
import { buildRoadmapModel } from '../../src/lib/roadmap-model.js';
import { objectiveLiveness, scoringWork, startScoring } from '../../src/lib/scoring-work.js';
import { planLinkMove } from '../../src/lib/priority-suggestion.js';
import { task } from './priority-fixtures';

/** The priority screen's logic (W2): prefs, the agent button, drag + undo, and a Tilki-sized board. */

describe('prefs: Roadmap opens on Objectives + Lanes on a machine with old prefs; the choice persists', () => {
  it('an old (v1) blob keeps its filters but not its layout', () => {
    const old = { layout: 'timeline', search: 'x', filters: { status: { inc: ['active'], exc: [] }, signal: { inc: [], exc: [] } } } as never;
    const p = mergePrefs(old);
    expect(p.layout).toBe('lanes');
    expect(p.level).toBe('objectives');
    expect(p.search).toBe('x');
    expect(p.filters.status.inc).toEqual(['active']);
  });
  it('empty storage (the desktop port changed) opens on the default', () => {
    expect(mergePrefs({})).toMatchObject({ layout: 'lanes', level: 'objectives', v: 2 });
    expect(DEFAULT_ROADMAP_PREFS.layout).toBe('lanes');
  });
  it('a v2 blob keeps the owner\'s choice afterwards', () => {
    expect(mergePrefs({ v: 2, layout: 'timeline', level: 'tasks' })).toMatchObject({ layout: 'timeline', level: 'tasks' });
    expect(mergePrefs({ v: 2, layout: 'map' })).toMatchObject({ layout: 'map', level: 'objectives' });
    expect(mergePrefs({ v: 2, layout: 'bogus' as never }).layout).toBe('lanes');
  });
});

describe('the agent button', () => {
  it('suggestions while pending (also while running); hidden at N = 0 with none pending even if running; Scoring… while running; else Score N', () => {
    expect(agentButtonState({ count: 3, pending: 2, running: true })).toMatchObject({ kind: 'suggestions', label: '✦ 2 suggestions' });
    expect(agentButtonState({ count: 0, pending: 0, running: true })).toEqual({ kind: 'hidden' });
    expect(agentButtonState({ count: 4, pending: 0, running: true })).toEqual({ kind: 'running', label: 'Scoring…' });
    expect(agentButtonState({ count: 4, pending: 0, running: false })).toMatchObject({ kind: 'score', label: '✦ Score 4' });
    expect(agentButtonState({ count: 1, pending: 1, running: false }).kind === 'suggestions' && agentButtonState({ count: 1, pending: 1, running: false })).toMatchObject({ label: '✦ 1 suggestion' });
  });
});

describe('drag: sideways links, Undo restores the source link at its position, other links stay', () => {
  const t = (over: Partial<PriorityTask>) => task('t', over);

  it('drop on another objective moves the source link only', () => {
    const card = { column: 'a', linkGhost: false, task: t({ links: ['a', 'c'], all_links: ['a', 'c'] }) };
    expect(planDrop(card, 'b')).toEqual({ remove: 'a', add: 'b' });
    expect(planDrop(card, UNLINKED)).toEqual({ remove: 'a', add: null });
    expect(planDrop(card, 'a')).toBeNull();
    expect(planDrop({ ...card, linkGhost: true }, 'b')).toBeNull();
  });

  it('a card marked objective done/missing replaces its first dead link', () => {
    const card = { column: UNLINKED, linkGhost: false, task: t({ links: [], all_links: ['old', 'gone'], mark: 'objective done' as const }) };
    expect(planDrop(card, 'b')).toEqual({ remove: 'old', add: 'b' });
    expect(planDrop({ ...card, task: t({}) }, 'b')).toEqual({ remove: null, add: 'b' });
  });

  it('optimistic local move, and the server undo round-trips with a link added elsewhere kept', () => {
    const tasks = [t({ links: ['a', 'c'], all_links: ['a', 'c'] })];
    const after = applyMoveLocal(tasks, 't', { remove: 'a', add: 'b' });
    expect(after[0].links.sort()).toEqual(['b', 'c']);
    // Server side: a link 'x' was added while the board was open.
    const server = planLinkMove(['a', 'c', 'x'], { remove: 'a', add: 'b' });
    expect(server.links).toEqual(['b', 'c', 'x']);
    expect(planLinkMove(server.links, server.undo).links).toEqual(['a', 'c', 'x']);
  });
});

describe('panel segments always include the stored value', () => {
  it('Tilki\'s 0.2 weeks is a choice', () => {
    expect(segmentValues('effort', 0.2)).toContain(0.2);
    expect(segmentValues('effort', 0.2)).toHaveLength(5);
    expect(segmentValues('reach', 6)).toEqual([2, 4, 6, 8, 10]);
    expect(segmentValues('reach', 7)).toContain(7);
  });
});

// ─── A Tilki-sized scratch vault through the REAL server payload ────────────

let projectRoot: string;
let contextRoot: string;

function writeTask(slug: string, fm: Record<string, unknown>): void {
  writeFileSync(join(contextRoot, 'state', `${slug}.md`), matter.stringify('## Why\nx\n', { name: slug, status: 'todo', priority: 'medium', urgency: 'medium', ...fm }));
}

beforeEach(() => {
  const raw = join(tmpdir(), `dc-prio-ui-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
});
afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

function seedTilki(): void {
  createObjective(contextRoot, { slug: 'mrr', title: '3000 USD MRR', impact: 5, effort: 4 });
  createObjective(contextRoot, { slug: 'mkt', title: 'Marketing ready', reach: 6, impact: 4, confidence: 75, effort: 2 });
  createObjective(contextRoot, { slug: 'old', title: 'Old' });
  // 'old' is done (override).
  writeFileSync(join(contextRoot, 'core', 'objectives', 'old.md'), matter.stringify('## Why\nx\n', { title: 'Old', status: 'done', depends_on: [], created_at: '2026-01-01' }));
  for (let i = 0; i < 40; i++) {
    const links = i % 5 === 0 ? ['mrr', 'mkt'] : i % 5 === 1 ? ['mrr'] : i % 5 === 2 ? ['old'] : i % 5 === 3 ? ['ghost-obj'] : [];
    const rice = i % 3 === 0 ? { reach: (i % 10) + 1, impact: (i % 5) + 1, confidence: 75, effort: 0.5 } : undefined;
    writeTask(`top-${i}`, { ...(links.length ? { objectives: links } : {}), ...(rice ? { rice } : {}), status: i % 7 === 0 ? 'in_progress' : 'todo' });
  }
  for (let i = 0; i < 40; i++) writeTask(`sub-${i}`, { parent_task: `top-${i % 40}`, rice: { reach: 9, impact: 5, confidence: 100, effort: 0.5 } });
  writeTask('closed', { status: 'completed', objectives: ['mrr'] });
}

describe('a Tilki-sized board (80 open tasks, 40 sub-tasks)', () => {
  it('every open top-level task appears exactly once per effective link, or in Unlinked; sub-tasks are not cards', () => {
    seedTilki();
    const p = buildPriorityPayload(contextRoot) as unknown as PriorityPayload;
    expect(p.tasks).toHaveLength(40);
    const m = taskLanes(p.objectives, p.tasks, '');
    const count = new Map<string, number>();
    for (const c of m.columns) {
      for (const card of [...c.bands.now, ...c.bands.next, ...c.bands.later, ...c.notScored]) {
        count.set(card.task.slug, (count.get(card.task.slug) ?? 0) + 1);
        if (c.slug !== UNLINKED) expect(card.task.links).toContain(c.slug);
      }
    }
    for (const t of p.tasks) expect(count.get(t.slug)).toBe(Math.max(1, t.links.length));
    expect([...count.keys()].some((s) => s.startsWith('sub-'))).toBe(false);
    expect(m.columns.map((c) => c.slug)).toEqual(['mkt', 'mrr', UNLINKED]);
    expect(p.tasks.find((t) => t.slug === 'top-2')!.mark).toBe('objective done');
    expect(p.tasks.find((t) => t.slug === 'top-3')!.mark).toBe('objective missing');
    expect(p.tasks.find((t) => t.slug === 'top-0')!.subtask_count).toBe(1);
  });

  it('the button count equals the items shown; a mid-run accept keeps Scoring…; after everything is dismissed it is hidden', async () => {
    seedTilki();
    const b = new LocalTaskBackend(join(contextRoot, 'state'));
    const live = () => objectiveLiveness(buildRoadmapModel(contextRoot));
    expect(startScoring(contextRoot)).toBe(true);
    expect(startScoring(contextRoot)).toBe(false); // a second window / double click
    // One agent pass.
    for (const it of scoringWork(contextRoot).items) {
      if (it.kind === 'objective') {
        const input: Record<string, unknown> = { why: 'w' };
        for (const k of it.missing) input[k] = { reach: 7, impact: 3, confidence: 75, effort: 2 }[k];
        suggestObjective(contextRoot, it.slug, input, live());
        continue;
      }
      const input: Record<string, unknown> = { why: 'w' };
      for (const k of it.missing) input[k] = { reach: 3, impact: 2, confidence: 50, effort: 1 }[k];
      if (it.needs_link) input.objective = 'mrr';
      await b.suggestPriority(it.slug, input, live());
    }
    let p = buildPriorityPayload(contextRoot) as unknown as PriorityPayload;
    expect(p.scoring.count).toBe(0);
    expect(pendingItems(p)).toHaveLength(p.scoring.pending);
    expect(p.scoring.pending).toBeGreaterThan(0);
    expect(agentButtonState(p.scoring).kind).toBe('suggestions');
    // A task with two objectives is one item.
    expect(new Set(pendingItems(p).map((i) => i.slug)).size).toBe(pendingItems(p).length);

    // Accept one objective mid-run; dismiss the rest: pending → 0 while still running.
    acceptObjectiveSuggestion(contextRoot, 'mrr', getObjective(contextRoot, 'mrr')!.priority_suggestion!.at, {}, live());
    for (const it of pendingItems(buildPriorityPayload(contextRoot) as unknown as PriorityPayload)) {
      if (it.kind === 'task') await b.dismissSuggestion(it.slug, it.suggestion.at);
      else dismissObjectiveSuggestion(contextRoot, it.slug, it.suggestion.at);
    }
    p = buildPriorityPayload(contextRoot) as unknown as PriorityPayload;
    expect(p.scoring).toMatchObject({ count: 0, pending: 0, running: true });
    // A reload rebuilds from the server marker: still running; and with nothing left the button is hidden.
    expect(agentButtonState(p.scoring)).toEqual({ kind: 'hidden' });
    expect(agentButtonState({ ...p.scoring, count: 2 })).toEqual({ kind: 'running', label: 'Scoring…' });
  });
});
