import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInsight, getInsight, readCache } from '../../src/lib/lab/store.js';
import { syncAll, syncInsight, readFreshnessChecks, normalizeFreshness } from '../../src/lib/lab/sync.js';
import { buildProbeRequest } from '../../src/lib/lab/adapters/generic-http.js';
import { readFrontmatter, writeFrontmatter } from '../../src/lib/frontmatter.js';
import { _resetLabSyncJobs, currentLabSyncJob, startLabSyncJob } from '../../src/server/lab-sync-job.js';
import type { HttpSource } from '../../src/lib/lab/types.js';

/**
 * The freshness gate: sync only pays for change.
 *
 * Every test runs in a throwaway vault under the OS tmpdir (never the real
 * ~/.dreamcontext) and counts upstream requests through an injected fetch, so
 * "0 fetches" is measured, not inferred.
 */

let root: string;

const DATA_URL = 'https://api.example.com/v1/metric';
const PROBE_URL = 'https://api.example.com/v1/meta';
const T0 = Date.parse('2026-09-30T08:00:00Z');
const MIN = 60_000;

interface Call { url: string; init: RequestInit | undefined }

/** A fetch that answers by URL and records every call. */
function upstream(handlers: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const key = Object.keys(handlers).find((k) => url.startsWith(k));
    if (!key) throw new Error(`unexpected request to ${url}`);
    return handlers[key](init);
  }) as typeof fetch;
  const count = (prefix: string): number => calls.filter((c) => c.url.startsWith(prefix)).length;
  return { fetchImpl, calls, count };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const DATA_BODY = { data: [{ date: '2026-09-29', value: 7 }] };

function editManifest(slug: string, patch: (data: Record<string, unknown>) => Record<string, unknown>): void {
  const path = join(root, 'lab', 'insights', `${slug}.md`);
  const { data, content } = readFrontmatter<Record<string, unknown>>(path);
  writeFrontmatter(path, patch(data), content);
}

/** An http insight with an optional freshness probe and a `country` tweak. */
function httpInsight(
  slug: string,
  opts: { ttl?: number; freshness?: Record<string, unknown> | null; headers?: Record<string, string>; endpoint?: string } = {},
): void {
  createInsight(root, { slug, title: slug, ttl_minutes: opts.ttl ?? 60 });
  editManifest(slug, (data) => ({
    ...data,
    source: {
      adapter: 'http',
      http: {
        endpoint: opts.endpoint ?? `${DATA_URL}?country={{tweak:country}}`,
        method: 'GET',
        headers: opts.headers ?? {},
        body: null,
        extract: { seriesPath: 'data', seriesKey: null, x: 'date', y: 'value', agg: 'last' },
      },
    },
    refresh: {
      ttl_minutes: opts.ttl ?? 60,
      ...(opts.freshness === null ? {} : { freshness: opts.freshness ?? { url: PROBE_URL, extract: 'meta.lastModified' } }),
    },
    tweaks: [{ key: 'country', type: 'enum', options: ['us', 'tr'], value: 'us' }],
  }));
}

function setTweak(slug: string, value: string): void {
  editManifest(slug, (data) => ({
    ...data,
    tweaks: [{ key: 'country', type: 'enum', options: ['us', 'tr'], value }],
  }));
}

function writeCreds(creds: Record<string, string>): void {
  mkdirSync(join(root, 'lab'), { recursive: true });
  writeFileSync(join(root, 'lab', 'credentials.json'), JSON.stringify(creds), 'utf-8');
}

function scriptInsight(slug: string, body: string): void {
  createInsight(root, { slug, title: slug, ttl_minutes: 60 });
  editManifest(slug, (data) => ({ ...data, source: { adapter: 'script', script: { file: `scripts/${slug}.mjs` } } }));
  mkdirSync(join(root, 'lab', 'scripts'), { recursive: true });
  writeFileSync(join(root, 'lab', 'scripts', `${slug}.mjs`), body, 'utf-8');
}

