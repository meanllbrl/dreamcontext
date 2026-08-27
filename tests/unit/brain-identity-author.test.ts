import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateSetupConfig } from '../../src/lib/setup-config.js';
import { addPerson } from '../../src/lib/people-store.js';
import { FALLBACK_AUTHOR } from '../../src/lib/git-sync/brain-repo.js';
import { mapLoginToPerson } from '../../src/lib/task-backend/identity.js';
import * as git from '../../src/lib/git-sync/git.js';
import { runBrainSync, type SyncEngineDeps } from '../../src/lib/git-sync/sync-engine.js';

/**
 * C3 (github-cloud-collaboration-brain-repo-sync M3): a signed-in GitHub login
 * maps to a `person:` slug, and the brain commit author reflects THEM — a tier
 * layered ON TOP of the existing M1 git-identity tiering (never a
 * prerequisite: no login/mapping simply falls through, unchanged).
 */

describe('task-backend/identity — mapLoginToPerson', () => {
  it('maps a login to the person slug whose peopleIdentity.githubLogin matches (case-insensitive)', () => {
    const config = {
      platforms: [], packs: [], multiProduct: false as const, setupVersion: '1', disableNativeMemory: true,
      peopleIdentity: { 'kerem-yilmaz': { githubLogin: 'KeremYil' } },
    };
    expect(mapLoginToPerson('keremyil', config)).toBe('kerem-yilmaz');
  });

  it('returns null on a blank/absent login, absent config, or no matching mapping', () => {
    expect(mapLoginToPerson(null, null)).toBeNull();
    expect(mapLoginToPerson('', null)).toBeNull();
    expect(mapLoginToPerson('someone', null)).toBeNull();
    const config = {
      platforms: [], packs: [], multiProduct: false as const, setupVersion: '1', disableNativeMemory: true,
      peopleIdentity: { 'kerem-yilmaz': { githubLogin: 'KeremYil' } },
    };
    expect(mapLoginToPerson('someone-else', config)).toBeNull();
  });
});

describe('git-sync/sync-engine — authorFor person tier (C3)', () => {
  let projectRoot: string;
  let contextRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dc-brain-author-'));
    contextRoot = join(projectRoot, '_dream_context');
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    updateSetupConfig(projectRoot, { brainRepo: { mode: 'in-tree', enabled: true, autoSync: true } });
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  function makeFakeGit(identity: boolean, commitCalls: { message: string; author?: { name: string; email: string } }[]): typeof git {
    return {
      ...git,
      isGitRepo: () => true,
      hasMergeHead: () => false,
      remoteBranchExists: () => false,
      hasGitIdentity: () => identity,
      statusPorcelainTracked: () => ['knowledge/x.md'],
      stageAll: () => {},
      stagePath: () => {},
      revListCount: () => 0,
      currentSha: () => 'sha',
      commit: (_cwd: string, message: string, author?: { name: string; email: string }) => {
        commitCalls.push({ message, author });
        return 'newsha';
      },
      fetch: () => {},
      push: () => {},
      attemptMerge: () => ({ clean: true, conflicts: [] }),
      abortMerge: () => {},
      readOursTheirsBase: () => ({ base: 'b', ours: 'o', theirs: 't' }),
    } as typeof git;
  }

  function baseDeps(
    commitCalls: { message: string; author?: { name: string; email: string } }[],
    opts: { identity?: boolean; login?: string | null } = {},
  ): Partial<SyncEngineDeps> {
    return {
      git: makeFakeGit(opts.identity ?? true, commitCalls),
      scrubStagedFiles: () => [],
      resolveConflicts: () => ({ resolved: [], deferredToAgent: [] }),
      resolveBrainSyncToken: () => ({ token: 'fake-token', source: 'secrets', via: 'token' }),
      withGitCredentials: (async (_token: string, fn: (env: NodeJS.ProcessEnv) => unknown) => fn({} as NodeJS.ProcessEnv)) as SyncEngineDeps['withGitCredentials'],
      acquireBrainLock: () => true,
      releaseBrainLock: () => {},
      readGlobalGitHubLogin: () => opts.login ?? null,
    };
  }

  it('uses the mapped person as commit author when a signed-in login maps to a roster person', async () => {
    updateSetupConfig(projectRoot, {
      brainRepo: { mode: 'in-tree', enabled: true, autoSync: true },
      peopleIdentity: { 'kerem-yilmaz': { githubLogin: 'keremyil' } },
    });
    // 0.23.0: the DISPLAY NAME comes from the roster (`people/people.json`),
    // not the retired `config.people`. `peopleIdentity` still owns the
    // login→slug mapping; a slug with no roster entry falls back to the slug.
    addPerson(contextRoot, { name: 'Kerem Yilmaz' });
    const commitCalls: { message: string; author?: { name: string; email: string } }[] = [];
    await runBrainSync({ cwd: contextRoot, mode: 'auto' }, baseDeps(commitCalls, { identity: true, login: 'keremyil' }));
    expect(commitCalls[0].author).toEqual({ name: 'Kerem Yilmaz', email: 'keremyil@users.noreply.github.com' });
  });

  it('overrides even a set local git identity — the person tier is layered ON TOP', async () => {
    updateSetupConfig(projectRoot, {
      brainRepo: { mode: 'in-tree', enabled: true, autoSync: true },
      peopleIdentity: { 'kerem-yilmaz': { githubLogin: 'keremyil' } },
    });
    addPerson(contextRoot, { name: 'Kerem Yilmaz' });
    const commitCalls: { message: string; author?: { name: string; email: string } }[] = [];
    await runBrainSync({ cwd: contextRoot, mode: 'auto' }, baseDeps(commitCalls, { identity: true, login: 'keremyil' }));
    expect(commitCalls[0].author).not.toBeUndefined();
  });

  it('falls through to the M1 git-identity tier when no one is signed in (never a prerequisite)', async () => {
    const commitCalls: { message: string; author?: { name: string; email: string } }[] = [];
    await runBrainSync({ cwd: contextRoot, mode: 'auto' }, baseDeps(commitCalls, { identity: true, login: null }));
    expect(commitCalls[0].author).toBeUndefined();
  });

  it('falls through to the M1 FALLBACK_AUTHOR tier when signed in but unmapped and no git identity', async () => {
    updateSetupConfig(projectRoot, {
      brainRepo: { mode: 'in-tree', enabled: true, autoSync: true },
      peopleIdentity: { 'someone-else': { githubLogin: 'someone-else-login' } },
    });
    const commitCalls: { message: string; author?: { name: string; email: string } }[] = [];
    await runBrainSync({ cwd: contextRoot, mode: 'auto' }, baseDeps(commitCalls, { identity: false, login: 'a-totally-different-login' }));
    expect(commitCalls[0].author).toEqual(FALLBACK_AUTHOR);
  });
});
