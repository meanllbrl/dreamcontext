import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import matter from 'gray-matter';

import { ClickUpTaskBackend } from '../../src/lib/task-backend/clickup.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeClickUp, type FakeClickUp, type FakeTask } from './clickup-fake.js';

/**
 * A dreamcontext sub-task (`parent_task`) syncs as a real ClickUp SUBTASK of
 * its parent's task — never as a second top-level task. Mocked HTTP only.
 */

const CONFIG: SetupConfig = {
  platforms: [],
  packs: [],
  multiProduct: false,
  setupVersion: '0.0.0',
  disableNativeMemory: true,
  taskBackend: 'clickup',
  cloudTaskManagement: true,
  clickup: { teamId: 'team1', spaceId: 'space1', listId: 'list1', changelogTarget: 'comments' },
};

let projectRoot: string;
let contextRoot: string;
let fake: FakeClickUp;
let backend: ClickUpTaskBackend;
let localClock: number;
/** Requests matching this are refused with a 500 before they reach the fake. */
let refuse: ((method: string, body: Record<string, unknown> | undefined) => boolean) | null;

function makeBackend(): ClickUpTaskBackend {
  const now = () => (localClock += 7);
  const sleep = async () => { localClock += 1; };
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (refuse?.((init?.method ?? 'GET').toUpperCase(), body)) {
      return { ok: false, status: 400, headers: { get: () => null }, text: async () => '{"err":"refused"}' } as unknown as Response;
    }
    return fake.fetchImpl(url, init);
  }) as typeof fetch;
  const adapter = new ApiAdapter({
    baseUrl: 'https://api.clickup.com/api/v2',
    authHeaders: () => ({ Authorization: 'pk_test' }),
    fetchImpl,
    now,
    sleep,
  });
  return new ClickUpTaskBackend(contextRoot, CONFIG, { adapter, now, sleep });
}

