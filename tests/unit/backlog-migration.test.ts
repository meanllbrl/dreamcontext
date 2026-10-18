import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BACKLOG_AGENT_TASK_ID,
  BACKLOG_MIGRATION_REL_PATH,
  BACKLOG_STEP_ID,
  backlogDecisionsPending,
  backlogReport,
  createFamilyParent,
  decideTask,
  readBacklogStore,
  runBacklogStep,
} from '../../src/lib/backlog-migration.js';
import { migration0330Backlog } from '../../src/migrations/0.33.0-backlog.js';
import { migration0330 } from '../../src/migrations/0.33.0.js';
import { REGISTRY, agentTaskNeeded, unfinishedAgentTasks } from '../../src/migrations/index.js';
import { runMigrations } from '../../src/lib/migration-runner.js';
import { appendLedger } from '../../src/lib/migration-ledger.js';
import { readFrontmatter } from '../../src/lib/frontmatter.js';
import { LocalTaskBackend } from '../../src/lib/task-backend/local.js';
import { readJournal } from '../../src/lib/task-journal.js';
import { groupTasks, NONE_KEY, toTaskRecord } from '../../src/lib/task-query.js';
import { cardIssuesOfFile } from '../../src/lib/task-doctor.js';
import { loadStatuses } from '../../src/lib/overrides.js';

let projectRoot: string;
let ctx: string;
let stateDir: string;

interface Card {
  status?: string;
  version?: string;
  priority?: string;
  parent?: string;
  queue?: string;
  created?: string;
  id?: string;
  name?: string;
  feature?: string;
}

function card(slug: string, c: Card = {}): void {
  const fm = [
    '---',
    `id: ${c.id ?? `task_${slug}`}`,
    `name: ${c.name ?? slug.replace(/-/g, ' ')}`,
    `description: ${c.name ?? slug.replace(/-/g, ' ')}`,
    `status: ${c.status ?? 'todo'}`,
    `created_at: '${c.created ?? '2026-09-01'}'`,
    "updated_at: '2026-10-01'",
    ...(c.version ? [`version: ${c.version}`] : []),
    ...(c.priority ? [`priority: ${c.priority}`] : []),
    ...(c.parent ? [`parent_task: ${c.parent}`] : []),
    ...(c.queue ? [`queue: ${c.queue}`] : []),
    ...(c.feature ? [`related_feature: ${c.feature}`] : []),
    '---',
    '',
    '## Why',
    '',
    `Because ${slug} matters.`,
    '',
  ];
  writeFileSync(join(stateDir, `${slug}.md`), fm.join('\n'));
}

const fm = (slug: string) => readFrontmatter<Record<string, unknown>>(join(stateDir, `${slug}.md`)).data;

/** A feature doc (an area), listing the tasks that belong to it. */
function feature(slug: string, relatedTasks: string[] = []): void {
  const dir = join(ctx, 'knowledge', 'features');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.md`), [
    '---', `name: ${slug}`, 'type: feature', `related_tasks: [${relatedTasks.join(', ')}]`, '---', '', `# ${slug}`, '',
  ].join('\n'));
}
const featureTasks = (slug: string) =>
  readFrontmatter<Record<string, unknown>>(join(ctx, 'knowledge', 'features', `${slug}.md`)).data.related_tasks as string[];
const cardFiles = () => readdirSync(stateDir).filter((f) => f.endsWith('.md')).sort();
const snapshotAll = () => {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.locks') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, `${rel}${e.name}/`);
      else out[`${rel}${e.name}`] = readFileSync(p, 'utf-8');
    }
  };
  walk(ctx, '');
  return out;
};

const RELEASED = { id: 'rel_1', version: '0.31.0', date: '2026-10-11', summary: 'shipped', status: 'released', tasks: ['task_x'] };
const PLANNING_NEXT = { id: 'rel_2', version: 'v0.32.0', date: '2026-10-15', summary: 'the next one, in preparation', status: 'planning', tasks: ['task_a'] };
const PLANNING_BACKLOG = { id: 'rel_3', version: 'BACKLOG', date: '', summary: '', status: 'planning', tasks: [] };

function withCancelledStatus(): void {
  mkdirSync(join(ctx, 'overrides'), { recursive: true });
  writeFileSync(join(ctx, 'overrides', 'task.md'), [
    '---', 'statuses:', '  - { name: Cancelled, key: cancelled, kind: cancelled, order: 99 }', '---', '',
  ].join('\n'));
}

