import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ClickUpTaskBackend } from '../../src/lib/task-backend/clickup.js';
import { GitHubTaskBackend } from '../../src/lib/task-backend/github.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeClickUp, type FakeClickUp } from './clickup-fake.js';
import { makeFakeGitHub, type FakeGitHub } from './github-fake.js';

/**
 * Pull-side fallback matching (#204 Task C): when `.tasks-map.json` loses the
 * entry for a remote task (e.g. a team-merge conflict clobber on the map),
 * pull must re-link the incoming remote task to its EXISTING local mirror by
 * exact name — never mint a fresh `-N` duplicate mirror (C1). A local task
 * whose name genuinely collides with a DIFFERENT remote task (already claimed
 * by another mapping) still falls through to `-N` creation as before — a real
 * collision must not be silently re-linked to the wrong remote id (C2). A
 * truly new remote name with no local match is unaffected (C3). Covered for
 * BOTH backends (C4). Because `sync()` runs pull BEFORE push, a freshly
 * created, never-synced local task has no map entry either — the fallback
 * must NOT re-link it to an unrelated same-named remote task, so it is only
 * accepted when the candidate has prior sync history on this machine
 * (`taskSync().base_snapshot` set); a never-synced creation has none and
 * safely falls through to `-N` creation instead (C5).
 */

interface MapEntry {
  slug: string;
  dcId: string;
  backend: string;
  remoteId: string;
}

