import { describe, it, expect } from 'vitest';
import type * as gitModule from '../../src/lib/git-sync/git.js';
import { ApiAdapter, ApiError } from '../../src/lib/task-backend/api-adapter.js';
import {
  parseRepoSlug,
  sanitizeRepoName,
  setProjectOrigin,
  createProjectOrigin,
  attachProjectOrigin,
  previewOrigin,
  detachProjectOrigin,
} from '../../src/lib/git-sync/origin-setup.js';

// ─── Fakes ─────────────────────────────────────────────────────────────────

/** A stateful fake of the git module — records init + remote wiring, no real git. */
function fakeGit(initial: { isRepo?: boolean; origin?: string | null } = {}) {
  const state = { isRepo: initial.isRepo ?? false, origin: initial.origin ?? null as string | null, calls: [] as string[] };
  const module = {
    isGitRepo: () => state.isRepo,
    initRepo: () => { state.isRepo = true; state.calls.push('init'); },
    getRemoteUrl: (_cwd: string, name: string) => (name === 'origin' ? state.origin : null),
    addRemote: (_cwd: string, name: string, url: string) => { if (name === 'origin') state.origin = url; state.calls.push(`add:${url}`); },
    setRemoteUrl: (_cwd: string, name: string, url: string) => { if (name === 'origin') state.origin = url; state.calls.push(`set:${url}`); },
    removeRemote: (_cwd: string, name: string) => { if (name === 'origin') state.origin = null; state.calls.push(`remove:${name}`); },
  } as unknown as typeof gitModule;
  return { module, state };
}

interface AdapterCall { method: string; path: string; opts: { body?: unknown; query?: unknown } }
/** A fake ApiAdapter that records requests and returns a canned handler result. */
function fakeAdapter(handler: (call: AdapterCall) => unknown) {
  const calls: AdapterCall[] = [];
  const adapter = {
    request: async (method: string, path: string, opts: { body?: unknown; query?: unknown } = {}) => {
      const call = { method, path, opts };
      calls.push(call);
      const r = handler(call);
      if (r instanceof Error) throw r;
      return r;
    },
  } as unknown as ApiAdapter;
  return { adapter, calls };
}

// ─── parseRepoSlug ───────────────────────────────────────────────────────────

describe('parseRepoSlug', () => {
  it('parses https, ssh, owner/repo, and .git / trailing-slash forms', () => {
    expect(parseRepoSlug('https://github.com/acme/proj.git')).toEqual({ owner: 'acme', repo: 'proj' });
    expect(parseRepoSlug('https://github.com/acme/proj/')).toEqual({ owner: 'acme', repo: 'proj' });
    expect(parseRepoSlug('git@github.com:acme/proj.git')).toEqual({ owner: 'acme', repo: 'proj' });
    expect(parseRepoSlug('acme/proj')).toEqual({ owner: 'acme', repo: 'proj' });
  });
  it('returns null for a non-repo string', () => {
    expect(parseRepoSlug('not a url')).toBeNull();
    expect(parseRepoSlug('https://example.com/foo')).toBeNull();
  });
});

// ─── sanitizeRepoName ────────────────────────────────────────────────────────

describe('sanitizeRepoName', () => {
  it('keeps legal chars, collapses the rest to "-", trims separators', () => {
    expect(sanitizeRepoName('My Proj')).toBe('My-Proj');
    expect(sanitizeRepoName('  spaces  ')).toBe('spaces');
    expect(sanitizeRepoName('a/b:c')).toBe('a-b-c');
    expect(sanitizeRepoName('keep_this.name-1')).toBe('keep_this.name-1');
  });
  it('returns null when nothing usable survives', () => {
    expect(sanitizeRepoName('   ')).toBeNull();
    expect(sanitizeRepoName('///')).toBeNull();
  });
});

// ─── setProjectOrigin ────────────────────────────────────────────────────────

describe('setProjectOrigin', () => {
  it('inits the repo and adds origin when the project is not a repo', () => {
    const { module, state } = fakeGit({ isRepo: false });
    setProjectOrigin('/p', 'https://github.com/a/b.git', module);
    expect(state.calls).toContain('init');
    expect(state.calls).toContain('add:https://github.com/a/b.git');
    expect(state.origin).toBe('https://github.com/a/b.git');
  });
  it('replaces an existing origin instead of erroring', () => {
    const { module, state } = fakeGit({ isRepo: true, origin: 'https://github.com/a/old.git' });
    setProjectOrigin('/p', 'https://github.com/a/new.git', module);
    expect(state.calls).toContain('set:https://github.com/a/new.git');
    expect(state.calls).not.toContain('init');
    expect(state.origin).toBe('https://github.com/a/new.git');
  });
});

// ─── createProjectOrigin ─────────────────────────────────────────────────────

