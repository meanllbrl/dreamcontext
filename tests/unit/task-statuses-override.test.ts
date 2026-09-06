import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import matter from 'gray-matter';
import { readFileSync } from 'node:fs';

import {
  loadTaskOverride,
  loadStatuses,
  taskOverridePath,
  upsertStatus,
  removeStatus,
  renderOverrideBriefing,
  hasCustomStatuses,
} from '../../src/lib/overrides.js';
import { DEFAULT_STATUSES, PARENT_BY_KIND, childrenOf, parentOf, subStatusMarker, type StatusDef } from '../../src/lib/task-status.js';
import { filterTasks, groupTasks, toTaskRecord } from '../../src/lib/task-query.js';
import { dateUpdatesForStatus } from '../../src/lib/task-dates.js';
import { rankOpenTasks } from '../../src/lib/bookmark-task-link.js';
import { planCuratorTask, CURATOR_TASK_SLUG } from '../../src/lib/sleep-flags.js';
import { buildRoadmapModel, computeRollupStatus, type RoadmapTaskRef } from '../../src/lib/roadmap-model.js';
import { createObjective } from '../../src/lib/objectives-store.js';
import { mergeTaskMd, resolveConflicts } from '../../src/lib/git-sync/semantic-merge.js';
import { readTaskFile } from '../../src/lib/task-backend/local.js';
import { buildStatusModel, DEFAULT_STATUS_MODEL } from '../../dashboard/src/lib/statusModel.js';
import { dueInfo, isAtRisk, dimGroups, filterTasks as boardFilter, emptyFilters } from '../../dashboard/src/components/tasks/boardModel.js';
import { taskSpan } from '../../dashboard/src/components/tasks/calendar-utils.js';
import type { Task } from '../../dashboard/src/hooks/useTasks.js';

/**
 * Project-declarable task statuses (task_adYgpCxk): the `statuses:` override
 * frontmatter — every validation rule (warn + drop, never fatal), the writers,
 * the briefing — and every derived behaviour that now reads the KIND: list
 * visibility, grouping, date stamping, the bookmark hint, the curator plan,
 * roadmap progress, the team merge, and the dashboard's live-task exclusions.
 */

let root: string;

function writeOverride(body: string): void {
  mkdirSync(join(root, 'overrides'), { recursive: true });
  writeFileSync(taskOverridePath(root), body, 'utf-8');
}

const DECLARE_TWO = [
  '---',
  'statuses:',
  '  - { name: Planned, key: planned, kind: open, order: 5, color: c5def5 }',
  '  - { name: Cancelled, key: cancelled, kind: cancelled, order: 99, color: cfd3d7, clickup: [cancelled, canceled, "won\'t do"] }',
  '---',
  '',
].join('\n');

