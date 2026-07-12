import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import { ApiError } from '../../src/lib/task-backend/api-adapter.js';
import {
  listGitHubRepos,
  cloneGitHubRepo,
  planGitHubClone,
  resolveLauncherGitHubToken,
} from '../../src/lib/git-sync/github-browse.js';
import { writeGlobalGitHubToken } from '../../src/lib/git-sync/auth-store.js';
import { GitSyncError } from '../../src/lib/git-sync/git.js';

interface AdapterCall { method: string; path: string; opts: { body?: unknown; query?: Record<string, unknown> } }
/** A fake ApiAdapter that records requests and returns a canned handler result. */
function fakeAdapter(handler: (call: AdapterCall) => unknown) {
  const calls: AdapterCall[] = [];
  const adapter = {
    request: async (method: string, path: string, opts: { body?: unknown; query?: Record<string, unknown> } = {}) => {
      const call = { method, path, opts };
      calls.push(call);
      const r = handler(call);
      if (r instanceof Error) throw r;
      return r;
    },
  } as unknown as ApiAdapter;
  return { adapter, calls };
}

function repo(fullName: string, extra: Partial<Record<string, unknown>> = {}) {
  return {
    full_name: fullName,
    private: false,
    description: null,
    default_branch: 'main',
    pushed_at: '2026-07-01T00:00:00Z',
    ...extra,
  };
}

// ─── resolveLauncherGitHubToken ────────────────────────────────────────────────

