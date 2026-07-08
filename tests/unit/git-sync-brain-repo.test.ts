import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeGitHubToken } from '../../src/lib/task-backend/secrets.js';
import * as git from '../../src/lib/git-sync/git.js';
import {
  resolveMode,
  resolveBrainSyncEnabled,
  resolveBrainSyncToken,
  buildBrainGitignore,
  acquireBrainLock,
  releaseBrainLock,
} from '../../src/lib/git-sync/brain-repo.js';

describe('git-sync/brain-repo — resolveMode', () => {
  it('defaults to in-tree when unset or unspecified', () => {
    expect(resolveMode(null)).toBe('in-tree');
    expect(resolveMode({ platforms: [], packs: [], multiProduct: false, setupVersion: '1', disableNativeMemory: true })).toBe('in-tree');
  });

  it('resolves full-repo when explicitly configured', () => {
    expect(
      resolveMode({
        platforms: [], packs: [], multiProduct: false, setupVersion: '1', disableNativeMemory: true,
        brainRepo: { mode: 'full-repo' },
      }),
    ).toBe('full-repo');
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
