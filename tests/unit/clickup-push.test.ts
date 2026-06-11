import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ClickUpTaskBackend } from '../../src/lib/task-backend/clickup.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeClickUp, type FakeClickUp } from './clickup-fake.js';

/**
 * Issue #11 M3 — one-way PUSH (watermark-based) against mocked HTTP.
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
  people: ['Alice'],
  peopleIdentity: { alice: { clickupMemberId: '501' } },
};

let projectRoot: string;
let contextRoot: string;
let fake: FakeClickUp;
let backend: ClickUpTaskBackend;
let localClock: number;

function makeBackend(config: SetupConfig = CONFIG): ClickUpTaskBackend {
  const now = () => (localClock += 7);
  const sleep = async () => { localClock += 1; };
  const adapter = new ApiAdapter({
    baseUrl: 'https://api.clickup.com/api/v2',
    authHeaders: () => ({ Authorization: 'pk_test' }),
    fetchImpl: fake.fetchImpl,
    now,
    sleep,
  });
  return new ClickUpTaskBackend(contextRoot, config, { adapter, now, sleep });
}

beforeEach(() => {
  delete process.env.DREAMCONTEXT_PERSON;
  const raw = join(tmpdir(), `dc-cup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  // Local clock is tiny (≈1000); the fake server clock is ≈1.9e12 — disjoint
  // ranges let tests PROVE which clock produced a watermark.
  localClock = 1000;
  fake = makeFakeClickUp();
  backend = makeBackend();
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function syncStateFile(): { watermark: number | null; tasks: Record<string, any> } {
  return JSON.parse(readFileSync(join(contextRoot, 'state', '.tasks-sync.json'), 'utf-8'));
}

function mapFile(): Array<{ slug: string; dcId: string; backend: string; remoteId: string }> {
  return JSON.parse(readFileSync(join(contextRoot, 'state', '.tasks-map.json'), 'utf-8'));
}

describe('clickup PUSH (M3, mocked transport)', () => {
  it('PUSH creates unmapped local tasks remotely and records the id-map (state/.tasks-map.json)', async () => {
    await backend.create({ name: 'Push One', priority: 'high', tags: ['a'], version: 'v1', variant: 'cli' });
    await backend.create({ name: 'Push Two', variant: 'dashboard' });

    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(report.created).toBe(2);
    expect(fake.tasks.size).toBe(2);

    const map = mapFile();
    expect(map.map((e) => e.slug).sort()).toEqual(['push-one', 'push-two']);
    for (const e of map) {
      expect(e.backend).toBe('clickup');
      expect(e.remoteId).toMatch(/^cu_/);
      expect(e.dcId).toMatch(/^task_/);
    }

    const remote = [...fake.tasks.values()].find((t) => t.name === 'Push One')!;
    expect(remote.status.status).toBe('to do');
    expect(remote.priority.id).toBe('2'); // high
    expect(remote.tags.map((t) => t.name).sort()).toEqual(['a', 'version:v1']);
    expect(remote.description).toContain('## Why');
    expect(remote.description).not.toContain('## Changelog'); // changelog → comments
  });

  it('PUSH only sends tasks changed since last_synced_at (watermark, server time)', async () => {
    await backend.create({ name: 'Stable', variant: 'cli' });
    await backend.create({ name: 'Changing', variant: 'cli' });
    await backend.sync('push');

    fake.requests.length = 0;
    await backend.updateFields('changing', { status: 'in_progress', updated_at: '2026-06-11' });
    const report = await backend.sync('push');

    expect(report.errors).toEqual([]);
    expect(report.pushed).toBe(1);
    expect(report.created).toBe(0);
    const writes = fake.requests.filter((r) => r.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe('PUT');
    expect(writes[0].path).toBe(`/task/${mapFile().find((e) => e.slug === 'changing')!.remoteId}`);
  });

  it('PUSH uses ONE field-level PUT per task even after many local edits', async () => {
    await backend.create({ name: 'Many Edits', variant: 'cli' });
    await backend.sync('push');

    await backend.updateFields('many-edits', { status: 'in_progress', updated_at: '2026-06-11' });
    await backend.updateFields('many-edits', { priority: 'critical', updated_at: '2026-06-11' });
    await backend.insertSection('many-edits', 'Notes', 'note', { position: 'bottom' });

    fake.requests.length = 0;
    await backend.sync('push');
    const puts = fake.requests.filter((r) => r.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0].body).toMatchObject({ status: 'in progress', priority: 1 });
  });

  it('changelog entries push as ClickUp comments', async () => {
    await backend.create({ name: 'Logged', variant: 'cli' });
    await backend.addChangelog('logged', '### 2026-06-11 - Session Update\n- did a thing');
    await backend.addChangelog('logged', '### 2026-06-11 - Session Update\n- did another');

    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    const remoteId = mapFile()[0].remoteId;
    const comments = fake.comments.get(remoteId) ?? [];
    // 3 = the template "Created" entry + the two log entries
    expect(comments).toHaveLength(3);
    expect(report.commentsAdded).toBe(3);
    expect(comments.some((c) => c.comment_text.includes('did a thing'))).toBe(true);
    expect(comments.some((c) => c.comment_text.includes('did another'))).toBe(true);
  });

  it('PUSH re-run is idempotent: no duplicate tasks, no duplicate comments, zero write requests', async () => {
    await backend.create({ name: 'Idem', variant: 'cli' });
    await backend.addChangelog('idem', '### 2026-06-11 - Update\n- once only');
    await backend.sync('push');

    const taskCount = fake.tasks.size;
    const commentCount = [...fake.comments.values()].flat().length;
    fake.requests.length = 0;

    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(report.created).toBe(0);
    expect(report.pushed).toBe(0);
    expect(report.commentsAdded).toBe(0);
    expect(fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
    expect(fake.tasks.size).toBe(taskCount);
    expect([...fake.comments.values()].flat()).toHaveLength(commentCount);
  });

  it('watermarks use ClickUp server time (date_updated), never the local clock', async () => {
    await backend.create({ name: 'Clock Proof', variant: 'cli' });
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);

    const state = syncStateFile();
    const entry = state.tasks['clock-proof'];
    // Server clock lives at ~1.9e12; the injected local clock stays ~1e3.
    expect(entry.last_synced_at).toBeGreaterThan(1_800_000_000_000);
    expect(state.watermark).toBeGreaterThan(1_800_000_000_000);
    expect(String(entry.last_synced_at)).toBe(
      [...fake.tasks.values()][0].date_updated,
    );
  });

  it('assignee maps to the ClickUp member id from the identity layer', async () => {
    await backend.create({ name: 'Owned', variant: 'cli' });
    await backend.updateFields('owned', { assignee: 'alice', updated_at: '2026-06-11' });
    await backend.sync('push');
    const remote = [...fake.tasks.values()][0];
    expect(remote.assignees.map((a) => a.id)).toEqual([501]);
  });

  it('created_by/updated_by are recorded on mutations (attribution)', async () => {
    await backend.create({ name: 'Attributed', variant: 'cli' });
    const task = await backend.get('attributed');
    expect(task!.raw.created_by).toBe('alice');
    expect(task!.raw.updated_by).toBe('alice');
  });

  it('offline (network down): mutations enqueue, sync reports errors, queue replays on reconnect', async () => {
    await backend.create({ name: 'Offline Born', variant: 'cli' });
    fake.setFailMode({ kind: 'network' });

    const failed = await backend.sync('push');
    expect(failed.errors.length).toBeGreaterThan(0);
    expect(failed.pendingQueue).toBeGreaterThan(0);
    expect(syncStateFile().tasks['offline-born'].pendingPush).toBe(true);
    expect(fake.tasks.size).toBe(0);

    fake.setFailMode(null);
    const replayed = await backend.sync('push');
    expect(replayed.errors).toEqual([]);
    expect(replayed.created).toBe(1);
    expect(replayed.pendingQueue).toBe(0);
    expect(fake.tasks.size).toBe(1);
    expect(syncStateFile().tasks['offline-born'].pendingPush).toBe(false);

    // And the replay is idempotent too.
    const again = await backend.sync('push');
    expect(again.created).toBe(0);
    expect(fake.tasks.size).toBe(1);
  });

  it('sync() never throws when token/list are missing — it reports', async () => {
    const noList = makeBackend({ ...CONFIG, clickup: { teamId: 't', spaceId: 's' } });
    await noList.create({ name: 'Unconfigured', variant: 'cli' });
    const report = await noList.sync('push');
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.errors[0]).toMatch(/list/i);

    // No injected adapter + no token anywhere → reported, not thrown.
    const savedToken = process.env.CLICKUP_TOKEN;
    const savedKey = process.env.CLICKUP_API_KEY;
    delete process.env.CLICKUP_TOKEN;
    delete process.env.CLICKUP_API_KEY;
    try {
      const noToken = new ClickUpTaskBackend(contextRoot, CONFIG, {});
      const tokenReport = await noToken.sync('push');
      expect(tokenReport.errors.length).toBeGreaterThan(0);
      expect(tokenReport.errors[0]).toMatch(/token/i);
    } finally {
      if (savedToken !== undefined) process.env.CLICKUP_TOKEN = savedToken;
      if (savedKey !== undefined) process.env.CLICKUP_API_KEY = savedKey;
    }
  });

  it('the WAL queue file is op-id keyed and lives at state/.tasks-queue.json', async () => {
    fake.setFailMode({ kind: 'network' });
    await backend.create({ name: 'Queued', variant: 'cli' });
    const queuePath = join(contextRoot, 'state', '.tasks-queue.json');
    expect(existsSync(queuePath)).toBe(true);
    const queue = JSON.parse(readFileSync(queuePath, 'utf-8'));
    expect(queue.length).toBeGreaterThan(0);
    expect(queue[0].id).toMatch(/^op_/);
    expect(queue[0].slug).toBe('queued');
  });
});