beforeEach(() => {
  delete process.env.DREAMCONTEXT_PERSON;
  const raw = join(tmpdir(), `dc-cusub-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  localClock = 1000;
  refuse = null;
  fake = makeFakeClickUp();
  backend = makeBackend();
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function remoteIdOf(slug: string): string {
  const map = JSON.parse(readFileSync(join(contextRoot, 'state', '.tasks-map.json'), 'utf-8')) as Array<{ slug: string; remoteId: string }>;
  return map.find((e) => e.slug === slug)!.remoteId;
}

function parentTaskOf(slug: string): unknown {
  return matter(readFileSync(join(contextRoot, 'state', `${slug}.md`), 'utf-8')).data.parent_task;
}

async function makeParentAndChild(): Promise<void> {
  await backend.create({ name: 'Parent Job', variant: 'cli' });
  await backend.create({ name: 'Child Step', variant: 'cli', local_fields: { parent_task: 'parent-job' } });
}

describe('clickup sub-tasks', () => {
  it('push create: a sub-task is created as a ClickUp subtask of its parent, parent first', async () => {
    await makeParentAndChild();
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(report.created).toBe(2);

    const posts = fake.requests.filter((r) => r.method === 'POST' && r.path === '/list/list1/task');
    expect(posts.map((p) => (p.body as { name: string }).name)).toEqual(['Parent Job', 'Child Step']);
    const parentId = remoteIdOf('parent-job');
    expect((posts[1].body as { parent?: string }).parent).toBe(parentId);
    expect(fake.tasks.get(remoteIdOf('child-step'))!.parent).toBe(parentId);
    expect(fake.tasks.get(parentId)!.parent).toBeNull();
  });

  it('a synced subtask is read back with subtasks=true, so the next pull never deletes it', async () => {
    await makeParentAndChild();
    await backend.sync('push');
    const report = await backend.sync('both');
    expect(report.errors).toEqual([]);
    expect(report.mirrorDeleted).toBe(0);
    expect(existsSync(join(contextRoot, 'state', 'child-step.md'))).toBe(true);
    expect(parentTaskOf('child-step')).toBe('parent-job');
    const listReads = fake.requests.filter((r) => r.method === 'GET' && r.path === '/list/list1/task');
    expect(listReads.length).toBeGreaterThan(0);
  });

  it('push update: an edited subtask is updated in place, with no second parent move', async () => {
    await makeParentAndChild();
    await backend.sync('push');
    fake.requests.length = 0;

    await backend.updateFields('child-step', { status: 'in_progress', updated_at: '2026-10-28' });
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(report.pushed).toBe(1);
    expect(report.created).toBe(0);
    const puts = fake.requests.filter((r) => r.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect((puts[0].body as Record<string, unknown>).parent).toBeUndefined();
    expect(fake.tasks.get(remoteIdOf('child-step'))!.parent).toBe(remoteIdOf('parent-job'));
  });

  it('pull: a ClickUp subtask of a synced task lands as a sub-task of that task, never top-level', async () => {
    await backend.create({ name: 'Parent Job', variant: 'cli' });
    await backend.sync('push');
    const parentId = remoteIdOf('parent-job');

    fake.advanceServer(1000);
    const t: FakeTask = {
      id: 'cu_ui_1',
      listId: 'list1',
      name: 'Made In ClickUp',
      description: '',
      status: { status: 'to do' },
      priority: { id: '3' },
      tags: [],
      assignees: [],
      date_created: String(fake.serverNow()),
      date_updated: String(fake.serverNow()),
      custom_fields: [],
      parent: parentId,
    };
    fake.tasks.set(t.id, t);

    const report = await backend.sync('pull');
    expect(report.errors).toEqual([]);
    expect(parentTaskOf('made-in-clickup')).toBe('parent-job');
  });

  it('pull: a subtask moved under another task in ClickUp follows; a local re-parent waiting to push is kept', async () => {
    await backend.create({ name: 'Parent A', variant: 'cli' });
    await backend.create({ name: 'Parent B', variant: 'cli' });
    await backend.create({ name: 'Kid', variant: 'cli', local_fields: { parent_task: 'parent-a' } });
    await backend.sync('push');

    fake.editTask(remoteIdOf('kid'), { parent: remoteIdOf('parent-b') });
    await backend.sync('pull');
    expect(parentTaskOf('kid')).toBe('parent-b');

    // Local re-parent, then a remote edit to the same task before the push.
    await backend.updateFields('kid', { parent_task: 'parent-a', updated_at: '2026-10-28' });
    fake.editTask(remoteIdOf('kid'), { name: 'Kid' });
    await backend.sync('pull');
    expect(parentTaskOf('kid')).toBe('parent-a');
    await backend.sync('push');
    expect(fake.tasks.get(remoteIdOf('kid'))!.parent).toBe(remoteIdOf('parent-a'));
  });

  it('parent not yet synced: the sub-task waits instead of landing top-level, then syncs under it', async () => {
    await makeParentAndChild();
    refuse = (method, body) => method === 'POST' && body?.name === 'Parent Job';

    const first = await backend.sync('push');
    expect(first.failedPushes).toContain('parent-job');
    expect(fake.tasks.size).toBe(0); // the child was NOT created top-level
    expect(first.warnings.some((w) => w.includes('child-step') && w.includes('waits for its parent'))).toBe(true);

    refuse = null;
    const second = await backend.sync('push');
    expect(second.errors).toEqual([]);
    expect(second.created).toBe(2);
    expect(fake.tasks.get(remoteIdOf('child-step'))!.parent).toBe(remoteIdOf('parent-job'));
  });

  it('a move ClickUp refuses is reported once, not re-sent every sync, and the local link stays', async () => {
    await makeParentAndChild();
    await backend.sync('push');
    const childId = remoteIdOf('child-step');
    fake.tasks.get(childId)!.parent = null;
    const syncPath = join(contextRoot, 'state', '.tasks-sync.json');
    const state = JSON.parse(readFileSync(syncPath, 'utf-8'));
    delete state.tasks['child-step'].remote_parent;
    writeFileSync(syncPath, JSON.stringify(state, null, 2));

    refuse = (method, body) => method === 'PUT' && body?.parent !== undefined;
    const first = await backend.sync('push');
    expect(first.warnings.some((w) => w.includes('child-step') && w.includes('not retried until its parent changes'))).toBe(true);
    fake.requests.length = 0;
    const second = await backend.sync('push');
    expect(second.pushed).toBe(0);
    expect(fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
    await backend.sync('pull');
    expect(parentTaskOf('child-step')).toBe('parent-job');
  });

  it('re-link: a sub-task pushed earlier as a separate task is moved under its parent, never deleted or re-created', async () => {
    await makeParentAndChild();
    await backend.sync('push');
    const childId = remoteIdOf('child-step');
    const parentId = remoteIdOf('parent-job');

    // The pre-0.36 shape: the child sits top-level on ClickUp, and the ledger
    // never recorded a remote parent.
    fake.tasks.get(childId)!.parent = null;
    const syncPath = join(contextRoot, 'state', '.tasks-sync.json');
    const state = JSON.parse(readFileSync(syncPath, 'utf-8'));
    delete state.tasks['child-step'].remote_parent;
    writeFileSync(syncPath, JSON.stringify(state, null, 2));
    fake.requests.length = 0;

    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(report.created).toBe(0);
    expect(fake.requests.some((r) => r.method === 'DELETE')).toBe(false);
    expect(fake.requests.some((r) => r.method === 'PUT' && (r.body as Record<string, unknown>).parent === parentId)).toBe(true);
    expect(fake.tasks.get(childId)!.parent).toBe(parentId);
    expect(report.warnings.some((w) => w.startsWith('relinked: child-step'))).toBe(true);

    // Settled: the next push leaves it alone.
    fake.requests.length = 0;
    const again = await backend.sync('push');
    expect(again.pushed).toBe(0);
    expect(fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
  });
});