describe('createProjectOrigin', () => {
  it('POSTs a PRIVATE repo (sanitized name), wires the canonical https origin', async () => {
    const { adapter, calls } = fakeAdapter(() => ({ full_name: 'meanllbrl/my-proj', private: true }));
    const { module, state } = fakeGit({ isRepo: true, origin: null });
    const r = await createProjectOrigin({ projectRoot: '/p', name: 'My Proj', adapter, gitModule: module });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/user/repos' });
    expect(calls[0].opts.body).toEqual({ name: 'My-Proj', private: true });
    expect(r.remote).toBe('https://github.com/meanllbrl/my-proj.git');
    expect(r.fullName).toBe('meanllbrl/my-proj');
    expect(state.origin).toBe('https://github.com/meanllbrl/my-proj.git');
  });

  it('refuses a PUBLIC repo without confirmation (S5) and makes no API call', async () => {
    const { adapter, calls } = fakeAdapter(() => ({ full_name: 'o/x', private: false }));
    const { module } = fakeGit({ isRepo: true });
    await expect(createProjectOrigin({ projectRoot: '/p', name: 'x', private: false, adapter, gitModule: module }))
      .rejects.toThrow(/confirmation/i);
    expect(calls).toHaveLength(0);
  });

  it('creates a PUBLIC repo when confirmed (body private:false)', async () => {
    const { adapter, calls } = fakeAdapter(() => ({ full_name: 'o/x', private: false }));
    const { module } = fakeGit({ isRepo: true });
    await createProjectOrigin({ projectRoot: '/p', name: 'x', private: false, confirmed: true, adapter, gitModule: module });
    expect(calls[0].opts.body).toEqual({ name: 'x', private: false });
  });
});

// ─── attachProjectOrigin ─────────────────────────────────────────────────────

describe('attachProjectOrigin', () => {
  it('wires the canonical https origin from any accepted URL form', () => {
    for (const url of ['https://github.com/acme/repo.git', 'git@github.com:acme/repo.git', 'acme/repo']) {
      const { module, state } = fakeGit({ isRepo: false });
      const r = attachProjectOrigin({ projectRoot: '/p', url, gitModule: module });
      expect(r.remote).toBe('https://github.com/acme/repo.git');
      expect(state.isRepo).toBe(true); // git-inited
      expect(state.origin).toBe('https://github.com/acme/repo.git');
    }
  });
  it('throws on a URL that is not a GitHub repo', () => {
    const { module } = fakeGit({ isRepo: true });
    expect(() => attachProjectOrigin({ projectRoot: '/p', url: 'not a url', gitModule: module })).toThrow(/GitHub repo URL/);
  });
});

// ─── detachProjectOrigin ─────────────────────────────────────────────────────

describe('detachProjectOrigin', () => {
  it('removes an existing origin', () => {
    const { module, state } = fakeGit({ isRepo: true, origin: 'https://github.com/a/b.git' });
    detachProjectOrigin('/p', module);
    expect(state.calls).toContain('remove:origin');
    expect(state.origin).toBeNull();
  });
  it('is a no-op when there is no origin (never calls removeRemote)', () => {
    const { module, state } = fakeGit({ isRepo: true, origin: null });
    detachProjectOrigin('/p', module);
    expect(state.calls).not.toContain('remove:origin');
  });
  it('is a no-op when the project is not a git repo', () => {
    const { module, state } = fakeGit({ isRepo: false });
    detachProjectOrigin('/p', module);
    expect(state.calls).toEqual([]);
  });
});

// ─── previewOrigin (read-only) ───────────────────────────────────────────────

describe('previewOrigin', () => {
  it('returns reachable metadata for a readable repo', async () => {
    const { adapter } = fakeAdapter(() => ({ full_name: 'a/b', private: true, default_branch: 'main' }));
    const r = await previewOrigin({ projectRoot: '/p', url: 'https://github.com/a/b', adapter });
    expect(r).toMatchObject({ reachable: true, fullName: 'a/b', private: true, defaultBranch: 'main', empty: false });
  });
  it('flags an empty repo (no default branch yet)', async () => {
    const { adapter } = fakeAdapter(() => ({ full_name: 'a/b', private: true }));
    const r = await previewOrigin({ projectRoot: '/p', url: 'a/b', adapter });
    expect(r.reachable).toBe(true);
    expect(r.empty).toBe(true);
  });
  it('returns { reachable:false } with a reason on a bad URL (no API call)', async () => {
    const { adapter, calls } = fakeAdapter(() => ({}));
    const r = await previewOrigin({ projectRoot: '/p', url: 'not a url', adapter });
    expect(r.reachable).toBe(false);
    expect(r.reason).toMatch(/GitHub repo URL/);
    expect(calls).toHaveLength(0);
  });
  it('returns { reachable:false } with the error message when the repo is unreadable', async () => {
    const { adapter } = fakeAdapter(() => new ApiError('not_found', 'Repository not found', 404));
    const r = await previewOrigin({ projectRoot: '/p', url: 'a/missing', adapter });
    expect(r.reachable).toBe(false);
    expect(r.reason).toMatch(/not found/i);
  });
});

// ApiAdapter import kept live so the real type backs the fakes (compile-time only).
void ApiAdapter;
