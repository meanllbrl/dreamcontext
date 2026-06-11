import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ClickUpTaskBackend } from '../../src/lib/task-backend/clickup.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import { statusToClickUp, statusFromClickUp } from '../../src/lib/task-backend/clickup-map.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeClickUp, type FakeClickUp } from './clickup-fake.js';

/**
 * Issue #11 follow-up — status mapping against the LIST's custom status set.
 * Observed live: pushing "review" to a list without that status is a 400
 * ("Status does not exist", ECODE ITEM_114). The mapper now resolves each
 * dreamcontext status against the cached list statuses via candidate chains.
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

function makeBackend(): ClickUpTaskBackend {
  const now = () => (localClock += 7);
  const sleep = async () => { localClock += 1; };
  const adapter = new ApiAdapter({
    baseUrl: 'https://api.clickup.com/api/v2',
    authHeaders: () => ({ Authorization: 'pk_test' }),
    fetchImpl: fake.fetchImpl,
    now,
    sleep,
  });
  return new ClickUpTaskBackend(contextRoot, CONFIG, { adapter, now, sleep });
}

beforeEach(() => {
  delete process.env.DREAMCONTEXT_PERSON;
  const raw = join(tmpdir(), `dc-cus-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  localClock = 1000;
  fake = makeFakeClickUp();
  backend = makeBackend();
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('status mapping against the list status set', () => {
  it('pure mapper: exact candidate, fallback candidate, and no-safe-mapping → null', () => {
    expect(statusToClickUp('in_review', ['to do', 'review', 'complete'])).toBe('review');
    // No review-like status → falls back down the chain to "in progress".
    expect(statusToClickUp('in_review', ['to do', 'planning', 'in progress', 'complete'])).toBe('in progress');
    expect(statusToClickUp('todo', ['planning', 'doing', 'done'])).toBe('planning');
    expect(statusToClickUp('completed', ['to do', 'done'])).toBe('done');
    // Nothing safe at all → null (caller omits the field, no remote 400).
    expect(statusToClickUp('in_review', ['weird', 'states'])).toBeNull();
    // Unknown availability → first preference (pre-cache behavior).
    expect(statusToClickUp('in_review')).toBe('review');
  });

  it('matches statuses typed with Turkish dotless ı ("in revıew") in both directions', () => {
    // Observed live: a status set authored on a Turkish keyboard.
    expect(statusToClickUp('in_review', ['to do', 'in progress', 'in revıew', 'complete'])).toBe('in revıew');
    expect(statusFromClickUp('in revıew')).toBe('in_review');
  });

  it('pure folding: custom remote statuses map by intent on pull', () => {
    expect(statusFromClickUp('code review')).toBe('in_review');
    expect(statusFromClickUp('in development')).toBe('in_progress');
    expect(statusFromClickUp('cancelled')).toBe('completed');
    expect(statusFromClickUp('on hold')).toBe('todo');
    expect(statusFromClickUp('at risk')).toBe('todo');
  });

  it('push to a list WITHOUT a review status folds in_review to "in progress" instead of 400-ing', async () => {
    // The live failure: list statuses had no "review".
    fake.listStatuses = ['to do', 'planning', 'in progress', 'at risk', 'update required', 'on hold', 'complete', 'cancelled'];
    await backend.create({ name: 'Review Fold', variant: 'cli' });
    await backend.sync('push');

    await backend.updateFields('review-fold', { status: 'in_review', updated_at: '2026-06-11' });
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect([...fake.tasks.values()][0].status.status).toBe('in progress');
  });

  it('push to a list WITH a review status uses it exactly', async () => {
    await backend.create({ name: 'Review Exact', variant: 'cli' });
    await backend.sync('push');
    await backend.updateFields('review-exact', { status: 'in_review', updated_at: '2026-06-11' });
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect([...fake.tasks.values()][0].status.status).toBe('review');
  });

  it('a folded status does NOT bounce back and overwrite the richer local status on pull', async () => {
    fake.listStatuses = ['to do', 'in progress', 'complete'];
    await backend.create({ name: 'No Bounce', variant: 'cli' });
    await backend.sync('push');
    await backend.updateFields('no-bounce', { status: 'in_review', updated_at: '2026-06-11' });
    await backend.sync('push'); // remote now shows "in progress" (folded)

    // A later remote bump (comment) triggers a pull of this task.
    const rid = [...fake.tasks.keys()][0];
    fake.addRemoteComment(rid, 'unrelated remote comment');
    fake.editTask(rid, {});
    const report = await backend.sync('pull');
    expect(report.errors).toEqual([]);

    const mirror = readFileSync(join(contextRoot, 'state', 'no-bounce.md'), 'utf-8');
    expect(mirror).toContain('status: in_review'); // equivalence kept the local value
  });

  it('an unmappable status is omitted from the push (remote keeps its value, no error)', async () => {
    fake.listStatuses = ['weird', 'states'];
    await backend.create({ name: 'Unmappable', variant: 'cli' });
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    // create defaulted (fake uses 'to do' when status absent) — no 400, task exists
    expect(fake.tasks.size).toBe(1);
  });

  it('the list status set is cached into the sync state on every sync', async () => {
    await backend.sync('pull');
    const state = JSON.parse(readFileSync(join(contextRoot, 'state', '.tasks-sync.json'), 'utf-8'));
    expect(state.listStatuses).toEqual(['to do', 'in progress', 'review', 'complete']);
  });
});
