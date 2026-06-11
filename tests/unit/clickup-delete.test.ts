import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ClickUpTaskBackend } from '../../src/lib/task-backend/clickup.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeClickUp, type FakeClickUp } from './clickup-fake.js';

/**
 * Deletion propagation (local → remote): delete removes the mirror + ledger
 * entries immediately and queues the remote DELETE for the next sync.
 * Remote → local deletion stays out of scope (documented).
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

beforeEach(() => {
  delete process.env.DREAMCONTEXT_PERSON;
  const raw = join(tmpdir(), `dc-cudel-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe('clickup deletion propagation', () => {
  it('deleting a synced task removes mirror + ledger and deletes remotely on next sync', async () => {
    await backend.create({ name: 'Bye Bye', variant: 'cli' });
    await backend.sync('push');
    expect(fake.tasks.size).toBe(1);

    await backend.delete('bye-bye');
    expect(existsSync(join(contextRoot, 'state', 'bye-bye.md'))).toBe(false);
    const map = JSON.parse(readFileSync(join(contextRoot, 'state', '.tasks-map.json'), 'utf-8'));
    expect(map).toEqual([]);
    expect(fake.tasks.size).toBe(1); // remote untouched until sync

    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(report.deleted).toBe(1);
    expect(fake.tasks.size).toBe(0);
    expect(report.pendingQueue).toBe(0);
  });

  it('pull never resurrects a task whose deletion is pending', async () => {
    await backend.create({ name: 'No Zombie', variant: 'cli' });
    await backend.sync('push');
    const rid = [...fake.tasks.keys()][0];

    // Remote changes AFTER the local delete — without the guard, pull would
    // recreate the mirror before the delete op replays.
    await backend.delete('no-zombie');
    fake.editTask(rid, { status: { status: 'in progress' } });

    const report = await backend.sync('both'); // pull runs BEFORE push
    expect(report.errors).toEqual([]);
    expect(existsSync(join(contextRoot, 'state', 'no-zombie.md'))).toBe(false);
    expect(report.deleted).toBe(1);
    expect(fake.tasks.size).toBe(0);
  });

  it('deleting a never-synced task queues nothing remote', async () => {
    await backend.create({ name: 'Local Only', variant: 'cli' });
    await backend.delete('local-only');
    const queue = JSON.parse(readFileSync(join(contextRoot, 'state', '.tasks-queue.json'), 'utf-8'));
    expect(queue.filter((q: { kind: string }) => q.kind === 'delete')).toEqual([]);
    const report = await backend.sync('push');
    expect(report.deleted).toBe(0);
    expect(fake.tasks.size).toBe(0);
  });

  it('offline delete stays queued and replays; an already-gone remote task is a clean no-op', async () => {
    await backend.create({ name: 'Offline Del', variant: 'cli' });
    await backend.sync('push');
    const rid = [...fake.tasks.keys()][0];

    fake.setFailMode({ kind: 'network' });
    await backend.delete('offline-del');
    const failed = await backend.sync('push');
    expect(failed.pendingQueue).toBe(1);

    // Someone deletes it on ClickUp too, meanwhile we come back online.
    fake.setFailMode(null);
    fake.tasks.delete(rid);
    const replay = await backend.sync('push');
    expect(replay.errors).toEqual([]);
    expect(replay.pendingQueue).toBe(0); // 404 → dequeued, done
  });
});
