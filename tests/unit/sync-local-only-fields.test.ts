import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import matter from 'gray-matter';

import { GitHubTaskBackend } from '../../src/lib/task-backend/github.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import {
  preserveLocalOnlyFields,
  localOnlyFieldsFromSnapshot,
  isLocalOnlyTaskField,
  REMOTE_MAPPED_TASK_FIELDS,
} from '../../src/lib/task-backend/local-only.js';
import { SyncLedger } from '../../src/lib/task-backend/sync-state.js';
import { makeFakeGitHub, type FakeGitHub } from './github-fake.js';

/**
 * LOCAL-ONLY FIELD SURVIVAL (task: "tasks sync pull loses data silently").
 *
 * A pull may only author the fields the remote actually carries. `objectives:`
 * — and every other field with no remote representation — must come out of a
 * pull exactly as it went in, because `state/` is gitignored and a dropped
 * field has no history to restore from.
 */

const CONFIG: SetupConfig = {
  platforms: [],
  packs: [],
  multiProduct: false,
  setupVersion: '0.0.0',
  disableNativeMemory: true,
  taskBackend: 'github',
  cloudTaskManagement: true,
  github: { owner: 'meanllbrl', repo: 'dreamcontext', changelogTarget: 'comments' },
};

let projectRoot: string;
let contextRoot: string;
let fake: FakeGitHub;
let backend: GitHubTaskBackend;
let localClock: number;

function makeBackend(): GitHubTaskBackend {
  localClock = 1000;
  const now = () => (localClock += 7);
  const sleep = async () => { localClock += 1; };
  const adapter = new ApiAdapter({
    baseUrl: 'https://api.github.com',
    authHeaders: () => ({ Authorization: 'Bearer ghp_test' }),
    fetchImpl: fake.fetchImpl,
    now,
    sleep,
  });
  return new GitHubTaskBackend(contextRoot, CONFIG, { adapter, now, sleep });
}

function mirrorPath(slug: string): string {
  return join(contextRoot, 'state', `${slug}.md`);
}

function mirror(slug: string): string {
  return readFileSync(mirrorPath(slug), 'utf-8');
}

function fm(slug: string): Record<string, unknown> {
  return matter(mirror(slug)).data as Record<string, unknown>;
}

