/**
 * GitHub token tiers for Issues mirroring (src/lib/task-backend/secrets.ts). The machine's
 * GitHub sign-in (Settings → Team sync) is the LAST tier: a sign-in alone is enough, and any
 * token someone set for the project, or in the environment, still wins.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGitHubToken, writeGitHubToken } from '../../src/lib/task-backend/secrets.js';
import { writeGlobalGitHubToken } from '../../src/lib/git-sync/auth-store.js';

let home: string;
let project: string;
const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dc-gh-tier-home-'));
  project = mkdtempSync(join(tmpdir(), 'dc-gh-tier-proj-'));
  mkdirSync(join(project, '_dream_context', 'state'), { recursive: true });
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe('resolveGitHubToken tier order', () => {
  it('nothing anywhere = null', () => {
    expect(resolveGitHubToken(project, { home })).toBeNull();
  });

  it('the sign-in alone is enough (source global)', () => {
    writeGlobalGitHubToken('gho_signin_1111', home);
    expect(resolveGitHubToken(project, { home })).toEqual({ token: 'gho_signin_1111', source: 'global', via: 'sign-in' });
  });

  it('a project PAT still wins over the sign-in', () => {
    writeGlobalGitHubToken('gho_signin_1111', home);
    writeGitHubToken(project, 'ghp_project_2222');
    expect(resolveGitHubToken(project, { home })).toMatchObject({ token: 'ghp_project_2222', source: 'secrets' });
  });

  it('the environment wins over both', () => {
    writeGlobalGitHubToken('gho_signin_1111', home);
    writeGitHubToken(project, 'ghp_project_2222');
    process.env.GH_TOKEN = 'env_3333';
    expect(resolveGitHubToken(project, { home })).toMatchObject({ token: 'env_3333', source: 'env', via: 'GH_TOKEN' });
  });
});
