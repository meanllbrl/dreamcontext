import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import { writeGitHubToken } from '../../src/lib/task-backend/secrets.js';
import * as git from '../../src/lib/git-sync/git.js';
import {
  resolveMode,
  resolveBrainSyncEnabled,
  resolveBrainSyncToken,
  isOwnRepoRoot,
  buildBrainGitignore,
  bootstrapBrainRepo,
  createBrainRepo,
  attachBrainRepo,
  acquireBrainLock,
  releaseBrainLock,
} from '../../src/lib/git-sync/brain-repo.js';

function sh(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('git-sync/brain-repo — resolveMode', () => {
  it('defaults to in-tree when unset or unspecified', () => {
    expect(resolveMode(null)).toBe('in-tree');
    expect(resolveMode({ platforms: [], packs: [], multiProduct: false, setupVersion: '1', disableNativeMemory: true })).toBe('in-tree');
  });

  it('resolves separate only when explicitly configured', () => {
    expect(
      resolveMode({
        platforms: [], packs: [], multiProduct: false, setupVersion: '1', disableNativeMemory: true,
        brainRepo: { mode: 'separate' },
      }),
    ).toBe('separate');
  });
});

describe('git-sync/brain-repo — buildBrainGitignore', () => {
  it('gitignores task markdown only under a remote task backend', () => {
    const local = buildBrainGitignore('local');
    const github = buildBrainGitignore('github');
    expect(local).not.toContain('state/*.md');
    expect(github).toContain('state/*.md');
  });

  it('always gitignores secrets/session/merge-state', () => {
    const gi = buildBrainGitignore();
    expect(gi).toContain('state/.secrets.json');
    expect(gi).toContain('state/.brain-merge/');
    expect(gi).toContain('state/.brain-local.json');
  });
});

describe('git-sync/brain-repo — resolveBrainSyncEnabled (v3.3 master switch)', () => {
  const fakeGit = { isGitRepo: () => false, getRemoteUrl: () => null } as Pick<typeof git, 'isGitRepo' | 'getRemoteUrl'>;

  it('explicit value always wins', () => {
    const enabledCfg = { platforms: [], packs: [], multiProduct: false, setupVersion: '1', disableNativeMemory: true, brainRepo: { mode: 'in-tree' as const, enabled: true } };
    const disabledCfg = { ...enabledCfg, brainRepo: { mode: 'in-tree' as const, enabled: false } };
    expect(resolveBrainSyncEnabled('/tmp/whatever', enabledCfg, fakeGit)).toEqual({ enabled: true, source: 'explicit' });
    expect(resolveBrainSyncEnabled('/tmp/whatever', disabledCfg, fakeGit)).toEqual({ enabled: false, source: 'explicit' });
  });

  it('derives ON when the code repo origin is github.com', () => {
    const gh = { isGitRepo: () => true, getRemoteUrl: () => 'https://github.com/acme/repo.git' } as Pick<typeof git, 'isGitRepo' | 'getRemoteUrl'>;
    const res = resolveBrainSyncEnabled('/tmp/whatever', null, gh);
    expect(res).toEqual({ enabled: true, source: 'derived-github-connected' });
  });

  it('derives ON when taskBackend is github, even with no origin remote', () => {
    const cfg = { platforms: [], packs: [], multiProduct: false, setupVersion: '1', disableNativeMemory: true, taskBackend: 'github' as const };
    expect(resolveBrainSyncEnabled('/tmp/whatever', cfg, fakeGit).enabled).toBe(true);
  });

  it('derives OFF for a new/unconnected project', () => {
    expect(resolveBrainSyncEnabled('/tmp/whatever', null, fakeGit)).toEqual({ enabled: false, source: 'derived-unconnected' });
  });
});

describe('git-sync/brain-repo — resolveBrainSyncToken (M1: secrets-first, env-last)', () => {
  let projectRoot: string;
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dc-brain-token-'));
    // Isolate HOME: the GLOBAL tier reads ~/.dreamcontext/.secrets.json — on a
    // dev machine with a real GitHub sign-in these tests would resolve THAT
    // token instead of exercising the env/none tiers (os.homedir() honors HOME).
    process.env.HOME = projectRoot;
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  it('a per-project stored token wins over GITHUB_TOKEN env (the reverse of resolveGitHubToken)', () => {
    writeGitHubToken(projectRoot, 'from-secrets-file');
    process.env.GITHUB_TOKEN = 'from-env';
    const resolved = resolveBrainSyncToken(projectRoot);
    expect(resolved?.token).toBe('from-secrets-file');
    expect(resolved?.source).toBe('secrets');
  });

  it('falls back to GITHUB_TOKEN/GH_TOKEN env when no per-project secret exists', () => {
    delete process.env.GITHUB_TOKEN;
    process.env.GH_TOKEN = 'from-gh-token-env';
    const resolved = resolveBrainSyncToken(projectRoot);
    expect(resolved?.token).toBe('from-gh-token-env');
    expect(resolved?.source).toBe('env');
  });

  it('returns null when neither exists', () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    expect(resolveBrainSyncToken(projectRoot)).toBeNull();
  });
});

