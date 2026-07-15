import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeGitHubToken } from '../../src/lib/task-backend/secrets.js';
import * as git from '../../src/lib/git-sync/git.js';
import { readSetupConfig, updateSetupConfig } from '../../src/lib/setup-config.js';
import {
  resolveMode,
  resolveBrainSyncEnabled,
  resolveBrainSyncToken,
  buildBrainGitignore,
  acquireBrainLock,
  releaseBrainLock,
  healStaleBrainConfig,
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

describe('git-sync/brain-repo — healStaleBrainConfig (pre-b45adb4 config-drift self-heal)', () => {
  let projectRoot: string;
  const withOrigin = { isGitRepo: () => true, getRemoteUrl: () => 'https://github.com/acme/repo.git' } as Pick<typeof git, 'isGitRepo' | 'getRemoteUrl'>;
  const noOrigin = { isGitRepo: () => true, getRemoteUrl: () => null } as Pick<typeof git, 'isGitRepo' | 'getRemoteUrl'>;
  const throwingGit = { isGitRepo: () => { throw new Error('git must NOT be consulted for a healthy config'); }, getRemoteUrl: () => null } as Pick<typeof git, 'isGitRepo' | 'getRemoteUrl'>;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dc-brain-heal-'));
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  /** Seed a config with the given brainRepo, then re-read it (sanitized). */
  function seed(brainRepo: Record<string, unknown>) {
    updateSetupConfig(projectRoot, { brainRepo: brainRepo as never });
    return readSetupConfig(projectRoot);
  }

  it('stale enabled:true + in-tree WITH an origin → promotes to full-repo (honest on + connected) and persists', () => {
    const stale = seed({ mode: 'in-tree', enabled: true });
    const healed = healStaleBrainConfig(projectRoot, stale, withOrigin);
    expect(healed?.brainRepo?.mode).toBe('full-repo');
    expect(healed?.brainRepo?.enabled).toBe(true);
    expect(healed?.brainRepo?.autoSync).toBe(true);
    // Persisted, not just returned.
    const onDisk = readSetupConfig(projectRoot);
    expect(onDisk?.brainRepo?.mode).toBe('full-repo');
    expect(onDisk?.brainRepo?.enabled).toBe(true);
    // Gitignore-first: machine-local excludes laid before any full-repo push can stage them.
    const gi = readFileSync(join(projectRoot, '.gitignore'), 'utf-8');
    expect(gi).toContain('_dream_context/state/.secrets.json');
    expect(gi).toContain('_dream_context/state/.brain-merge/');
  });

  it('stale enabled:true + in-tree with NO origin → coerces enabled:false (honest OFF), no gitignore', () => {
    const stale = seed({ mode: 'in-tree', enabled: true });
    const healed = healStaleBrainConfig(projectRoot, stale, noOrigin);
    expect(healed?.brainRepo?.mode).toBe('in-tree');
    expect(healed?.brainRepo?.enabled).toBe(false);
    expect(readSetupConfig(projectRoot)?.brainRepo?.enabled).toBe(false);
    // No full-repo push is possible, so no project-root excludes are written.
    expect(existsSync(join(projectRoot, '.gitignore'))).toBe(false);
  });

  it('promotion preserves an explicit autoSync:false opt-out', () => {
    const stale = seed({ mode: 'in-tree', enabled: true, autoSync: false });
    const healed = healStaleBrainConfig(projectRoot, stale, withOrigin);
    expect(healed?.brainRepo?.mode).toBe('full-repo');
    expect(healed?.brainRepo?.autoSync).toBe(false);
  });

  it('is idempotent — a second heal after promotion is a no-op (mode already full-repo)', () => {
    const stale = seed({ mode: 'in-tree', enabled: true });
    healStaleBrainConfig(projectRoot, stale, withOrigin);
    const afterFirst = readSetupConfig(projectRoot);
    // Second pass must short-circuit (full-repo is not the stale combo) — throwing git proves no lookup.
    const afterSecond = healStaleBrainConfig(projectRoot, afterFirst, throwingGit);
    expect(afterSecond?.brainRepo?.mode).toBe('full-repo');
    expect(afterSecond?.brainRepo?.enabled).toBe(true);
  });

  it('a healthy full-repo/enabled config is returned untouched WITHOUT consulting git', () => {
    const healthy = seed({ mode: 'full-repo', enabled: true, autoSync: true });
    // throwingGit throws if isGitRepo is called — the short-circuit must run first.
    expect(() => healStaleBrainConfig(projectRoot, healthy, throwingGit)).not.toThrow();
    expect(readSetupConfig(projectRoot)?.brainRepo?.mode).toBe('full-repo');
  });

  it('a disabled config (enabled:false + in-tree) is honest already — untouched, no git lookup', () => {
    const disabled = seed({ mode: 'in-tree', enabled: false });
    expect(() => healStaleBrainConfig(projectRoot, disabled, throwingGit)).not.toThrow();
    expect(readSetupConfig(projectRoot)?.brainRepo?.enabled).toBe(false);
  });

  it('a config with no brainRepo (and a null config) is returned untouched', () => {
    const noBrain = seed({}); // sanitizeBrainRepo({}) → { mode: 'in-tree' }, enabled undefined
    expect(healStaleBrainConfig(projectRoot, noBrain, throwingGit)?.brainRepo?.enabled).toBeUndefined();
    expect(healStaleBrainConfig(projectRoot, null, throwingGit)).toBeNull();
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
