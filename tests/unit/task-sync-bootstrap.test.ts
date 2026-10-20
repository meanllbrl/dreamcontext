import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ClickUpTaskBackend } from '../../src/lib/task-backend/clickup.js';
import { GitHubTaskBackend } from '../../src/lib/task-backend/github.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import { SyncLedger } from '../../src/lib/task-backend/sync-state.js';
import { hardRefreshTasks } from '../../src/lib/task-backend/hard-refresh.js';
import { BOOTSTRAP_PUSH_THRESHOLD, type SyncProgressEvent } from '../../src/lib/task-backend/types.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeClickUp, type FakeClickUp } from './clickup-fake.js';
import { makeFakeGitHub, type FakeGitHub } from './github-fake.js';

/**
 * BULK FIRST SYNC (bootstrap) — connecting a backend to a mature brain with
 * 100s of tasks must fit the rate budget and stay observable:
 *  - creates carry custom fields INLINE (no per-field POSTs, no refetch)
 *  - pre-existing changelog history stays local (no comment flood)
 *  - onProgress ticks per task; the lock heartbeat prevents concurrent
 *    stale-breaks mid-run; hard refresh rebuilds the mirror from remote.
 */

const CLICKUP_CONFIG: SetupConfig = {
  platforms: [],
  packs: [],
  multiProduct: false,
  setupVersion: '0.0.0',
  disableNativeMemory: true,
  taskBackend: 'clickup',
  cloudTaskManagement: true,
  clickup: { teamId: 'team1', spaceId: 'space1', listId: 'list1', changelogTarget: 'comments' },
};

