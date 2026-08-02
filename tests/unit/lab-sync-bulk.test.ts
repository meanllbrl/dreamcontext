import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInsight, readCache } from '../../src/lib/lab/store.js';
import { syncAll, type LabSyncProgress } from '../../src/lib/lab/sync.js';
import { readFrontmatter, writeFrontmatter } from '../../src/lib/frontmatter.js';
import {
  _resetLabSyncJobs,
  currentLabSyncJob,
  mergeLabResults,
  startLabSyncJob,
} from '../../src/server/lab-sync-job.js';

/**
 * Bulk insight sync — the "Sync all only synced some of them" defect.
 *
 * The board's Sync all used to hold one HTTP request open for a strictly
 * sequential run over every insight; the server's 30s socket timeout killed it
 * mid-flight and the UI never learned the outcome. These tests pin the two
 * halves of the fix: a bounded-concurrency engine that ALWAYS settles every
 * insight and reports progress as it goes, and a server-owned job that owns the
 * run instead of the request.
 */

let root: string;

function writeScript(slug: string, body: string): void {
  mkdirSync(join(root, 'lab', 'scripts'), { recursive: true });
  writeFileSync(join(root, 'lab', 'scripts', `${slug}.mjs`), body, 'utf-8');
}

/** Create an insight backed by a custom script with the given body. */
function scriptInsight(slug: string, body: string): void {
  createInsight(root, { slug, title: slug });
  const path = join(root, 'lab', 'insights', `${slug}.md`);
  const { data, content } = readFrontmatter(path);
  writeFrontmatter(
    path,
    { ...data, source: { adapter: 'script', script: { file: `scripts/${slug}.mjs` } } },
    content,
  );
  writeScript(slug, body);
}

const OK_SCRIPT = 'export default async () => [{ name: "d", points: [{ t: "2026-01-01", v: 1 }] }];\n';

/** A script that sleeps `ms` before returning — used to prove overlap and to
 *  starve the watchdog. */
function slowScript(ms: number): string {
  return `export default async () => {
  await new Promise((r) => setTimeout(r, ${ms}));
  return [{ name: "d", points: [{ t: "2026-01-01", v: 1 }] }];
};
`;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-lab-bulk-'));
  mkdirSync(join(root, 'core'), { recursive: true });
  _resetLabSyncJobs();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('syncAll — every insight settles', () => {
  it('syncs EVERY insight when one of them fails, and reports each one', async () => {
    for (const slug of ['a', 'b', 'c', 'd', 'e']) scriptInsight(slug, OK_SCRIPT);
    scriptInsight('broken', 'export default async () => { throw new Error("nope"); };\n');

    const { results, failed } = await syncAll(root, { force: true });

    expect(results).toHaveLength(6);
    expect(results.every((r) => r.status === 'ok' || r.status === 'failed')).toBe(true);
    expect(failed.map((f) => f.slug)).toEqual(['broken']);
    // The five healthy insights wrote real caches — a neighbour's failure never
    // costs another insight its sync.
    for (const slug of ['a', 'b', 'c', 'd', 'e']) {
      expect(readCache(root, slug)?.latest).toBe(1);
    }
  });

  it('returns results in MANIFEST order even though workers finish out of order', async () => {
    // `slow` is listed first but finishes last; the report must not reshuffle.
    scriptInsight('a-slow', slowScript(220));
    scriptInsight('b-fast', OK_SCRIPT);
    scriptInsight('c-fast', OK_SCRIPT);

    const { results } = await syncAll(root, { force: true, concurrency: 3 });
    expect(results.map((r) => r.slug)).toEqual(['a-slow', 'b-fast', 'c-fast']);
  });

  it('honours the `only` filter (the job layer\'s retry pass)', async () => {
    scriptInsight('a', OK_SCRIPT);
    scriptInsight('b', OK_SCRIPT);
    scriptInsight('c', OK_SCRIPT);

    const { results } = await syncAll(root, { force: true, only: ['b'] });
    expect(results.map((r) => r.slug)).toEqual(['b']);
    expect(readCache(root, 'a')).toBeNull();
  });

  it('emits one progress event per settled insight, counting up to the total', async () => {
    for (const slug of ['a', 'b', 'c']) scriptInsight(slug, OK_SCRIPT);

    const events: LabSyncProgress[] = [];
    await syncAll(root, { force: true, concurrency: 2, onProgress: (ev) => events.push(ev) });

    expect(events).toHaveLength(3);
    expect(events.map((e) => e.done)).toEqual([1, 2, 3]);
    expect(events.every((e) => e.total === 3)).toBe(true);
    expect(new Set(events.map((e) => e.slug))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('a throwing progress callback does NOT abort the run', async () => {
    for (const slug of ['a', 'b', 'c']) scriptInsight(slug, OK_SCRIPT);

    const { results } = await syncAll(root, {
      force: true,
      onProgress: () => { throw new Error('caller bug'); },
    });
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === 'ok')).toBe(true);
  });
});

describe('syncAll — bounded concurrency', () => {
  it('runs insights in parallel up to the concurrency ceiling', async () => {
    // Four ~200ms scripts at concurrency 4 must overlap: sequential would be
    // ~800ms, and the assertion is deliberately loose so a slow CI box still
    // proves overlap rather than timing precision.
    for (const slug of ['a', 'b', 'c', 'd']) scriptInsight(slug, slowScript(200));

    const started = Date.now();
    const { results } = await syncAll(root, { force: true, concurrency: 4 });
    const elapsed = Date.now() - started;

    expect(results.every((r) => r.status === 'ok')).toBe(true);
    expect(elapsed).toBeLessThan(700);
  });

  it('never EXCEEDS the ceiling — 4 insights at concurrency 2 run as two waves', async () => {
    for (const slug of ['a', 'b', 'c', 'd']) scriptInsight(slug, slowScript(200));

    const started = Date.now();
    const { results } = await syncAll(root, { force: true, concurrency: 2 });
    const elapsed = Date.now() - started;

    expect(results).toHaveLength(4);
    // Two waves of ~200ms. An unbounded fan-out would land near 200ms — the
    // floor is what proves the ceiling is real, not just that it's fast.
    expect(elapsed).toBeGreaterThanOrEqual(380);
  });

  it('clamps a bogus concurrency to at least one worker', async () => {
    for (const slug of ['a', 'b']) scriptInsight(slug, OK_SCRIPT);
    const { results } = await syncAll(root, { force: true, concurrency: 0 });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === 'ok')).toBe(true);
  });

  it('an empty board settles instead of hanging on zero workers', async () => {
    const { results, failed } = await syncAll(root, { force: true });
    expect(results).toEqual([]);
    expect(failed).toEqual([]);
  });
});

