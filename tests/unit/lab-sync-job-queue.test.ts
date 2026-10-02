import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { SyncAllOptions, SyncAllResult, SyncResult } from '../../src/lib/lab/sync.js';
import {
  _resetLabSyncJobs,
  _setLabSyncAllImpl,
  currentLabSyncJob,
  labSyncJobSlots,
  startLabSyncJob,
} from '../../src/server/lab-sync-job.js';

/**
 * The job store: one running job and one queued follow-up per vault.
 *
 * The engine is replaced by a fake whose runs the test releases by hand, so
 * "the queued job starts only after the running one settles" is observed, not
 * timed. No vault is touched: the fake never reads the disk.
 */

const ROOT = '/nonexistent/vault-under-test';

interface FakeRun {
  opts: SyncAllOptions;
  release: (outcome?: { failed?: string[]; throws?: Error }) => void;
}

let runs: FakeRun[];

function installFake(): void {
  runs = [];
  _setLabSyncAllImpl(async (_root: string, opts: SyncAllOptions = {}): Promise<SyncAllResult> => {
    return await new Promise<SyncAllResult>((resolve, reject) => {
      runs.push({
        opts,
        release: (outcome = {}) => {
          if (outcome.throws) {
            reject(outcome.throws);
            return;
          }
          const slugs = opts.only ?? ['a', 'c', 'd'];
          const failed = new Set(outcome.failed ?? []);
          const results: SyncResult[] = slugs.map((slug) => ({
            slug,
            status: failed.has(slug) ? 'failed' : 'ok',
            ...(failed.has(slug) ? { error: 'boom' } : {}),
          }));
          resolve({ results, failed: results.filter((r) => r.status === 'failed') });
        },
      });
    });
  });
}

/** Let pending promise continuations (the job's finally) run. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function waitForRuns(n: number): Promise<void> {
  for (let i = 0; i < 200 && runs.length < n; i++) await tick();
  expect(runs.length).toBe(n);
}

beforeEach(() => {
  _resetLabSyncJobs();
  installFake();
});

afterEach(() => {
  _setLabSyncAllImpl(null);
  _resetLabSyncJobs();
});

describe('lab sync job — queued follow-up', () => {
  it('a request the running job covers adopts it (no queue)', async () => {
    const first = startLabSyncJob(ROOT, { force: 'user' });
    const second = startLabSyncJob(ROOT, { force: 'user', slugs: ['a'] });
    const third = startLabSyncJob(ROOT, {});
    expect(first.started).toBe(true);
    expect(second).toMatchObject({ started: false, queued: false });
    expect(second.job.id).toBe(first.job.id);
    expect(third.queued).toBe(false);
    expect(labSyncJobSlots(ROOT).queued).toBeNull();
    await waitForRuns(1);
    runs[0].release();
  });

  it('later requests merge into ONE queued job: union of slugs, the stronger force wins', async () => {
    const first = startLabSyncJob(ROOT, { slugs: ['a'] });
    const q1 = startLabSyncJob(ROOT, { force: 'user', slugs: ['c'] });
    const q2 = startLabSyncJob(ROOT, { force: 'hard', slugs: ['d'] });
    const q3 = startLabSyncJob(ROOT, { slugs: ['a'] }); // covered by the running job: adopts it
    const q4 = startLabSyncJob(ROOT, { force: true, slugs: ['c', 'e'] }); // true = 'user', weaker than 'hard'

    expect(q1).toMatchObject({ started: false, queued: true });
    expect(q2.job.id).toBe(q1.job.id);
    expect(q4.job.id).toBe(q1.job.id);
    expect(q3.job.id).toBe(first.job.id);

    const slots = labSyncJobSlots(ROOT);
    expect(slots.running?.id).toBe(first.job.id);
    expect(slots.queued).toMatchObject({ status: 'queued', force: 'hard' });
    expect([...(slots.queued?.slugs ?? [])].sort()).toEqual(['c', 'd', 'e']);
    expect(q4.running?.id).toBe(first.job.id);
    expect(q4.pending?.id).toBe(q1.job.id);

    await waitForRuns(1);
    expect(runs[0].opts).toMatchObject({ force: undefined, only: ['a'] });
    runs[0].release();

    await waitForRuns(2);
    expect(runs[1].opts.force).toBe('hard');
    expect([...(runs[1].opts.only ?? [])].sort()).toEqual(['c', 'd', 'e']);
    expect(currentLabSyncJob(ROOT)?.id).toBe(q1.job.id);
    expect(labSyncJobSlots(ROOT).queued).toBeNull();
    runs[1].release();
    for (let i = 0; i < 50 && currentLabSyncJob(ROOT)?.status === 'running'; i++) await tick();
    expect(currentLabSyncJob(ROOT)?.status).toBe('success');
  });

  it('a whole-board request absorbs a scoped queued one', async () => {
    startLabSyncJob(ROOT, { slugs: ['a'] });
    startLabSyncJob(ROOT, { slugs: ['c'] });
    startLabSyncJob(ROOT, {});
    expect(labSyncJobSlots(ROOT).queued?.slugs).toBeNull();
    await waitForRuns(1);
    runs[0].release();
    await waitForRuns(2);
    expect(runs[1].opts.only).toBeUndefined();
    runs[1].release();
  });

  it('the queued job runs even when the running job throws', async () => {
    const first = startLabSyncJob(ROOT, { slugs: ['a'] });
    const queued = startLabSyncJob(ROOT, { force: 'user', slugs: ['c'] });
    await waitForRuns(1);
    runs[0].release({ throws: new Error('engine exploded') });

    await waitForRuns(2);
    expect(first.job.status).toBe('error');
    expect(first.job.error).toBe('engine exploded');
    expect(currentLabSyncJob(ROOT)?.id).toBe(queued.job.id);
    expect(queued.job.status).toBe('running');
    expect(runs[1].opts).toMatchObject({ force: 'user', only: ['c'] });
    runs[1].release();
  });
});

describe('lab sync job — retry pass', () => {
  async function settle(): Promise<void> {
    for (let i = 0; i < 200 && currentLabSyncJob(ROOT)?.status === 'running'; i++) await tick();
  }

  it('an automatic job never retries its failures', async () => {
    const { job } = startLabSyncJob(ROOT);
    await waitForRuns(1);
    runs[0].release({ failed: ['c'] });
    await settle();
    expect(runs).toHaveLength(1);
    expect(job).toMatchObject({ status: 'success', attempt: 1, failed: ['c'], force: null });
  });

  it("a 'user' job retries once and the retry inherits 'user'", async () => {
    const { job } = startLabSyncJob(ROOT, { force: 'user' });
    await waitForRuns(1);
    runs[0].release({ failed: ['c'] });
    await waitForRuns(2);
    expect(runs[1].opts).toMatchObject({ force: 'user', only: ['c'] });
    runs[1].release();
    await settle();
    expect(job).toMatchObject({ status: 'success', attempt: 2, failed: [] });
  });

  it("a 'hard' job's retry inherits 'hard'; true is read as 'user'", async () => {
    startLabSyncJob(ROOT, { force: 'hard' });
    await waitForRuns(1);
    runs[0].release({ failed: ['a'] });
    await waitForRuns(2);
    expect(runs[1].opts.force).toBe('hard');
    runs[1].release();
    await settle();

    _resetLabSyncJobs();
    installFake();
    const { job } = startLabSyncJob(ROOT, { force: true });
    expect(job.force).toBe('user');
    await waitForRuns(1);
    expect(runs[0].opts.force).toBe('user');
    runs[0].release();
  });
});