const GITHUB_CONFIG: SetupConfig = {
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
let localClock: number;

beforeEach(() => {
  delete process.env.DREAMCONTEXT_PERSON;
  const raw = join(tmpdir(), `dc-boot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  localClock = 1000;
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function makeClickUpBackend(fake: FakeClickUp, fetchImpl?: typeof fetch): ClickUpTaskBackend {
  const now = () => (localClock += 7);
  const sleep = async () => { localClock += 1; };
  const adapter = new ApiAdapter({
    baseUrl: 'https://api.clickup.com/api/v2',
    authHeaders: () => ({ Authorization: 'pk_test' }),
    fetchImpl: fetchImpl ?? fake.fetchImpl,
    now,
    sleep,
  });
  return new ClickUpTaskBackend(contextRoot, CLICKUP_CONFIG, { adapter, now, sleep });
}

function makeGitHubBackend(fake: FakeGitHub): GitHubTaskBackend {
  const now = () => (localClock += 7);
  const sleep = async () => { localClock += 1; };
  const adapter = new ApiAdapter({
    baseUrl: 'https://api.github.com',
    authHeaders: () => ({ Authorization: 'Bearer ghp_test' }),
    fetchImpl: fake.fetchImpl,
    now,
    sleep,
  });
  return new GitHubTaskBackend(contextRoot, GITHUB_CONFIG, { adapter, now, sleep });
}

async function createMany(backend: ClickUpTaskBackend | GitHubTaskBackend, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await backend.create({
      name: `Bulk Task ${String(i).padStart(3, '0')}`,
      urgency: 'high',
      description: `summary ${i}`,
      variant: 'cli',
    });
  }
}

describe('bulk first sync (ClickUp)', () => {
  it(`≥${BOOTSTRAP_PUSH_THRESHOLD} never-synced tasks: creates carry custom_fields inline, NO per-field POSTs, NO refetch GET, NO comment backfill`, async () => {
    const fake = makeFakeClickUp();
    const backend = makeClickUpBackend(fake);
    await createMany(backend, BOOTSTRAP_PUSH_THRESHOLD);

    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(report.created).toBe(BOOTSTRAP_PUSH_THRESHOLD);
    expect(report.warnings.some((w) => w.includes('bulk first sync'))).toBe(true);

    const creates = fake.requests.filter((r) => r.method === 'POST' && /^\/list\/list1\/task$/.test(r.path));
    expect(creates).toHaveLength(BOOTSTRAP_PUSH_THRESHOLD);
    // Urgency + Summary bind on the fake list → both ride the create body.
    for (const c of creates) {
      const cf = (c.body as { custom_fields?: Array<{ id: string; value: unknown }> }).custom_fields ?? [];
      expect(cf.some((f) => f.id === 'fld_urgency')).toBe(true);
      expect(cf.some((f) => f.id === 'fld_summary')).toBe(true);
    }
    // Zero per-field settles, zero comment backfill, zero timestamp refetches.
    expect(fake.requests.filter((r) => r.method === 'POST' && r.path.includes('/field/'))).toHaveLength(0);
    expect(fake.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/comment'))).toHaveLength(0);
    expect(fake.requests.filter((r) => r.method === 'GET' && /^\/task\/[^/]+$/.test(r.path))).toHaveLength(0);
    expect(report.commentsAdded).toBe(0);
  });

  it('below the threshold the changelog backfill still posts comments (small syncs unchanged)', async () => {
    const fake = makeFakeClickUp();
    const backend = makeClickUpBackend(fake);
    await createMany(backend, 2);

    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    // Every fresh task carries its "Created" changelog entry → 1 comment each.
    expect(report.commentsAdded).toBe(2);
    expect(fake.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/comment'))).toHaveLength(2);
  });

  it('bootstrap keeps history local but entries written AFTER the first sync still become comments', async () => {
    const fake = makeFakeClickUp();
    const backend = makeClickUpBackend(fake);
    await createMany(backend, BOOTSTRAP_PUSH_THRESHOLD);
    await backend.sync('push');

    const slug = 'bulk-task-000';
    await backend.addChangelog(slug, '### 2099-01-01 - Update\n- post-bootstrap progress note');
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(report.commentsAdded).toBe(1);
    const comments = fake.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/comment'));
    expect(comments).toHaveLength(1);
    expect(String((comments[0].body as { comment_text: string }).comment_text)).toContain('post-bootstrap progress note');
  });

  it('a 400 on create-with-fields falls back: task still created, fields settle per-field', async () => {
    const fake = makeFakeClickUp();
    const rejectInline: typeof fetch = (async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (method === 'POST' && String(url).includes('/list/list1/task') && !String(url).includes('/field')
          && body?.custom_fields) {
        return {
          ok: false, status: 400, headers: { get: () => null },
          text: async () => JSON.stringify({ err: 'Custom field rejected' }),
        } as unknown as Response;
      }
      return fake.fetchImpl(url, init);
    }) as typeof fetch;
    const backend = makeClickUpBackend(fake, rejectInline);
    await createMany(backend, BOOTSTRAP_PUSH_THRESHOLD);

    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(report.created).toBe(BOOTSTRAP_PUSH_THRESHOLD);
    // Fallback path: every task's fields settled via the per-field endpoint.
    expect(fake.requests.filter((r) => r.method === 'POST' && r.path.includes('/field/')).length)
      .toBeGreaterThan(0);
  });

  it('onProgress ticks: phase-start with bootstrap flag, one tick per task, monotonic to total', async () => {
    const fake = makeFakeClickUp();
    const backend = makeClickUpBackend(fake);
    await createMany(backend, BOOTSTRAP_PUSH_THRESHOLD);

    const events: SyncProgressEvent[] = [];
    await backend.sync('push', { onProgress: (ev) => events.push(ev) });

    const push = events.filter((e) => e.phase === 'push');
    expect(push[0]).toMatchObject({ current: 0, total: BOOTSTRAP_PUSH_THRESHOLD, bootstrap: true });
    expect(push).toHaveLength(BOOTSTRAP_PUSH_THRESHOLD + 1);
    expect(push[push.length - 1].current).toBe(BOOTSTRAP_PUSH_THRESHOLD);
    for (let i = 1; i < push.length; i++) {
      expect(push[i].current).toBe(push[i - 1].current + 1);
      expect(push[i].slug).toBeTruthy();
    }
  });
});

describe('bulk first sync (GitHub)', () => {
  it(`≥${BOOTSTRAP_PUSH_THRESHOLD} never-synced tasks: issues created, NO comment backfill, progress ticks`, async () => {
    const fake = makeFakeGitHub();
    const backend = makeGitHubBackend(fake);
    await createMany(backend, BOOTSTRAP_PUSH_THRESHOLD);

    const events: SyncProgressEvent[] = [];
    const report = await backend.sync('push', { onProgress: (ev) => events.push(ev) });
    expect(report.errors).toEqual([]);
    expect(report.created).toBe(BOOTSTRAP_PUSH_THRESHOLD);
    expect(report.commentsAdded).toBe(0);
    expect(fake.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/comments'))).toHaveLength(0);
    const push = events.filter((e) => e.phase === 'push');
    expect(push[0]).toMatchObject({ current: 0, total: BOOTSTRAP_PUSH_THRESHOLD, bootstrap: true });
    expect(push[push.length - 1].current).toBe(BOOTSTRAP_PUSH_THRESHOLD);
  });

  it('below the threshold GitHub comment backfill still runs', async () => {
    const fake = makeFakeGitHub();
    const backend = makeGitHubBackend(fake);
    await createMany(backend, 2);
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(report.commentsAdded).toBe(2);
  });
});

describe('review fixes', () => {
  it('CREATE fallback fires ONLY on 400/422 — an auth failure must not re-POST (duplicate-create risk)', async () => {
    const fake = makeFakeClickUp();
    let createAttempts = 0;
    const rejectAll: typeof fetch = (async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && /\/list\/list1\/task$/.test(String(new URL(String(url)).pathname))) {
        createAttempts++;
        return {
          ok: false, status: 403, headers: { get: () => null },
          text: async () => JSON.stringify({ err: 'no' }),
        } as unknown as Response;
      }
      return fake.fetchImpl(url, init);
    }) as typeof fetch;
    const backend = makeClickUpBackend(fake, rejectAll);
    await createMany(backend, BOOTSTRAP_PUSH_THRESHOLD);

    const report = await backend.sync('push');
    expect(report.failedPushes).toHaveLength(BOOTSTRAP_PUSH_THRESHOLD);
    // One attempt per task (403 is not retried by the adapter): a blind
    // without-fields retry would have doubled this.
    expect(createAttempts).toBe(BOOTSTRAP_PUSH_THRESHOLD);
  });

  it('mapped-but-unsnapshotted task (push died before its ledger write) never re-floods history as comments', async () => {
    const fake = makeFakeClickUp();
    const backend = makeClickUpBackend(fake);
    await backend.create({ name: 'Solo', variant: 'cli' });
    const first = await backend.sync('push');
    expect(first.commentsAdded).toBe(1); // the "Created" entry, non-bootstrap

    // Simulate the crash window: mapping survives, per-task sync entry lost.
    new SyncLedger(contextRoot).removeTaskSync('solo');
    const second = await backend.sync('push');
    expect(second.errors).toEqual([]);
    expect(second.commentsAdded).toBe(0); // history stays local — no duplicates
    expect(fake.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/comment'))).toHaveLength(1);
  });

  it('mergeReports accumulates counters across retry passes and keeps last-pass diagnostics', async () => {
    const { mergeReports } = await import('../../src/server/sync-job.js');
    const base = {
      backend: 'clickup', direction: 'both', pushed: 50, pulled: 2, created: 10, deleted: 1,
      mirrorDeleted: 0, mirrorRemapped: 0, commentsAdded: 3, conflicts: [], pendingQueue: 0,
      errors: ['pass1 err'], failedPushes: ['a', 'b'], warnings: ['w1'], reconciled: 0,
      watermark: 100, noop: false,
    };
    const retry = { ...base, pushed: 2, pulled: 0, created: 0, deleted: 0, commentsAdded: 0, errors: [], failedPushes: [], warnings: [], watermark: 200 };
    const merged = mergeReports(base as never, retry as never);
    expect(merged.pushed).toBe(52);
    expect(merged.created).toBe(10);
    expect(merged.commentsAdded).toBe(3);
    expect(merged.failedPushes).toEqual([]); // last pass describes current state
    expect(merged.errors).toEqual([]);
    expect(merged.watermark).toBe(200);
  });

  it('hard refresh self-heals a crashed run: stranded .partial files are restored, then backed up cleanly', async () => {
    const fake = makeFakeClickUp();
    const backend = makeClickUpBackend(fake);
    await backend.create({ name: 'Alive', variant: 'cli' });
    await backend.sync('both');

    // A previous hard refresh died mid-move: one mirror stranded in .partial.
    const stateDir = join(contextRoot, 'state');
    const partial = join(stateDir, '.hard-refresh-1999-01-01-00-00-00.partial');
    mkdirSync(partial, { recursive: true });
    renameSync(join(stateDir, 'alive.md'), join(partial, 'alive.md'));

    const result = await hardRefreshTasks(makeClickUpBackend(fake), contextRoot);
    expect(result.report.errors).toEqual([]);
    expect(result.movedMirrors).toBe(1); // restored from .partial, then backed up
    expect(existsSync(partial)).toBe(false);
    expect(readdirSync(stateDir).filter((f) => f.endsWith('.md'))).toHaveLength(1); // re-pulled
    expect(readdirSync(stateDir).filter((f) => f.endsWith('.partial'))).toHaveLength(0);
  });
});

describe('sync lock heartbeat', () => {
  it('touchSyncLock keeps a long-running sync owned; silence still goes stale', () => {
    const ledger = new SyncLedger(contextRoot);
    const STALE = 3 * 60 * 1000;
    expect(ledger.acquireSyncLock(1_000, STALE)).toBe(true);

    // 2 minutes in, the engine heartbeats. A rival arriving at minute 3:20
    // (age-since-beat 80s) must yield — before the heartbeat it would have
    // judged the ORIGINAL stamp stale and broken the lock mid-run.
    expect(ledger.touchSyncLock(120_000)).toBe(true);
    expect(ledger.acquireSyncLock(200_000, STALE)).toBe(false);

    // No further beats: once the last beat itself is older than STALE, the
    // lock is a dead process's and gets broken.
    expect(ledger.acquireSyncLock(120_000 + STALE + 1_000, STALE)).toBe(true);
  });

  it('a stalled engine may NOT stomp the rival that legitimately broke its stale lock', () => {
    const STALE = 3 * 60 * 1000;
    const original = new SyncLedger(contextRoot);
    const rival = new SyncLedger(contextRoot);
    expect(original.acquireSyncLock(1_000, STALE)).toBe(true);

    // Original stalls (laptop sleep) past STALE; the rival breaks the lock.
    expect(rival.acquireSyncLock(1_000 + STALE + 5_000, STALE)).toBe(true);

    // Original wakes up: its heartbeat must FAIL, not overwrite the rival's
    // lock — two engines on one ledger is the corruption the lock prevents.
    expect(original.touchSyncLock(1_000 + STALE + 6_000)).toBe(false);
    // …and its release must NOT delete the rival's lock either.
    original.releaseSyncLock();
    expect(rival.touchSyncLock(1_000 + STALE + 7_000)).toBe(true);
    expect(original.acquireSyncLock(1_000 + STALE + 8_000, STALE)).toBe(false); // rival still holds it
  });
});

describe('hard refresh', () => {
  it('backs mirrors up, wipes the ledger, and rebuilds everything from the remote', async () => {
    const fake = makeFakeClickUp();
    const backend = makeClickUpBackend(fake);
    await backend.create({ name: 'Alpha', variant: 'cli' });
    await backend.create({ name: 'Beta', variant: 'cli' });
    const first = await backend.sync('both');
    expect(first.errors).toEqual([]);
    expect(fake.tasks.size).toBe(2);

    // A remote-only task the wiped-and-refreshed mirror must pick up.
    fake.advanceServer(60_000);
    const reqInit = { method: 'POST', body: JSON.stringify({ name: 'Remote Gamma', description: 'born remote' }) };
    await fake.fetchImpl('https://api.clickup.com/api/v2/list/list1/task', reqInit as RequestInit);

    const events: SyncProgressEvent[] = [];
    const result = await hardRefreshTasks(makeClickUpBackend(fake), contextRoot, {
      onProgress: (ev) => events.push(ev),
    });

    expect(result.movedMirrors).toBe(2);
    expect(result.backupDir).toBeTruthy();
    expect(readdirSync(result.backupDir!).filter((f) => f.endsWith('.md'))).toHaveLength(2);
    expect(result.report.errors).toEqual([]);
    expect(result.report.pulled).toBe(3); // full re-pull — remote is the truth

    const stateDir = join(contextRoot, 'state');
    const mirrors = readdirSync(stateDir).filter((f) => f.endsWith('.md'));
    expect(mirrors).toHaveLength(3);
    expect(existsSync(join(stateDir, '.tasks-map.json'))).toBe(true); // rebuilt by the pull
    expect(events.some((e) => e.phase === 'pull' && e.total === 3)).toBe(true);
  });

  it('same-second repeat hard refresh does not collide on the backup dir', async () => {
    const fake = makeFakeClickUp();
    const backend = makeClickUpBackend(fake);
    await backend.create({ name: 'Twice', variant: 'cli' });
    await backend.sync('both');

    // Frozen clock ⇒ identical second-granularity stamps for both runs.
    const frozenNow = () => 1_700_000_000_000;
    const first = await hardRefreshTasks(makeClickUpBackend(fake), contextRoot, {}, frozenNow);
    expect(first.report.errors).toEqual([]);
    const second = await hardRefreshTasks(makeClickUpBackend(fake), contextRoot, {}, frozenNow);
    expect(second.report.errors).toEqual([]);
    expect(second.movedMirrors).toBe(1);
    expect(second.backupDir).not.toBe(first.backupDir); // uniquified, no ENOTEMPTY
    const stateDir = join(contextRoot, 'state');
    expect(readdirSync(stateDir).filter((f) => f.endsWith('.partial'))).toHaveLength(0);
    expect(readdirSync(stateDir).filter((f) => f.endsWith('.md'))).toHaveLength(1);
  });

  it('refuses to run while a sync holds the lock', async () => {
    const fake = makeFakeClickUp();
    const backend = makeClickUpBackend(fake);
    const rival = new SyncLedger(contextRoot);
    expect(rival.acquireSyncLock(Date.now(), 3 * 60 * 1000)).toBe(true);
    await expect(hardRefreshTasks(backend, contextRoot)).rejects.toThrow(/currently running/);
    rival.releaseSyncLock();
  });

  it('refuses the local backend (state/ is already the source of truth)', async () => {
    const { LocalTaskBackend } = await import('../../src/lib/task-backend/local.js');
    const local = new LocalTaskBackend(join(contextRoot, 'state'));
    await expect(hardRefreshTasks(local, contextRoot)).rejects.toThrow(/remote task backend/);
  });
});