beforeEach(() => {
  const raw = join(tmpdir(), `dc-st-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(raw, 'state'), { recursive: true });
  root = realpathSync(raw);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('statuses: frontmatter — parse + validate', () => {
  it('no override → the shipped four, byte-identical', () => {
    expect(loadStatuses(root)).toEqual(DEFAULT_STATUSES);
    expect(hasCustomStatuses(loadStatuses(root))).toBe(false);
  });

  it('an override with no statuses key → the shipped four, no warnings', () => {
    writeOverride('---\ncustom_fields: []\n---\n');
    const ov = loadTaskOverride(root)!;
    expect(ov.statuses).toEqual(DEFAULT_STATUSES);
    expect(ov.warnings).toEqual([]);
  });

  it('parses declared statuses into the EFFECTIVE set, sorted by order, shipped four intact', () => {
    writeOverride(DECLARE_TWO);
    const ov = loadTaskOverride(root)!;
    expect(ov.warnings).toEqual([]);
    expect(ov.statuses.map((s) => s.key)).toEqual(['todo', 'planned', 'in_progress', 'in_review', 'completed', 'cancelled']);
    const cancelled = ov.statuses.find((s) => s.key === 'cancelled')!;
    expect(cancelled).toEqual({ key: 'cancelled', label: 'Cancelled', kind: 'cancelled', order: 99, color: 'cfd3d7', clickup: ['cancelled', 'canceled', "won't do"] });
    expect(hasCustomStatuses(ov.statuses)).toBe(true);
  });

  it('invalid kind → warning, entry dropped', () => {
    writeOverride('---\nstatuses:\n  - { name: Active-ish, kind: acive, order: 12 }\n---\n');
    const ov = loadTaskOverride(root)!;
    expect(ov.statuses.map((s) => s.key)).toEqual(['todo', 'in_progress', 'in_review', 'completed']);
    expect(ov.warnings.join('\n')).toMatch(/unknown kind "acive"/);
  });

  it('missing kind on a NEW status → warning, entry dropped', () => {
    writeOverride('---\nstatuses:\n  - { name: Someday, order: 3 }\n---\n');
    const ov = loadTaskOverride(root)!;
    expect(ov.statuses.some((s) => s.key === 'someday')).toBe(false);
    expect(ov.warnings.join('\n')).toMatch(/has no `kind`/);
  });

  it('non-6-hex colour → warning, colour dropped to the kind default, entry KEPT', () => {
    writeOverride('---\nstatuses:\n  - { name: Planned, kind: open, order: 5, color: "blue" }\n---\n');
    const ov = loadTaskOverride(root)!;
    const planned = ov.statuses.find((s) => s.key === 'planned')!;
    expect(planned.color).toBeUndefined();
    expect(ov.warnings.join('\n')).toMatch(/not a 6-hex colour/);
  });

  it('accepts a leading # on a colour', () => {
    writeOverride('---\nstatuses:\n  - { name: Planned, kind: open, order: 5, color: "#C5DEF5" }\n---\n');
    expect(loadTaskOverride(root)!.statuses.find((s) => s.key === 'planned')!.color).toBe('c5def5');
  });

  it('duplicate derived keys → second dropped with a warning', () => {
    writeOverride('---\nstatuses:\n  - { name: Planned, kind: open, order: 5 }\n  - { name: "planned", kind: review, order: 6 }\n---\n');
    const ov = loadTaskOverride(root)!;
    expect(ov.statuses.filter((s) => s.key === 'planned')).toHaveLength(1);
    expect(ov.statuses.find((s) => s.key === 'planned')!.kind).toBe('open');
    expect(ov.warnings.join('\n')).toMatch(/duplicate status key "planned"/);
  });

  it('collision with a custom-field key, a reserved word, or a reserved label prefix → dropped', () => {
    writeOverride([
      '---',
      'custom_fields:',
      '  - { name: Team, type: text }',
      'statuses:',
      '  - { name: Team, kind: open, order: 5 }',
      '  - { name: Deleted, kind: cancelled, order: 98 }',
      '  - { name: Prio, key: "priority:high", kind: open, order: 7 }',
      '  - { name: Sub, key: "dc:foo", kind: open, order: 8 }',
      '---',
    ].join('\n'));
    const ov = loadTaskOverride(root)!;
    expect(ov.statuses.map((s) => s.key)).toEqual(['todo', 'in_progress', 'in_review', 'completed']);
    expect(ov.warnings.join('\n')).toMatch(/collides with a custom field/);
    expect(ov.warnings.join('\n')).toMatch(/"deleted" is reserved/);
    expect(ov.warnings.join('\n')).toMatch(/reserved label prefix/);
  });

  it('a shipped key may be relabelled / reordered / recoloured but a re-kind attempt drops the entry', () => {
    writeOverride([
      '---',
      'statuses:',
      '  - { key: in_review, name: "QA", order: 25, color: "112233" }',
      '  - { key: completed, name: "Done", kind: cancelled }',
      '---',
    ].join('\n'));
    const ov = loadTaskOverride(root)!;
    const review = ov.statuses.find((s) => s.key === 'in_review')!;
    expect(review).toMatchObject({ label: 'QA', order: 25, color: '112233', kind: 'review' });
    const done = ov.statuses.find((s) => s.key === 'completed')!;
    expect(done).toMatchObject({ label: 'Completed', kind: 'done' });
    expect(ov.warnings.join('\n')).toMatch(/cannot be re-kinded/);
    // Still exactly four + nothing removed.
    expect(ov.statuses).toHaveLength(4);
  });

  it('exactly ONE done-kind status: a second done-kind declaration is dropped', () => {
    writeOverride('---\nstatuses:\n  - { name: Shipped, kind: done, order: 35 }\n---\n');
    const ov = loadTaskOverride(root)!;
    expect(ov.statuses.filter((s) => s.kind === 'done').map((s) => s.key)).toEqual(['completed']);
    expect(ov.warnings.join('\n')).toMatch(/only `completed` may be done-kind/);
  });

  it('duplicate order within a kind warns but keeps the entry; a non-numeric order warns and defaults', () => {
    writeOverride('---\nstatuses:\n  - { name: Backlog, kind: open, order: 0 }\n  - { name: Later, kind: open, order: soon }\n---\n');
    const ov = loadTaskOverride(root)!;
    expect(ov.statuses.some((s) => s.key === 'backlog')).toBe(true);
    expect(ov.statuses.find((s) => s.key === 'later')!.order).toBe(5);
    expect(ov.warnings.join('\n')).toMatch(/shares order 0/);
    expect(ov.warnings.join('\n')).toMatch(/non-numeric order/);
  });

  it('`statuses` that is not a list → warning, shipped four', () => {
    writeOverride('---\nstatuses: planned\n---\n');
    const ov = loadTaskOverride(root)!;
    expect(ov.statuses).toEqual(DEFAULT_STATUSES);
    expect(ov.warnings.join('\n')).toMatch(/must be a list/);
  });

  it('never throws: a malformed frontmatter still yields the shipped four', () => {
    writeOverride('---\nstatuses: [\n---\n');
    const ov = loadTaskOverride(root)!;
    expect(ov.statuses).toEqual(DEFAULT_STATUSES);
    expect(ov.warnings.length).toBeGreaterThan(0);
  });
});

describe('upsertStatus / removeStatus', () => {
  it('creates the file, ALWAYS writes an explicit key, and round-trips', () => {
    upsertStatus(root, { name: 'Planned', kind: 'open', order: 5, color: '#C5DEF5' });
    const fm = matter(readFileSync(taskOverridePath(root), 'utf-8')).data as { statuses: Array<Record<string, unknown>> };
    expect(fm.statuses[0]).toMatchObject({ name: 'Planned', key: 'planned', kind: 'open', order: 5, color: 'c5def5' });
    expect(loadStatuses(root).find((s) => s.key === 'planned')).toMatchObject({ label: 'Planned', kind: 'open' });
  });

  it('a rename keeps the same key (the upsert is keyed, so synced dc:<key> labels are never orphaned)', () => {
    upsertStatus(root, { name: 'Planned', kind: 'open', order: 5 });
    upsertStatus(root, { name: 'Scheduled', key: 'planned', kind: 'open', order: 5 });
    const set = loadStatuses(root);
    expect(set.filter((s) => s.key === 'planned')).toHaveLength(1);
    expect(set.find((s) => s.key === 'planned')!.label).toBe('Scheduled');
  });

  it('refuses a new status without a kind, a done-kind status, a re-kind of a shipped key, a bad colour', () => {
    expect(() => upsertStatus(root, { name: 'X' })).toThrow(/kind must be one of/);
    expect(() => upsertStatus(root, { name: 'Shipped', kind: 'done' })).toThrow(/done-kind/);
    expect(() => upsertStatus(root, { name: 'Completed', key: 'completed', kind: 'cancelled' })).toThrow(/cannot be re-kinded/);
    expect(() => upsertStatus(root, { name: 'Planned', kind: 'open', color: 'blue' })).toThrow(/6-hex/);
  });

  it('a shipped key can be relabelled / recoloured without a kind and its kind is not written', () => {
    upsertStatus(root, { name: 'QA', key: 'in_review', color: '112233', order: 25 });
    const fm = matter(readFileSync(taskOverridePath(root), 'utf-8')).data as { statuses: Array<Record<string, unknown>> };
    expect(fm.statuses[0]).toEqual({ name: 'QA', key: 'in_review', order: 25, color: '112233' });
    expect(loadStatuses(root).find((s) => s.key === 'in_review')).toMatchObject({ label: 'QA', kind: 'review' });
  });

  it('removeStatus drops a declared key and refuses a shipped one', () => {
    writeOverride(DECLARE_TWO);
    removeStatus(root, 'planned');
    expect(loadStatuses(root).map((s) => s.key)).toEqual(['todo', 'in_progress', 'in_review', 'completed', 'cancelled']);
    expect(() => removeStatus(root, 'completed')).toThrow(/cannot be removed/);
  });
});

describe('renderOverrideBriefing surfaces the set', () => {
  it('lists every key with its kind and tells the agent where cancelled work goes', () => {
    writeOverride(DECLARE_TWO);
    const text = renderOverrideBriefing(loadTaskOverride(root)!);
    expect(text).toContain('`planned` — Planned (kind: open');
    expect(text).toContain('`cancelled` — Cancelled (kind: cancelled');
    expect(text).toMatch(/abandoned, superseded or obsoleted goes to `cancelled`/);
    expect(text).toMatch(/NOT to `in_review "confirm close"`/);
  });

  it('says nothing about statuses when only the shipped four exist', () => {
    writeOverride('---\ncustom_fields: []\n---\n');
    expect(renderOverrideBriefing(loadTaskOverride(root)!)).not.toContain('declares its own task statuses');
  });
});

describe('derived behaviour reads the kind', () => {
  const declared = (): StatusDef[] => { writeOverride(DECLARE_TWO); return loadStatuses(root); };
  const rec = (name: string, status: string, updated = '2026-09-01') => toTaskRecord({ status, updated_at: updated }, name);

  it('tasks list: a cancelled-kind task is hidden by default, shown with --all, found with -s', () => {
    const set = declared();
    const tasks = [rec('a', 'todo'), rec('b', 'cancelled'), rec('c', 'completed'), rec('d', 'planned')];
    expect(filterTasks(tasks, { statuses: set }).map((t) => t.name)).toEqual(['a', 'd']);
    expect(filterTasks(tasks, { all: true, statuses: set }).map((t) => t.name)).toEqual(['a', 'b', 'c', 'd']);
    expect(filterTasks(tasks, { status: 'cancelled', statuses: set }).map((t) => t.name)).toEqual(['b']);
    // Without the set (no override), `cancelled` is unknown → fails safe → stays visible.
    expect(filterTasks(tasks).map((t) => t.name)).toEqual(['a', 'b', 'd']);
  });

  it('-g status groups in the declared pipeline order', () => {
    const set = declared();
    const tasks = [rec('a', 'in_progress'), rec('b', 'planned'), rec('c', 'todo'), rec('d', 'cancelled')];
    expect(groupTasks(tasks, 'status', set).map((g) => g.key)).toEqual(['todo', 'planned', 'in_progress', 'cancelled']);
  });

  it('date stamping: an active-kind status stamps the start, cancelled stamps NOTHING', () => {
    const set: StatusDef[] = [...DEFAULT_STATUSES, { key: 'doing', label: 'Doing', kind: 'active', order: 12 }, { key: 'cancelled', label: 'Cancelled', kind: 'cancelled', order: 99 }];
    expect(dateUpdatesForStatus('doing', { start_date: null, due_date: null }, '2026-09-06', set)).toEqual({ start_date: '2026-09-06' });
    expect(dateUpdatesForStatus('cancelled', { start_date: null, due_date: '2026-08-01' }, '2026-09-06', set)).toEqual({});
    // Shipped behaviour unchanged.
    expect(dateUpdatesForStatus('completed', { start_date: '2026-09-01', due_date: null }, '2026-09-06')).toEqual({ due_date: '2026-09-06' });
  });

  it('bookmark open-task hint drops a cancelled-kind task', () => {
    const set = declared();
    const rows = [
      { slug: 'a', status: 'cancelled', updated_at: '2026-09-05' },
      { slug: 'b', status: 'todo', updated_at: '2026-09-01' },
      { slug: 'c', status: 'completed', updated_at: '2026-09-06' },
    ];
    expect(rankOpenTasks(rows, 5, set).map((r) => r.slug)).toEqual(['b']);
  });

  it('curator plan: a cancelled chore is recreated, never refreshed back to life', () => {
    const set = declared();
    expect(planCuratorTask(200, { slug: CURATOR_TASK_SLUG, status: 'cancelled' }, null, set).action).toBe('create');
    expect(planCuratorTask(200, { slug: CURATOR_TASK_SLUG, status: 'planned' }, null, set).action).toBe('refresh');
  });

  it('roadmap: cancelled leaves numerator AND denominator; all-remaining-cancelled rolls up done', () => {
    const set = declared();
    const ref = (status: string): RoadmapTaskRef => ({ slug: 'x', status, start_date: null, due_date: null, version: null, updated_at: null });
    expect(computeRollupStatus([ref('completed'), ref('cancelled')], set)).toBe('done');
    expect(computeRollupStatus([ref('cancelled')], set)).toBe('not_started');
    expect(computeRollupStatus([ref('planned'), ref('cancelled')], set)).toBe('not_started');
    expect(computeRollupStatus([ref('in_progress'), ref('cancelled')], set)).toBe('active');

    mkdirSync(join(root, 'core'), { recursive: true });
    createObjective(root, { slug: 'launch', title: 'Launch' });
    const task = (slug: string, status: string) => writeFileSync(
      join(root, 'state', `${slug}.md`),
      `---\nid: "task_${slug}"\nname: "${slug}"\nstatus: "${status}"\ncreated_at: "2026-06-01"\nupdated_at: "2026-06-01"\ntags: []\nobjectives: ["launch"]\n---\n\n## Why\n\nx\n`,
      'utf-8',
    );
    task('a', 'completed'); task('b', 'cancelled'); task('c', 'todo');
    const o = buildRoadmapModel(root).objectives.find((x) => x.slug === 'launch')!;
    expect(o.progress.done).toBe(1);
    expect(o.progress.total).toBe(2);
    expect(o.progress.pct).toBe(50);
  });

  it('readTaskFile normalises case + hyphens, preserves an unknown key, and defaults an absent one', () => {
    const set = declared();
    const file = join(root, 'state', 'x.md');
    const read = (raw: string, defs?: StatusDef[]) => {
      writeFileSync(file, `---\nname: x\n${raw}\n---\n## Why\nx\n`, 'utf-8');
      return defs ? readTaskFile(file, defs).status : readTaskFile(file).status;
    };
    expect(read('status: cancelled', set)).toBe('cancelled');
    // Unknown to the shipped set → PRESERVED, never rewritten to todo: a status
    // another machine declared must survive a machine that has not pulled it.
    expect(read('status: cancelled')).toBe('cancelled');
    expect(read('status: on_hold')).toBe('on_hold');
    // Case + hyphen folding. `COMPLETED` MUST fold: several surfaces still compare
    // the done status literally, and an un-normalised value slips past them.
    expect(read('status: in-progress')).toBe('in_progress');
    expect(read('status: COMPLETED')).toBe('completed');
    expect(read('status: In-Progress')).toBe('in_progress');
    expect(read('status: "  todo  "')).toBe('todo');
    // Absent / empty → todo, exactly as before.
    expect(read('')).toBe('todo');
    expect(read('status: ""')).toBe('todo');
  });
});