/** A brain shaped like this project's: planning versions, an active version, families. */
function seedBrain(): void {
  withCancelledStatus();
  writeFileSync(join(ctx, 'core', 'RELEASES.json'), JSON.stringify([PLANNING_NEXT, RELEASED, PLANNING_BACKLOG], null, 2) + '\n');
  writeFileSync(join(stateDir, '.active-version.json'), '{\n  "active_planning_version": "v0.32.0"\n}\n');
  card('ship-the-export', { id: 'task_ship-the', status: 'in_progress', version: 'v0.32.0', priority: 'high', created: '2026-10-01' });
  card('old-idea', { version: 'BACKLOG', priority: 'low' });
  card('stale-polish', { version: '0.28.0', priority: 'medium', created: '2026-08-01' });
  card('agents-epic-finished-end-to-end', { version: '0.30.0' });
  card('agents-step-2-a-run-pushes-a-message', { status: 'in_review', version: '0.30.0' });
  card('agents-step-3-a-message-carries-a-question', { version: '0.30.0' });
  card('agents-step-1-the-page', { status: 'completed', version: '0.30.0' });
  card('done-thing', { status: 'completed', version: '0.28.0' });
  card('already-placed', { queue: 'later' });
  card('legacy-child', { parent: 'task_ship-the' });
  card('duplicate-of-export', { version: 'v0.32.0' });
}

