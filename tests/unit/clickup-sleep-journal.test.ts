import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ClickUpTaskBackend } from '../../src/lib/task-backend/clickup.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeClickUp, type FakeClickUp, type FakeTask } from './clickup-fake.js';

/**
 * Tasks are editable from OUTSIDE (ClickUp) — so consolidation must see
 * remote-originated changes exactly like dashboard edits. Every pull that
 * applies a remote change journals it into the sleep ledger
 * (state/.sleep.json → dashboard_changes).
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
let seedN = 0;

function seedRemote(name: string, extra: Partial<Omit<FakeTask, 'id'>> = {}): FakeTask {
  fake.advanceServer(1000);
  const id = `cu_seed_${++seedN}`;
  const task: FakeTask = {
    id,
    listId: 'list1', // the list these tests sync against
    name,
    description: '## Why\n\nremote why\n',
    status: { status: 'to do' },
    priority: { id: '3' },
    tags: [],
    assignees: [],
    date_created: String(fake.serverNow()),
    date_updated: String(fake.serverNow()),
    custom_fields: fake.customFields.map((f) => ({ ...f })),
    ...extra,
  };
  fake.tasks.set(id, task);
  return task;
}

function sleepChanges(): Array<{ entity: string; action: string; target: string; field?: string; summary: string }> {
  const path = join(contextRoot, 'state', '.sleep.json');
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf-8')).dashboard_changes ?? [];
}

beforeEach(() => {
  delete process.env.DREAMCONTEXT_PERSON;
  const raw = join(tmpdir(), `dc-cuj-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  localClock = 1000;
  fake = makeFakeClickUp();
  const now = () => (localClock += 7);
  const sleep = async () => { localClock += 1; };
  const adapter = new ApiAdapter({
    baseUrl: 'https://api.clickup.com/api/v2',
    authHeaders: () => ({ Authorization: 'pk_test' }),
    fetchImpl: fake.fetchImpl,
    now,
    sleep,
  });
  backend = new ClickUpTaskBackend(contextRoot, CONFIG, { adapter, now, sleep });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('remote changes reach the sleep ledger (consolidation visibility)', () => {
  it('a task created in ClickUp journals a create entry on pull', async () => {
    seedRemote('Born Outside');
    await backend.sync('pull');

    const changes = sleepChanges();
    const create = changes.find((c) => c.action === 'create' && c.target === 'state/born-outside.md');
    expect(create).toBeTruthy();
    expect(create!.summary).toContain('Remote sync created');
  });

  it('a remote status/field change journals an update entry with the changed fields', async () => {
    await backend.create({ name: 'Watched Task', variant: 'cli' });
    await backend.sync('push');
    const before = sleepChanges().length;
    const rid = [...fake.tasks.keys()][0];

    fake.editTask(rid, { status: { status: 'in progress' }, priority: { id: '1' } });
    await backend.sync('pull');

    const changes = sleepChanges().slice(0, sleepChanges().length - before);
    const update = changes.find((c) => c.action === 'update' && c.target === 'state/watched-task.md');
    expect(update).toBeTruthy();
    expect(update!.field).toContain('status');
    expect(update!.field).toContain('priority');
    // The ledger rebuilds the summary from the net field diffs.
    expect(update!.summary).toContain('status');
    expect(update!.summary).toContain('in_progress');
  });

  it('remote comments journal a changelog change', async () => {
    await backend.create({ name: 'Commented', variant: 'cli' });
    await backend.sync('push');
    const rid = [...fake.tasks.keys()][0];

    fake.addRemoteComment(rid, 'dis yorum');
    fake.editTask(rid, {});
    await backend.sync('pull');

    const update = sleepChanges().find((c) => c.target === 'state/commented.md' && c.action === 'update');
    expect(update).toBeTruthy();
    expect(update!.field).toContain('changelog');
  });

  it('a local-win merge (remote did not really change anything) journals NOTHING', async () => {
    await backend.create({ name: 'Local Wins', variant: 'cli' });
    await backend.sync('push');
    const rid = [...fake.tasks.keys()][0];
    const before = sleepChanges().length;

    // Local edit + a remote bump that changes no values (status PUT to the
    // same value) → pull runs the merge, local wins everywhere.
    await backend.updateFields('local-wins', { status: 'in_progress', updated_at: '2026-06-11' });
    fake.editTask(rid, {}); // date_updated bump only
    await backend.sync('pull');

    expect(sleepChanges().length).toBe(before);
  });

  it('a merge conflict journals an entry pointing to the preserved copy', async () => {
    await backend.create({ name: 'Conflicted', why: 'orijinal', variant: 'cli' });
    await backend.sync('push');
    const rid = [...fake.tasks.keys()][0];

    await backend.insertSection('conflicted', 'Why', 'lokal ek', { position: 'bottom' });
    fake.editTask(rid, { description: fake.tasks.get(rid)!.description.replace('orijinal', 'uzak yeniden yazim') });
    await backend.sync('pull');

    const entry = sleepChanges().find((c) => c.target === 'state/conflicted.md' && c.summary.includes('conflict'));
    expect(entry).toBeTruthy();
    expect(entry!.summary).toContain('state/.conflicts/');
  });
});
