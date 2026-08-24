import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { GitHubTaskBackend } from '../../src/lib/task-backend/github.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import { SyncLedger } from '../../src/lib/task-backend/sync-state.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeGitHub, type FakeGitHub } from './github-fake.js';

/**
 * POISON-PILL WATERMARK (task: "tasks sync pull loses data silently", AC5).
 *
 * The pull applies remote items in list order — NOT time order — and advances
 * the global watermark per APPLIED item. So a task that fails to apply gets
 * silently excluded from every future delta pull the moment any other item in
 * the same batch succeeds with a newer timestamp. The pull reports success; the
 * task simply never arrives again. Same family as the #185 watermark bugs.
 */

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
let localClock: number;
/** Issue numbers whose comment fetch should fail (→ applyRemoteIssue throws). */
let poisoned: Set<number>;

function makeBackend(): GitHubTaskBackend {
  localClock = 1000;
  const now = () => (localClock += 7);
  const sleep = async () => { localClock += 1; };
  // Wrap the fake transport: a poisoned issue's comment fetch 500s, so applying
  // THAT issue throws while every other issue in the batch applies normally.
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const m = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(path);
    if (m && poisoned.has(Number(m[1]))) {
      return {
        ok: false,
        status: 500,
        headers: { get: () => null },
        text: async () => JSON.stringify({ message: 'boom' }),
      } as unknown as Response;
    }
    return fake.fetchImpl(url, init);
  }) as typeof fetch;
  const adapter = new ApiAdapter({
    baseUrl: 'https://api.github.com',
    authHeaders: () => ({ Authorization: 'Bearer ghp_test' }),
    fetchImpl,
    now,
    sleep,
    maxRetries: 0, // the failure is the point — do not spend the retry budget
  });
  return new GitHubTaskBackend(contextRoot, CONFIG, { adapter, now, sleep });
}

function watermark(): number | null {
  return JSON.parse(readFileSync(join(contextRoot, 'state', '.tasks-sync.json'), 'utf-8')).watermark;
}

function mirrorExists(slug: string): boolean {
  return existsSync(join(contextRoot, 'state', `${slug}.md`));
}

beforeEach(() => {
  delete process.env.DREAMCONTEXT_PERSON;
  const raw = join(tmpdir(), `dc-poison-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  fake = makeFakeGitHub();
  poisoned = new Set<number>();
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('AC5: the pull watermark never passes a task that failed to apply', () => {
  it('a task that throws is still returned by the NEXT delta pull (failure listed first)', async () => {
    const bad = fake.seedIssue({ title: 'Poison Pill', body: '## Why\n\nfails to apply\n' });
    const good = fake.seedIssue({ title: 'Healthy One', body: '## Why\n\napplies fine\n' });
    expect(Date.parse(good.updated_at)).toBeGreaterThan(Date.parse(bad.updated_at));

    poisoned.add(bad.number);
    const first = await makeBackend().sync('pull');

    expect(first.pulled).toBe(1);                       // only the healthy one landed
    expect(first.errors.join(' ')).toContain(`pull #${bad.number}`);
    expect(mirrorExists('healthy-one')).toBe(true);
    expect(mirrorExists('poison-pill')).toBe(false);
    // The healthy (newer) issue must NOT have carried the watermark past the
    // failed (older) one, or the failure is now invisible forever.
    expect(watermark()).toBeLessThan(Date.parse(bad.updated_at));

    // Next pull, with the transient failure gone: the poisoned task comes back.
    poisoned.clear();
    const second = await makeBackend().sync('pull');
    expect(second.errors).toEqual([]);
    expect(mirrorExists('poison-pill')).toBe(true);
  });

  it('…even when the failure is discovered AFTER a newer task already advanced it (unsorted batch)', async () => {
    // The batch is listed by issue NUMBER, so seed the newer issue first and
    // hand-date the second one older: the successful apply runs BEFORE the
    // failure, writing a watermark that then has to be pulled back down.
    const good = fake.seedIssue({ title: 'Healthy First' });
    const bad = fake.seedIssue({ title: 'Old Poison' });
    const olderIso = new Date(Date.parse(good.updated_at) - 60_000).toISOString();
    fake.issues.get(bad.number)!.updated_at = olderIso;
    fake.issues.get(bad.number)!.created_at = olderIso;

    poisoned.add(bad.number);
    const first = await makeBackend().sync('pull');

    expect(first.pulled).toBe(1);
    expect(mirrorExists('healthy-first')).toBe(true);
    expect(watermark()).toBeLessThan(Date.parse(olderIso));

    poisoned.clear();
    const second = await makeBackend().sync('pull');
    expect(second.errors).toEqual([]);
    expect(mirrorExists('old-poison')).toBe(true);
    // The already-applied issue is not re-applied as a change (echo gate).
    expect(second.pulled).toBe(1);
  });

  it('a clean batch still advances the watermark to the newest applied item', async () => {
    fake.seedIssue({ title: 'One' });
    const last = fake.seedIssue({ title: 'Two' });
    const report = await makeBackend().sync('pull');
    expect(report.errors).toEqual([]);
    expect(watermark()).toBe(Date.parse(last.updated_at));
  });
});

describe('SyncLedger watermark floor', () => {
  let root: string;
  let ledger: SyncLedger;

  beforeEach(() => {
    root = join(projectRoot, 'ledger-only');
    mkdirSync(join(root, 'state'), { recursive: true });
    ledger = new SyncLedger(root);
    ledger.beginPullBatch(0);
  });

  it('clamps a later advance below an already-noted failure', () => {
    ledger.noteUnapplied(1000);
    ledger.advanceWatermark(5000);
    expect(ledger.readSyncState().watermark).toBe(999);
  });

  it('retreats an already-written watermark when the failure comes later', () => {
    ledger.advanceWatermark(5000);
    expect(ledger.readSyncState().watermark).toBe(5000);
    ledger.noteUnapplied(1000);
    ledger.enforceUnappliedFloor();
    expect(ledger.readSyncState().watermark).toBe(999);
  });

  it('keeps the OLDEST failure as the floor, and is a no-op on a clean batch', () => {
    ledger.noteUnapplied(4000);
    ledger.noteUnapplied(2000);
    ledger.noteUnapplied(9000);
    ledger.advanceWatermark(8000);
    ledger.enforceUnappliedFloor();
    expect(ledger.readSyncState().watermark).toBe(1999);

    ledger.beginPullBatch(0); // next run starts clean
    ledger.advanceWatermark(8000);
    ledger.enforceUnappliedFloor();
    expect(ledger.readSyncState().watermark).toBe(8000);
  });

  it('never RAISES the watermark via the floor, and ignores unknown timestamps', () => {
    ledger.advanceWatermark(3000);
    ledger.noteUnapplied(null); // an item with no server time can't cap anything
    ledger.enforceUnappliedFloor();
    expect(ledger.readSyncState().watermark).toBe(3000);
  });
});
