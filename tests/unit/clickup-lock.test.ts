import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, utimesSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ClickUpTaskBackend } from '../../src/lib/task-backend/clickup.js';
import { SyncLedger } from '../../src/lib/task-backend/sync-state.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeClickUp, type FakeClickUp } from './clickup-fake.js';

/**
 * SYNC LOCK — sync fires from several places (manual, git hooks, post-sleep,
 * dashboard); exactly one engine may run per project. Losers yield with
 * `skipped: 'locked'`; stale locks from dead processes are broken.
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

const lockPath = () => join(contextRoot, 'state', '.tasks-sync.lock');

beforeEach(() => {
  delete process.env.DREAMCONTEXT_PERSON;
  const raw = join(tmpdir(), `dc-lock-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  localClock = 1000;
  fake = makeFakeClickUp();
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('sync lock (one engine per project)', () => {
  it('a sync that finds the lock held yields with skipped=locked and does NOTHING remote', async () => {
    const backend = makeBackend();
    await backend.create({ name: 'Locked Out', variant: 'cli' });

    // Another process holds the lock (fresh timestamp).
    const ledger = new SyncLedger(contextRoot);
    expect(ledger.acquireSyncLock(localClock, 3 * 60_000)).toBe(true);

    fake.requests.length = 0;
    const report = await backend.sync('push');
    expect(report.skipped).toBe('locked');
    expect(report.created).toBe(0);
    expect(fake.requests).toHaveLength(0); // zero network — it truly yielded
    expect(report.pendingQueue).toBeGreaterThan(0); // queue intact for later

    // Holder releases → next sync proceeds normally.
    ledger.releaseSyncLock();
    const next = await backend.sync('push');
    expect(next.skipped).toBeUndefined();
    expect(next.created).toBe(1);
  });

  it('two ACTUALLY concurrent syncs: one runs, the other yields', async () => {
    const a = makeBackend();
    const b = makeBackend();
    await a.create({ name: 'Race Task', variant: 'cli' });

    // Gate A's transport so its sync is in flight while B starts.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const realFetch = fake.fetchImpl;
    let gated = false;
    (a as unknown as { deps: { adapter: ApiAdapter } }); // a uses injected adapter
    // Wrap the SHARED fake: first request waits on the gate.
    fake.fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (!gated) { gated = true; await gate; }
      return realFetch(url, init);
    }) as typeof fetch;
    const aBackend = makeBackend(); // picks up the gated transport

    const aRun = aBackend.sync('push');           // acquires the lock, blocks on gate
    await new Promise((r) => setTimeout(r, 20));  // let A reach the gate
    const bReport = await b.sync('push');         // must yield
    expect(bReport.skipped).toBe('locked');

    release();
    const aReport = await aRun;
    expect(aReport.skipped).toBeUndefined();
    expect(aReport.created).toBe(1);
    expect(existsSync(lockPath())).toBe(false); // released afterwards
  });

  it('the lock is released even when the sync errors', async () => {
    const backend = makeBackend();
    await backend.create({ name: 'Erroring', variant: 'cli' });
    fake.setFailMode({ kind: 'network' });
    const report = await backend.sync('push');
    expect(report.errors.length).toBeGreaterThan(0);
    expect(existsSync(lockPath())).toBe(false);

    fake.setFailMode(null);
    const next = await backend.sync('push');
    expect(next.skipped).toBeUndefined();
    expect(next.created).toBe(1);
  });

  it('a stale lock (dead process) is broken; a garbage lock falls back to mtime', async () => {
    const backend = makeBackend();
    await backend.create({ name: 'Stale Lock', variant: 'cli' });

    // JSON lock with an ancient timestamp → broken.
    writeFileSync(lockPath(), JSON.stringify({ pid: 1, at: localClock - 10 * 60_000 }));
    const report = await backend.sync('push');
    expect(report.skipped).toBeUndefined();
    expect(report.created).toBe(1);

    // Garbage content, old mtime → broken via the mtime fallback. The
    // fallback compares against wall-clock time, so this sub-case uses a
    // backend on the REAL clock (production configuration).
    writeFileSync(lockPath(), 'not-json');
    const old = Date.now() / 1000 - 600;
    utimesSync(lockPath(), old, old);
    const realClockAdapter = new ApiAdapter({
      baseUrl: 'https://api.clickup.com/api/v2',
      authHeaders: () => ({ Authorization: 'pk_test' }),
      fetchImpl: fake.fetchImpl,
    });
    const realClockBackend = new ClickUpTaskBackend(contextRoot, CONFIG, { adapter: realClockAdapter });
    const second = await realClockBackend.sync('push');
    expect(second.skipped).toBeUndefined();
  });
});