describe('syncAll — per-insight watchdog', () => {
  it('a wedged insight is reported failed instead of holding the whole run open', async () => {
    // A source parked on a long `Retry-After` (or a script blocked on a socket
    // that never answers) is the real shape: the process stays alive and busy,
    // so nothing below the engine ever gives up.
    scriptInsight('wedged', slowScript(3000));
    scriptInsight('healthy', OK_SCRIPT);

    const { results, failed } = await syncAll(root, {
      force: true,
      concurrency: 2,
      insightTimeoutMs: 300,
    });

    expect(results).toHaveLength(2);
    expect(failed.map((f) => f.slug)).toEqual(['wedged']);
    expect(failed[0].error).toMatch(/timed out after 300ms/);
    // The run still settled, and the healthy insight still got its data.
    expect(readCache(root, 'healthy')?.latest).toBe(1);
  }, 15_000);
});

describe('lab sync job — the run belongs to the server, not the request', () => {
  /** Poll until the job settles (or the deadline passes). */
  async function settle(timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = currentLabSyncJob(root);
      if (job && job.status !== 'running') return job;
      if (Date.now() > deadline) throw new Error('job never settled');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it('starts immediately and settles with every insight reported', async () => {
    for (const slug of ['a', 'b', 'c']) scriptInsight(slug, OK_SCRIPT);

    const { job, started } = startLabSyncJob(root);
    expect(started).toBe(true);
    expect(job.status).toBe('running');

    const settled = await settle();
    expect(settled.status).toBe('success');
    expect(settled.results).toHaveLength(3);
    expect(settled.failed).toEqual([]);
    expect(settled.done).toBe(3);
    expect(settled.total).toBe(3);
    expect(settled.finishedAt).not.toBeNull();
  }, 25_000);

  it('ADOPTS the running job instead of starting a second engine on the same cache', async () => {
    scriptInsight('a', slowScript(300));

    const first = startLabSyncJob(root);
    const second = startLabSyncJob(root);

    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(second.job.id).toBe(first.job.id);

    await settle();
  }, 25_000);

  it('retries the failures once and reports what is still broken', async () => {
    scriptInsight('ok', OK_SCRIPT);
    scriptInsight('broken', 'export default async () => { throw new Error("nope"); };\n');

    startLabSyncJob(root);
    const settled = await settle();

    // Individual insight failures are reported per tile — the JOB still
    // succeeded, because the run itself did its work.
    expect(settled.status).toBe('success');
    expect(settled.attempt).toBe(2);
    expect(settled.failed).toEqual(['broken']);
    expect(settled.results.map((r) => r.slug).sort()).toEqual(['broken', 'ok']);
    expect(readCache(root, 'ok')?.latest).toBe(1);
  }, 30_000);

  it('a settled job stays readable so a returning page can re-adopt its outcome', async () => {
    scriptInsight('a', OK_SCRIPT);
    const { job } = startLabSyncJob(root);
    await settle();

    const readBack = currentLabSyncJob(root);
    expect(readBack?.id).toBe(job.id);
    expect(readBack?.status).toBe('success');
  }, 25_000);
});

describe('mergeLabResults', () => {
  it('lets the retry pass overwrite a slug while keeping first-pass order', () => {
    const first = [
      { slug: 'a', status: 'ok' as const },
      { slug: 'b', status: 'failed' as const, error: 'boom' },
      { slug: 'c', status: 'ok' as const },
    ];
    const retry = [{ slug: 'b', status: 'ok' as const, latest: 7 }];

    const merged = mergeLabResults(first, retry);
    expect(merged.map((r) => r.slug)).toEqual(['a', 'b', 'c']);
    expect(merged[1]).toEqual({ slug: 'b', status: 'ok', latest: 7 });
  });

  it('appends slugs the first pass never saw', () => {
    const merged = mergeLabResults(
      [{ slug: 'a', status: 'ok' as const }],
      [{ slug: 'z', status: 'ok' as const }],
    );
    expect(merged.map((r) => r.slug)).toEqual(['a', 'z']);
  });
});