describe('clickup pull fallback matching', () => {
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

  function mapEntries(): MapEntry[] {
    return JSON.parse(readFileSync(join(contextRoot, 'state', '.tasks-map.json'), 'utf-8'));
  }

  beforeEach(() => {
    delete process.env.DREAMCONTEXT_PERSON;
    const raw = join(tmpdir(), `dc-cupfm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  it('C1: a lost map entry re-links to the existing mirror by name — no -N duplicate', async () => {
    await backend.create({ name: 'Reconcile Me', variant: 'cli' });
    await backend.sync('push');
    expect(fake.tasks.size).toBe(1);
    expect(mapEntries()).toHaveLength(1);
    // The real-world #204 shape: the committed map is corrupted/clobbered but
    // this machine's local sync history (gitignored) survives intact — that
    // history is exactly what the re-link guard requires.
    const syncStateBefore = JSON.parse(readFileSync(join(contextRoot, 'state', '.tasks-sync.json'), 'utf-8'));
    expect(syncStateBefore.tasks['reconcile-me'].base_snapshot).toBeTruthy();

    // Simulate the #204 corruption: the committed map lost its entry (e.g. a
    // team-merge conflict clobber), while the mirror file + remote task survive.
    writeFileSync(join(contextRoot, 'state', '.tasks-map.json'), '[]\n');

    const report = await backend.sync('pull');
    expect(report.errors).toEqual([]);
    expect(existsSync(join(contextRoot, 'state', 'reconcile-me.md'))).toBe(true);
    expect(existsSync(join(contextRoot, 'state', 'reconcile-me-2.md'))).toBe(false);
    const entries = mapEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ slug: 'reconcile-me' });
  });

  it('C2: a same-name local task already claimed by a DIFFERENT remote id still gets -N (genuine collision preserved)', async () => {
    await backend.create({ name: 'Dup Name', variant: 'cli' });
    await backend.sync('push');
    const claimedRemoteId = mapEntries()[0].remoteId;

    // A second, distinct remote task shares the SAME name but a DIFFERENT id
    // — never synced before, so it has no map entry either.
    fake.tasks.set('cu_manual_dup', {
      id: 'cu_manual_dup',
      listId: 'list1',
      name: 'Dup Name',
      description: '',
      status: { status: 'to do' },
      priority: { id: '3' },
      tags: [],
      assignees: [],
      date_created: String(fake.serverNow()),
      date_updated: String(fake.serverNow()),
      custom_fields: [],
    });

    const report = await backend.sync('pull');
    expect(report.errors).toEqual([]);
    expect(existsSync(join(contextRoot, 'state', 'dup-name.md'))).toBe(true);
    expect(existsSync(join(contextRoot, 'state', 'dup-name-2.md'))).toBe(true);
    const entries = mapEntries();
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.slug === 'dup-name')?.remoteId).toBe(claimedRemoteId);
    expect(entries.find((e) => e.slug === 'dup-name-2')?.remoteId).toBe('cu_manual_dup');
  });

  it('C3: a truly new remote name with no local match still creates the base slug (no regression)', async () => {
    fake.tasks.set('cu_fresh', {
      id: 'cu_fresh',
      listId: 'list1',
      name: 'Brand New',
      description: '',
      status: { status: 'to do' },
      priority: { id: '3' },
      tags: [],
      assignees: [],
      date_created: String(fake.serverNow()),
      date_updated: String(fake.serverNow()),
      custom_fields: [],
    });

    const report = await backend.sync('pull');
    expect(report.errors).toEqual([]);
    expect(existsSync(join(contextRoot, 'state', 'brand-new.md'))).toBe(true);
    expect(mapEntries()).toHaveLength(1);
  });

  it('C5: an unmapped, NEVER-SYNCED local task must NOT be re-linked to a same-named new remote task', async () => {
    // Created locally but never pushed: no map entry AND no `.tasks-sync.json`
    // history — exactly the case the guard must reject, since `sync()` runs
    // pull before push and this task would otherwise look like an orphan.
    await backend.create({ name: 'Never Synced', variant: 'cli' });
    // Never pushed: no committed map file has been written at all yet.
    expect(existsSync(join(contextRoot, 'state', '.tasks-map.json'))).toBe(false);
    const before = readFileSync(join(contextRoot, 'state', 'never-synced.md'), 'utf-8');

    fake.tasks.set('cu_new_remote', {
      id: 'cu_new_remote',
      listId: 'list1',
      name: 'Never Synced',
      description: '',
      status: { status: 'to do' },
      priority: { id: '3' },
      tags: [],
      assignees: [],
      date_created: String(fake.serverNow()),
      date_updated: String(fake.serverNow()),
      custom_fields: [],
    });

    const report = await backend.sync('pull');
    expect(report.errors).toEqual([]);
    // A fresh -N mirror was created for the remote task; the never-synced
    // local file is untouched — no merge, no relink, no wrong-remote binding.
    expect(existsSync(join(contextRoot, 'state', 'never-synced-2.md'))).toBe(true);
    expect(readFileSync(join(contextRoot, 'state', 'never-synced.md'), 'utf-8')).toBe(before);
    const entries = mapEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ slug: 'never-synced-2', remoteId: 'cu_new_remote' });
  });
});

describe('github pull fallback matching', () => {
  const CONFIG: SetupConfig = {
    platforms: [],
    packs: [],
    multiProduct: false,
    setupVersion: '0.0.0',
    disableNativeMemory: true,
    taskBackend: 'github',
    cloudTaskManagement: true,
    github: { owner: 'meanllbrl', repo: 'dreamcontext', changelogTarget: 'comments' },
  };

  let projectRoot: string;
  let contextRoot: string;
  let fake: FakeGitHub;
  let backend: GitHubTaskBackend;
  let localClock: number;

  function mapEntries(): MapEntry[] {
    return JSON.parse(readFileSync(join(contextRoot, 'state', '.tasks-map.json'), 'utf-8'));
  }

  beforeEach(() => {
    delete process.env.DREAMCONTEXT_PERSON;
    const raw = join(tmpdir(), `dc-ghpfm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(raw, { recursive: true });
    projectRoot = realpathSync(raw);
    contextRoot = join(projectRoot, '_dream_context');
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    localClock = 1000;
    fake = makeFakeGitHub();
    const now = () => (localClock += 7);
    const sleep = async () => { localClock += 1; };
    const adapter = new ApiAdapter({
      baseUrl: 'https://api.github.com',
      authHeaders: () => ({ Authorization: 'Bearer ghp_test' }),
      fetchImpl: fake.fetchImpl,
      now,
      sleep,
    });
    backend = new GitHubTaskBackend(contextRoot, CONFIG, { adapter, now, sleep });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('C1: a lost map entry re-links to the existing mirror by name — no -N duplicate', async () => {
    await backend.create({ name: 'Reconcile Me', variant: 'cli' });
    await backend.sync('push');
    expect(fake.issues.size).toBe(1);
    expect(mapEntries()).toHaveLength(1);
    // The real-world #204 shape: the committed map is corrupted/clobbered but
    // this machine's local sync history (gitignored) survives intact — that
    // history is exactly what the re-link guard requires.
    const syncStateBefore = JSON.parse(readFileSync(join(contextRoot, 'state', '.tasks-sync.json'), 'utf-8'));
    expect(syncStateBefore.tasks['reconcile-me'].base_snapshot).toBeTruthy();

    writeFileSync(join(contextRoot, 'state', '.tasks-map.json'), '[]\n');

    const report = await backend.sync('pull');
    expect(report.errors).toEqual([]);
    expect(existsSync(join(contextRoot, 'state', 'reconcile-me.md'))).toBe(true);
    expect(existsSync(join(contextRoot, 'state', 'reconcile-me-2.md'))).toBe(false);
    const entries = mapEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ slug: 'reconcile-me' });
  });

  it('C2: a same-name local task already claimed by a DIFFERENT remote id still gets -N (genuine collision preserved)', async () => {
    await backend.create({ name: 'Dup Name', variant: 'cli' });
    await backend.sync('push');
    const claimedRemoteId = mapEntries()[0].remoteId;

    // A second, distinct remote issue shares the SAME title but a DIFFERENT
    // number — never synced before, so it has no map entry either.
    const dup = fake.seedIssue({ title: 'Dup Name' });

    const report = await backend.sync('pull');
    expect(report.errors).toEqual([]);
    expect(existsSync(join(contextRoot, 'state', 'dup-name.md'))).toBe(true);
    expect(existsSync(join(contextRoot, 'state', 'dup-name-2.md'))).toBe(true);
    const entries = mapEntries();
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.slug === 'dup-name')?.remoteId).toBe(claimedRemoteId);
    expect(entries.find((e) => e.slug === 'dup-name-2')?.remoteId).toBe(String(dup.number));
  });

  it('C3: a truly new remote name with no local match still creates the base slug (no regression)', async () => {
    fake.seedIssue({ title: 'Brand New' });

    const report = await backend.sync('pull');
    expect(report.errors).toEqual([]);
    expect(existsSync(join(contextRoot, 'state', 'brand-new.md'))).toBe(true);
    expect(mapEntries()).toHaveLength(1);
  });

  it('C5: an unmapped, NEVER-SYNCED local task must NOT be re-linked to a same-named new remote task', async () => {
    // Created locally but never pushed: no map entry AND no `.tasks-sync.json`
    // history — exactly the case the guard must reject, since `sync()` runs
    // pull before push and this task would otherwise look like an orphan.
    await backend.create({ name: 'Never Synced', variant: 'cli' });
    // Never pushed: no committed map file has been written at all yet.
    expect(existsSync(join(contextRoot, 'state', '.tasks-map.json'))).toBe(false);
    const before = readFileSync(join(contextRoot, 'state', 'never-synced.md'), 'utf-8');

    fake.seedIssue({ title: 'Never Synced' });

    const report = await backend.sync('pull');
    expect(report.errors).toEqual([]);
    // A fresh -N mirror was created for the remote issue; the never-synced
    // local file is untouched — no merge, no relink, no wrong-remote binding.
    expect(existsSync(join(contextRoot, 'state', 'never-synced-2.md'))).toBe(true);
    expect(readFileSync(join(contextRoot, 'state', 'never-synced.md'), 'utf-8')).toBe(before);
    const entries = mapEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].slug).toBe('never-synced-2');
  });
});
