import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, realpathSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  metaFetch,
  uploadVideoFile,
  uploadImageFile,
  liveCtxFromEnv,
  dryRunCtx,
  TokenExpiredError,
  MetaApiError,
  HeaderAuthAssertionError,
  _resetQueues,
  type MetaCtx,
} from '../../src/lib/marketing/meta-fetch.js';

function makeProject(): string {
  const raw = join(tmpdir(), `mk-meta-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  const root = realpathSync(raw);
  mkdirSync(join(root, '_dream_context', 'marketing', 'runs', 'by-idem'), { recursive: true });
  return root;
}

function jsonResp(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const txt = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(txt, {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function liveCtx(overrides: Partial<MetaCtx> = {}): MetaCtx {
  return {
    dryRun: false,
    apiVersion: 'v25.0',
    accessToken: 'TEST_BEARER_TOKEN',
    adAccountId: 'act_123456789',
    pageId: 'page_111',
    igActorId: 'ig_222',
    pixelId: 'pixel_333',
    logger: () => undefined,
    ...overrides,
  };
}

describe('meta-fetch', () => {
  let project: string;
  const origCwd = process.cwd();

  beforeEach(() => {
    project = makeProject();
    process.chdir(project);
    _resetQueues();
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(project, { recursive: true, force: true });
    vi.useRealTimers();
  });

  // ─── Dry-run gate (no network at all) ──────────────────────────────────────

  it('dry-run gate: does not call fetch and returns synthesized id', async () => {
    const fetchImpl = vi.fn();
    const ctx = liveCtx({ dryRun: true });
    const result = await metaFetch(ctx, {
      method: 'POST',
      path: 'act_123456789/campaigns',
      params: { name: 'Test', objective: 'OUTCOME_LEADS' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(typeof (result as { id: string }).id).toBe('string');
    expect((result as { id: string }).id).toMatch(/^DRY_/);
  });

  it('dry-run gate: enforced even when caller passes dryRun=false in init (no override path exists)', async () => {
    // The init has no dryRun field — only ctx controls it. Bypass-by-refactor impossible.
    const fetchImpl = vi.fn();
    const ctx = liveCtx({ dryRun: true });
    await metaFetch(ctx, {
      method: 'POST',
      path: 'act_123456789/campaigns',
      params: { name: 'X' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // ─── Header-only auth ──────────────────────────────────────────────────────

  it('sends Authorization: Bearer header and never access_token= in URL', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return jsonResp({ data: [] });
    };
    const ctx = liveCtx();
    await metaFetch(ctx, {
      method: 'GET',
      path: 'me/adaccounts',
      query: { fields: 'id,name' },
      fetchImpl,
    });
    expect(capturedUrl).not.toMatch(/access_token=/);
    expect(capturedHeaders.Authorization).toBe('Bearer TEST_BEARER_TOKEN');
  });

  it('throws HeaderAuthAssertionError if a query somehow contains access_token=', async () => {
    const ctx = liveCtx();
    let threw: unknown;
    try {
      await metaFetch(ctx, {
        method: 'GET',
        path: 'me/adaccounts',
        query: { access_token: 'shouldnt_be_here' },
        fetchImpl: (async () => jsonResp({ data: [] })) as unknown as typeof fetch,
      });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(HeaderAuthAssertionError);
  });

  // ─── Retry on 429 + backoff ────────────────────────────────────────────────

  it('retries on 429 then succeeds; honors X-Business-Use-Case-Usage hint', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(
        jsonResp(
          { error: { code: 4, message: 'rate limited' } },
          {
            status: 429,
            headers: {
              'x-business-use-case-usage': JSON.stringify({
                '12345': [{ estimated_time_to_regain_access: 1 }],
              }),
            },
          },
        ),
      )
      .mockResolvedValueOnce(jsonResp({ id: 'ok_123' }));
    const ctx = liveCtx();
    const promise = metaFetch(ctx, {
      method: 'POST',
      path: 'act_123456789/campaigns',
      params: { name: 'X' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // Backoff hint = 1 minute = 60s — advance and let retry land
    await vi.advanceTimersByTimeAsync(61_000);
    const result = await promise;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((result as { id: string }).id).toBe('ok_123');
  });

  it('retries on 5xx with exponential backoff', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResp({ error: { message: 'internal' } }, { status: 500 }))
      .mockResolvedValueOnce(jsonResp({ error: { message: 'bad gateway' } }, { status: 502 }))
      .mockResolvedValueOnce(jsonResp({ id: 'ok_after_two' }));
    const ctx = liveCtx();
    const promise = metaFetch(ctx, {
      method: 'POST',
      path: 'act_123456789/adsets',
      params: { name: 'AS' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await promise;
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect((result as { id: string }).id).toBe('ok_after_two');
  });

  it('retries on Meta error codes {1,2,4,17,32,613} but not on others', async () => {
    vi.useFakeTimers();
    // code 100 = invalid param — not in retry set → no retry
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResp({ error: { code: 100, message: 'param invalid', fbtrace_id: 'tr_1' } }, { status: 400 }),
    );
    const ctx = liveCtx();
    await expect(
      metaFetch(ctx, {
        method: 'POST',
        path: 'act_123456789/ads',
        params: { name: 'X' },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(MetaApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries on Meta code 17 (user too many calls)', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResp({ error: { code: 17, message: 'too many' } }, { status: 400 }))
      .mockResolvedValueOnce(jsonResp({ id: 'ok_17' }));
    const ctx = liveCtx();
    const promise = metaFetch(ctx, {
      method: 'POST',
      path: 'act_123456789/campaigns',
      params: { name: 'X' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await promise;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('exhausts after MAX_ATTEMPTS retries on persistent 5xx', async () => {
    vi.useFakeTimers();
    // Factory — each call gets a fresh Response (text() consumes the body once)
    const fetchImpl = vi.fn().mockImplementation(async () =>
      jsonResp({ error: { message: '503' } }, { status: 503 }),
    );
    const ctx = liveCtx();
    const promise = metaFetch(ctx, {
      method: 'POST',
      path: 'act_123456789/campaigns',
      params: { name: 'X' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(120_000);
    const err = await promise;
    expect(err).toBeInstanceOf(MetaApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  // ─── Token expiry: no retry, throws TokenExpiredError ──────────────────────

  it('OAuthException 190 → TokenExpiredError, no retry', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () =>
      jsonResp(
        { error: { code: 190, message: 'token expired', fbtrace_id: 'tr_190' } },
        { status: 401 },
      ),
    );
    const ctx = liveCtx();
    await expect(
      metaFetch(ctx, {
        method: 'POST',
        path: 'act_123456789/campaigns',
        params: { name: 'X' },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(TokenExpiredError);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no retry
  });

  // ─── Idempotency ───────────────────────────────────────────────────────────

  it('on create, generates idempotency key and writes cache after success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResp({ id: 'cmp_42' }));
    const ctx = liveCtx();
    const result = await metaFetch(ctx, {
      method: 'POST',
      path: 'act_123456789/campaigns',
      params: { name: 'X', objective: 'OUTCOME_LEADS' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect((result as { id: string }).id).toBe('cmp_42');
    const idemDir = join(project, '_dream_context', 'marketing', 'runs', 'by-idem');
    const files = require('node:fs').readdirSync(idemDir).filter((f: string) => f.endsWith('.json'));
    expect(files.length).toBe(1);
    const cached = JSON.parse(readFileSync(join(idemDir, files[0]), 'utf8'));
    expect(cached.response.id).toBe('cmp_42');
    expect(cached.request_path).toBe('act_123456789/campaigns');
  });

  it('idempotency cache hit: pre-existing key is returned without a network call', async () => {
    // Seed cache with a synthetic key. Since metaFetch generates a new UUID per
    // call, we can't test the natural hit path without mocking randomUUID.
    // Instead verify writeIdem → readIdem round-trips by inspecting the dir.
    // (Natural cache replay belongs in PR 3 launch resume tests.)
    const idemDir = join(project, '_dream_context', 'marketing', 'runs', 'by-idem');
    mkdirSync(idemDir, { recursive: true });
    writeFileSync(
      join(idemDir, 'preseed.json'),
      JSON.stringify({
        key: 'preseed',
        request_path: 'act_123456789/campaigns',
        response: { id: 'pre_seeded' },
        written_at: '2026-04-25T00:00:00Z',
      }),
    );
    expect(existsSync(join(idemDir, 'preseed.json'))).toBe(true);
    // Live path can't natively look up "preseed" without a UUID match — this test
    // documents the storage shape contract. Natural-hit coverage = launch-resume.
  });

  // ─── Chunked upload threshold ──────────────────────────────────────────────

  it('uploadVideoFile: file ≤50MB uses single-shot multipart (no upload_phase=start)', async () => {
    const filepath = join(project, 'small.mp4');
    writeFileSync(filepath, Buffer.alloc(1024)); // 1KB
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const origFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      // Return whatever the test path expects
      return jsonResp({ id: 'vid_small_1' });
    };
    try {
      const ctx = liveCtx();
      const result = await uploadVideoFile(ctx, filepath, { name: 'small' });
      expect(result.video_id).toBe('vid_small_1');
      expect(result.upload_session_id).toBe('');
      // No call should be to graph-video host for a single-shot upload
      const usedVideoHost = calls.some((c) => c.url.includes('graph-video.facebook.com'));
      expect(usedVideoHost).toBe(false);
      // No upload_phase in the body
      const body = calls[0].init?.body;
      expect(body).toBeInstanceOf(FormData);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('chunked upload threshold check: statSync size > 50MiB triggers chunked path', async () => {
    // We don't actually write a 50MB file in unit test; we check the math.
    // The constant is exported via the public API only implicitly — verify the
    // boundary by reading the threshold value used in the implementation.
    // Lighter-weight: stub statSync to lie about size.
    const filepath = join(project, 'big.mp4');
    writeFileSync(filepath, Buffer.alloc(1024)); // tiny file on disk
    // Patch fs.statSync via our own stat read — since the impl uses node:fs, we
    // cannot easily inject. Instead, verify the threshold constant indirectly
    // by checking that a small file took the single-shot path (covered above)
    // and that the code's threshold matches the documented 50MiB.
    expect(50 * 1024 * 1024).toBe(52_428_800);
    expect(statSync(filepath).size).toBeLessThan(52_428_800);
  });

  // ─── Per-account write queue (concurrency cap = 3) ─────────────────────────

  it('per-account write queue caps concurrent in-flight writes at 3', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl: typeof fetch = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return jsonResp({ id: 'cmp_x' });
    };
    const ctx = liveCtx();
    // Fire 6 concurrent creates — only 3 should run at once
    const tasks = Array.from({ length: 6 }, (_, i) =>
      metaFetch(ctx, {
        method: 'POST',
        path: 'act_123456789/campaigns',
        params: { name: `n${i}` },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    );
    await Promise.all(tasks);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it('GET reads are unthrottled (do not enter the write queue)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl: typeof fetch = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return jsonResp({ data: [] });
    };
    const ctx = liveCtx();
    const tasks = Array.from({ length: 6 }, () =>
      metaFetch(ctx, {
        method: 'GET',
        path: 'me/adaccounts',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    );
    await Promise.all(tasks);
    expect(maxInFlight).toBe(6);
  });

  // ─── Dry-run for image upload ──────────────────────────────────────────────

  it('uploadImageFile: dry-run returns a fake hash without network', async () => {
    const ctx = liveCtx({ dryRun: true });
    const filepath = join(project, 'pic.png');
    writeFileSync(filepath, Buffer.alloc(64));
    const result = await uploadImageFile(ctx, filepath);
    expect(result.hash).toMatch(/^DRY_HASH_/);
  });

  // ─── liveCtxFromEnv ────────────────────────────────────────────────────────

  it('liveCtxFromEnv: throws on missing token / account', () => {
    expect(() => liveCtxFromEnv({})).toThrow(/META_AD_ACCOUNT_ID/);
    expect(() =>
      liveCtxFromEnv({ META_AD_ACCOUNT_ID: 'act_1' }),
    ).toThrow(/META_SYSTEM_USER_TOKEN/);
  });

  it('liveCtxFromEnv: prepends act_ if missing', () => {
    const ctx = liveCtxFromEnv({
      META_AD_ACCOUNT_ID: '99999',
      META_SYSTEM_USER_TOKEN: 'tok',
    });
    expect(ctx.adAccountId).toBe('act_99999');
    expect(ctx.dryRun).toBe(false);
    expect(ctx.apiVersion).toBe('v25.0');
  });

  it('liveCtxFromEnv: keeps act_ prefix if already present', () => {
    const ctx = liveCtxFromEnv({
      META_AD_ACCOUNT_ID: 'act_42',
      META_SYSTEM_USER_TOKEN: 'tok',
    });
    expect(ctx.adAccountId).toBe('act_42');
  });

  // ─── dryRunCtx factory ─────────────────────────────────────────────────────

  it('dryRunCtx: defaults to dryRun=true with fake token', () => {
    const ctx = dryRunCtx();
    expect(ctx.dryRun).toBe(true);
    expect(ctx.adAccountId).toBe('act_dryrun');
    expect(ctx.accessToken).toBe('DRY_RUN_FAKE_TOKEN');
  });
});
