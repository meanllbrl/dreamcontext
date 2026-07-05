import { describe, it, expect } from 'vitest';
import { genericHttpAdapter } from '../../src/lib/lab/adapters/generic-http.js';
import { LabError, type AdapterContext, type HttpSource, type InsightManifest } from '../../src/lib/lab/types.js';

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface CapturedCall { url: string; method: string; body?: string }

function makeFetch(responder: (call: CapturedCall) => Response): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const call: CapturedCall = { url: String(url), method: init?.method ?? 'GET', body: init?.body as string | undefined };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function httpManifest(source: Partial<HttpSource>): InsightManifest {
  return {
    slug: 'x',
    title: 'X',
    description: null,
    group: null,
    render: 'number',
    source: {
      adapter: 'http',
      endpoint: 'https://api.example.test/v1/metric?range={{tweak:range}}',
      method: 'GET',
      headers: {},
      body: null,
      extract: { seriesPath: 'data', seriesKey: null, x: 'date', y: 'value', agg: 'last' },
      ...source,
    },
    refresh: { ttl_minutes: 1440 },
    tweaks: [],
    binding: null,
    credentials_used: [],
    unit: null,
    path: '/tmp/lab/insights/x.md',
    body: '',
  };
}

function ctx(manifest: InsightManifest, fetchImpl: typeof fetch, opts: Partial<AdapterContext> = {}): AdapterContext {
  return {
    manifest,
    resolvedTweaks: { values: { range: '30d' }, range: { fromISO: '2026-01-01', toISO: '2026-02-01' }, spanDays: 30 },
    credentials: {},
    fetchImpl,
    ...opts,
  };
}

describe('generic-http adapter — GET extraction', () => {
  it('extracts seriesPath and splits a seriesKey response into >=2 series (A/B)', async () => {
    const { fetchImpl } = makeFetch(() => fakeResponse(200, {
      data: [
        { date: '2026-01-01', value: 10, plan: 'A' },
        { date: '2026-01-02', value: 20, plan: 'A' },
        { date: '2026-01-01', value: 5, plan: 'B' },
      ],
    }));
    const manifest = httpManifest({ extract: { seriesPath: 'data', seriesKey: 'plan', x: 'date', y: 'value', agg: 'last' } });
    const series = await genericHttpAdapter.fetch(ctx(manifest, fetchImpl));
    expect(series.length).toBeGreaterThanOrEqual(2);
    const names = series.map((s) => s.name).sort();
    expect(names).toEqual(['A', 'B']);
  });

  it('GET URL fidelity: the observed request URL equals the resolved endpoint byte-for-byte', async () => {
    const { fetchImpl, calls } = makeFetch(() => fakeResponse(200, { data: [] }));
    const manifest = httpManifest({ endpoint: 'https://api.example.test/v1/metric?range={{tweak:range}}' });
    await genericHttpAdapter.fetch(ctx(manifest, fetchImpl));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.example.test/v1/metric?range=30d');
    // No trailing slash, no corrupted final param.
    expect(calls[0].url.endsWith('/')).toBe(false);
  });
});

describe('generic-http adapter — POST body', () => {
  it('a body template resolving to valid JSON is sent ONCE, not double-encoded', async () => {
    const { fetchImpl, calls } = makeFetch(() => fakeResponse(200, { data: [] }));
    const manifest = httpManifest({
      method: 'POST',
      endpoint: 'https://api.example.test/v1/query',
      body: '{"metric": "{{tweak:range}}"}',
    });
    await genericHttpAdapter.fetch(ctx(manifest, fetchImpl));
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    // The fake transport received a single-encoded JSON object as the body —
    // parsing it once yields the object, not a JSON string (double-encoded).
    const parsed = JSON.parse(calls[0].body!);
    expect(parsed).toEqual({ metric: '30d' });
  });

  it('POST URL fidelity: the observed URL equals the resolved endpoint byte-for-byte', async () => {
    const { fetchImpl, calls } = makeFetch(() => fakeResponse(200, { data: [] }));
    const manifest = httpManifest({
      method: 'POST',
      endpoint: 'https://api.example.test/v1/query?range={{tweak:range}}',
      body: '{}',
    });
    await genericHttpAdapter.fetch(ctx(manifest, fetchImpl));
    expect(calls[0].url).toBe('https://api.example.test/v1/query?range=30d');
  });

  it('an invalid-JSON body template throws a loud LabError', async () => {
    const { fetchImpl } = makeFetch(() => fakeResponse(200, { data: [] }));
    const manifest = httpManifest({
      method: 'POST',
      endpoint: 'https://api.example.test/v1/query',
      body: '{not valid json',
    });
    await expect(genericHttpAdapter.fetch(ctx(manifest, fetchImpl))).rejects.toThrow(LabError);
  });
});

describe('generic-http adapter — redaction', () => {
  it('a non-2xx failure throws a LabError built from the redacted endpoint only', async () => {
    // 404 (not 5xx/429) so the underlying ApiAdapter throws immediately with no
    // retry/backoff delay — keeps this test fast without touching production timing.
    const { fetchImpl } = makeFetch(() => ({
      ok: false,
      status: 404,
      headers: { get: () => null },
      text: async () => 'super-secret-body-snippet',
    } as unknown as Response));
    const manifest = httpManifest({ endpoint: 'https://api.example.test/v1/metric?key={{cred:apiKey}}' });
    const err = await genericHttpAdapter.fetch(ctx(manifest, fetchImpl, { credentials: { apiKey: 'sk-super-secret' } })).catch((e) => e);
    expect(err).toBeInstanceOf(LabError);
    expect((err as Error).message).not.toContain('sk-super-secret');
    expect((err as Error).message).not.toContain('super-secret-body-snippet');
    expect((err as Error).message).toContain('***');
  });
});
