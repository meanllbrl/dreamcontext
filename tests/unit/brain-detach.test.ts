import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import * as git from '../../src/lib/git-sync/git.js';
import {
  detachBrain,
  detectShowcaseTracking,
  scrubEntireHistory,
} from '../../src/lib/git-sync/detach.js';
import { createDetachRemote } from '../../src/cli/commands/brain.js';

/**
 * C4 (github-cloud-collaboration-brain-repo-sync M3): `brain detach` produces
 * a PRIVATE separate brain repo, scrubs before push (S4), is showcase-safe by
 * default (C5), supports `--preserve-history` (scrub historical trees or
 * refuse), and is idempotent.
 */

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

// ─── createDetachRemote (the network-creating half — private by default) ────

describe('brain.ts — createDetachRemote', () => {
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
    const remote = await createDetachRemote({
      projectRoot: '/tmp', owner: 'acme', name: 'brain', private: true, confirmed: false, adapter: makeAdapter(requests),
    });
    expect(remote).toBe('https://github.com/acme/brain.git');
    expect(requests.find((r) => r.path === '/user/repos')?.body).toMatchObject({ private: true });
    expect(requests.some((r) => r.path === '/repos/acme/brain/topics' && r.method === 'PUT')).toBe(true);
  });

  it('refuses to create a PUBLIC repo without confirmation (S5) — never hits the API', async () => {
    const requests: { method: string; path: string; body?: unknown }[] = [];
    await expect(
      createDetachRemote({ projectRoot: '/tmp', owner: 'acme', name: 'brain', private: false, confirmed: false, adapter: makeAdapter(requests) }),
    ).rejects.toThrow(/PUBLIC brain repo without explicit confirmation/i);
    expect(requests.length).toBe(0);
  });

  it('creates a public repo when explicitly confirmed', async () => {
    const requests: { method: string; path: string; body?: unknown }[] = [];
    await createDetachRemote({ projectRoot: '/tmp', owner: 'acme', name: 'brain', private: false, confirmed: true, adapter: makeAdapter(requests) });
    expect(requests.find((r) => r.path === '/user/repos')?.body).toMatchObject({ private: false });
  });
});

// ─── detachBrain (local + push, fully fake git — mirrors bootstrapBrainRepo tests) ──