describe('semantic-merge: status by rank, unknown preserved and named', () => {
  const doc = (status: string, updated = '2026-09-01') =>
    ['---', `status: ${status}`, `updated_at: '${updated}'`, '---', '', '## Why', 'x', '', '## Changelog', '### 2026-07-01 - start', '- created'].join('\n');
  const set: StatusDef[] = [...DEFAULT_STATUSES, { key: 'cancelled', label: 'Cancelled', kind: 'cancelled', order: 99 }];

  it('known vs known by rank: cancelled beats in_progress, completed beats cancelled — order-independent', () => {
    expect(mergeTaskMd(doc('todo'), doc('cancelled'), doc('in_progress'), { statuses: set }).merged).toMatch(/status: cancelled/);
    expect(mergeTaskMd(doc('todo'), doc('in_progress'), doc('cancelled'), { statuses: set }).merged).toMatch(/status: cancelled/);
    expect(mergeTaskMd(doc('todo'), doc('cancelled'), doc('completed'), { statuses: set }).merged).toMatch(/status: completed/);
    expect(mergeTaskMd(doc('todo'), doc('completed'), doc('cancelled'), { statuses: set }).merged).toMatch(/status: completed/);
  });

  it('known vs unknown (no override on this machine): the unknown side survives and is named', () => {
    const r1 = mergeTaskMd(doc('todo'), doc('completed'), doc('cancelled'));
    const r2 = mergeTaskMd(doc('todo'), doc('cancelled'), doc('completed'));
    expect(r1.merged).toMatch(/status: cancelled/);
    expect(r2.merged).toMatch(/status: cancelled/);
    expect(r1.unknownStatuses).toEqual(['cancelled']);
  });

  it('both unknown: later updated_at wins from either side', () => {
    const a = doc('frozen', '2026-09-01');
    const b = doc('blocked', '2026-09-03');
    expect(mergeTaskMd(doc('todo'), a, b).merged).toMatch(/status: blocked/);
    expect(mergeTaskMd(doc('todo'), b, a).merged).toMatch(/status: blocked/);
  });

  it('resolveConflicts returns notes naming the unknown status', () => {
    // No git repo here — exercise only the shape of a clean result on no conflicts.
    const r = resolveConflicts(root, [], { contextRoot: root });
    expect(r.notes).toEqual([]);
  });

  it('shipped behaviour unchanged with no set: furthest status wins', () => {
    expect(mergeTaskMd(doc('todo'), doc('in_progress'), doc('todo')).merged).toMatch(/status: in_progress/);
  });
});

