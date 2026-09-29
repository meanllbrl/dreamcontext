import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleLabSync, handleLabSyncJobStart } from '../../src/server/routes/lab.js';
import { _resetLabSyncJobs, _setLabSyncAllImpl, currentLabSyncJob } from '../../src/server/lab-sync-job.js';
import { createInsight, writeCache } from '../../src/lib/lab/store.js';
import { normalizeSyncForce, syncAll, type SyncAllOptions } from '../../src/lib/lab/sync.js';
import { readFrontmatter, writeFrontmatter } from '../../src/lib/frontmatter.js';

/**
 * The force split (D6, r3.1): ABSENT force = automatic (TTL + error backoff,
 * no retry pass), `'user'` = someone asked, `'hard'` = skip the probe too, and
 * `true` read as `'user'` for one release. Pinned three ways: the dashboard
 * source never sends a bare `force: true`, the routes no longer default a
 * missing force to a forced run, and a recently-errored slug costs nothing
 * when nobody asked.
 */

const ROOT = join(import.meta.dirname, '../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'generated') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe('dashboard source', () => {
  it('never sends a bare `force: true` (user actions say \'user\', automatic callers send nothing)', () => {
    const files = walk(join(ROOT, 'dashboard/src'));
    expect(files.length).toBeGreaterThan(100);
    const offenders = files
      .filter((f) => /\bforce\s*:\s*true\b/.test(readFileSync(f, 'utf-8')))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('the start-job hook sends force only when the caller passes one (no `!== false` default)', () => {
    const src = readFileSync(join(ROOT, 'dashboard/src/hooks/useLab.ts'), 'utf-8');
    expect(src).not.toMatch(/force\s*!==\s*false/);
    expect(src).not.toMatch(/\bwindows\b/);
  });

  it('the routes read force through normalizeSyncForce, never a boolean default', () => {
    const src = readFileSync(join(ROOT, 'src/server/routes/lab.ts'), 'utf-8');
    expect(src).not.toMatch(/body\.force\s*!==\s*false/);
    expect(src).not.toMatch(/body\.force\s*===\s*true/);
    expect(src.match(/normalizeSyncForce\(body\.force\)/g)?.length).toBe(2);
  });
});

describe('normalizeSyncForce', () => {
  it('absent/false/junk = automatic, true and \'user\' = user, \'hard\' = hard', () => {
    expect(normalizeSyncForce(undefined)).toBeUndefined();
    expect(normalizeSyncForce(false)).toBeUndefined();
    expect(normalizeSyncForce('yes')).toBeUndefined();
    expect(normalizeSyncForce(true)).toBe('user');
    expect(normalizeSyncForce('user')).toBe('user');
    expect(normalizeSyncForce('hard')).toBe('hard');
  });
});

// ─── Route behaviour ────────────────────────────────────────────────────────

function makeRes(): { res: ServerResponse; body: () => any } {
  let responseBody: unknown = null;
  const res = {
    writeHead() {},
    end(data: string) { responseBody = JSON.parse(data); },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, body: () => responseBody as any };
}

function makeReq(bodyObj: unknown): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(bodyObj))]), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage;
}

let root: string;
let fetches: number;

/** An http insight whose cache failed `minutesAgo` minutes ago (TTL 60, so past the TTL: only the backoff holds it). */
function erroredInsight(slug: string, minutesAgo: number): void {
  createInsight(root, { slug, title: slug, ttl_minutes: 60 });
  const path = join(root, 'lab', 'insights', `${slug}.md`);
  const { data, content } = readFrontmatter<Record<string, unknown>>(path);
  writeFrontmatter(path, {
    ...data,
    source: {
      adapter: 'http',
      http: {
        endpoint: 'https://api.example.com/v1/metric', method: 'GET', headers: {}, body: null,
        extract: { seriesPath: 'data', seriesKey: null, x: 'date', y: 'value', agg: 'last' },
      },
    },
  }, content);
  writeCache(root, slug, {
    slug, fetchedAt: new Date(Date.now() - 600 * 60_000).toISOString(), tweaks: {}, granularity: 'daily', unit: null,
    series: [], latest: 1, error: 'upstream 500', errorAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(), scriptHash: null,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-lab-force-'));
  mkdirSync(join(root, 'core'), { recursive: true });
  fetches = 0;
  _resetLabSyncJobs();
  vi.stubGlobal('fetch', (async () => {
    fetches++;
    // A 4xx is not retried by the http adapter, so a failed run settles at once.
    return new Response('bad request', { status: 400 });
  }) as typeof fetch);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  _setLabSyncAllImpl(null);
  _resetLabSyncJobs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

async function settle() {
  for (let i = 0; i < 400; i++) {
    const job = currentLabSyncJob(root);
    if (job && job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job never settled');
}

describe('POST /api/lab/sync-jobs with no force = automatic', () => {
  it('a recently-errored slug costs 0 fetches and gets no retry pass', async () => {
    erroredInsight('broken', 5);
    const passes: SyncAllOptions[] = [];
    _setLabSyncAllImpl((contextRoot, opts) => { passes.push(opts ?? {}); return syncAll(contextRoot, opts); });

    const { res, body } = makeRes();
    await handleLabSyncJobStart(makeReq({ slugs: ['broken'] }), res, {}, root);
    expect(body().job.force).toBeNull();
    const job = await settle();

    expect(fetches).toBe(0);
    expect(passes).toHaveLength(1); // no retry pass
    expect(passes[0].force).toBeUndefined();
    expect(job.attempt).toBe(1);
    expect(job.results).toEqual([expect.objectContaining({ slug: 'broken', status: 'skipped', reason: 'error-backoff' })]);
  });

  it('force: true is read as \'user\': the backoff is bypassed and the failure gets one retry pass', async () => {
    erroredInsight('broken', 5);
    const passes: SyncAllOptions[] = [];
    _setLabSyncAllImpl((contextRoot, opts) => { passes.push(opts ?? {}); return syncAll(contextRoot, opts); });

    const { res, body } = makeRes();
    await handleLabSyncJobStart(makeReq({ slugs: ['broken'], force: true }), res, {}, root);
    expect(body().job.force).toBe('user');
    const job = await settle();

    expect(passes.map((p) => p.force)).toEqual(['user', 'user']);
    expect(job.attempt).toBe(2);
    expect(fetches).toBeGreaterThan(0);
  }, 30_000);
});

describe('POST /api/lab/sync with no force = automatic', () => {
  it('backs off a recently-errored slug with zero fetches; \'hard\' fetches', async () => {
    erroredInsight('broken', 5);
    const auto = makeRes();
    await handleLabSync(makeReq({ slug: 'broken' }), auto.res, {}, root);
    expect(auto.body().results[0]).toMatchObject({ status: 'skipped', reason: 'error-backoff' });
    expect(fetches).toBe(0);

    const hard = makeRes();
    await handleLabSync(makeReq({ slug: 'broken', force: 'hard' }), hard.res, {}, root);
    expect(hard.body().results[0].status).toBe('failed');
    expect(fetches).toBeGreaterThan(0);
  }, 30_000);

  it('an old failure (past the backoff) is retried by an automatic run', async () => {
    erroredInsight('stale-error', 120);
    const auto = makeRes();
    await handleLabSync(makeReq({ slug: 'stale-error' }), auto.res, {}, root);
    expect(fetches).toBeGreaterThan(0);
  }, 30_000);
});