describe('git-sync/brain-repo — createBrainRepo', () => {
  let contextRoot: string;
  let projectRoot: string;
  const ORIGINAL_GITHUB_TOKEN = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dc-create-brain-'));
    contextRoot = join(projectRoot, '_dream_context');
    mkdirSync(contextRoot, { recursive: true });
    // The remote is an https URL here, so bootstrapBrainRepo's token check
    // needs SOMETHING to resolve — withGitCredentialsImpl is faked below so
    // this never touches the network; it just satisfies the pre-push guard.
    process.env.GITHUB_TOKEN = 'fake-test-token';
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    if (ORIGINAL_GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = ORIGINAL_GITHUB_TOKEN;
  });

  const fakeGit = {
    ...git,
    isGitRepo: () => true,
    initRepo: () => {},
    getRemoteUrl: () => null,
    setRemoteUrl: () => {},
    addRemote: () => {},
    stageAll: () => {},
    hasGitIdentity: () => true,
    commit: () => 'deadbeef',
    push: () => {},
  } as typeof git;

  function makeAdapter(requests: { method: string; path: string; body?: unknown }[]): ApiAdapter {
    return new ApiAdapter({
      baseUrl: 'https://api.github.com',
      authHeaders: () => ({ Authorization: 'token x' }),
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
        const u = new URL(String(url));
        const method = (init?.method ?? 'GET').toUpperCase();
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ method, path: u.pathname, body });
        if (u.pathname === '/user/repos' && method === 'POST') return jsonResponse(201, { full_name: 'acme/brain' });
        if (u.pathname === '/repos/acme/brain/topics' && method === 'PUT') return jsonResponse(200, {});
        return jsonResponse(404, { message: 'unhandled' });
      }) as typeof fetch,
    });
  }

  it('defaults private:true and sets the discovery topic', async () => {
    const requests: { method: string; path: string; body?: unknown }[] = [];
    const adapter = makeAdapter(requests);

    const result = await createBrainRepo({
      contextRoot, projectRoot, owner: 'acme', name: 'brain', adapter,
      gitModule: fakeGit,
      scrubStagedFilesImpl: () => [],
      withGitCredentialsImpl: async (_token, fn) => fn({} as NodeJS.ProcessEnv),
    });

    expect(result.blocked).toBe(false);
    expect(result.remote).toBe('https://github.com/acme/brain.git');
    const createReq = requests.find((r) => r.path === '/user/repos');
    expect(createReq?.body).toMatchObject({ private: true });
    expect(requests.some((r) => r.path === '/repos/acme/brain/topics' && r.method === 'PUT')).toBe(true);
  });

  it('creates a public repo only when explicitly requested (with confirmation)', async () => {
    const requests: { method: string; path: string; body?: unknown }[] = [];
    const adapter = makeAdapter(requests);
    await createBrainRepo({
      contextRoot, projectRoot, owner: 'acme', name: 'brain', private: false, confirmed: true, adapter,
      gitModule: fakeGit,
      scrubStagedFilesImpl: () => [],
      withGitCredentialsImpl: async (_token, fn) => fn({} as NodeJS.ProcessEnv),
    });
    expect(requests.find((r) => r.path === '/user/repos')?.body).toMatchObject({ private: false });
  });

  it('refuses to create a PUBLIC repo without confirmation (S5 defense-in-depth) — never hits the API', async () => {
    const requests: { method: string; path: string; body?: unknown }[] = [];
    const adapter = makeAdapter(requests);
    await expect(
      createBrainRepo({
        contextRoot, projectRoot, owner: 'acme', name: 'brain', private: false, adapter,
        gitModule: fakeGit,
        scrubStagedFilesImpl: () => [],
        withGitCredentialsImpl: async (_token, fn) => fn({} as NodeJS.ProcessEnv),
      }),
    ).rejects.toThrow(/PUBLIC brain repo without explicit confirmation/i);
    expect(requests.length).toBe(0);
  });

  it('blocks the first push when staged content scrubs BLOCK (S3) — never reaches push', async () => {
    const requests: { method: string; path: string; body?: unknown }[] = [];
    const adapter = makeAdapter(requests);
    let pushed = false;
    const gitWithPushTracking = { ...fakeGit, push: () => { pushed = true; } } as typeof git;

    const result = await createBrainRepo({
      contextRoot, projectRoot, owner: 'acme', name: 'brain', adapter,
      gitModule: gitWithPushTracking,
      scrubStagedFilesImpl: () => [{ file: 'knowledge/x.md', line: 1, rule: 'github-pat', severity: 'block', excerpt: 'redacted' }],
      withGitCredentialsImpl: async (_token, fn) => fn({} as NodeJS.ProcessEnv),
    });

    expect(result.blocked).toBe(true);
    expect(pushed).toBe(false);
  });
});