beforeEach(() => {
  const raw = join(tmpdir(), `dc-backlog-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  ctx = join(projectRoot, '_dream_context');
  stateDir = join(ctx, 'state');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(ctx, 'core'), { recursive: true });
});
afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

describe('registry', () => {
  it('is a second 0.33.0 entry, after the journal split, with an agent task that knows when it is needed', () => {
    const at = REGISTRY.indexOf(migration0330Backlog);
    expect(at).toBeGreaterThan(REGISTRY.indexOf(migration0330));
    expect(migration0330Backlog.version).toBe('0.33.0');
    expect(migration0330Backlog.agentTask?.id).toBe(BACKLOG_AGENT_TASK_ID);
    expect(typeof migration0330Backlog.agentTask?.needed).toBe('function');
    expect(migration0330Backlog.steps[0](ctx).step).toBe(BACKLOG_STEP_ID);
  });

  it('the brief names the model, the commands, the proposal path and the no-delete rule', () => {
    const text = migration0330Backlog.agentTask!.instruction;
    for (const needle of [
      'migrations backlog show --pending', 'migrations backlog decide', 'migrations backlog parent',
      'migrations backlog propose', 'migrations backlog report', 'never delete', 'An area is NEVER a parent',
      'a family is a feature link', '--feature <feature>', '--criterion', 'never create a feature',
      'its own `--reason`', 'hands-off', 'never put anything in a cycle',
    ]) expect(text).toContain(needle);
  });
});

describe('any brain: nothing open means nothing happens', () => {
  it('a fresh brain: the step writes nothing, the agent task is never listed', () => {
    const before = snapshotAll();
    const r = runBacklogStep(ctx);
    expect(r.detected).toBe(true);
    expect(r.filesTouched).toEqual([]);
    expect(existsSync(join(ctx, BACKLOG_MIGRATION_REL_PATH))).toBe(false);
    expect(snapshotAll()).toEqual(before);
    expect(backlogDecisionsPending(ctx)).toBe(false);

    // Even once the runner has ledgered the code step, nothing nags.
    const run = runMigrations(ctx, '0.32.0', '0.33.0');
    expect(run.pendingAgentTasks.map((p) => p.agentTask.id)).not.toContain(BACKLOG_AGENT_TASK_ID);
    expect(unfinishedAgentTasks(ctx, '0.33.0').map((m) => m.agentTask!.id)).not.toContain(BACKLOG_AGENT_TASK_ID);
  });

  it('a brain with only finished tasks and released versions: no-op', () => {
    card('done-a', { status: 'completed' });
    writeFileSync(join(ctx, 'core', 'RELEASES.json'), JSON.stringify([RELEASED], null, 2) + '\n');
    const before = snapshotAll();
    expect(runBacklogStep(ctx).detected).toBe(true);
    expect(snapshotAll()).toEqual(before);
    expect(agentTaskNeeded(migration0330Backlog, ctx)).toBe(false);
  });

  it('a brain with planning entries but no open task retires them and still asks nothing of the agent', () => {
    writeFileSync(join(ctx, 'core', 'RELEASES.json'), JSON.stringify([PLANNING_BACKLOG, RELEASED], null, 2) + '\n');
    const r = runBacklogStep(ctx);
    expect(r.retiredReleases).toEqual(['BACKLOG']);
    expect(JSON.parse(readFileSync(join(ctx, 'core', 'RELEASES.json'), 'utf-8'))).toEqual([RELEASED]);
    expect(readBacklogStore(ctx)!.retiredReleases).toEqual([PLANNING_BACKLOG]);
    expect(backlogDecisionsPending(ctx)).toBe(false);
  });
});

describe('the code step on a real-shaped brain', () => {
  it('retires planning + the active version, places every open card, links exact families, takes stock, deletes nothing', () => {
    seedBrain();
    const filesBefore = cardFiles();
    const done = readFileSync(join(stateDir, 'done-thing.md'), 'utf-8');
    const placed = readFileSync(join(stateDir, 'already-placed.md'), 'utf-8');

    const r = runBacklogStep(ctx, { now: new Date('2026-10-18T09:00:00Z') });
    expect(r.detected).toBe(false);
    expect(r.failed).toEqual([]);

    // Planning entries leave RELEASES.json, kept verbatim in the change list.
    expect(r.retiredReleases).toEqual(['v0.32.0', 'BACKLOG']);
    expect(JSON.parse(readFileSync(join(ctx, 'core', 'RELEASES.json'), 'utf-8'))).toEqual([RELEASED]);
    const store = readBacklogStore(ctx)!;
    expect(store.retiredReleases).toEqual([PLANNING_NEXT, PLANNING_BACKLOG]);
    expect(existsSync(join(stateDir, '.active-version.json'))).toBe(false);
    expect(store.retiredActiveVersion).toContain('v0.32.0');

    // Every open card has a place; BACKLOG → Later; the old active version leads Next.
    expect(fm('old-idea').queue).toBe('later');
    expect(fm('ship-the-export').queue).toBe('next');
    expect(fm('stale-polish').queue).toBe('next');
    expect(fm('ship-the-export').rank as number).toBeLessThan(fm('duplicate-of-export').rank as number);
    expect(fm('duplicate-of-export').rank as number).toBeLessThan(fm('stale-polish').rank as number);
    // Legacy fields stay readable, never stripped.
    expect(fm('old-idea').version).toBe('BACKLOG');
    expect(fm('ship-the-export').priority).toBe('high');

    // Exact family: open steps under the one open epic; the done step untouched.
    expect(fm('agents-step-2-a-run-pushes-a-message').parent_task).toBe('agents-epic-finished-end-to-end');
    expect(fm('agents-step-3-a-message-carries-a-question').parent_task).toBe('agents-epic-finished-end-to-end');
    expect(fm('agents-step-1-the-page').parent_task).toBeUndefined();
    expect(readJournal(stateDir, 'agents-step-3-a-message-carries-a-question')[0].body).toContain('placed under agents-epic-finished-end-to-end');
    // The epic's status and place now come from its children (one is in review → active).
    expect(fm('agents-epic-finished-end-to-end').status).toBe('in_progress');

    // A legacy id parent becomes the slug.
    expect(fm('legacy-child').parent_task).toBe('ship-the-export');

    // Finished and already-placed cards are untouched; no card file is gone.
    expect(readFileSync(join(stateDir, 'done-thing.md'), 'utf-8')).toBe(done);
    expect(readFileSync(join(stateDir, 'already-placed.md'), 'utf-8')).toBe(placed);
    expect(cardFiles()).toEqual(filesBefore);

    // Every open task got a record; exact families are decided by code, the rest wait.
    const open = ['ship-the-export', 'old-idea', 'stale-polish', 'agents-epic-finished-end-to-end',
      'agents-step-2-a-run-pushes-a-message', 'agents-step-3-a-message-carries-a-question',
      'already-placed', 'legacy-child', 'duplicate-of-export'];
    expect(Object.keys(store.tasks).sort()).toEqual([...open].sort());
    expect(store.tasks['agents-step-2-a-run-pushes-a-message']).toMatchObject({ outcome: 'keep', by: 'code' });
    expect(store.tasks['agents-epic-finished-end-to-end']).toMatchObject({ outcome: 'keep', by: 'code' });
    expect(store.tasks['old-idea'].outcome).toBeNull();
    // The undo record holds the before value of every change.
    expect(store.tasks['old-idea'].changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'queue', before: null, after: 'later', by: 'code' }),
    ]));
    expect(store.tasks['legacy-child'].changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'parent_task', before: 'task_ship-the', after: 'ship-the-export' }),
    ]));
    expect(store.before).toEqual({ open: 9, topLevel: 8, parents: 1, byFeature: { groups: 8, features: 0, unlinked: 8 } });
    expect(backlogReport(ctx).now).toEqual({ open: 9, topLevel: 6, parents: 2, byFeature: { groups: 6, features: 0, unlinked: 6 } });

    // The agent task is listed once the runner has ledgered the code step.
    expect(backlogDecisionsPending(ctx)).toBe(true);
    appendLedger(ctx, { version: '0.33.0', step: BACKLOG_STEP_ID, executor: 'code', timestamp: '', filesTouched: [], summary: '' });
    expect(unfinishedAgentTasks(ctx, '0.33.0').map((m) => m.agentTask!.id)).toContain(BACKLOG_AGENT_TASK_ID);
  });

  it('a second run writes nothing', () => {
    seedBrain();
    runBacklogStep(ctx, { now: new Date('2026-10-18T09:00:00Z') });
    const after = snapshotAll();
    const again = runBacklogStep(ctx, { now: new Date('2026-10-19T09:00:00Z') });
    expect(again.detected).toBe(true);
    expect(again.filesTouched).toEqual([]);
    expect(snapshotAll()).toEqual(after);
  });

  it('through the real runner (update / sleep start): both 0.33.0 steps ledgered, the agent task pending', () => {
    seedBrain();
    const run = runMigrations(ctx, '0.32.0', '0.33.0');
    expect(run.applied.map((e) => e.step)).toEqual(expect.arrayContaining([BACKLOG_STEP_ID]));
    expect(run.failedSteps).toBe(0);
    expect(run.pendingAgentTasks.map((p) => p.agentTask.id)).toContain(BACKLOG_AGENT_TASK_ID);
    expect(fm('old-idea').queue).toBe('later');
  });

  it('an unreadable change list is never overwritten, and the agent task stays visible', () => {
    seedBrain();
    writeFileSync(join(ctx, BACKLOG_MIGRATION_REL_PATH), '{ not json');
    const r = runBacklogStep(ctx);
    expect(r.notes.join(' ')).toContain('not valid JSON');
    expect(readFileSync(join(ctx, BACKLOG_MIGRATION_REL_PATH), 'utf-8')).toBe('{ not json');
    expect(existsSync(join(stateDir, '.active-version.json'))).toBe(true);
    expect(backlogDecisionsPending(ctx)).toBe(true);
  });
});

describe('decisions', () => {
  const backend = () => new LocalTaskBackend(stateDir);

  beforeEach(() => {
    seedBrain();
    runBacklogStep(ctx, { now: new Date('2026-10-18T09:00:00Z') });
  });

  it('merge cancels with absorbed_by, journals both sides, and never deletes', async () => {
    const rec = await decideTask(ctx, backend(), 'duplicate-of-export', { outcome: 'merge', into: 'ship-the-export', by: 'agent', reason: 'same export' });
    expect(rec).toMatchObject({ outcome: 'merge', into: 'ship-the-export', by: 'agent' });
    expect(fm('duplicate-of-export')).toMatchObject({ status: 'cancelled', absorbed_by: 'ship-the-export' });
    expect(existsSync(join(stateDir, 'duplicate-of-export.md'))).toBe(true);
    expect(readJournal(stateDir, 'duplicate-of-export')[0].body).toContain('merged into ship-the-export');
    expect(readJournal(stateDir, 'ship-the-export')[0].body).toContain('absorbed duplicate-of-export');
    expect(readBacklogStore(ctx)!.tasks['duplicate-of-export'].changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'status', before: 'todo', after: 'cancelled' }),
      expect.objectContaining({ field: 'absorbed_by', before: null, after: 'ship-the-export' }),
    ]));
  });

  it('cancel, keep under a parent, keep in Later', async () => {
    await decideTask(ctx, backend(), 'stale-polish', { outcome: 'cancel', by: 'agent', reason: 'shipped in 0.30.0' });
    expect(fm('stale-polish').status).toBe('cancelled');
    await decideTask(ctx, backend(), 'old-idea', { outcome: 'keep', by: 'agent', parent: 'ship-the-export' });
    expect(fm('old-idea').parent_task).toBe('ship-the-export');
    await decideTask(ctx, backend(), 'already-placed', { outcome: 'keep', by: 'agent', queue: 'later' });
    expect(readBacklogStore(ctx)!.tasks['already-placed']).toMatchObject({ outcome: 'keep', by: 'agent' });
  });

  it('refuses what would lose work or break the two levels', async () => {
    await expect(decideTask(ctx, backend(), 'agents-epic-finished-end-to-end', { outcome: 'cancel', by: 'agent', reason: 'x' }))
      .rejects.toMatchObject({ code: 'has_children' });
    await expect(decideTask(ctx, backend(), 'old-idea', { outcome: 'merge', into: 'done-thing', by: 'agent' }))
      .rejects.toMatchObject({ code: 'not_open' });
    await expect(decideTask(ctx, backend(), 'old-idea', { outcome: 'merge', into: 'old-idea', by: 'agent' }))
      .rejects.toMatchObject({ code: 'invalid' });
    await expect(decideTask(ctx, backend(), 'old-idea', { outcome: 'keep', by: 'agent', parent: 'agents-step-2-a-run-pushes-a-message' }))
      .rejects.toMatchObject({ code: 'invalid' });
    await expect(decideTask(ctx, backend(), 'done-thing', { outcome: 'keep', by: 'agent' }))
      .rejects.toMatchObject({ code: 'not_found' });
    expect(fm('old-idea').status).toBe('todo');
  });

  it('an interrupted merge is written ahead and a retry finishes it (the undo record is never behind)', async () => {
    const real = backend();
    const flaky = Object.create(real) as LocalTaskBackend;
    flaky.addJournal = async (slug, entry) => {
      // Killed right after the card was cancelled, before the outcome was recorded.
      if (slug === 'ship-the-export') throw new Error('killed mid-decision');
      return real.addJournal(slug, entry);
    };
    await expect(decideTask(ctx, flaky, 'duplicate-of-export', { outcome: 'merge', into: 'ship-the-export', by: 'agent', reason: 'same export' }))
      .rejects.toThrow('killed mid-decision');
    expect(fm('duplicate-of-export').status).toBe('cancelled');
    const mid = readBacklogStore(ctx)!.tasks['duplicate-of-export'];
    expect(mid.outcome).toBeNull();
    expect(mid.intent).toMatchObject({ outcome: 'merge', into: 'ship-the-export' });
    expect(mid.changes).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'status', before: 'todo', after: 'cancelled' })]));
    expect(backlogDecisionsPending(ctx)).toBe(true);
    // A different outcome on the cancelled card is still refused.
    await expect(decideTask(ctx, backend(), 'duplicate-of-export', { outcome: 'cancel', by: 'agent', reason: 'x' }))
      .rejects.toMatchObject({ code: 'not_open' });
    const done = await decideTask(ctx, backend(), 'duplicate-of-export', { outcome: 'merge', into: 'ship-the-export', by: 'agent', reason: 'same export' });
    expect(done).toMatchObject({ outcome: 'merge', into: 'ship-the-export' });
    expect(done.intent).toBeUndefined();
    expect(done.changes.filter((c) => c.field === 'status')).toHaveLength(1);
    expect(existsSync(join(stateDir, 'duplicate-of-export.md'))).toBe(true);
  });

  it('an interrupted merge never waits forever: its target closing or its card closing another way does not strand it', async () => {
    const real = backend();
    const killing = () => {
      const flaky = Object.create(real) as LocalTaskBackend;
      flaky.addJournal = async (slug, entry) => {
        if (slug === 'ship-the-export') throw new Error('killed mid-decision');
        return real.addJournal(slug, entry);
      };
      return flaky;
    };
    await expect(decideTask(ctx, killing(), 'duplicate-of-export', { outcome: 'merge', into: 'ship-the-export', by: 'agent', reason: 'same export' }))
      .rejects.toThrow('killed mid-decision');
    // The target closes before the retry: the landed merge is still finished.
    await real.updateFields('ship-the-export', { status: 'completed' });
    await expect(decideTask(ctx, real, 'duplicate-of-export', { outcome: 'cancel', by: 'agent', reason: 'x' }))
      .rejects.toThrow(/finish it with: dreamcontext migrations backlog decide duplicate-of-export merge --into ship-the-export/);
    const done = await decideTask(ctx, real, 'duplicate-of-export', { outcome: 'merge', into: 'ship-the-export', by: 'agent', reason: 'same export' });
    expect(done.outcome).toBe('merge');
    // A card the interruption left cancelled that someone then re-closed another way waits for nothing.
    await expect(decideTask(ctx, killing(), 'stale-polish', { outcome: 'merge', into: 'ship-the-export', by: 'agent', reason: 'x' }))
      .rejects.toMatchObject({ code: 'not_open' });
    await real.updateFields('ship-the-export', { status: 'todo' });
    await expect(decideTask(ctx, killing(), 'stale-polish', { outcome: 'merge', into: 'ship-the-export', by: 'agent', reason: 'x' }))
      .rejects.toThrow('killed mid-decision');
    await real.updateFields('stale-polish', { status: 'completed', absorbed_by: null });
    const store = readBacklogStore(ctx)!;
    expect(store.tasks['stale-polish'].intent).toBeDefined();
    expect(backlogReport(ctx).outcomes.closedMeanwhile).toBeGreaterThanOrEqual(1);
    expect(Object.values(store.tasks).filter((r) => r.intent).map((r) => r.slug)).toEqual(['stale-polish']);
    // ...and it is not listed as work: once the rest is decided, the agent task is done.
    for (const r of Object.values(readBacklogStore(ctx)!.tasks).filter((x) => x.outcome === null && x.slug !== 'stale-polish')) {
      await decideTask(ctx, real, r.slug, { outcome: 'keep', by: 'agent', reason: 'kept' }).catch(() => {});
    }
    expect(backlogDecisionsPending(ctx)).toBe(false);
  });

  it('an interrupted keep under a parent has its link on the record first, and a retry finishes the parent\'s place', async () => {
    const real = backend();
    await real.updateFields('ship-the-export', { queue: 'later' });
    const flaky = Object.create(real) as LocalTaskBackend;
    flaky.updateFields = async (slug, fields, o) => {
      if (slug === 'ship-the-export') throw new Error('killed mid-decision');
      return real.updateFields(slug, fields, o);
    };
    await expect(decideTask(ctx, flaky, 'old-idea', { outcome: 'keep', by: 'agent', parent: 'ship-the-export', reason: 'a step of the export' }))
      .rejects.toThrow('killed mid-decision');
    expect(fm('old-idea').parent_task).toBe('ship-the-export');
    expect(readBacklogStore(ctx)!.tasks['old-idea'].changes)
      .toEqual(expect.arrayContaining([expect.objectContaining({ field: 'parent_task', before: null, after: 'ship-the-export' })]));
    const done = await decideTask(ctx, backend(), 'old-idea', { outcome: 'keep', by: 'agent', parent: 'ship-the-export', reason: 'a step of the export' });
    expect(done.outcome).toBe('keep');
    expect(done.changes.filter((c) => c.field === 'parent_task')).toHaveLength(1);
    expect(fm('ship-the-export').queue).toBe('next');
  });

  it('an agent does not overrule the owner', async () => {
    await decideTask(ctx, backend(), 'old-idea', { outcome: 'keep', by: 'owner' });
    await expect(decideTask(ctx, backend(), 'old-idea', { outcome: 'cancel', by: 'agent', reason: 'x' }))
      .rejects.toMatchObject({ code: 'decided' });
    expect(fm('old-idea').status).toBe('todo');
  });

  it('a new parent for a family: created, recorded, its children under it; the top level shrinks', async () => {
    const before = backlogReport(ctx).now.topLevel;
    const out = await createFamilyParent(ctx, backend(), {
      name: 'Exports reach every format', why: 'One deliverable.', criteria: ['An export runs in every format'], children: ['old-idea', 'stale-polish'], by: 'agent',
    });
    expect(fm('old-idea').parent_task).toBe(out.slug);
    expect(fm('stale-polish').parent_task).toBe(out.slug);
    // Its place follows its children (one Next, one Later → Next).
    expect(fm(out.slug).queue).toBe('next');
    const store = readBacklogStore(ctx)!;
    expect(store.createdParents).toEqual([out.slug]);
    expect(store.tasks[out.slug]).toMatchObject({ outcome: 'keep', created: true });
    expect(backlogReport(ctx).now.topLevel).toBe(before - 1);
    await expect(createFamilyParent(ctx, backend(), { name: 'Solo', why: 'x', criteria: ['done'], children: ['duplicate-of-export'], by: 'agent' }))
      .rejects.toMatchObject({ code: 'invalid' });
    // A task that is already a parent cannot become a child.
    await expect(createFamilyParent(ctx, backend(), { name: 'Pair', why: 'x', criteria: ['done'], children: ['ship-the-export', 'duplicate-of-export'], by: 'agent' }))
      .rejects.toMatchObject({ code: 'invalid' });
  });

  it('a family is a feature link: keep --feature links both sides and records it; a parent passes it to its open steps', async () => {
    feature('exports');
    feature('agents');
    const rec = await decideTask(ctx, backend(), 'old-idea', { outcome: 'keep', by: 'agent', feature: 'exports', reason: 'an export format idea' });
    expect(fm('old-idea').related_feature).toBe('exports');
    expect(featureTasks('exports')).toEqual(['old-idea']);
    expect(rec.changes).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'related_feature', before: null, after: 'exports', by: 'agent' })]));
    // Its parent's feature reaches every open step that has none; a finished step is left alone.
    await decideTask(ctx, backend(), 'agents-epic-finished-end-to-end', { outcome: 'keep', by: 'agent', feature: 'agents', reason: 'the agents page' });
    expect(fm('agents-step-2-a-run-pushes-a-message').related_feature).toBe('agents');
    expect(fm('agents-step-3-a-message-carries-a-question').related_feature).toBe('agents');
    expect(fm('agents-step-1-the-page').related_feature).toBeUndefined();
    expect(readBacklogStore(ctx)!.tasks['agents-step-3-a-message-carries-a-question'].changes)
      .toEqual(expect.arrayContaining([expect.objectContaining({ field: 'related_feature', before: null, after: 'agents' })]));
    // A step put under a parent takes the parent's feature, and the undo record has it.
    const step = await decideTask(ctx, backend(), 'duplicate-of-export', { outcome: 'keep', by: 'agent', parent: 'agents-epic-finished-end-to-end', reason: 'a step of the agents page' });
    expect(fm('duplicate-of-export').related_feature).toBe('agents');
    expect(step.changes).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'related_feature', before: null, after: 'agents' })]));
  });

  it('an agent never moves a task off its feature; a step takes its parent\'s; a feature goes with keep only', async () => {
    feature('exports');
    feature('agents');
    card('owned-elsewhere', { feature: 'agents' });
    rmSync(join(ctx, BACKLOG_MIGRATION_REL_PATH));
    runBacklogStep(ctx, { now: new Date('2026-10-18T09:00:00Z') });
    await expect(decideTask(ctx, backend(), 'owned-elsewhere', { outcome: 'keep', by: 'agent', feature: 'exports', reason: 'x' }))
      .rejects.toMatchObject({ code: 'invalid' });
    expect(fm('owned-elsewhere').related_feature).toBe('agents');
    expect(readBacklogStore(ctx)!.tasks['owned-elsewhere'].outcome).toBeNull();
    // The owner may move it.
    await decideTask(ctx, backend(), 'owned-elsewhere', { outcome: 'keep', by: 'owner', feature: 'exports' });
    expect(fm('owned-elsewhere').related_feature).toBe('exports');
    expect(featureTasks('agents')).toEqual([]);
    // A step takes its parent's feature: the feature goes on the parent.
    await expect(decideTask(ctx, backend(), 'agents-step-3-a-message-carries-a-question', { outcome: 'keep', by: 'agent', feature: 'agents', reason: 'x' }))
      .rejects.toMatchObject({ code: 'invalid' });
    await expect(decideTask(ctx, backend(), 'old-idea', { outcome: 'merge', into: 'stale-polish', feature: 'exports', by: 'agent', reason: 'x' }))
      .rejects.toMatchObject({ code: 'invalid' });
    await expect(decideTask(ctx, backend(), 'old-idea', { outcome: 'keep', by: 'agent', feature: 'no-such-area', reason: 'x' }))
      .rejects.toMatchObject({ code: 'invalid' });
    expect(fm('old-idea').related_feature).toBeUndefined();
    expect(fm('old-idea').status).toBe('todo');
  });

  it('the report counts groups by feature, before and now: linking a family makes it one group', async () => {
    feature('exports');
    const before = backlogReport(ctx);
    // Taken at stock time, before the code step put the steps under their epic.
    expect(before.before!.byFeature).toEqual({ groups: before.before!.topLevel, features: 0, unlinked: before.before!.topLevel });
    const groups = before.now.byFeature!.groups;
    expect(groups).toBe(before.now.topLevel);
    await decideTask(ctx, backend(), 'old-idea', { outcome: 'keep', by: 'agent', feature: 'exports', reason: 'export idea' });
    await decideTask(ctx, backend(), 'duplicate-of-export', { outcome: 'keep', by: 'agent', feature: 'exports', reason: 'export work' });
    const after = backlogReport(ctx).now;
    expect(after.topLevel).toBe(before.now.topLevel);
    expect(after.byFeature).toEqual({ groups: groups - 1, features: 1, unlinked: before.now.topLevel - 2 });
  });

  it('a created parent is born a clean card: a criterion, a short name, its feature passed to its steps', async () => {
    feature('exports');
    const out = await createFamilyParent(ctx, backend(), {
      name: 'Exports reach every format', why: 'One deliverable.', criteria: ['An export runs in every format'],
      children: ['old-idea', 'stale-polish'], feature: 'exports', by: 'agent',
    });
    const file = join(stateDir, `${out.slug}.md`);
    expect(readFileSync(file, 'utf-8')).toContain('- [ ] An export runs in every format');
    expect(cardIssuesOfFile(file, loadStatuses(ctx))).toEqual([]);
    expect(fm(out.slug).related_feature).toBe('exports');
    expect(fm('old-idea').related_feature).toBe('exports');
    await expect(createFamilyParent(ctx, backend(), {
      name: 'x'.repeat(81), why: 'y', criteria: ['z'], children: ['duplicate-of-export', 'already-placed'], by: 'agent',
    })).rejects.toMatchObject({ code: 'invalid' });
    await expect(createFamilyParent(ctx, backend(), {
      name: 'No criterion', why: 'y', criteria: ['  '], children: ['duplicate-of-export', 'already-placed'], by: 'agent',
    })).rejects.toMatchObject({ code: 'invalid' });
    expect(readBacklogStore(ctx)!.createdParents).toEqual([out.slug]);
  });

  it('once every open task has an outcome the agent task is done, and the report says so', async () => {
    const pending = Object.values(readBacklogStore(ctx)!.tasks).filter((t) => t.outcome === null).map((t) => t.slug);
    for (const slug of pending) await decideTask(ctx, backend(), slug, { outcome: 'keep', by: 'agent' });
    expect(backlogDecisionsPending(ctx)).toBe(false);
    const r = backlogReport(ctx);
    expect(r.outcomes.pending).toBe(0);
    expect(r.outcomes.keep).toBe(9);
    expect(r.retiredReleases).toEqual(['v0.32.0', 'BACKLOG']);
    expect(r.activeVersionRemoved).toBe(true);
  });

  it('a task closed meanwhile no longer waits', async () => {
    await backend().updateFields('old-idea', { status: 'completed' });
    const r = backlogReport(ctx);
    expect(r.outcomes.closedMeanwhile).toBe(1);
  });
});

describe('a brain without a cancelled-kind status', () => {
  it('cannot merge or cancel, and says so', async () => {
    card('a');
    card('b');
    runBacklogStep(ctx);
    await expect(decideTask(ctx, new LocalTaskBackend(stateDir), 'a', { outcome: 'merge', into: 'b', by: 'agent' }))
      .rejects.toMatchObject({ code: 'no_cancel_status' });
    expect(fm('a').status).toBe('todo');
  });
});

describe('tasks list -g feature', () => {
  it('groups by area, the tasks with no feature last', () => {
    const rec = (slug: string, extra: Record<string, unknown> = {}) => toTaskRecord({ id: `id_${slug}`, status: 'todo', ...extra }, slug);
    const groups = groupTasks([rec('a', { related_feature: 'whiteboards' }), rec('b'), rec('c', { related_feature: 'agents' }), rec('d', { related_feature: 'agents' })], 'feature');
    expect(groups.map((g) => [g.key, g.tasks.map((t) => t.name)])).toEqual([
      ['agents', ['c', 'd']], ['whiteboards', ['a']], [NONE_KEY.feature, ['b']],
    ]);
  });
});

describe('tasks list -g parent', () => {
  it('groups each family under its parent (parent row first, legacy id refs resolved) and standalone last', () => {
    const rec = (slug: string, extra: Record<string, unknown> = {}) => toTaskRecord({ id: `id_${slug}`, status: 'todo', ...extra }, slug);
    const groups = groupTasks([
      rec('child-b', { parent_task: 'epic' }),
      rec('solo'),
      rec('epic'),
      rec('child-a', { parent_task: 'id_epic' }),
    ], 'parent');
    expect(groups.map((g) => g.key)).toEqual(['epic', NONE_KEY.parent]);
    expect(groups[0].tasks.map((t) => t.name)).toEqual(['epic', 'child-b', 'child-a']);
    expect(groups[1].tasks.map((t) => t.name)).toEqual(['solo']);
  });
});
