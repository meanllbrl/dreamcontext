import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ClickUpTaskBackend } from '../../src/lib/task-backend/clickup.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeClickUp, type FakeClickUp } from './clickup-fake.js';

/**
 * Issue #11 follow-up — local tag edits push to the remote.
 * ClickUp's PUT carries no tags, so changed tags travel through the per-tag
 * endpoints (POST/DELETE /task/:id/tag/:name), diffed against the base
 * snapshot. Local assignee changes (incl. removal) diff the same way.
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
  const raw = join(tmpdir(), `dc-cut-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function remoteTags(): string[] {
  return [...fake.tasks.values()][0].tags.map((t) => t.name).sort();
}

describe('local tag edits push to the remote (per-tag endpoints)', () => {
  it('adding a local tag on a synced task reaches ClickUp', async () => {
    await backend.create({ name: 'Tag Push', tags: ['a'], variant: 'cli' });
    await backend.sync('push');
    expect(remoteTags()).toEqual(['a']);

    await backend.updateFields('tag-push', { tags: ['a', 'urgent'], updated_at: '2026-06-11' });
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(remoteTags()).toEqual(['a', 'urgent']);
  });

  it('removing a local tag removes it remotely; version tag swaps follow too', async () => {
    await backend.create({ name: 'Tag Drop', tags: ['a', 'b'], version: 'v1', variant: 'cli' });
    await backend.sync('push');
    expect(remoteTags()).toEqual(['a', 'b', 'version:v1']);

    await backend.updateFields('tag-drop', { tags: ['a'], version: 'v2', updated_at: '2026-06-11' });
    await backend.sync('push');
    expect(remoteTags()).toEqual(['a', 'version:v2']);
  });

  it('tag pushes converge: the follow-up sync is a total no-op', async () => {
    await backend.create({ name: 'Tag Conv', tags: ['a'], variant: 'cli' });
    await backend.sync('both');
    await backend.updateFields('tag-conv', { tags: ['a', 'x'], updated_at: '2026-06-11' });
    await backend.sync('both');

    fake.requests.length = 0;
    const again = await backend.sync('both');
    expect(again.pushed).toBe(0);
    expect(again.pulled).toBe(0);
    expect(fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
  });

  it('person tags never travel as remote tags — they become assignee deltas', async () => {
    await backend.create({ name: 'Person Not Tag', tags: ['a'], variant: 'cli' });
    await backend.sync('push');

    await backend.updateFields('person-not-tag', { tags: ['a', 'person:alice-smith'], updated_at: '2026-06-11' });
    await backend.sync('push');
    expect(remoteTags()).toEqual(['a']); // no person: tag remotely
    expect([...fake.tasks.values()][0].assignees.map((a) => a.id)).toEqual([501]);
  });

  it('local assignee handover and removal push add+rem deltas', async () => {
    await backend.create({ name: 'Handover Local', tags: ['person:alice-smith'], variant: 'cli' });
    await backend.sync('push');
    expect([...fake.tasks.values()][0].assignees.map((a) => a.id)).toEqual([501]);

    // handover: alice → mehmet
    await backend.updateFields('handover-local', { tags: ['person:mehmet-nuraydin'], updated_at: '2026-06-11' });
    await backend.sync('push');
    expect([...fake.tasks.values()][0].assignees.map((a) => a.id)).toEqual([502]);

    // removal: nobody
    await backend.updateFields('handover-local', { tags: [], updated_at: '2026-06-11' });
    await backend.sync('push');
    expect([...fake.tasks.values()][0].assignees).toEqual([]);
  });
});
