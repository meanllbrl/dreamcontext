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

  it('a task deleted IN CLICKUP is removed locally on sync (mirror + map + sleep journal)', async () => {
    await backend.create({ name: 'Killed Remotely', variant: 'cli' });
    await backend.sync('push');
    const rid = [...fake.tasks.keys()][0];

    fake.tasks.delete(rid); // someone deletes it on ClickUp
    const report = await backend.sync('pull');
    expect(report.errors).toEqual([]);
    expect(report.mirrorDeleted).toBe(1);
    expect(existsSync(join(contextRoot, 'state', 'killed-remotely.md'))).toBe(false);
    expect(JSON.parse(readFileSync(join(contextRoot, 'state', '.tasks-map.json'), 'utf-8'))).toEqual([]);

    const sleep = JSON.parse(readFileSync(join(contextRoot, 'state', '.sleep.json'), 'utf-8'));
    const entry = (sleep.dashboard_changes ?? []).find(
      (c: { action: string; target: string }) => c.action === 'delete' && c.target === 'state/killed-remotely.md',
    );
    expect(entry).toBeTruthy();
    expect(entry.summary).toContain('Remote sync deleted');
  });

  it('unsaved local edits are preserved to .conflicts/ when the remote task was deleted', async () => {
    await backend.create({ name: 'Edited Then Killed', why: 'kiymetli metin', variant: 'cli' });
    await backend.sync('push');
    const rid = [...fake.tasks.keys()][0];

    await backend.addChangelog('edited-then-killed', '### 2026-06-11 - Update\n- push edilmemis not');
    fake.tasks.delete(rid);

    const report = await backend.sync('pull');
    expect(report.mirrorDeleted).toBe(1);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0].reason).toBe('remote_deleted');
    const saved = readFileSync(report.conflicts[0].savedTo, 'utf-8');
    expect(saved).toContain('push edilmemis not');
    expect(saved).toContain('kiymetli metin');
    expect(existsSync(join(contextRoot, 'state', 'edited-then-killed.md'))).toBe(false);
  });

  it('the deletion sweep is throttled — and runs again once the window passes', async () => {
    await backend.create({ name: 'Throttle Probe', variant: 'cli' });
    await backend.sync('push');
    await backend.sync('pull'); // sweep #1 stamps lastReconcileAt
    const rid = [...fake.tasks.keys()][0];

    fake.tasks.delete(rid);
    const throttled = await backend.sync('pull'); // within the window → no sweep
    expect(throttled.mirrorDeleted).toBe(0);
    expect(existsSync(join(contextRoot, 'state', 'throttle-probe.md'))).toBe(true);

    // Age the throttle stamp past the window (persisted in sync state).
    const syncPath = join(contextRoot, 'state', '.tasks-sync.json');
    const state = JSON.parse(readFileSync(syncPath, 'utf-8'));
    state.lastReconcileAt = state.lastReconcileAt - 10 * 60 * 1000;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(syncPath, JSON.stringify(state, null, 2));

    const swept = await backend.sync('pull');
    expect(swept.mirrorDeleted).toBe(1);
    expect(existsSync(join(contextRoot, 'state', 'throttle-probe.md'))).toBe(false);
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
