import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SyncLedger, reconcileRenamedTasks } from '../../src/lib/task-backend/sync-state.js';
import { GitHubTaskBackend } from '../../src/lib/task-backend/github.js';
import { ClickUpTaskBackend } from '../../src/lib/task-backend/clickup.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeGitHub, type FakeGitHub } from './github-fake.js';
import { makeFakeClickUp, type FakeClickUp } from './clickup-fake.js';

/**
 * #77 — Task rename must NOT duplicate the remote task. Reconciliation joins
 * local↔remote on the STABLE dcId (the task's `id:` frontmatter), not the
 * name-derived slug. These tests cover the ledger surgery in isolation and the
 * end-to-end no-duplicate guarantee for BOTH remote backends.
 */

// ───────────────────────────── pure ledger primitives ──────────────────────

describe('SyncLedger rename primitives (#77)', () => {
  let contextRoot: string;

  beforeEach(() => {
    const raw = join(tmpdir(), `dc-led-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(raw, { recursive: true });
    contextRoot = realpathSync(raw);
  });

  afterEach(() => {
    rmSync(contextRoot, { recursive: true, force: true });
  });

  it('migrateSlug re-keys the map (preserving dcId/backend/remoteId), sync-state, and queue', () => {
    const ledger = new SyncLedger(contextRoot);
    ledger.recordMapping({ slug: 'old-slug', dcId: 'task_A', backend: 'github', remoteId: '7' });
    ledger.updateTaskSync('old-slug', {
      last_synced_at: 1234,
      localHash: 'h1',
      base_snapshot: { hash: 'h1', body: 'base body' },
      pendingPush: true,
    });
    ledger.enqueue({ id: 'op1', kind: 'push', slug: 'old-slug', ts: 1 });

    ledger.migrateSlug('old-slug', 'new-slug');

    // Map: same identity, new slug, no residue on the old slug.
    expect(ledger.remoteIdFor('old-slug')).toBeNull();
    expect(ledger.remoteIdFor('new-slug')).toBe('7');
    const entry = ledger.entryForDcId('task_A');
    expect(entry).toMatchObject({ slug: 'new-slug', dcId: 'task_A', backend: 'github', remoteId: '7' });
    expect(ledger.readMap()).toHaveLength(1);

    // Sync state: history carried over, old key dropped.
    expect(ledger.taskSync('old-slug')).toBeNull();
    expect(ledger.taskSync('new-slug')).toMatchObject({
      last_synced_at: 1234,
      localHash: 'h1',
      base_snapshot: { hash: 'h1', body: 'base body' },
    });

    // Queue: op re-keyed.
    expect(ledger.readQueue()).toEqual([{ id: 'op1', kind: 'push', slug: 'new-slug', ts: 1 }]);
  });

  it('migrateSlug is a no-op when the slug is unchanged or unmapped', () => {
    const ledger = new SyncLedger(contextRoot);
    ledger.recordMapping({ slug: 'keep', dcId: 'task_K', backend: 'clickup', remoteId: 'cu_1' });

    ledger.migrateSlug('keep', 'keep'); // identical
    ledger.migrateSlug('ghost', 'somewhere'); // unmapped

    expect(ledger.readMap()).toEqual([
      { slug: 'keep', dcId: 'task_K', backend: 'clickup', remoteId: 'cu_1' },
    ]);
  });

  it('reconcileRenamedTasks migrates a renamed file by dcId and reports the migration', () => {
    const ledger = new SyncLedger(contextRoot);
    ledger.recordMapping({ slug: 'calorie-foo', dcId: 'task_X', backend: 'clickup', remoteId: 'cu_9' });

    const migrations = reconcileRenamedTasks(ledger, [{ slug: 'dietpal-foo', dcId: 'task_X' }]);

    expect(migrations).toEqual([{ from: 'calorie-foo', to: 'dietpal-foo' }]);
    expect(ledger.remoteIdFor('dietpal-foo')).toBe('cu_9');
    expect(ledger.remoteIdFor('calorie-foo')).toBeNull();
  });

  it('reconcileRenamedTasks is a no-op when every mapped slug still has a file', () => {
    const ledger = new SyncLedger(contextRoot);
    ledger.recordMapping({ slug: 'a', dcId: 'task_A', backend: 'github', remoteId: '1' });
    ledger.recordMapping({ slug: 'b', dcId: 'task_B', backend: 'github', remoteId: '2' });

    const migrations = reconcileRenamedTasks(ledger, [
      { slug: 'a', dcId: 'task_A' },
      { slug: 'b', dcId: 'task_B' },
    ]);

    expect(migrations).toEqual([]);
  });

  it('reconcileRenamedTasks leaves a deleted task (stale slug, no matching live dcId) for the deletion reconciler', () => {
    const ledger = new SyncLedger(contextRoot);
    ledger.recordMapping({ slug: 'gone', dcId: 'task_G', backend: 'github', remoteId: '3' });

    const migrations = reconcileRenamedTasks(ledger, []); // file deleted entirely

    expect(migrations).toEqual([]);
    expect(ledger.remoteIdFor('gone')).toBe('3'); // untouched — not a rename
  });

  it('reconcileRenamedTasks never clobbers an existing mapping (duplicate residue left for --reconcile)', () => {
    const ledger = new SyncLedger(contextRoot);
    // Pre-existing corruption from the bug: two entries with the SAME dcId.
    ledger.recordMapping({ slug: 'old', dcId: 'task_D', backend: 'github', remoteId: '10' });
    ledger.recordMapping({ slug: 'new', dcId: 'task_D', backend: 'github', remoteId: '11' });

    // The live file lives at the new slug.
    const migrations = reconcileRenamedTasks(ledger, [{ slug: 'new', dcId: 'task_D' }]);

    expect(migrations).toEqual([]); // 'new' already mapped — do not merge/clobber
    expect(ledger.readMap()).toHaveLength(2); // residue preserved, nothing lost
  });
});

// ───────────────────────────── shared e2e helpers ──────────────────────────

/** Simulate a HAND rename (the issue's scenario): edit `name:`, move the file. */
function handRename(stateDir: string, oldSlug: string, newSlug: string, newName: string): void {
  const oldPath = join(stateDir, `${oldSlug}.md`);
  const raw = readFileSync(oldPath, 'utf-8').replace(/^name:.*$/m, `name: "${newName}"`);
  writeFileSync(join(stateDir, `${newSlug}.md`), raw, 'utf-8');
  rmSync(oldPath);
}

function mdFiles(stateDir: string): string[] {
  return readdirSync(stateDir).filter((f) => f.endsWith('.md')).sort();
}

// ───────────────────────────── GitHub end-to-end ───────────────────────────

describe('GitHub: rename never duplicates the remote issue (#77)', () => {
  const CONFIG: SetupConfig = {
    platforms: [],
    packs: [],
    multiProduct: false,
    setupVersion: '0.0.0',
    disableNativeMemory: true,
    taskBackend: 'github',
    cloudTaskManagement: true,
    github: { owner: 'meanllbrl', repo: 'dreamcontext', changelogTarget: 'comments' },
    people: ['Alice'],
  };

  let projectRoot: string;
  let contextRoot: string;
  let stateDir: string;
  let fake: FakeGitHub;
  let backend: GitHubTaskBackend;
  let localClock: number;

  function makeBackend(): GitHubTaskBackend {
    const now = () => (localClock += 7);
    const sleep = async () => { localClock += 1; };
    const adapter = new ApiAdapter({
      baseUrl: 'https://api.github.com',
      authHeaders: () => ({ Authorization: 'Bearer ghp_test' }),
      fetchImpl: fake.fetchImpl,
      now,
      sleep,
    });
    return new GitHubTaskBackend(contextRoot, CONFIG, { adapter, now, sleep });
  }

  function mapFile(): Array<{ slug: string; dcId: string; backend: string; remoteId: string }> {
    return JSON.parse(readFileSync(join(stateDir, '.tasks-map.json'), 'utf-8'));
  }

  beforeEach(() => {
    delete process.env.DREAMCONTEXT_PERSON;
    const raw = join(tmpdir(), `dc-ghr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(raw, { recursive: true });
    projectRoot = realpathSync(raw);
    contextRoot = join(projectRoot, '_dream_context');
    stateDir = join(contextRoot, 'state');
    mkdirSync(stateDir, { recursive: true });
    localClock = 1000;
    fake = makeFakeGitHub();
    backend = makeBackend();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('hand-rename → push UPDATES the same issue (no duplicate, identity preserved)', async () => {
    await backend.create({ name: 'Push One', priority: 'high', variant: 'cli' });
    await backend.sync('push');
    expect(fake.issues.size).toBe(1);
    const before = mapFile()[0];

    handRename(stateDir, 'push-one', 'renamed-task', 'Renamed Task');

    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(report.created).toBe(0); // NOT created again
    expect(report.pushed).toBe(1); // updated in place
    expect(fake.issues.size).toBe(1); // ← the bug: this used to be 2

    const issue = [...fake.issues.values()][0];
    expect(String(issue.number)).toBe(before.remoteId); // same remote object
    expect(issue.title).toBe('Renamed Task');

    const map = mapFile();
    expect(map).toHaveLength(1);
    expect(map[0]).toMatchObject({ slug: 'renamed-task', dcId: before.dcId, remoteId: before.remoteId });
    expect(report.warnings.some((w) => w.includes('renamed: push-one → renamed-task'))).toBe(true);
  });

  it('rename then sync(both) does not resurrect the old mirror', async () => {
    await backend.create({ name: 'Round Trip', variant: 'cli' });
    await backend.sync('both');

    handRename(stateDir, 'round-trip', 'round-renamed', 'Round Renamed');

    const report = await backend.sync('both');
    expect(report.errors).toEqual([]);
    expect(fake.issues.size).toBe(1);
    expect(mdFiles(stateDir)).toEqual(['round-renamed.md']); // old mirror not recreated
    expect(mapFile()).toHaveLength(1);
  });

  it('backend.rename() (the `tasks rename` path) UPDATES the same issue — no duplicate', async () => {
    await backend.create({ name: 'Owned', variant: 'cli' });
    await backend.sync('push');
    const before = mapFile()[0];

    const newSlug = await backend.rename('owned', 'Owned Renamed');
    expect(newSlug).toBe('owned-renamed');
    expect(mdFiles(stateDir)).toEqual(['owned-renamed.md']); // file moved
    expect(mapFile()[0].slug).toBe('owned-renamed'); // ledger re-keyed eagerly

    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(report.created).toBe(0);
    expect(fake.issues.size).toBe(1);
    expect([...fake.issues.values()][0].title).toBe('Owned Renamed');
    expect(mapFile()[0]).toMatchObject({ slug: 'owned-renamed', remoteId: before.remoteId });
  });

  it('backend.rename() rejects a colliding target slug and a name-only change keeps the slug', async () => {
    await backend.create({ name: 'Alpha', variant: 'cli' });
    await backend.create({ name: 'Beta', variant: 'cli' });

    await expect(backend.rename('alpha', 'Beta')).rejects.toThrow(/already exists/i);

    // Name-only tweak (slug stays 'alpha') returns the same slug, no move.
    const same = await backend.rename('alpha', 'ALPHA!');
    expect(same).toBe('alpha');
  });
});

// ───────────────────────────── ClickUp end-to-end ──────────────────────────

describe('ClickUp: rename never duplicates the remote task (#77)', () => {
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
  };

  let projectRoot: string;
  let contextRoot: string;
  let stateDir: string;
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

  function mapFile(): Array<{ slug: string; dcId: string; backend: string; remoteId: string }> {
    return JSON.parse(readFileSync(join(stateDir, '.tasks-map.json'), 'utf-8'));
  }

  beforeEach(() => {
    delete process.env.DREAMCONTEXT_PERSON;
    const raw = join(tmpdir(), `dc-cur-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(raw, { recursive: true });
    projectRoot = realpathSync(raw);
    contextRoot = join(projectRoot, '_dream_context');
    stateDir = join(contextRoot, 'state');
    mkdirSync(stateDir, { recursive: true });
    localClock = 1000;
    fake = makeFakeClickUp();
    backend = makeBackend();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('hand-rename → push UPDATES the same task (no duplicate, identity preserved)', async () => {
    await backend.create({ name: 'Push One', priority: 'high', variant: 'cli' });
    await backend.sync('push');
    expect(fake.tasks.size).toBe(1);
    const before = mapFile()[0];

    handRename(stateDir, 'push-one', 'renamed-task', 'Renamed Task');

    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(report.created).toBe(0); // NOT created again
    expect(report.pushed).toBe(1); // updated in place
    expect(fake.tasks.size).toBe(1); // ← the bug: this used to be 2

    const remote = [...fake.tasks.values()][0];
    expect(remote.id).toBe(before.remoteId); // same remote object
    expect(remote.name).toBe('Renamed Task');

    const map = mapFile();
    expect(map).toHaveLength(1);
    expect(map[0]).toMatchObject({ slug: 'renamed-task', dcId: before.dcId, remoteId: before.remoteId });
    expect(report.warnings.some((w) => w.includes('renamed: push-one → renamed-task'))).toBe(true);
  });

  it('rename then sync(both) does not resurrect the old mirror', async () => {
    await backend.create({ name: 'Round Trip', variant: 'cli' });
    await backend.sync('both');

    handRename(stateDir, 'round-trip', 'round-renamed', 'Round Renamed');

    const report = await backend.sync('both');
    expect(report.errors).toEqual([]);
    expect(fake.tasks.size).toBe(1);
    expect(mdFiles(stateDir)).toEqual(['round-renamed.md']); // old mirror not recreated
    expect(mapFile()).toHaveLength(1);
  });

  it('backend.rename() (the `tasks rename` path) UPDATES the same task — no duplicate', async () => {
    await backend.create({ name: 'Owned', variant: 'cli' });
    await backend.sync('push');
    const before = mapFile()[0];

    const newSlug = await backend.rename('owned', 'Owned Renamed');
    expect(newSlug).toBe('owned-renamed');
    expect(mdFiles(stateDir)).toEqual(['owned-renamed.md']); // file moved
    expect(mapFile()[0].slug).toBe('owned-renamed'); // ledger re-keyed eagerly

    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(report.created).toBe(0);
    expect(fake.tasks.size).toBe(1);
    expect([...fake.tasks.values()][0].name).toBe('Owned Renamed');
    expect(mapFile()[0]).toMatchObject({ slug: 'owned-renamed', remoteId: before.remoteId });
  });
});