const cacheFile = (slug: string): string => join(root, 'lab', 'cache', `${slug}.json`);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-lab-fresh-'));
  mkdirSync(join(root, 'core'), { recursive: true });
  _resetLabSyncJobs();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('freshness gate — the skip rules', () => {
  it('all-fresh: an automatic run inside the TTL makes zero upstream requests', async () => {
    httpInsight('a');
    httpInsight('c');
    const up = upstream({ [PROBE_URL]: () => json({ meta: { lastModified: 'm1' } }), [DATA_URL]: () => json(DATA_BODY) });
    await syncAll(root, { force: 'user', fetchImpl: up.fetchImpl, now: () => T0 });
    up.calls.length = 0;

    const { results } = await syncAll(root, { fetchImpl: up.fetchImpl, now: () => T0 + 10 * MIN });
    expect(up.calls).toHaveLength(0);
    expect(results.map((r) => [r.status, r.reason])).toEqual([['fresh', 'ttl'], ['fresh', 'ttl']]);
  });

  it("unchanged marker + queryKey under 'user' = 1 probe, 0 fetches", async () => {
    httpInsight('a');
    const up = upstream({ [PROBE_URL]: () => json({ meta: { lastModified: 'm1' } }), [DATA_URL]: () => json(DATA_BODY) });
    const first = await syncInsight(root, 'a', { force: 'user', fetchImpl: up.fetchImpl, now: () => T0 });
    expect(first.status).toBe('ok');
    expect(readCache(root, 'a')?.sourceFreshness?.marker).toBe('m1');
    up.calls.length = 0;

    const second = await syncInsight(root, 'a', { force: 'user', fetchImpl: up.fetchImpl, now: () => T0 + MIN });
    expect(second).toMatchObject({ status: 'fresh', reason: 'upstream-unchanged', latest: 7 });
    expect(up.count(PROBE_URL)).toBe(1);
    expect(up.count(DATA_URL)).toBe(0);
  });

  it("force: true is read as 'user' (probe consulted, no fetch)", async () => {
    httpInsight('a');
    const up = upstream({ [PROBE_URL]: () => json({ meta: { lastModified: 'm1' } }), [DATA_URL]: () => json(DATA_BODY) });
    await syncInsight(root, 'a', { force: true, fetchImpl: up.fetchImpl, now: () => T0 });
    up.calls.length = 0;
    const again = await syncInsight(root, 'a', { force: true, fetchImpl: up.fetchImpl, now: () => T0 + MIN });
    expect(again.reason).toBe('upstream-unchanged');
    expect(up.count(DATA_URL)).toBe(0);
    expect(up.count(PROBE_URL)).toBe(1);
  });

  it('a changed tweak with the same marker = 1 fetch (the queryKey moved)', async () => {
    httpInsight('a');
    const up = upstream({ [PROBE_URL]: () => json({ meta: { lastModified: 'm1' } }), [DATA_URL]: () => json(DATA_BODY) });
    await syncInsight(root, 'a', { force: 'user', fetchImpl: up.fetchImpl, now: () => T0 });
    const keyBefore = readCache(root, 'a')?.sourceFreshness?.queryKey;
    up.calls.length = 0;

    setTweak('a', 'tr');
    const res = await syncInsight(root, 'a', { force: 'user', fetchImpl: up.fetchImpl, now: () => T0 + MIN });
    expect(res.status).toBe('ok');
    expect(up.count(DATA_URL)).toBe(1);
    expect(up.calls.find((c) => c.url.startsWith(DATA_URL))?.url).toContain('country=tr');
    expect(readCache(root, 'a')?.sourceFreshness?.queryKey).not.toBe(keyBefore);
  });

  it("'hard' fetches without probing", async () => {
    httpInsight('a');
    const up = upstream({ [PROBE_URL]: () => json({ meta: { lastModified: 'm1' } }), [DATA_URL]: () => json(DATA_BODY) });
    await syncInsight(root, 'a', { force: 'user', fetchImpl: up.fetchImpl, now: () => T0 });
    up.calls.length = 0;
    const res = await syncInsight(root, 'a', { force: 'hard', fetchImpl: up.fetchImpl, now: () => T0 + MIN });
    expect(res.status).toBe('ok');
    expect(up.count(PROBE_URL)).toBe(0);
    expect(up.count(DATA_URL)).toBe(1);
  });

  it('no marker = TTL only: no probe config means every stale or user run fetches', async () => {
    httpInsight('a', { freshness: null });
    const up = upstream({ [DATA_URL]: () => json(DATA_BODY) });
    await syncInsight(root, 'a', { force: 'user', fetchImpl: up.fetchImpl, now: () => T0 });
    expect(readCache(root, 'a')?.sourceFreshness).toBeUndefined();

    expect((await syncInsight(root, 'a', { fetchImpl: up.fetchImpl, now: () => T0 + 30 * MIN })).reason).toBe('ttl');
    expect(up.count(DATA_URL)).toBe(1);
    expect((await syncInsight(root, 'a', { fetchImpl: up.fetchImpl, now: () => T0 + 61 * MIN })).status).toBe('ok');
    expect((await syncInsight(root, 'a', { force: 'user', fetchImpl: up.fetchImpl, now: () => T0 + 62 * MIN })).status).toBe('ok');
    expect(up.count(DATA_URL)).toBe(3);
  });

  it('a script without a freshness export is TTL-only (never probed)', async () => {
    scriptInsight('s', `export default async () => [{ name: 'd', points: [{ t: '2026-01-01', v: 1 }] }];\n`);
    const first = await syncInsight(root, 's', { force: 'user', now: () => T0 });
    expect(first.status).toBe('ok');
    expect(readCache(root, 's')?.sourceFreshness).toBeUndefined();
    const second = await syncInsight(root, 's', { force: 'user', now: () => T0 + MIN });
    expect(second.status).toBe('ok');
  }, 20_000);
});

