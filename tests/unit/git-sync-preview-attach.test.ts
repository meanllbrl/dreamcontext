import { describe, it, expect } from 'vitest';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import { previewAttach, parseRepoSlug } from '../../src/lib/git-sync/brain-repo.js';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('git-sync/brain-repo — parseRepoSlug', () => {
  it('parses https, .git-suffixed, and short forms', () => {
    expect(parseRepoSlug('https://github.com/acme/brain.git')).toEqual({ owner: 'acme', repo: 'brain' });
    expect(parseRepoSlug('https://github.com/acme/brain')).toEqual({ owner: 'acme', repo: 'brain' });
    expect(parseRepoSlug('acme/brain')).toEqual({ owner: 'acme', repo: 'brain' });
    expect(parseRepoSlug('not a url')).toBeNull();
  });
});

describe('git-sync/brain-repo — previewAttach (READ-ONLY, S6 surface)', () => {
  function makeAdapter(requests: { method: string; path: string }[], topics: string[] = ['dreamcontext-brain']) {
    return new ApiAdapter({
      baseUrl: 'https://api.github.com',
      authHeaders: () => ({ Authorization: 'token x' }),
      fetchImpl: (async (url: string, init?: RequestInit) => {
        const u = new URL(String(url));
        const method = (init?.method ?? 'GET').toUpperCase();
        requests.push({ method, path: u.pathname });
        if (u.pathname === '/repos/acme/brain' && method === 'GET') {
          return jsonResponse(200, { full_name: 'acme/brain', private: true, default_branch: 'main' });
        }
        if (u.pathname === '/repos/acme/brain/topics' && method === 'GET') {
          return jsonResponse(200, { names: topics });
        }
        return jsonResponse(404, { message: 'unhandled' });
      }) as typeof fetch,
    });
  }

  it('does not mutate — only GETs the repo + topics', async () => {
    const requests: { method: string; path: string }[] = [];
    const adapter = makeAdapter(requests);
    const result = await previewAttach({ projectRoot: '/tmp', url: 'https://github.com/acme/brain.git', adapter });

    expect(result.reachable).toBe(true);
    expect(result.fullName).toBe('acme/brain');
    expect(result.private).toBe(true);
    expect(result.isBrainRepo).toBe(true);
    expect(result.defaultBranch).toBe('main');
    // Every request is a GET — no POST/PUT/PATCH/DELETE mutation.
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('flags a repo without the brain topic as not a brain repo', async () => {
    const requests: { method: string; path: string }[] = [];
    const adapter = makeAdapter(requests, ['some-other-topic']);
    const result = await previewAttach({ projectRoot: '/tmp', url: 'acme/brain', adapter });
    expect(result.reachable).toBe(true);
    expect(result.isBrainRepo).toBe(false);
  });

  it('returns { reachable:false, reason } for an unparseable URL without any request', async () => {
    const requests: { method: string; path: string }[] = [];
    const adapter = makeAdapter(requests);
    const result = await previewAttach({ projectRoot: '/tmp', url: 'garbage', adapter });
    expect(result.reachable).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(requests.length).toBe(0);
  });

  it('returns { reachable:false } when the repo 404s', async () => {
    const adapter = new ApiAdapter({
      baseUrl: 'https://api.github.com',
      authHeaders: () => ({ Authorization: 'token x' }),
      fetchImpl: (async () => jsonResponse(404, { message: 'Not Found' })) as typeof fetch,
    });
    const result = await previewAttach({ projectRoot: '/tmp', url: 'acme/missing', adapter });
    expect(result.reachable).toBe(false);
  });
});