describe('git-sync/brain-repo — attachBrainRepo (S6 trust gate)', () => {
  it('refuses without explicit confirmation', () => {
    const result = attachBrainRepo({ contextRoot: '/tmp/x', projectRoot: '/tmp', url: 'https://github.com/acme/brain.git', confirmed: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/confirmation/i);
  });

  it('wires the remote when confirmed', () => {
    const contextRoot = mkdtempSync(join(tmpdir(), 'dc-attach-'));
    try {
      const fakeGit = {
        ...git,
        isGitRepo: () => true,
        getRemoteUrl: vi.fn(() => null),
        addRemote: vi.fn(),
        setRemoteUrl: vi.fn(),
      } as unknown as typeof git;
      const result = attachBrainRepo({
        contextRoot, projectRoot: '/tmp', url: 'https://github.com/acme/brain.git', confirmed: true, gitModule: fakeGit,
      });
      expect(result.ok).toBe(true);
      expect((fakeGit.addRemote as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(contextRoot, 'origin', 'https://github.com/acme/brain.git');
      expect(existsSync(join(contextRoot, '.gitignore'))).toBe(true);
    } finally {
      rmSync(contextRoot, { recursive: true, force: true });
    }
  });
});

describe('git-sync/brain-repo — nested-context guard (real git)', () => {
  let projectRoot: string;
  let contextRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dc-nested-guard-'));
    contextRoot = join(projectRoot, '_dream_context');
    mkdirSync(contextRoot, { recursive: true });
    // The user's layout: the CODE repo owns the whole tree, _dream_context is
    // just a nested directory inside its work tree.
    sh(projectRoot, ['init']);
    sh(projectRoot, ['remote', 'add', 'origin', 'https://github.com/meanllbrl/vibe-cto.git']);
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('isOwnRepoRoot distinguishes a nested dir from its own repo root (isGitRepo cannot)', () => {
    expect(git.isGitRepo(contextRoot)).toBe(true); // the trap: nested reads as "a repo"
    expect(isOwnRepoRoot(contextRoot)).toBe(false);
    sh(contextRoot, ['init']);
    expect(isOwnRepoRoot(contextRoot)).toBe(true);
  });

  it('attachBrainRepo git-inits the nested context instead of rewriting the CODE repo origin', () => {
    const result = attachBrainRepo({
      contextRoot, projectRoot, url: 'https://github.com/acme/brain.git', confirmed: true,
    });
    expect(result.ok).toBe(true);
    // The code repo's origin is untouched; the brain got its OWN repo + remote.
    expect(sh(projectRoot, ['remote', 'get-url', 'origin'])).toBe('https://github.com/meanllbrl/vibe-cto.git');
    expect(isOwnRepoRoot(contextRoot)).toBe(true);
    expect(sh(contextRoot, ['remote', 'get-url', 'origin'])).toBe('https://github.com/acme/brain.git');
  });

  it('bootstrapBrainRepo commits/pushes ONLY the brain — never stages or pushes the code repo', async () => {
    const bareRemote = mkdtempSync(join(tmpdir(), 'dc-nested-bare-'));
    try {
      execFileSync('git', ['init', '--bare', bareRemote]);
      // Uncommitted code-repo file that must NOT get swept into a brain commit.
      writeFileSync(join(projectRoot, 'app.ts'), 'export const x = 1;\n', 'utf-8');
      writeFileSync(join(contextRoot, 'note.md'), '# hello brain\n', 'utf-8');

      const result = await bootstrapBrainRepo({ contextRoot, projectRoot, remote: bareRemote });

      expect(result.blocked).toBe(false);
      expect(result.pushed).toBe(true);
      // Code repo: origin unchanged, still ZERO commits, app.ts still untracked.
      expect(sh(projectRoot, ['remote', 'get-url', 'origin'])).toBe('https://github.com/meanllbrl/vibe-cto.git');
      expect(() => sh(projectRoot, ['rev-parse', 'HEAD'])).toThrow();
      // Brain repo: its own root, remote wired to the bare, initial import pushed.
      expect(isOwnRepoRoot(contextRoot)).toBe(true);
      expect(sh(contextRoot, ['remote', 'get-url', 'origin'])).toBe(bareRemote);
      expect(sh(bareRemote, ['log', '-1', '--format=%s', 'main'])).toBe('chore(brain): initial import');
      expect(sh(bareRemote, ['ls-tree', '--name-only', 'main'])).toContain('note.md');
    } finally {
      rmSync(bareRemote, { recursive: true, force: true });
    }
  });
});

describe('git-sync/brain-repo — acquireBrainLock/releaseBrainLock (reuses file-lock, PID-liveness-gated)', () => {
  it('a second acquire while the first (this process, definitely alive) holds it returns false', () => {
    const contextRoot = mkdtempSync(join(tmpdir(), 'dc-brainlock-'));
    try {
      expect(acquireBrainLock(contextRoot, 1000)).toBe(true);
      // Same process pid -> definitely alive -> even far in the future, not reclaimed.
      expect(acquireBrainLock(contextRoot, 1000 + 10 * 60_000)).toBe(false);
      releaseBrainLock(contextRoot);
      expect(acquireBrainLock(contextRoot, 2000)).toBe(true);
    } finally {
      rmSync(contextRoot, { recursive: true, force: true });
    }
  });
});
