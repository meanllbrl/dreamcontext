import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ClickUpTaskBackend } from '../../src/lib/task-backend/clickup.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import { statusToClickUp, statusFromClickUp, resolveStatusFromClickUp, subStatusTag } from '../../src/lib/task-backend/clickup-map.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeClickUp, type FakeClickUp } from './clickup-fake.js';
import { DEFAULT_STATUSES, type StatusDef } from '../../src/lib/task-status.js';

/**
 * Declared statuses over the ClickUp wire (task_adYgpCxk). ClickUp cannot
 * create statuses via its API, so the contract is: the declared-alias EXACT
 * match runs FIRST on pull (before the shipped table and the fuzzy fold, which
 * stay byte-identical), and an unmappable declared status produces a loud push
 * warning naming the status.
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

const DECLARED: StatusDef[] = [
  ...DEFAULT_STATUSES,
  { key: 'planned', label: 'Planned', kind: 'open', order: 5 },
  { key: 'cancelled', label: 'Cancelled', kind: 'cancelled', order: 99, clickup: ['cancelled', 'canceled', "won't do"] },
];

let projectRoot: string;
let contextRoot: string;
let fake: FakeClickUp;
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
  const raw = join(tmpdir(), `dc-cust-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state', 'x'), { recursive: true });
  mkdirSync(join(contextRoot, 'overrides'), { recursive: true });
  writeFileSync(
    join(contextRoot, 'overrides', 'task.md'),
    ['---', 'statuses:', '  - { name: Planned, key: planned, kind: open, order: 5 }', '  - { name: Cancelled, key: cancelled, kind: cancelled, order: 99, clickup: [cancelled, canceled, "won\'t do"] }', '---', ''].join('\n'),
    'utf-8',
  );
  localClock = 1000;
  fake = makeFakeClickUp();
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('statusFromClickUp — declared alias FIRST, fuzzy fold unchanged', () => {
  it('remote "Cancelled" → the declared cancelled status when declared; → completed when nothing is declared', () => {
    expect(statusFromClickUp('Cancelled', DECLARED)).toBe('cancelled');
    expect(statusFromClickUp("won't do", DECLARED)).toBe('cancelled');
    expect(statusFromClickUp('Cancelled')).toBe('completed');
    expect(statusFromClickUp('cancelled', DEFAULT_STATUSES)).toBe('completed');
  });

  it('a declared status with no aliases matches by label / spaced key', () => {
    expect(statusFromClickUp('Planned', DECLARED)).toBe('planned');
    expect(statusFromClickUp('planned')).toBe('todo'); // shipped fold: nothing matches → todo
  });

  it('shipped spellings still resolve exactly as before with the declared set', () => {
    expect(statusFromClickUp('to do', DECLARED)).toBe('todo');
    expect(statusFromClickUp('in progress', DECLARED)).toBe('in_progress');
    expect(statusFromClickUp('code review', DECLARED)).toBe('in_review');
    expect(statusFromClickUp('complete', DECLARED)).toBe('completed');
    expect(statusFromClickUp('on hold', DECLARED)).toBe('todo');
  });
});

describe('statusToClickUp — declared candidates', () => {
  it('a declared alias wins when the list has it; label/spaced key next', () => {
    expect(statusToClickUp('cancelled', ['to do', 'complete', 'canceled'], DECLARED)).toBe('canceled');
    expect(statusToClickUp('planned', ['to do', 'Planned', 'complete'], DECLARED)).toBe('Planned');
  });

  it('THE PARENT FALLBACK: a list carrying none of the declared names still takes the push', () => {
    // This is what makes a declared status need NOTHING created in ClickUp: it
    // lands on its parent's status, which every list can express, and the child
    // identity rides as a `dc:<key>` tag.
    expect(statusToClickUp('cancelled', ['to do', 'in progress', 'complete'], DECLARED)).toBe('complete');
    expect(statusToClickUp('planned', ['to do', 'in progress', 'complete'], DECLARED)).toBe('to do');
    expect(subStatusTag('cancelled', DECLARED)).toBe('dc:cancelled');
    expect(subStatusTag('planned', DECLARED)).toBe('dc:planned');
    // A shipped status carries no tag — that is the zero-change gate.
    for (const k of ['todo', 'in_progress', 'in_review', 'completed']) {
      expect(subStatusTag(k, DECLARED)).toBeNull();
    }
    // Only a list missing the PARENT's spellings too is genuinely unmappable.
    expect(statusToClickUp('cancelled', ['weird', 'states'], DECLARED)).toBeNull();
  });

  it('the tag round-trips the child, but a human move in ClickUp beats a stale tag', () => {
    // Pushed as complete + dc:cancelled → pulls back as cancelled.
    expect(resolveStatusFromClickUp('complete', ['dc:cancelled'], DECLARED)).toBe('cancelled');
    expect(resolveStatusFromClickUp('to do', ['dc:planned'], DECLARED)).toBe('planned');
    // Someone dragged it to In Progress: the tag no longer agrees with the list
    // status, so the REMOTE wins and the stale tag is ignored.
    expect(resolveStatusFromClickUp('in progress', ['dc:cancelled'], DECLARED)).toBe('in_progress');
    // A machine without the override cannot resolve the tag — it keeps the fold.
    expect(resolveStatusFromClickUp('complete', ['dc:cancelled'])).toBe('completed');
    // No tag at all → exactly the old behaviour.
    expect(resolveStatusFromClickUp('complete', [], DECLARED)).toBe('completed');
  });

  it('shipped keys keep their historical chain first even with a declared set', () => {
    expect(statusToClickUp('in_review', ['to do', 'planning', 'in progress', 'complete'], DECLARED)).toBe('in progress');
    expect(statusToClickUp('todo', ['open', 'todo'], DECLARED)).toBe('open');
    expect(statusToClickUp('todo', ['open', 'todo'])).toBe('open');
  });
});

describe('backend push with a declared status the list lacks', () => {
  it('a list with none of the declared names still takes it — parent status + dc tag, no warning', async () => {
    fake.listStatuses = ['to do', 'in progress', 'review', 'complete'];
    const backend = makeBackend();
    await backend.create({ name: 'Never Mind', variant: 'cli' });
    await backend.sync('push');
    await backend.updateFields('never-mind', { status: 'cancelled', updated_at: '2026-09-02' });
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(report.warnings.some((w) => w.includes("status 'cancelled'"))).toBe(false);
    const remote = [...fake.tasks.values()][0];
    expect(remote.status.status).toBe('complete');
    expect(remote.tags.map((t: { name: string }) => t.name)).toContain('dc:cancelled');
  });

  it('…and it pulls back as the declared status, not as completed', async () => {
    fake.listStatuses = ['to do', 'in progress', 'review', 'complete'];
    const backend = makeBackend();
    await backend.create({ name: 'Round Trip', variant: 'cli' });
    await backend.sync('push');
    await backend.updateFields('round-trip', { status: 'cancelled', updated_at: '2026-09-02' });
    await backend.sync('push');
    const remote = [...fake.tasks.values()][0];
    fake.editTask(remote.id, { name: 'Round Trip' });
    await backend.sync('pull');
    const raw = readFileSync(join(contextRoot, 'state', 'round-trip.md'), 'utf-8');
    expect(raw).toMatch(/status:\s*"?cancelled"?/);
    // The carrier tag never leaks into the task's own tags.
    expect(raw).not.toContain('dc:cancelled');
  });

  it('uses the list status exactly when an alias matches, and pulls it back as the declared key', async () => {
    fake.listStatuses = ['to do', 'in progress', 'complete', 'Canceled'];
    const backend = makeBackend();
    await backend.create({ name: 'Dropped', variant: 'cli' });
    await backend.sync('push');
    await backend.updateFields('dropped', { status: 'cancelled', updated_at: '2026-09-02' });
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(report.warnings.some((w) => w.includes("status 'cancelled'"))).toBe(false);
    const remote = [...fake.tasks.values()][0];
    expect(remote.status.status).toBe('Canceled');
  });
});

describe('doctor pre-flight — the reinterpretation an EXISTING list would undergo', () => {
  it('a list status the declaration now binds changes what every task in it pulls down as', () => {
    // The case that bites a project already synced to a list carrying "Cancelled":
    // those tasks used to fold to `completed`; declaring a cancelled-kind status
    // rebinds the name. Desirable, but doctor must say it BEFORE the sync.
    expect(statusFromClickUp('Cancelled')).toBe('completed');
    expect(statusFromClickUp('Cancelled', DECLARED)).toBe('cancelled');
    // Everything else on a normal list is untouched by the declaration.
    for (const s of ['to do', 'in progress', 'complete', 'review']) {
      expect(statusFromClickUp(s, DECLARED)).toBe(statusFromClickUp(s));
    }
  });
});