describe('resolveLauncherGitHubToken', () => {
  let tmpHome: string;
  let savedGithubToken: string | undefined;
  let savedGhToken: string | undefined;

  beforeEach(() => {
    tmpHome = join(tmpdir(), `dc-ghbrowse-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpHome, { recursive: true });
    savedGithubToken = process.env.GITHUB_TOKEN;
    savedGhToken = process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });

  afterEach(() => {
    if (savedGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedGithubToken;
    if (savedGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = savedGhToken;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns null with no global token and no env', () => {
    expect(resolveLauncherGitHubToken(tmpHome)).toBeNull();
  });

  it('prefers the global signed-in token over env', () => {
    writeGlobalGitHubToken('ghp_global', tmpHome);
    process.env.GITHUB_TOKEN = 'ghp_env';
    expect(resolveLauncherGitHubToken(tmpHome)?.token).toBe('ghp_global');
  });

  it('falls back to GITHUB_TOKEN / GH_TOKEN env', () => {
    process.env.GH_TOKEN = 'ghp_env2';
    const resolved = resolveLauncherGitHubToken(tmpHome);
    expect(resolved?.token).toBe('ghp_env2');
    expect(resolved?.source).toBe('env');
  });
});

// ─── listGitHubRepos ───────────────────────────────────────────────────────────

describe('listGitHubRepos', () => {
  it('lists the user repos and maps to summaries', async () => {
    const { adapter, calls } = fakeAdapter(() => [repo('acme/api', { private: true, description: 'the API' })]);
    const repos = await listGitHubRepos({ token: 't', adapter });
    expect(repos).toEqual([
      {
        fullName: 'acme/api',
        private: true,
        description: 'the API',
        defaultBranch: 'main',
        pushedAt: '2026-07-01T00:00:00Z',
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/user/repos');
    expect(calls[0].opts.query).toMatchObject({
      sort: 'pushed',
      affiliation: 'owner,collaborator,organization_member',
      page: 1,
    });
  });

  it('paginates while pages are full and stops at a short page', async () => {
    const { adapter, calls } = fakeAdapter((call) => {
      const page = Number(call.opts.query?.page);
      if (page === 1) return Array.from({ length: 100 }, (_, i) => repo(`acme/p1-${i}`));
      return [repo('acme/p2-last')];
    });
    const repos = await listGitHubRepos({ token: 't', adapter });
    expect(calls.filter((c) => c.path === '/user/repos')).toHaveLength(2);
    // Capped at 50 for the picker.
    expect(repos).toHaveLength(50);
  });

  it('filters by case-insensitive substring on full_name', async () => {
    const { adapter } = fakeAdapter(() => [repo('acme/api'), repo('acme/website'), repo('other/API-tools')]);
    const repos = await listGitHubRepos({ token: 't', query: 'api', adapter });
    expect(repos.map((r) => r.fullName)).toEqual(['acme/api', 'other/API-tools']);
  });

  it('owner/repo query tries a direct lookup and prepends the hit', async () => {
    const { adapter, calls } = fakeAdapter((call) =>
      call.path === '/repos/someone/else' ? repo('someone/else') : [repo('acme/api')],
    );
    const repos = await listGitHubRepos({ token: 't', query: 'someone/else', adapter });
    expect(calls.some((c) => c.path === '/repos/someone/else')).toBe(true);
    expect(repos[0].fullName).toBe('someone/else');
  });

  it('skips the direct lookup when the exact repo is already in the list', async () => {
    const { adapter, calls } = fakeAdapter(() => [repo('acme/api')]);
    await listGitHubRepos({ token: 't', query: 'acme/api', adapter });
    expect(calls.every((c) => c.path === '/user/repos')).toBe(true);
  });

  it('swallows a 404 from the direct lookup (repo simply not found)', async () => {
    const { adapter } = fakeAdapter((call) =>
      call.path.startsWith('/repos/') ? new ApiError('not_found', 'nope', 404) : [repo('acme/api')],
    );
    const repos = await listGitHubRepos({ token: 't', query: 'ghost/repo', adapter });
    expect(repos).toEqual([]);
  });

  it('propagates auth errors', async () => {
    const { adapter } = fakeAdapter(() => new ApiError('auth', 'bad credentials', 401));
    await expect(listGitHubRepos({ token: 't', adapter })).rejects.toMatchObject({ kind: 'auth' });
  });
});

// ─── cloneGitHubRepo ───────────────────────────────────────────────────────────

describe('cloneGitHubRepo', () => {
  let parent: string;

  /** Fake git module: records the call, streams fake progress, fabricates the dest folder. */
  function fakeGit(opts: { withContext?: boolean } = {}) {
    const calls: { url: string; dest: string; env: NodeJS.ProcessEnv }[] = [];
    return {
      calls,
      module: {
        cloneStreaming: (
          url: string,
          dest: string,
          env: NodeJS.ProcessEnv,
          onProgress?: (chunk: string) => void,
        ) => ({
          promise: (async () => {
            calls.push({ url, dest, env: { ...env } });
            onProgress?.('Receiving objects: 100%\r');
            mkdirSync(opts.withContext ? join(dest, '_dream_context') : dest, { recursive: true });
          })(),
          cancel: () => {},
        }),
      },
    };
  }

  beforeEach(() => {
    parent = join(tmpdir(), `dc-ghclone-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(parent, { recursive: true });
  });

  afterEach(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it('rejects a non-GitHub URL before any git call', async () => {
    const git = fakeGit();
    await expect(
      cloneGitHubRepo({ url: 'ext::sh -c whoami', parentDir: parent, token: 't', gitModule: git.module }),
    ).rejects.toBeInstanceOf(GitSyncError);
    expect(git.calls).toHaveLength(0);
  });

  it('rejects a relative parentDir', async () => {
    const git = fakeGit();
    await expect(
      cloneGitHubRepo({ url: 'acme/api', parentDir: 'relative/dir', token: 't', gitModule: git.module }),
    ).rejects.toThrow(/absolute/);
    expect(git.calls).toHaveLength(0);
  });

  it('rejects a missing parent directory', async () => {
    const git = fakeGit();
    await expect(
      cloneGitHubRepo({ url: 'acme/api', parentDir: join(parent, 'nope'), token: 't', gitModule: git.module }),
    ).rejects.toThrow(/does not exist/);
    expect(git.calls).toHaveLength(0);
  });

  it('rejects when the destination folder already exists', async () => {
    mkdirSync(join(parent, 'api'));
    const git = fakeGit();
    await expect(
      cloneGitHubRepo({ url: 'acme/api', parentDir: parent, token: 't', gitModule: git.module }),
    ).rejects.toThrow(/already exists/);
    expect(git.calls).toHaveLength(0);
  });

  it('clones with the CANONICAL https URL and an askpass-credentialed env', async () => {
    const git = fakeGit();
    const result = await cloneGitHubRepo({
      url: 'git@github.com:acme/api.git',
      parentDir: parent,
      token: 'sekret',
      gitModule: git.module,
    });
    expect(git.calls).toHaveLength(1);
    expect(git.calls[0].url).toBe('https://github.com/acme/api.git');
    expect(git.calls[0].dest).toBe(join(parent, 'api'));
    // Token flows via the askpass contract, never in env values directly.
    expect(git.calls[0].env.GIT_ASKPASS).toBeTruthy();
    expect(git.calls[0].env.DREAMCONTEXT_ASKPASS_TOKEN_FILE).toBeTruthy();
    expect(Object.values(git.calls[0].env)).not.toContain('sekret');
    // The tmp token file is unlinked once the clone resolves.
    expect(existsSync(git.calls[0].env.DREAMCONTEXT_ASKPASS_TOKEN_FILE as string)).toBe(false);
    expect(result).toEqual({ path: join(parent, 'api'), name: 'api', hasContext: false });
  });

  it('reports hasContext when the clone already carries _dream_context/', async () => {
    const git = fakeGit({ withContext: true });
    const result = await cloneGitHubRepo({ url: 'acme/brainy', parentDir: parent, token: 't', gitModule: git.module });
    expect(result.hasContext).toBe(true);
    expect(result.name).toBe('brainy');
  });

  it('streams progress and exposes a cancel handle', async () => {
    const git = fakeGit();
    const chunks: string[] = [];
    let cancel: (() => void) | null = null;
    await cloneGitHubRepo({
      url: 'acme/api',
      parentDir: parent,
      token: 't',
      gitModule: git.module,
      onProgress: (c) => chunks.push(c),
      registerCancel: (c) => { cancel = c; },
    });
    expect(chunks.join('')).toContain('Receiving objects');
    expect(typeof cancel).toBe('function');
  });

  it('planGitHubClone validates without any git call and returns the canonical plan', () => {
    const plan = planGitHubClone('git@github.com:acme/api.git', parent);
    expect(plan).toEqual({
      cloneUrl: 'https://github.com/acme/api.git',
      dest: join(parent, 'api'),
      name: 'api',
    });
    expect(() => planGitHubClone('not a url at all !!!', parent)).toThrow(GitSyncError);
  });
});
