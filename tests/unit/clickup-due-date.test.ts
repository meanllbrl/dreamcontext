import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ClickUpTaskBackend } from '../../src/lib/task-backend/clickup.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import { dueDateToClickUp, dueDateFromClickUp } from '../../src/lib/task-backend/clickup-map.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeClickUp, type FakeClickUp } from './clickup-fake.js';

/**
 * due_date — a NATIVE ClickUp field (rides the single PUT/POST, no custom
 * field needed). YYYY-MM-DD locally ↔ epoch-ms remotely (UTC noon keeps the
 * calendar day stable across timezones).
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
  const raw = join(tmpdir(), `dc-cud-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function mirror(slug: string): string {
  return readFileSync(join(contextRoot, 'state', `${slug}.md`), 'utf-8');
}

describe('due_date sync (native ClickUp field)', () => {
  it('date conversion round-trips and stays on the same calendar day', () => {
    const ms = dueDateToClickUp('2026-07-01');
    expect(ms).toBe(Date.parse('2026-07-01T12:00:00Z'));
    expect(dueDateFromClickUp(String(ms))).toBe('2026-07-01');
    expect(dueDateToClickUp(null)).toBeNull();
    expect(dueDateFromClickUp(null)).toBeNull();
    expect(dueDateToClickUp('garbage')).toBeNull();
  });

  it('a task created with due_date pushes it in the create POST', async () => {
    await backend.create({ name: 'Dated', due_date: '2026-07-15', variant: 'cli' });
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    const remote = [...fake.tasks.values()][0];
    expect(remote.due_date).toBe(String(Date.parse('2026-07-15T12:00:00Z')));
  });

  it('setting/clearing due_date on an existing task rides the single PUT', async () => {
    await backend.create({ name: 'Late Bloomer', variant: 'cli' });
    await backend.sync('push');
    const rid = [...fake.tasks.keys()][0];

    await backend.updateFields('late-bloomer', { due_date: '2026-08-01', updated_at: '2026-06-11' });
    await backend.sync('push');
    expect(fake.tasks.get(rid)!.due_date).toBe(String(Date.parse('2026-08-01T12:00:00Z')));
    const puts = fake.requests.filter((r) => r.method === 'PUT');
    expect(puts.length).toBeGreaterThan(0); // no extra endpoints — native field

    await backend.updateFields('late-bloomer', { due_date: null, updated_at: '2026-06-11' });
    await backend.sync('push');
    expect(fake.tasks.get(rid)!.due_date).toBeNull();
  });

  it('a remote due-date change pulls into the mirror; LWW handles both-changed', async () => {
    await backend.create({ name: 'Pull Due', due_date: '2026-07-01', variant: 'cli' });
    await backend.sync('push');
    const rid = [...fake.tasks.keys()][0];

    // remote moves it
    fake.editTask(rid, { due_date: String(Date.parse('2026-09-09T12:00:00Z')) });
    await backend.sync('pull');
    expect(mirror('pull-due')).toContain("due_date: '2026-09-09'");

    // both move — remote later wins
    await backend.updateFields('pull-due', { due_date: '2026-10-01', updated_at: '2026-06-11' });
    fake.editTask(rid, { due_date: String(Date.parse('2026-12-24T12:00:00Z')) });
    await backend.sync('both');
    expect(mirror('pull-due')).toContain("due_date: '2026-12-24'");
  });

  it('due-date syncs converge (follow-up sync is a no-op)', async () => {
    await backend.create({ name: 'Due Conv', due_date: '2026-07-01', variant: 'cli' });
    await backend.sync('both');
    fake.requests.length = 0;
    const again = await backend.sync('both');
    expect(again.pushed).toBe(0);
    expect(again.pulled).toBe(0);
    expect(fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
  });
});