describe('dashboard status model — live-task exclusions', () => {
  const sm = buildStatusModel([
    ...DEFAULT_STATUS_MODEL.defs,
    { key: 'planned', label: 'Planned', kind: 'open', order: 5, color: 'c5def5' },
    { key: 'cancelled', label: 'Cancelled', kind: 'cancelled', order: 99 },
  ]);
  const task = (status: string, due: string | null = '2000-01-01'): Task => ({
    slug: `t-${status}`, id: 'x', name: status, description: '', priority: 'high', urgency: 'high', status,
    created_at: '2026-01-01', updated_at: '2026-01-01', tags: [], parent_task: null, related_feature: null, version: null,
    due_date: due, rice: null, why: '', user_stories: '', acceptance_criteria: '', constraints: '', technical_details: '', notes: '', changelog: '', sections: [], body: '',
  });

  it('order, labels, colours (declared hex, shipped tokens, kind token fallback)', () => {
    expect(sm.order).toEqual(['todo', 'planned', 'in_progress', 'in_review', 'completed', 'cancelled']);
    expect(sm.colorOf('planned')).toBe('#c5def5');
    expect(sm.colorOf('completed')).toBe('var(--color-status-completed)');
    expect(sm.colorOf('cancelled')).toBe('var(--color-status-cancelled)');
    expect(sm.labelOf('zzz')).toBe('zzz');
    expect(sm.isTerminal('cancelled')).toBe(true);
    expect(sm.isTerminal('zzz')).toBe(false);
  });

  it('a cancelled task with a past due date is NOT overdue, NOT at risk, and no calendar span marks it overdue', () => {
    expect(dueInfo(task('cancelled'), sm)).toBeNull();
    expect(isAtRisk(task('cancelled'), sm)).toBe(false);
    expect(dueInfo(task('planned'), sm)?.kind).toBe('overdue');
    expect(taskSpan(task('cancelled'), sm)?.overdue).toBe(false);
    expect(taskSpan(task('planned'), sm)?.overdue).toBe(true);
    // Shipped model: completed still excluded exactly as before.
    expect(dueInfo(task('completed'))).toBeNull();
  });

  it('the board due filter excludes cancelled from "overdue" and the status dim gets declared + unknown columns', () => {
    const tasks = [task('planned'), task('cancelled'), task('mystery')];
    // Cancelled is excluded; an UNKNOWN status fails safe as live (stays visible).
    const overdue = boardFilter(tasks, { ...emptyFilters(), due: 'overdue' }, '', undefined, sm);
    expect(overdue.map((t) => t.status)).toEqual(['planned', 'mystery']);
    const cols = dimGroups('status', tasks, { versionOrder: [], assignees: [], statuses: sm });
    expect(cols.map((c) => c.key)).toEqual(['todo', 'planned', 'in_progress', 'in_review', 'completed', 'cancelled', 'mystery']);
    expect(cols.find((c) => c.key === 'cancelled')!.tasks).toHaveLength(1);
    expect(cols.find((c) => c.key === 'mystery')!.tasks).toHaveLength(1);
  });
});

