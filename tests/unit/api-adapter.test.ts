import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiAdapter, ApiError } from '../../src/lib/task-backend/api-adapter.js';

/**
 * Generic REST adapter — issue #11 M2.
 * Rate-limit queue (~100 req/min), retry/backoff, normalized errors.
 * Tests run on an injected clock + sleeper, so they complete instantly.
 */

interface FakeCall {
  url: string;
  method: string;
  at: number;
  headers: Record<string, string>;
  body?: string;
}

function fakeResponse(status: number, body: unknown = {}, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

function makeHarness(responses: Array<(call: FakeCall) => Response | Error>, opts: Partial<ConstructorParameters<typeof ApiAdapter>[0]> = {}) {
  let t = 0;
  const sleeps: number[] = [];
  const calls: FakeCall[] = [];
  let i = 0;

  const adapter = new ApiAdapter({
    baseUrl: 'https://api.example.test/v2',
    authHeaders: () => ({ Authorization: 'tok_test' }),
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      const call: FakeCall = {
        url: String(url),
        method: init?.method ?? 'GET',
        at: t,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body as string | undefined,
      };
      calls.push(call);
      const r = (responses[Math.min(i, responses.length - 1)] ?? (() => fakeResponse(200)))(call);
      i++;
      if (r instanceof Error) throw r;
      return r;
    }) as typeof fetch,
    ...opts,
  });

  return { adapter, calls, sleeps, time: () => t };
}

describe('ApiAdapter (generic REST adapter — M2)', () => {
  it('ApiAdapter is backend-generic: auth header + base URL config, no provider types in the module', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'lib', 'task-backend', 'api-adapter.ts'),
      'utf-8',
    );
    // The boundary test for the adapter design: nothing provider-specific.
    expect(src.toLowerCase()).not.toContain('clickup');
    expect(src.toLowerCase()).not.toContain('github');
    expect(src.toLowerCase()).not.toContain('linear');
    expect(src).not.toContain('mcp');
  });

  it('sends auth headers and serializes the JSON body', async () => {
    const { adapter, calls } = makeHarness([() => fakeResponse(200, { ok: true })]);
    const result = await adapter.request<{ ok: boolean }>('POST', '/task', {
      body: { name: 'x' },
      query: { page: 0 },
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.Authorization).toBe('tok_test');
    expect(calls[0].url).toBe('https://api.example.test/v2/task?page=0');
    expect(calls[0].body).toBe('{"name":"x"}');
  });

  it('rate-limit queue keeps under the per-minute budget (sliding window)', async () => {
    const { adapter, calls } = makeHarness([() => fakeResponse(200, {})], { ratePerMinute: 3 });
    await Promise.all(
      Array.from({ length: 7 }, (_, n) => adapter.request('GET', `/r/${n}`)),
    );
    expect(calls).toHaveLength(7);
    // In every 60s window at most 3 dispatches.
    for (const c of calls) {
      const inWindow = calls.filter((o) => o.at > c.at - 60_000 && o.at <= c.at);
      expect(inWindow.length).toBeLessThanOrEqual(3);
    }
    // The 4th call had to wait a full window.
    expect(calls[3].at).toBeGreaterThanOrEqual(60_000);
  });

  it('retries 429 with backoff and honors Retry-After', async () => {
    const { adapter, calls, sleeps } = makeHarness([
      () => fakeResponse(429, { err: 'slow down' }, { 'retry-after': '7' }),
      () => fakeResponse(200, { ok: 1 }),
    ]);
    const res = await adapter.request<{ ok: number }>('PUT', '/task/1');
    expect(res).toEqual({ ok: 1 });
    expect(calls).toHaveLength(2);
    expect(sleeps).toContain(7000); // Retry-After: 7 → 7000ms
  });

  it('retries 5xx with exponential backoff, then surfaces a normalized server error', async () => {
    const { adapter, calls } = makeHarness([() => fakeResponse(503, { boom: 1 })], { maxRetries: 2 });
    await expect(adapter.request('GET', '/x')).rejects.toMatchObject({
      name: 'ApiError',
      kind: 'server',
      status: 503,
    });
    expect(calls).toHaveLength(3); // initial + 2 retries
  });

  it('retries network failures and normalizes them', async () => {
    const { adapter, calls } = makeHarness([() => new Error('ECONNREFUSED')], { maxRetries: 1 });
    await expect(adapter.request('GET', '/x')).rejects.toMatchObject({
      name: 'ApiError',
      kind: 'network',
    });
    expect(calls).toHaveLength(2);
  });

  it('normalizes timeouts (AbortError) as kind=timeout', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const { adapter } = makeHarness([() => abortErr], { maxRetries: 0 });
    await expect(adapter.request('GET', '/x')).rejects.toMatchObject({
      kind: 'timeout',
    });
  });

  it('does NOT retry auth/not_found/4xx — fails fast with typed errors', async () => {
    for (const [status, kind] of [[401, 'auth'], [403, 'auth'], [404, 'not_found'], [400, 'invalid']] as const) {
      const { adapter, calls } = makeHarness([() => fakeResponse(status, { e: 1 })]);
      await expect(adapter.request('GET', '/x')).rejects.toMatchObject({ kind, status });
      expect(calls).toHaveLength(1);
    }
  });

  it('one failed request does not poison the queue for later requests', async () => {
    const { adapter } = makeHarness([
      () => fakeResponse(404, {}),
      () => fakeResponse(200, { fine: true }),
    ]);
    await expect(adapter.request('GET', '/gone')).rejects.toBeInstanceOf(ApiError);
    await expect(adapter.request('GET', '/ok')).resolves.toEqual({ fine: true });
  });
});