describe('git-sync/detach — detachBrain', () => {
  let projectRoot: string;
  let contextRoot: string;
  const ORIGINAL_GITHUB_TOKEN = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dc-detach-'));
    contextRoot = join(projectRoot, '_dream_context');
    mkdirSync(contextRoot, { recursive: true });
    // The remote is an https URL, so detachBrain's pre-push token check needs
    // SOMETHING to resolve — withGitCredentialsImpl is faked below so this
    // never touches the network; it just satisfies the guard (mirrors the
    // existing createBrainRepo tests in git-sync-brain-repo.test.ts).
    process.env.GITHUB_TOKEN = 'fake-test-token';
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    if (ORIGINAL_GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = ORIGINAL_GITHUB_TOKEN;
  });

  function makeState() {
    return { isRepo: false, remote: null as string | null, commits: 0, commitReturns: undefined as (string | null)[] | undefined, pushes: 0 };
  }

  function makeFakeGit(state: ReturnType<typeof makeState>): typeof git {
    return {
      ...git,
      isGitRepo: () => state.isRepo,
      initRepo: () => { state.isRepo = true; },
      getRemoteUrl: () => state.remote,
      setRemoteUrl: (_cwd: string, _name: string, url: string) => { state.remote = url; },
      addRemote: (_cwd: string, _name: string, url: string) => { state.remote = url; },
      stageAll: () => {},
      hasGitIdentity: () => true,
      commit: () => {
        state.commits += 1;
        if (state.commitReturns) return state.commitReturns[Math.min(state.commits - 1, state.commitReturns.length - 1)];
        return `sha-${state.commits}`;
      },
      push: () => { state.pushes += 1; },
    } as typeof git;
  }

  it('produces a separate brain repo: pushes a scrubbed single commit to the new remote', async () => {
    const state = makeState();
    const result = await detachBrain({
      contextRoot, projectRoot, remote: 'https://github.com/acme/brain.git',
      keepTracked: true,
      gitModule: makeFakeGit(state),
      scrubStagedFilesImpl: () => [],
      withGitCredentialsImpl: async (_token, fn) => fn({} as NodeJS.ProcessEnv),
      detectShowcaseImpl: () => false,
    });
    expect(result.action).toBe('detached');
    expect(state.isRepo).toBe(true);
    expect(state.remote).toBe('https://github.com/acme/brain.git');
    expect(state.commits).toBe(1);
    expect(state.pushes).toBe(1);
    expect(existsSync(join(contextRoot, '.dreamcontext-brain'))).toBe(true);
  });

  it('scrub BLOCK aborts detach entirely — no commit, no push (S4)', async () => {
    const state = makeState();
    const result = await detachBrain({
      contextRoot, projectRoot, remote: 'https://github.com/acme/brain.git',
      keepTracked: true,
      gitModule: makeFakeGit(state),
      scrubStagedFilesImpl: () => [{ file: 'knowledge/x.md', line: 1, rule: 'github-pat', severity: 'block', excerpt: 'redacted' }],
      withGitCredentialsImpl: async (_token, fn) => fn({} as NodeJS.ProcessEnv),
      detectShowcaseImpl: () => false,
    });
    expect(result.action).toBe('blocked-scrub');
    expect(state.commits).toBe(0);
    expect(state.pushes).toBe(0);
  });

  it('is idempotent: a second detach with nothing new to commit and the same remote returns already-detached', async () => {
    const state = makeState();
    state.commitReturns = ['sha-1', null];
    const fakeGit = makeFakeGit(state);
    const opts = {
      contextRoot, projectRoot, remote: 'https://github.com/acme/brain.git',
      keepTracked: true,
      gitModule: fakeGit,
      scrubStagedFilesImpl: () => [],
      withGitCredentialsImpl: async (_token: string, fn: (env: NodeJS.ProcessEnv) => unknown) => fn({} as NodeJS.ProcessEnv),
      detectShowcaseImpl: () => false,
    };

    const first = await detachBrain(opts);
    expect(first.action).toBe('detached');

    const second = await detachBrain(opts);
    expect(second.action).toBe('already-detached');
    expect(state.pushes).toBe(2); // still pushes (a no-op push against an unchanged remote is safe) — just doesn't report it as fresh
  });

  it('showcase repo: defaults to --keep-tracked and never touches the code repo .gitignore', async () => {
    // Real code-repo git repo with a CURATED .gitignore — detach must not touch it.
    execFileSync('git', ['init', '-q'], { cwd: projectRoot });
    const curated = '# curated\nnode_modules/\n_dream_context/state/.secrets.json\n';
    writeFileSync(join(projectRoot, '.gitignore'), curated, 'utf-8');

    const state = makeState();
    const result = await detachBrain({
      contextRoot, projectRoot, remote: 'https://github.com/acme/brain.git',
      gitModule: makeFakeGit(state), // used for contextRoot ops; detectShowcaseImpl below drives the decision
      scrubStagedFilesImpl: () => [],
      withGitCredentialsImpl: async (_token, fn) => fn({} as NodeJS.ProcessEnv),
      detectShowcaseImpl: () => true,
    });

    expect(result.showcase).toBe(true);
    expect(result.keptTracked).toBe(true);
    expect(result.gitignoreAdded).toEqual([]);
    expect(readFileSync(join(projectRoot, '.gitignore'), 'utf-8')).toBe(curated); // byte-for-byte untouched
  });

  it('ordinary project: defaults to --gitignore-in-tree, idempotently ADDING (never overwriting) _dream_context/', async () => {
    execFileSync('git', ['init', '-q'], { cwd: projectRoot });
    writeFileSync(join(projectRoot, '.gitignore'), 'node_modules/\n', 'utf-8');

    const state = makeState();
    const opts = {
      contextRoot, projectRoot, remote: 'https://github.com/acme/brain.git',
      gitModule: makeFakeGit(state),
      scrubStagedFilesImpl: () => [],
      withGitCredentialsImpl: async (_token: string, fn: (env: NodeJS.ProcessEnv) => unknown) => fn({} as NodeJS.ProcessEnv),
      detectShowcaseImpl: () => false,
    };

    const first = await detachBrain(opts);
    expect(first.keptTracked).toBe(false);
    expect(first.gitignoreAdded).toEqual(['_dream_context/']);
    const afterFirst = readFileSync(join(projectRoot, '.gitignore'), 'utf-8');
    expect(afterFirst).toContain('node_modules/');
    expect(afterFirst).toContain('_dream_context/');

    // Second run: already covered — idempotent, nothing new added.
    const second = await detachBrain(opts);
    expect(second.gitignoreAdded).toEqual([]);
    expect(readFileSync(join(projectRoot, '.gitignore'), 'utf-8')).toBe(afterFirst);
  });

  it('explicit --keep-tracked and --gitignore-in-tree together throws', async () => {
    const state = makeState();
    await expect(
      detachBrain({
        contextRoot, projectRoot, remote: 'https://github.com/acme/brain.git',
        keepTracked: true, gitignoreInTree: true,
        gitModule: makeFakeGit(state),
        scrubStagedFilesImpl: () => [],
        withGitCredentialsImpl: async (_token, fn) => fn({} as NodeJS.ProcessEnv),
      }),
    ).rejects.toThrow(/mutually exclusive/i);
  });

  // ── --preserve-history ──────────────────────────────────────────────────

  it('--preserve-history is REFUSED when the source is still in-tree (no history to carry over safely)', async () => {
    const state = makeState(); // isRepo:false => in-tree source
    const result = await detachBrain({
      contextRoot, projectRoot, remote: 'https://github.com/acme/brain.git',
      preserveHistory: true,
      keepTracked: true,
      gitModule: makeFakeGit(state),
      scrubStagedFilesImpl: () => [],
      withGitCredentialsImpl: async (_token, fn) => fn({} as NodeJS.ProcessEnv),
      detectShowcaseImpl: () => false,
    });
    expect(result.action).toBe('refused-preserve-history');
    expect(state.commits).toBe(0);
    expect(state.pushes).toBe(0);
  });

  it('--preserve-history is REFUSED when the (already-separate) source history contains a scrub hit', async () => {
    const state = makeState();
    state.isRepo = true; // already separate — has its own history
    state.remote = 'https://github.com/acme/old-brain.git';
    const result = await detachBrain({
      contextRoot, projectRoot, remote: 'https://github.com/acme/new-brain.git',
      preserveHistory: true,
      keepTracked: true,
      gitModule: makeFakeGit(state),
      scrubStagedFilesImpl: () => [],
      withGitCredentialsImpl: async (_token, fn) => fn({} as NodeJS.ProcessEnv),
      detectShowcaseImpl: () => false,
      scrubHistoryImpl: () => [{ file: '(brain repo history)', line: 3, rule: 'github-pat', severity: 'block', excerpt: 'redacted' }],
    });
    expect(result.action).toBe('refused-preserve-history');
    expect(result.scrub.blocks).toHaveLength(1);
    expect(state.commits).toBe(0);
    expect(state.pushes).toBe(0);
  });

  it('--preserve-history proceeds when the (already-separate) source history scrubs clean', async () => {
    const state = makeState();
    state.isRepo = true;
    state.remote = 'https://github.com/acme/old-brain.git';
    const result = await detachBrain({
      contextRoot, projectRoot, remote: 'https://github.com/acme/new-brain.git',
      preserveHistory: true,
      keepTracked: true,
      gitModule: makeFakeGit(state),
      scrubStagedFilesImpl: () => [],
      withGitCredentialsImpl: async (_token, fn) => fn({} as NodeJS.ProcessEnv),
      detectShowcaseImpl: () => false,
      scrubHistoryImpl: () => [],
    });
    expect(result.action).toBe('detached');
    expect(state.remote).toBe('https://github.com/acme/new-brain.git');
    expect(state.pushes).toBe(1);
  });
});