describe('freshness gate — a probe that fails means a full fetch', () => {
  async function primed(probe: (init?: RequestInit) => Response | Promise<Response>) {
    httpInsight('a');
    const good = upstream({ [PROBE_URL]: () => json({ meta: { lastModified: 'm1' } }), [DATA_URL]: () => json(DATA_BODY) });
    await syncInsight(root, 'a', { force: 'user', fetchImpl: good.fetchImpl, now: () => T0 });
    return upstream({ [PROBE_URL]: probe, [DATA_URL]: () => json(DATA_BODY) });
  }

  it('garbage (no marker at the path) → fetch', async () => {
    const up = await primed(() => json({ meta: { somethingElse: 1 } }));
    const res = await syncInsight(root, 'a', { force: 'user', fetchImpl: up.fetchImpl, now: () => T0 + MIN });
    expect(res.status).toBe('ok');
    expect(up.count(DATA_URL)).toBe(1);
  });

  it('a marker over 256 chars is no marker → fetch', async () => {
    const up = await primed(() => json({ meta: { lastModified: 'x'.repeat(300) } }));
    const res = await syncInsight(root, 'a', { force: 'user', fetchImpl: up.fetchImpl, now: () => T0 + MIN });
    expect(res.status).toBe('ok');
    expect(up.count(DATA_URL)).toBe(1);
  });

  it('a non-JSON body or a 500 → fetch', async () => {
    let up = await primed(() => new Response('<html>oops</html>', { status: 200 }));
    expect((await syncInsight(root, 'a', { force: 'user', fetchImpl: up.fetchImpl, now: () => T0 + MIN })).status).toBe('ok');
    expect(up.count(DATA_URL)).toBe(1);
    up = upstream({ [PROBE_URL]: () => json({}, 500), [DATA_URL]: () => json(DATA_BODY) });
    expect((await syncInsight(root, 'a', { force: 'user', fetchImpl: up.fetchImpl, now: () => T0 + 2 * MIN })).status).toBe('ok');
    expect(up.count(DATA_URL)).toBe(1);
  });

  it('a redirect is never followed → fetch', async () => {
    const up = await primed((init) => {
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example.net/' } });
    });
    const res = await syncInsight(root, 'a', { force: 'user', fetchImpl: up.fetchImpl, now: () => T0 + MIN });
    expect(res.status).toBe('ok');
    expect(up.calls.some((c) => c.url.startsWith('https://elsewhere'))).toBe(false);
  });

  it('a throw → fetch, and the warning carries no secret', async () => {
    writeCreds({ token: 'sekret-123' });
    httpInsight('a', { freshness: { url: `${PROBE_URL}?k={{cred:token}}`, extract: 'meta.lastModified' } });
    const good = upstream({ [PROBE_URL]: () => json({ meta: { lastModified: 'm1' } }), [DATA_URL]: () => json(DATA_BODY) });
    await syncInsight(root, 'a', { force: 'user', fetchImpl: good.fetchImpl, now: () => T0 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const up = upstream({
      [PROBE_URL]: () => { throw new Error('socket hang up sekret-123'); },
      [DATA_URL]: () => json(DATA_BODY),
    });
    const res = await syncInsight(root, 'a', { force: 'user', fetchImpl: up.fetchImpl, now: () => T0 + MIN });
    expect(res.status).toBe('ok');
    expect(up.count(DATA_URL)).toBe(1);
    const warned = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('freshness probe failed');
    expect(warned).not.toContain('sekret-123');
  });

  it('a timeout → fetch', async () => {
    const up = await primed((init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const res = await syncInsight(root, 'a', { force: 'user', fetchImpl: up.fetchImpl, now: () => T0 + MIN, probeTimeoutMs: 50 });
    expect(res.status).toBe('ok');
    expect(up.count(DATA_URL)).toBe(1);
  });

  it('a probe that ignores its abort signal still cannot hold the sync open', async () => {
    const up = await primed(() => new Promise<Response>(() => { /* never settles */ }));
    const started = Date.now();
    const res = await syncInsight(root, 'a', { force: 'user', fetchImpl: up.fetchImpl, now: () => T0 + MIN, probeTimeoutMs: 50 });
    expect(res.status).toBe('ok');
    expect(Date.now() - started).toBeLessThan(6_000);
  }, 10_000);
});

describe('freshness gate — staleness, max age, backoff', () => {
  it('staleness age = now − max(fetchedAt, checkedAt); max age forces a real fetch', async () => {
    httpInsight('a', { ttl: 60 });
    const up = upstream({ [PROBE_URL]: () => json({ meta: { lastModified: 'm1' } }), [DATA_URL]: () => json(DATA_BODY) });
    await syncInsight(root, 'a', { force: 'user', fetchImpl: up.fetchImpl, now: () => T0 });
    up.calls.length = 0;

    // Stale by fetchedAt → probe, unchanged → skip, checkedAt recorded.
    const stale = await syncInsight(root, 'a', { fetchImpl: up.fetchImpl, now: () => T0 + 120 * MIN });
    expect(stale.reason).toBe('upstream-unchanged');
    expect(up.count(DATA_URL)).toBe(0);

    // 30 min after the check: fetchedAt says stale, checkedAt says fresh → TTL skip, no requests.
    up.calls.length = 0;
    const afterCheck = await syncInsight(root, 'a', { fetchImpl: up.fetchImpl, now: () => T0 + 150 * MIN });
    expect(afterCheck.reason).toBe('ttl');
    expect(up.calls).toHaveLength(0);

    // Past max(24h, 10 × 60 min) since the last REAL fetch: the unchanged marker no longer counts.
    const old = await syncInsight(root, 'a', { fetchImpl: up.fetchImpl, now: () => T0 + 25 * 60 * MIN });
    expect(old.status).toBe('ok');
    expect(up.count(DATA_URL)).toBe(1);
  });

  it('max age uses 10 × TTL when that is longer than a day', async () => {
    httpInsight('a', { ttl: 1440 });
    const up = upstream({ [PROBE_URL]: () => json({ meta: { lastModified: 'm1' } }), [DATA_URL]: () => json(DATA_BODY) });
    await syncInsight(root, 'a', { force: 'user', fetchImpl: up.fetchImpl, now: () => T0 });
    up.calls.length = 0;
    // 3 days later: stale (TTL 1 day) but inside 10 days → probe only.
    const res = await syncInsight(root, 'a', { fetchImpl: up.fetchImpl, now: () => T0 + 3 * 1440 * MIN });
    expect(res.reason).toBe('upstream-unchanged');
    expect(up.count(DATA_URL)).toBe(0);
  });

  it('automatic runs back off a recently failed slug; a user run still retries', async () => {
    httpInsight('a', { ttl: 5, freshness: null });
    const broken = upstream({ [DATA_URL]: () => json({ error: 'x' }, 400) });
    const failed = await syncInsight(root, 'a', { force: 'user', fetchImpl: broken.fetchImpl, now: () => T0 });
    expect(failed.status).toBe('failed');
    broken.calls.length = 0;

    // TTL 5 min, but the backoff is max(TTL, 15 min).
    const auto = await syncInsight(root, 'a', { fetchImpl: broken.fetchImpl, now: () => T0 + 10 * MIN });
    expect(auto).toMatchObject({ status: 'skipped', reason: 'error-backoff' });
    expect(broken.calls).toHaveLength(0);

    const later = await syncInsight(root, 'a', { fetchImpl: broken.fetchImpl, now: () => T0 + 16 * MIN });
    expect(later.status).toBe('failed');
    expect(broken.calls).toHaveLength(1);

    const user = await syncInsight(root, 'a', { force: 'user', fetchImpl: broken.fetchImpl, now: () => T0 + 17 * MIN });
    expect(user.status).toBe('failed');
    expect(broken.calls).toHaveLength(2);
  });

  it('an automatic job has no retry pass, and skips a slug still in backoff', async () => {
    scriptInsight('broken', 'export default async () => { throw new Error("nope"); };\n');
    // Fails once (automatic, never synced → runs), then is backed off.
    startLabSyncJob(root);
    const settle = async () => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const job = currentLabSyncJob(root);
        if (job && job.status !== 'running' && job.status !== 'queued') return job;
        if (Date.now() > deadline) throw new Error('job never settled');
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    const first = await settle();
    expect(first.attempt).toBe(1);
    expect(first.failed).toEqual(['broken']);

    _resetLabSyncJobs();
    startLabSyncJob(root);
    const second = await settle();
    expect(second.attempt).toBe(1);
    expect(second.results[0]).toMatchObject({ slug: 'broken', status: 'skipped', reason: 'error-backoff' });
    expect(second.failed).toEqual([]);
  }, 30_000);
});

describe('freshness gate — the same-origin credential rule', () => {
  const source: HttpSource = {
    adapter: 'http',
    endpoint: 'https://api.example.com/v1/metric',
    method: 'GET',
    headers: { Authorization: 'Bearer {{cred:token}}' },
    body: null,
    extract: { seriesPath: 'data', seriesKey: null, x: 'date', y: 'value', agg: 'last' },
  };
  const creds = { token: 'tok-abc', host: 'https://evil.example.net', same: 'https://api.example.com' };
  const pctx = { cred: creds, tweak: {} };
  const spec = (over: Partial<Parameters<typeof buildProbeRequest>[1]>) => ({
    url: 'https://api.example.com/v1/meta',
    method: 'GET' as const,
    headers: null,
    body: null,
    extract: { marker: 'm', asOf: null, note: null },
    ...over,
  });

  it('a same-origin probe inherits the source auth headers', () => {
    const plan = buildProbeRequest(source, spec({}), creds, pctx);
    expect(plan).toMatchObject({ headers: { Authorization: 'Bearer tok-abc' }, carriesCredential: true });
  });

  it('a cross-origin probe with no credential goes out bare', () => {
    const plan = buildProbeRequest(source, spec({ url: 'https://status.example.org/meta' }), creds, pctx);
    expect(plan).toMatchObject({ headers: {}, carriesCredential: false });
  });

  it('a placeholder that RESOLVES to another origin is refused (checked after resolution)', () => {
    expect(buildProbeRequest(source, spec({ url: '{{cred:host}}/meta' }), creds, pctx)).toHaveProperty('refused');
  });

  it('a placeholder that resolves to the SAME origin is allowed', () => {
    const plan = buildProbeRequest(source, spec({ url: '{{cred:same}}/v1/meta' }), creds, pctx);
    expect(plan).toMatchObject({ url: 'https://api.example.com/v1/meta', carriesCredential: true });
  });

  it('cross-origin is refused wherever the credential sits: URL, header, body, or a literal secret', () => {
    const x = 'https://status.example.org/meta';
    expect(buildProbeRequest(source, spec({ url: `${x}?k={{cred:token}}` }), creds, pctx)).toHaveProperty('refused');
    expect(buildProbeRequest(source, spec({ url: x, headers: { 'X-Key': '{{cred:token}}' } }), creds, pctx)).toHaveProperty('refused');
    expect(buildProbeRequest(source, spec({ url: x, method: 'POST', body: '{"k":"{{cred:token}}"}' }), creds, pctx)).toHaveProperty('refused');
    expect(buildProbeRequest(source, spec({ url: x, headers: { 'X-Key': 'tok-abc' } }), creds, pctx)).toHaveProperty('refused');
  });

  it('end to end: a refused probe sends nothing to the other origin and the sync fetches', async () => {
    writeCreds({ token: 'tok-abc', host: 'https://evil.example.net' });
    httpInsight('a', {
      endpoint: DATA_URL,
      headers: { Authorization: 'Bearer {{cred:token}}' },
      freshness: { url: '{{cred:host}}/meta', extract: 'meta.lastModified' },
    });
    const up = upstream({ [DATA_URL]: () => json(DATA_BODY), 'https://evil.example.net': () => json({ meta: { lastModified: 'm' } }) });
    const res = await syncInsight(root, 'a', { force: 'user', fetchImpl: up.fetchImpl, now: () => T0 });
    expect(res.status).toBe('ok');
    expect(up.count('https://evil.example.net')).toBe(0);
    expect(up.count(DATA_URL)).toBe(1);
  });

  it('end to end: a same-origin probe carries the source auth', async () => {
    writeCreds({ token: 'tok-abc' });
    httpInsight('a', { endpoint: DATA_URL, headers: { Authorization: 'Bearer {{cred:token}}' } });
    const up = upstream({ [PROBE_URL]: () => json({ meta: { lastModified: 'm1' } }), [DATA_URL]: () => json(DATA_BODY) });
    await syncInsight(root, 'a', { force: 'user', fetchImpl: up.fetchImpl, now: () => T0 });
    const probeCall = up.calls.find((c) => c.url.startsWith(PROBE_URL));
    expect((probeCall?.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok-abc');
  });
});

describe('freshness gate — what gets written where', () => {
  it('checkedAt goes to the machine-local sidecar; an unchanged probe does not rewrite the synced cache', async () => {
    httpInsight('a');
    const up = upstream({ [PROBE_URL]: () => json({ meta: { lastModified: 'm1' } }), [DATA_URL]: () => json(DATA_BODY) });
    await syncInsight(root, 'a', { force: 'user', fetchImpl: up.fetchImpl, now: () => T0 });
    const before = readFileSync(cacheFile('a'), 'utf-8');
    expect(JSON.parse(before).sourceFreshness).not.toHaveProperty('checkedAt');
    expect(existsSync(join(root, 'state', '.lab-freshness.json'))).toBe(false);

    await syncInsight(root, 'a', { force: 'user', fetchImpl: up.fetchImpl, now: () => T0 + 5 * MIN });
    expect(readFileSync(cacheFile('a'), 'utf-8')).toBe(before);
    const checks = readFreshnessChecks(root);
    expect(checks.a).toMatchObject({ checkedAt: new Date(T0 + 5 * MIN).toISOString(), marker: 'm1' });
  });

  it('the sidecar is merge-on-write: checks for different insights coexist', async () => {
    httpInsight('a');
    httpInsight('c');
    const up = upstream({ [PROBE_URL]: () => json({ meta: { lastModified: 'm1' } }), [DATA_URL]: () => json(DATA_BODY) });
    await syncAll(root, { force: 'user', fetchImpl: up.fetchImpl, now: () => T0 });
    await syncAll(root, { force: 'user', fetchImpl: up.fetchImpl, now: () => T0 + MIN });
    expect(Object.keys(readFreshnessChecks(root)).sort()).toEqual(['a', 'c']);
  });

  it('a failed fetch keeps the prior marker with the prior data, and is not skipped by it', async () => {
    httpInsight('a');
    const good = upstream({ [PROBE_URL]: () => json({ meta: { lastModified: 'm1' } }), [DATA_URL]: () => json(DATA_BODY) });
    await syncInsight(root, 'a', { force: 'user', fetchImpl: good.fetchImpl, now: () => T0 });
    const bad = upstream({ [PROBE_URL]: () => json({ meta: { lastModified: 'm2' } }), [DATA_URL]: () => json({}, 400) });
    expect((await syncInsight(root, 'a', { force: 'user', fetchImpl: bad.fetchImpl, now: () => T0 + MIN })).status).toBe('failed');
    expect(readCache(root, 'a')?.sourceFreshness?.marker).toBe('m1');
    // Upstream back to m1: the error on the cache means it is re-fetched, not skipped.
    good.calls.length = 0;
    expect((await syncInsight(root, 'a', { force: 'user', fetchImpl: good.fetchImpl, now: () => T0 + 2 * MIN })).status).toBe('ok');
    expect(good.count(DATA_URL)).toBe(1);
  });

  it('normalizeFreshness redacts secrets, caps text, and rejects a missing marker', () => {
    expect(normalizeFreshness({ marker: 'v-sek', note: 'line1\n<b>sek</b>' }, ['sek'])).toEqual({
      marker: 'v-***',
      asOf: null,
      note: 'line1 <b>***</b>',
    });
    expect(normalizeFreshness({ marker: 42 }, [])).toMatchObject({ marker: '42' });
    expect(normalizeFreshness({ asOf: 'x' }, [])).toBeNull();
    expect(normalizeFreshness({ marker: { nested: 1 } }, [])).toBeNull();
    expect(normalizeFreshness('m', [])).toBeNull();
  });

  it('parseRefresh reads the probe block and degrades a malformed one to TTL-only', () => {
    httpInsight('a', { freshness: { url: PROBE_URL, extract: { marker: 'meta.v', asOf: 'meta.d', note: 'meta.n' } } });
    expect(getInsight(root, 'a')?.refresh.freshness).toMatchObject({
      url: PROBE_URL,
      method: 'GET',
      headers: null,
      extract: { marker: 'meta.v', asOf: 'meta.d', note: 'meta.n' },
    });
    httpInsight('c', { freshness: { url: PROBE_URL } });
    expect(getInsight(root, 'c')?.refresh.freshness).toBeUndefined();
    expect(getInsight(root, 'c')?.refresh.ttl_minutes).toBe(60);
  });
});

describe('freshness gate — NeonBI-shaped script envelope', () => {
  const FIXTURE = join(__dirname, '..', 'fixtures', 'lab', 'neonbi-freshness-envelope.mjs');

  function neonbiInsight(tableLastModified: string): void {
    createInsight(root, { slug: 'neon', title: 'Neon', ttl_minutes: 60 });
    editManifest('neon', (data) => ({ ...data, source: { adapter: 'script', script: { file: 'scripts/neon.mjs' } } }));
    mkdirSync(join(root, 'lab', 'scripts'), { recursive: true });
    copyFileSync(FIXTURE, join(root, 'lab', 'scripts', 'neon.mjs'));
    setTable(tableLastModified);
  }
  function setTable(tableLastModified: string): void {
    writeFileSync(join(root, 'lab', 'scripts', 'neonbi-state.json'), JSON.stringify({
      meta: { tableLastModified, dataThrough: '2026-09-29' },
      rows: [{ date: '2026-09-29', value: 11 }],
    }));
  }
  const calls = (): string[] => {
    const p = join(root, 'lab', 'scripts', 'neonbi-calls.log');
    return existsSync(p) ? readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean) : [];
  };

  it('maps tableLastModified/dataThrough to marker/asOf, surfaces freshnessNote, and skips an unchanged table', async () => {
    neonbiInsight('2026-09-30T04:00:00Z');
    const first = await syncInsight(root, 'neon', { force: 'user', now: () => T0 });
    expect(first.status).toBe('ok');
    expect(first.freshnessNote).toBe('NeonBI table refreshed 2026-09-30T04:00:00Z, data through 2026-09-29');
    expect(readCache(root, 'neon')?.sourceFreshness).toMatchObject({
      marker: '2026-09-30T04:00:00Z',
      asOf: '2026-09-29',
      note: 'NeonBI table refreshed 2026-09-30T04:00:00Z, data through 2026-09-29',
    });
    expect(calls().filter((c) => c === 'data')).toHaveLength(1);

    const before = calls().length;
    const second = await syncInsight(root, 'neon', { force: 'user', now: () => T0 + MIN });
    expect(second).toMatchObject({ status: 'fresh', reason: 'upstream-unchanged' });
    expect(second.freshnessNote).toContain('NeonBI table refreshed');
    expect(calls().slice(before)).toEqual(['freshness']);

    setTable('2026-09-30T09:00:00Z');
    const third = await syncInsight(root, 'neon', { force: 'user', now: () => T0 + 2 * MIN });
    expect(third.status).toBe('ok');
    expect(calls().filter((c) => c === 'data')).toHaveLength(2);
    expect(readCache(root, 'neon')?.sourceFreshness?.marker).toBe('2026-09-30T09:00:00Z');
  }, 30_000);

  it('a changed script is never probed (the tripwire): it fetches', async () => {
    neonbiInsight('2026-09-30T04:00:00Z');
    await syncInsight(root, 'neon', { force: 'user', now: () => T0 });
    const path = join(root, 'lab', 'scripts', 'neon.mjs');
    writeFileSync(path, readFileSync(path, 'utf-8') + '\n// edited\n');
    const before = calls().length;
    const res = await syncInsight(root, 'neon', { force: 'user', now: () => T0 + MIN });
    expect(res.status).toBe('ok');
    expect(calls().slice(before)).toContain('data');
  }, 30_000);
});
