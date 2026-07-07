import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  globalSecretsPath,
  writeGlobalGitHubToken,
  readGlobalGitHubToken,
  clearGlobalGitHubToken,
} from '../../src/lib/git-sync/auth-store.js';
import { writeGitHubToken } from '../../src/lib/task-backend/secrets.js';
import { resolveBrainSyncToken } from '../../src/lib/git-sync/brain-repo.js';

describe('git-sync/auth-store — global GitHub token store', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dc-home-'));
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('writes to ~/.dreamcontext/.secrets.json at mode 0600 and reads it back', () => {
    writeGlobalGitHubToken('ghp_globaltoken', home);
    const path = globalSecretsPath(home);
    expect(existsSync(path)).toBe(true);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    const resolved = readGlobalGitHubToken(home);
    expect(resolved?.token).toBe('ghp_globaltoken');
    expect(resolved?.via).toBe('global');
  });

  it('never returns a token for a missing store', () => {
    expect(readGlobalGitHubToken(home)).toBeNull();
  });

  it('clears the token (logout) idempotently', () => {
    writeGlobalGitHubToken('ghp_x', home);
    clearGlobalGitHubToken(home);
    expect(readGlobalGitHubToken(home)).toBeNull();
    // Second clear on an already-cleared store is a no-op, not a throw.
    expect(() => clearGlobalGitHubToken(home)).not.toThrow();
  });

  it('rejects an empty token', () => {
    expect(() => writeGlobalGitHubToken('  ', home)).toThrow();
  });
});

describe('git-sync/brain-repo — resolveBrainSyncToken tiering (per-project → global → env)', () => {
  let projectRoot: string;
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dc-proj-'));
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    // The global tier reads os.homedir() — isolate it, or a developer's real
    // signed-in global token leaks in and wins over the env tier under test.
    originalHome = process.env.HOME;
    fakeHome = mkdtempSync(join(tmpdir(), 'dc-home-'));
    process.env.HOME = fakeHome;
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('uses the env token when neither per-project nor global exists', () => {
    process.env.GITHUB_TOKEN = 'ghp_env';
    const t = resolveBrainSyncToken(projectRoot);
    expect(t?.token).toBe('ghp_env');
    expect(t?.source).toBe('env');
  });

  it('per-project token wins over global and env', () => {
    // Global tier resolves the CURRENT user home; a per-project token must win
    // regardless, so this asserts precedence without touching the real home.
    writeGitHubToken(projectRoot, 'ghp_perproject');
    process.env.GITHUB_TOKEN = 'ghp_env';
    const t = resolveBrainSyncToken(projectRoot);
    expect(t?.token).toBe('ghp_perproject');
    expect(t?.source).toBe('secrets');
    expect(t?.via).toBe('token');
  });
});