// ─── detectShowcaseTracking (real git — genuine end-to-end confidence) ──────

describe('git-sync/detach — detectShowcaseTracking (real git)', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'dc-showcase-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('detects the showcase pattern: tracked core/knowledge, no blanket ignore', () => {
    mkdirSync(join(repo, '_dream_context', 'core'), { recursive: true });
    mkdirSync(join(repo, '_dream_context', 'knowledge'), { recursive: true });
    writeFileSync(join(repo, '_dream_context', 'core', '0.soul.md'), '# soul\n');
    writeFileSync(join(repo, '_dream_context', 'knowledge', 'x.md'), '# x\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });

    expect(detectShowcaseTracking(repo)).toBe(true);
  });

  it('is false when _dream_context/ is blanket-gitignored, even if files exist untracked', () => {
    writeFileSync(join(repo, '.gitignore'), '_dream_context/\n', 'utf-8');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
    mkdirSync(join(repo, '_dream_context', 'core'), { recursive: true });
    writeFileSync(join(repo, '_dream_context', 'core', '0.soul.md'), '# soul\n');

    expect(detectShowcaseTracking(repo)).toBe(false);
  });

  it('is false for an ordinary project with nothing tracked under _dream_context/', () => {
    writeFileSync(join(repo, 'README.md'), '# hi\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });

    expect(detectShowcaseTracking(repo)).toBe(false);
  });

  it('is false when the directory is not a git repo at all', () => {
    const bare = mkdtempSync(join(tmpdir(), 'dc-not-git-'));
    try {
      expect(detectShowcaseTracking(bare)).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

// ─── scrubEntireHistory (real git — genuine end-to-end confidence) ─────────

describe('git-sync/detach — scrubEntireHistory (real git)', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'dc-history-scrub-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('detects a secret committed in an OLD commit even after it was removed later', () => {
    writeFileSync(join(repo, 'notes.md'), 'hello\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });

    // A GitHub PAT-shaped secret lands in history...
    writeFileSync(join(repo, 'notes.md'), `token: ghp_${'a'.repeat(36)}\n`);
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'oops, committed a token'], { cwd: repo });

    // ...then gets removed in a later commit — the CURRENT tree is clean.
    writeFileSync(join(repo, 'notes.md'), 'hello again\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'remove the token'], { cwd: repo });

    const hits = scrubEntireHistory(repo);
    expect(hits.some((h) => h.rule === 'github-pat')).toBe(true);
  });

  it('returns no hits for a clean history', () => {
    writeFileSync(join(repo, 'notes.md'), 'hello\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
    writeFileSync(join(repo, 'notes.md'), 'hello again\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'update'], { cwd: repo });

    expect(scrubEntireHistory(repo)).toEqual([]);
  });
});
