import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ClickUpTaskBackend } from '../../src/lib/task-backend/clickup.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import { startDateToClickUp, startDateFromClickUp } from '../../src/lib/task-backend/clickup-map.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeClickUp, type FakeClickUp } from './clickup-fake.js';

/**
 * start_date — a NATIVE ClickUp field, the planned START of a task's date range
 * (the due_date is the END). Same epoch-ms wire shape as due_date; both ride the
 * single PUT/POST and both clear by sending null.
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
  const raw = join(tmpdir(), `dc-cus-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe('start_date sync (native ClickUp field)', () => {
  it('conversion round-trips on the same calendar day', () => {
    const ms = startDateToClickUp('2026-07-01');
    expect(ms).toBe(Date.parse('2026-07-01T12:00:00Z'));
    expect(startDateFromClickUp(String(ms))).toBe('2026-07-01');
    expect(startDateToClickUp(null)).toBeNull();
    expect(startDateFromClickUp(null)).toBeNull();
  });

  it('creating with a start+due range pushes BOTH native fields', async () => {
    await backend.create({ name: 'Sprint', start_date: '2026-07-01', due_date: '2026-07-15', variant: 'cli' });
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    const remote = [...fake.tasks.values()][0];
    expect(remote.start_date).toBe(String(Date.parse('2026-07-01T12:00:00Z')));
    expect(remote.due_date).toBe(String(Date.parse('2026-07-15T12:00:00Z')));
  });

  it('setting then clearing start_date rides the single PUT and propagates the clear', async () => {
    await backend.create({ name: 'Planner', variant: 'cli' });
    await backend.sync('push');
    const rid = [...fake.tasks.keys()][0];

    await backend.updateFields('planner', { start_date: '2026-08-01', updated_at: '2026-06-11' });
    await backend.sync('push');
    expect(fake.tasks.get(rid)!.start_date).toBe(String(Date.parse('2026-08-01T12:00:00Z')));

    await backend.updateFields('planner', { start_date: null, updated_at: '2026-06-11' });
    await backend.sync('push');
    expect(fake.tasks.get(rid)!.start_date).toBeNull();
  });

  it('a remote start-date change pulls into the mirror', async () => {
    await backend.create({ name: 'Pull Start', start_date: '2026-07-01', variant: 'cli' });
    await backend.sync('push');
    const rid = [...fake.tasks.keys()][0];

    fake.editTask(rid, { start_date: String(Date.parse('2026-09-09T12:00:00Z')) });
    await backend.sync('pull');
    expect(mirror('pull-start')).toContain("start_date: '2026-09-09'");
  });

  it('a start+due range converges (follow-up sync is a no-op)', async () => {
    await backend.create({ name: 'Range Conv', start_date: '2026-07-01', due_date: '2026-07-09', variant: 'cli' });
    await backend.sync('both');
    fake.requests.length = 0;
    const again = await backend.sync('both');
    expect(again.pushed).toBe(0);
    expect(again.pulled).toBe(0);
    expect(fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
  });
});