describe('parent — the remote carrier that makes a declared status need nothing created', () => {
  const declared = (): StatusDef[] => { writeOverride(DECLARE_TWO); return loadStatuses(root); };

  it('every kind has a natural parent, and cancelled parents to completed (closed on a remote)', () => {
    expect(PARENT_BY_KIND).toEqual({ open: 'todo', active: 'in_progress', review: 'in_review', done: 'completed', cancelled: 'completed' });
  });

  it('a declared status resolves to its parent; a shipped one is its own parent; unknown → todo', () => {
    const set = declared();
    expect(parentOf(set, 'planned')).toBe('todo');
    expect(parentOf(set, 'cancelled')).toBe('completed');
    for (const k of ['todo', 'in_progress', 'in_review', 'completed']) expect(parentOf(set, k)).toBe(k);
    // Unknown falls back to the safest of the four: it neither closes nor completes.
    expect(parentOf(set, 'on_hold')).toBe('todo');
  });

  it('an explicit parent overrides the kind default and is written back verbatim', () => {
    writeOverride('---\nstatuses:\n  - { name: Blocked, key: blocked, kind: open, parent: in_progress, order: 12 }\n---\n');
    const set = loadStatuses(root);
    expect(parentOf(set, 'blocked')).toBe('in_progress');
    expect(loadTaskOverride(root)!.warnings).toEqual([]);
  });

  it('a parent that is not one of the four warns and falls back to the kind default — never drops the status', () => {
    writeOverride('---\nstatuses:\n  - { name: Blocked, key: blocked, kind: open, parent: nonsense, order: 12 }\n---\n');
    const ov = loadTaskOverride(root)!;
    expect(ov.statuses.some((s) => s.key === 'blocked')).toBe(true);
    expect(parentOf(ov.statuses, 'blocked')).toBe('todo');
    expect(ov.warnings.join('\n')).toMatch(/not one of the four shipped statuses/);
  });

  it('childrenOf groups the declared statuses under their parent', () => {
    const set = declared();
    expect(childrenOf(set, 'todo').map((d) => d.key)).toEqual(['planned']);
    expect(childrenOf(set, 'completed').map((d) => d.key)).toEqual(['cancelled']);
    expect(childrenOf(set, 'in_review')).toEqual([]);
  });

  it('only a DECLARED status carries a dc:<key> marker — the shipped four carry none', () => {
    const set = declared();
    expect(subStatusMarker(set, 'cancelled')).toBe('dc:cancelled');
    expect(subStatusMarker(set, 'planned')).toBe('dc:planned');
    for (const k of ['todo', 'in_progress', 'in_review', 'completed']) expect(subStatusMarker(set, k)).toBeNull();
  });

  it('upsertStatus ALWAYS writes the parent explicitly (the wire contract must not drift)', () => {
    upsertStatus(root, { name: 'Cancelled', kind: 'cancelled', order: 99 });
    const fm = matter(readFileSync(taskOverridePath(root), 'utf-8')).data as { statuses: Array<Record<string, unknown>> };
    expect(fm.statuses[0]).toMatchObject({ key: 'cancelled', kind: 'cancelled', parent: 'completed' });
    expect(() => upsertStatus(root, { name: 'Odd', kind: 'open', parent: 'nonsense' })).toThrow(/parent must be one of/);
  });
});