beforeEach(() => {
  delete process.env.DREAMCONTEXT_PERSON;
  const raw = join(tmpdir(), `dc-lof-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  fake = makeFakeGitHub();
  backend = makeBackend();
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('local-only field registry', () => {
  it('classifies every field the remote does NOT carry as local-only', () => {
    for (const key of ['objectives', 'rice', 'parent_task', 'related_feature', 'description', 'id', 'created_at']) {
      expect(isLocalOnlyTaskField(key)).toBe(true);
    }
    // …and a key nobody has invented yet fails SAFE (local-only, so preserved).
    expect(isLocalOnlyTaskField('some_future_field')).toBe(true);
    // The mapped set is the closed complement — these the remote owns.
    for (const key of ['name', 'status', 'priority', 'urgency', 'tags', 'version', 'start_date', 'due_date']) {
      expect(REMOTE_MAPPED_TASK_FIELDS.has(key)).toBe(true);
    }
  });

  it('preserveLocalOnlyFields restores a dropped local-only field and NAMES it', () => {
    const local = { name: 'T', objectives: ['ship-v1'], rice: { reach: 5 }, due_date: '2026-01-01' };
    const merged = { name: 'T renamed', due_date: null }; // remote cleared the due date
    const res = preserveLocalOnlyFields(local, merged);
    expect(res.rescued.sort()).toEqual(['objectives', 'rice']);
    expect(res.fm.objectives).toEqual(['ship-v1']);
    expect(res.fm.due_date).toBeNull(); // remote-owned clear is legitimate — untouched
  });

  it('preserveLocalOnlyFields leaves a field the CONTAINER binds to the remote alone', () => {
    const local = { related_feature: 'tasks', objectives: ['o'] };
    const merged = { related_feature: null, objectives: [] };
    // ClickUp with a bound "Feature" list field genuinely owns related_feature.
    const res = preserveLocalOnlyFields(local, merged, ['related_feature']);
    expect(res.rescued).toEqual(['objectives']);
    expect(res.fm.related_feature).toBeNull();
  });

  it('localOnlyFieldsFromSnapshot reads local-only fields back out of a base snapshot', () => {
    const snapshot = matter.stringify('body\n', {
      id: 'task_old', name: 'T', status: 'todo', tags: ['a'],
      objectives: ['ship-v1'], parent_task: 'parent-x', rice: { reach: 3 },
    });
    const restored = localOnlyFieldsFromSnapshot(snapshot);
    expect(restored).toEqual({ objectives: ['ship-v1'], parent_task: 'parent-x', rice: { reach: 3 } });
    expect(restored.id).toBeUndefined();   // identity is minted fresh on a rebuild
    expect(restored.name).toBeUndefined(); // remote-owned
    expect(localOnlyFieldsFromSnapshot(null)).toEqual({});
    expect(localOnlyFieldsFromSnapshot('not: [valid yaml')).toEqual({});
  });
});

describe('github pull preserves LOCAL-ONLY task fields', () => {
  /** Seed a pushed, mapped mirror carrying every local-only field class. */
  async function seedRichTask(): Promise<number> {
    await backend.create({
      name: 'Linked Task',
      objectives: ['ship-v1', 'team-ready'],
      rice: { reach: 5, impact: 3, confidence: 80, effort: 2, score: 6 },
      variant: 'cli',
    });
    await backend.updateFields('linked-task', {
      parent_task: 'umbrella-task',
      related_feature: 'task-management',
      description: 'a local description the remote never carries',
      future_field: { anything: 'at all' },
    });
    await backend.sync('push');
    return [...fake.issues.values()][0].number;
  }

  it('AC2: `objectives:` survives a pull that updates the mirror — byte for byte', async () => {
    const number = await seedRichTask();
    const before = fm('linked-task').objectives;
    expect(before).toEqual(['ship-v1', 'team-ready']);

    fake.editIssue(number, { title: 'Linked Task Renamed', body: '## Why\n\nedited on GitHub\n' });
    const report = await backend.sync('pull');

    expect(report.errors).toEqual([]);
    expect(report.pulled).toBe(1);
    expect(fm('linked-task').name).toBe('Linked Task Renamed'); // the remote DID win its own field
    expect(fm('linked-task').objectives).toEqual(before);
    // …and the raw YAML block is unchanged, not just the parsed value.
    expect(mirror('linked-task')).toContain('objectives:\n  - ship-v1\n  - team-ready');
  });

  it.each([
    ['objectives', (v: Record<string, unknown>) => v.objectives, ['ship-v1', 'team-ready']],
    ['rice', (v: Record<string, unknown>) => (v.rice as Record<string, unknown>)?.reach, 5],
    ['parent_task', (v: Record<string, unknown>) => v.parent_task, 'umbrella-task'],
    ['related_feature', (v: Record<string, unknown>) => v.related_feature, 'task-management'],
    ['description', (v: Record<string, unknown>) => v.description, 'a local description the remote never carries'],
    ['an unknown future field', (v: Record<string, unknown>) => v.future_field, { anything: 'at all' }],
  ])('AC1: %s survives a remote-edit pull', async (_label, read, expected) => {
    const number = await seedRichTask();
    fake.editIssue(number, { title: 'Renamed Remotely', labels: [{ name: 'priority:critical' }] });
    const report = await backend.sync('pull');
    expect(report.errors).toEqual([]);
    expect(read(fm('linked-task'))).toEqual(expected);
  });

  it('survives the keptLocal branch too (local AND remote changed in the same window)', async () => {
    const number = await seedRichTask();
    await backend.updateFields('linked-task', { priority: 'critical' });
    fake.editIssue(number, { title: 'Both Sides Moved' });

    const report = await backend.sync('pull');
    expect(report.errors).toEqual([]);
    expect(fm('linked-task').objectives).toEqual(['ship-v1', 'team-ready']);
    // The base snapshot is what the next push diffs against — it must carry the
    // local-only fields too, or the next merge reads them as "removed locally".
    const state = JSON.parse(readFileSync(join(contextRoot, 'state', '.tasks-sync.json'), 'utf-8'));
    expect(state.tasks['linked-task'].base_snapshot.body).toContain('ship-v1');
  });

  it('survives a missing-base (conflict) pull, where GitHub wins the prose', async () => {
    const number = await seedRichTask();
    // Wipe the ledger's base snapshot: the merge then has no base and GitHub wins.
    const statePath = join(contextRoot, 'state', '.tasks-sync.json');
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    delete state.tasks['linked-task'].base_snapshot;
    state.tasks['linked-task'].localHash = 'stale';
    writeFileSync(statePath, JSON.stringify(state, null, 2));

    fake.editIssue(number, { body: '## Why\n\nremote prose wins\n' });
    const report = await backend.sync('pull');

    expect(report.conflicts.map((c) => c.reason)).toContain('missing_base');
    expect(fm('linked-task').objectives).toEqual(['ship-v1', 'team-ready']);
  });

  it('a VANISHED mirror is rebuilt WITH its local-only fields, and says so', async () => {
    const number = await seedRichTask();
    rmSync(mirrorPath('linked-task')); // e.g. a lost state/ file or a map re-slug

    fake.editIssue(number, { title: 'Linked Task' });
    const report = await backend.sync('pull');

    expect(report.errors).toEqual([]);
    expect(existsSync(mirrorPath('linked-task'))).toBe(true);
    const rebuilt = fm('linked-task');
    expect(rebuilt.objectives).toEqual(['ship-v1', 'team-ready']);
    expect(rebuilt.parent_task).toBe('umbrella-task');
    expect(rebuilt.related_feature).toBe('task-management');
    // Loud, not silent: the report names what it had to restore.
    expect(report.warnings.some((w) => w.includes('REBUILT') && w.includes('objectives'))).toBe(true);
  });

  it('the mirror WRITE can never see a dropped local-only field (guard runs first)', async () => {
    const number = await seedRichTask();
    const proto = Object.getPrototypeOf(backend) as { renderMirror: (...a: unknown[]) => string };
    const original = proto.renderMirror;
    let sawObjectives: unknown;
    proto.renderMirror = function patched(frontmatter: unknown, ...rest: unknown[]) {
      sawObjectives = (frontmatter as Record<string, unknown>).objectives;
      return original.call(this, frontmatter, ...rest);
    } as typeof original;
    try {
      // The guard runs BEFORE the mirror is composed, so the field is already
      // restored here — the write can never see a dropped local-only field.
      fake.editIssue(number, { title: 'Regression Probe' });
      await backend.sync('pull');
    } finally {
      proto.renderMirror = original;
    }
    expect(sawObjectives).toEqual(['ship-v1', 'team-ready']);
  });
});

describe('AC4: a pull backs up the mirror it is about to overwrite', () => {
  it('keeps the pre-pull bytes under state/.pre-pull-<stamp>/', async () => {
    await backend.create({ name: 'Backed Up', objectives: ['ship-v1'], variant: 'cli' });
    await backend.sync('push');
    const before = mirror('backed-up');

    const number = [...fake.issues.values()][0].number;
    fake.editIssue(number, { title: 'Backed Up Remotely', body: '## Why\n\nremote\n' });
    await backend.sync('pull');

    const dirs = readdirSync(join(contextRoot, 'state')).filter((d) => d.startsWith('.pre-pull-'));
    expect(dirs).toHaveLength(1);
    const saved = readFileSync(join(contextRoot, 'state', dirs[0], 'backed-up.md'), 'utf-8');
    expect(saved).toBe(before);            // byte-identical pre-pull copy
    expect(mirror('backed-up')).not.toBe(before); // …of a mirror that really changed
  });

  it('the sync report NAMES the backup dir (a backup nobody is told about is not recovery)', async () => {
    await backend.create({ name: 'Told About It', variant: 'cli' });
    await backend.sync('push');
    fake.editIssue([...fake.issues.values()][0].number, { title: 'Told About It Remotely' });

    const report = await backend.sync('pull');
    expect(report.mirrorBackupDir).toContain('.pre-pull-');
    expect(existsSync(join(report.mirrorBackupDir!, 'told-about-it.md'))).toBe(true);
  });

  it('the backup dir is gitignored (state/ is derived — it must never be committed)', async () => {
    writeFileSync(join(projectRoot, '.gitignore'), '_dream_context/state/*.md\n');
    await backend.create({ name: 'Ignored', variant: 'cli' });
    await backend.sync('push');
    fake.editIssue([...fake.issues.values()][0].number, { title: 'Ignored Remotely' });
    await backend.sync('pull');

    expect(readFileSync(join(projectRoot, '.gitignore'), 'utf-8')).toContain('_dream_context/state/.pre-pull-*/');
  });

  it('a pull that changes nothing writes no backup dir', async () => {
    await backend.create({ name: 'Quiet', variant: 'cli' });
    await backend.sync('push');
    const report = await backend.sync('pull'); // echo only — nothing to overwrite

    const dirs = readdirSync(join(contextRoot, 'state')).filter((d) => d.startsWith('.pre-pull-'));
    expect(dirs).toEqual([]);
    expect(report.mirrorBackupDir).toBeNull();
  });

  it('only the newest few backup runs are kept (the dir is a safety net, not an archive)', async () => {
    await backend.create({ name: 'Churner', variant: 'cli' });
    await backend.sync('push');
    const number = [...fake.issues.values()][0].number;
    for (let i = 0; i < SyncLedger.PRE_PULL_KEEP + 3; i++) {
      fake.editIssue(number, { body: `## Why\n\nedit ${i}\n` });
      await makeBackend().sync('pull'); // a fresh engine per run = a fresh stamp
    }
    const dirs = readdirSync(join(contextRoot, 'state')).filter((d) => d.startsWith('.pre-pull-'));
    expect(dirs.length).toBeLessThanOrEqual(SyncLedger.PRE_PULL_KEEP);
    expect(dirs.length).toBeGreaterThan(1);
  });
});
