import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import { updateSetupConfig, readBrainLocal, writeBrainLocal } from '../../src/lib/setup-config.js';
import { writeConflictReport, readConflictReport } from '../../src/lib/git-sync/conflict-report.js';
import { acquireBrainLock, releaseBrainLock, isDemotedProjectToken, FALLBACK_AUTHOR } from '../../src/lib/git-sync/brain-repo.js';
import { writeGitHubToken, writeClickUpToken, type ResolvedToken } from '../../src/lib/task-backend/secrets.js';
import * as git from '../../src/lib/git-sync/git.js';
import { runBrainSync, type SyncEngineDeps } from '../../src/lib/git-sync/sync-engine.js';

/**
 * `runBrainSync` unit tests with a fully injected FAKE git wrapper — no real
 * git process is ever invoked. `contextRoot`/`projectRoot` are real temp
 * dirs so the real `.config.json` / `.brain-local.json` / conflict-report
 * filesystem side effects (which are NOT part of the injectable deps) are
 * exercised for real, deterministically.
 */

interface FakeState {
  isGitRepoResult: boolean;
  hasMergeHead: boolean;
  identity: boolean;
  dirty: string[];
  aheadCount: number;
  /** Commits WE have that the remote doesn't (`origin/main..HEAD`) — drives the localAhead push gate. */
  localAhead: number;
  shaSequence: (string | null)[];
  shaIdx: number;
  mergeConflicts: string[] | null; // null => clean; array => conflicted paths
  /** false = ref-less empty remote (freshly attached repo, zero commits). */
  remoteExists: boolean;
  /** non-null => attemptMerge throws with this message (e.g. unrelated histories). */
  mergeThrows: string | null;
  fetchCalls: number;
  pushCalls: number;
  pushFailFirstN: number;
  commitCalls: { message: string; author?: { name: string; email: string } }[];
  abortMergeCalls: number;
  /** What `currentBranch()` returns — full-repo syncs whatever branch you're on. */
  branch: string;
  /** Records the branch args every `fetch`/`push`/`remoteBranchExists` was called with. */
  branchCalls: string[];
}

function makeFakeGit(state: FakeState): typeof git {
  return {
    ...git,
    isGitRepo: () => state.isGitRepoResult,
    hasMergeHead: () => state.hasMergeHead,
    hasGitIdentity: () => state.identity,
    statusPorcelainTracked: () => state.dirty,
    stageAll: () => {},
    stagePath: () => {},
    // `origin/main..HEAD` (ends with ..HEAD, not a HEAD..X range) → localAhead;
    // `HEAD..origin/main` and the pull-only `before..after` range → aheadCount.
    revListCount: (_cwd: string, range: string) =>
      (/\.\.HEAD$/.test(range) && !range.startsWith('HEAD..') ? state.localAhead : state.aheadCount),
    currentSha: () => {
      const sha = state.shaSequence[Math.min(state.shaIdx, state.shaSequence.length - 1)];
      state.shaIdx += 1;
      return sha;
    },
    commit: (_cwd: string, message: string, author?: { name: string; email: string }) => {
      state.commitCalls.push({ message, author });
      return 'newsha';
    },
    currentBranch: () => state.branch,
    fetch: (_cwd: string, _remote: string, branch: string) => {
      state.fetchCalls += 1;
      state.branchCalls.push(branch);
    },
    push: (_cwd: string, _remote: string, branch: string) => {
      state.pushCalls += 1;
      state.branchCalls.push(branch);
      if (state.pushCalls <= state.pushFailFirstN) {
        throw new Error('push rejected (non-fast-forward)');
      }
    },
    remoteBranchExists: (_cwd: string, _remote: string, branch: string) => {
      state.branchCalls.push(branch);
      return state.remoteExists;
    },
    attemptMerge: () => {
      if (state.mergeThrows) throw new Error(state.mergeThrows);
      if (state.mergeConflicts === null) return { clean: true, conflicts: [] };
      return { clean: false, conflicts: state.mergeConflicts };
    },
    abortMerge: () => {
      state.abortMergeCalls += 1;
    },
    readOursTheirsBase: () => ({ base: 'b', ours: 'o', theirs: 't' }),
  } as typeof git;
}

function makeState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    isGitRepoResult: true,
    hasMergeHead: false,
    identity: true,
    dirty: [],
    aheadCount: 0,
    localAhead: 0,
    shaSequence: ['sha1', 'sha2'],
    shaIdx: 0,
    mergeConflicts: null,
    remoteExists: true,
    mergeThrows: null,
    fetchCalls: 0,
    pushCalls: 0,
    pushFailFirstN: 0,
    commitCalls: [],
    abortMergeCalls: 0,
    branch: 'main',
    branchCalls: [],
    ...overrides,
  };
}

describe('git-sync/sync-engine — runBrainSync', () => {
  let projectRoot: string;
  let contextRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dc-sync-engine-'));
    contextRoot = join(projectRoot, '_dream_context');
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    // Explicit `enabled:true` short-circuits the v3.3 derivation entirely — no
    // real git call needed to resolve the master switch in these tests.
    updateSetupConfig(projectRoot, { brainRepo: { mode: 'full-repo', enabled: true, autoSync: true } });
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  function baseDeps(
    state: FakeState,
    resolvedConflicts: {
      resolved: string[];
      deferredToAgent: { path: string; class: 'knowledge-md' }[];
      deferredToHuman?: { path: string; class: 'code' }[];
    } = { resolved: [], deferredToAgent: [] },
  ): Partial<SyncEngineDeps> {
    const resolution = { deferredToHuman: [] as { path: string; class: 'code' }[], ...resolvedConflicts };
    return {
      git: makeFakeGit(state),
      scrubStagedFiles: () => [],
      scrubCommitRange: () => [],
      resolveConflicts: () => resolution,
      resolveBrainSyncToken: () => ({ token: 'fake-token', source: 'secrets', via: 'token' }),
      withGitCredentials: (async (_token: string, fn: (env: NodeJS.ProcessEnv) => unknown) => fn({} as NodeJS.ProcessEnv)) as SyncEngineDeps['withGitCredentials'],
      acquireBrainLock: () => true,
      releaseBrainLock: () => {},
    };
  }

  // ── basic auto flow ────────────────────────────────────────────────────
  it('noop on a clean tree', async () => {
    const state = makeState();
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto' }, baseDeps(state));
    expect(result.action).toBe('noop');
    expect(state.commitCalls).toHaveLength(0);
    expect(state.pushCalls).toBe(0);
  });

  it('pushed after a local edit', async () => {
    const state = makeState({ dirty: ['knowledge/x.md'] });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto' }, baseDeps(state));
    expect(result.action).toBe('pushed');
    expect(state.commitCalls).toHaveLength(1);
    expect(state.pushCalls).toBe(1);
  });

  it('scrub BLOCK aborts before commit', async () => {
    const state = makeState({ dirty: ['x.md'] });
    const deps = baseDeps(state);
    deps.scrubStagedFiles = () => [{ file: 'x.md', line: 1, rule: 'github-pat', severity: 'block', excerpt: 'r' }];
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto' }, deps);
    expect(result.action).toBe('blocked-scrub');
    expect(state.commitCalls).toHaveLength(0);
    expect(state.pushCalls).toBe(0);
  });

  // ── empty remote (freshly attached, zero commits) ─────────────────────
  it('auto: empty remote + local edits → bootstraps first commit + push, never fetches', async () => {
    const state = makeState({ remoteExists: false, dirty: ['knowledge/x.md'] });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto' }, baseDeps(state));
    expect(result.action).toBe('pushed');
    expect(state.fetchCalls).toBe(0);
    expect(state.commitCalls).toHaveLength(1);
    expect(state.pushCalls).toBe(1);
  });

  it('auto: empty remote + clean tree with existing local commits → bootstrap push (main must be born)', async () => {
    const state = makeState({ remoteExists: false, shaSequence: ['localsha'] });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto' }, baseDeps(state));
    expect(result.action).toBe('pushed');
    expect(state.commitCalls).toHaveLength(0);
    expect(state.pushCalls).toBe(1);
  });

  it('auto: empty remote + truly nothing local (unborn HEAD, clean) → noop', async () => {
    const state = makeState({ remoteExists: false, shaSequence: [null] });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto' }, baseDeps(state));
    expect(result.action).toBe('noop');
    expect(state.pushCalls).toBe(0);
  });

  it('pull-only: empty remote → noop with guidance, never fetches or pushes', async () => {
    const state = makeState({ remoteExists: false, dirty: ['knowledge/x.md'] });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'pull-only' }, baseDeps(state));
    expect(result.action).toBe('noop');
    expect(result.note).toMatch(/empty/i);
    expect(state.fetchCalls).toBe(0);
    expect(state.pushCalls).toBe(0);
    expect(state.commitCalls).toHaveLength(0);
  });

  it('push failure against an empty remote → clean token/permissions error, not a fetch crash', async () => {
    const state = makeState({ remoteExists: false, dirty: ['x.md'], pushFailFirstN: 99 });
    await expect(runBrainSync({ cwd: contextRoot, mode: 'auto' }, baseDeps(state))).rejects.toThrow(/empty brain remote/i);
    expect(state.fetchCalls).toBe(0);
  });

  it('unrelated histories merge failure → actionable GitSyncError, not raw git output', async () => {
    const state = makeState({ aheadCount: 1, mergeThrows: 'git merge failed: fatal: refusing to merge unrelated histories' });
    await expect(runBrainSync({ cwd: contextRoot, mode: 'auto' }, baseDeps(state))).rejects.toThrow(/unrelated histories.*attach an empty repo/is);
  });

  // ── in-tree mode ─────────────────────────────────────────────────────
  it('in-tree mode commits but never pushes', async () => {
    updateSetupConfig(projectRoot, { brainRepo: { mode: 'in-tree', enabled: true, autoSync: false } });
    const state = makeState();
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto' }, baseDeps(state));
    expect(result.action).toBe('skipped-in-tree');
    expect(state.commitCalls).toHaveLength(1);
    expect(state.pushCalls).toBe(0);
  });

  it('in-tree mode still scrubs before the commit and blocks on a hit (S2)', async () => {
    updateSetupConfig(projectRoot, { brainRepo: { mode: 'in-tree', enabled: true, autoSync: false } });
    const state = makeState();
    const deps = baseDeps(state);
    deps.scrubStagedFiles = () => [{ file: '_dream_context/x.md', line: 1, rule: 'github-pat', severity: 'block', excerpt: 'r' }];
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto' }, deps);
    expect(result.action).toBe('blocked-scrub');
    expect(state.commitCalls).toHaveLength(0);
  });

  // ── auto merge / conflict handling ────────────────────────────────────
  it('auto: agent-class conflict leaves the merge in progress and writes a report', async () => {
    const state = makeState({ aheadCount: 1, mergeConflicts: ['knowledge/x.md'] });
    const deps = baseDeps(state, { resolved: ['core/CHANGELOG.json'], deferredToAgent: [{ path: 'knowledge/x.md', class: 'knowledge-md' }] });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto' }, deps);
    expect(result.action).toBe('awaiting-agent');
    expect(state.abortMergeCalls).toBe(0); // auto leaves the merge IN PROGRESS, does not abort
    expect(readConflictReport(contextRoot)).not.toBeNull();
    expect(state.pushCalls).toBe(0);
  });

  it('amendment 1: --continue + push success clears the report and a follow-up plain sync proceeds normally', async () => {
    writeConflictReport(contextRoot, {
      remoteRef: 'origin/main', resolvedByCli: [],
      deferred: [{ path: 'knowledge/x.md', class: 'knowledge-md', reason: 'r', base: 'b', ours: 'o', theirs: 't' }],
    });
    writeBrainLocal(projectRoot, { pendingAgentMerge: false });

    const state = makeState({ hasMergeHead: true });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto', continue: true }, baseDeps(state));
    expect(result.action).toBe('pushed');
    expect(readConflictReport(contextRoot)).toBeNull();

    // Follow-up plain sync: MERGE_HEAD now gone, no pending -> must NOT be already-awaiting-agent.
    const state2 = makeState({ hasMergeHead: false });
    const result2 = await runBrainSync({ cwd: contextRoot, mode: 'auto' }, baseDeps(state2));
    expect(result2.action).not.toBe('already-awaiting-agent');
  });

  it('a stale report (no MERGE_HEAD, pendingAgentMerge:false) is auto-cleared on the next run', async () => {
    writeConflictReport(contextRoot, {
      remoteRef: 'origin/main', resolvedByCli: [],
      deferred: [{ path: 'knowledge/x.md', class: 'knowledge-md', reason: 'r', base: 'b', ours: 'o', theirs: 't' }],
    });
    writeBrainLocal(projectRoot, { pendingAgentMerge: false });

    const state = makeState({ hasMergeHead: false });
    await runBrainSync({ cwd: contextRoot, mode: 'auto' }, baseDeps(state));
    expect(readConflictReport(contextRoot)).toBeNull();
  });

  it('v3.1 counter-case: a LIVE pull-only report (pendingAgentMerge:true) is NOT cleared and returns already-awaiting-agent', async () => {
    writeConflictReport(contextRoot, {
      remoteRef: 'origin/main', resolvedByCli: [],
      deferred: [{ path: 'knowledge/x.md', class: 'knowledge-md', reason: 'r', base: 'b', ours: 'o', theirs: 't' }],
    });
    writeBrainLocal(projectRoot, { pendingAgentMerge: true });

    const state = makeState({ hasMergeHead: false });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto' }, baseDeps(state));
    expect(result.action).toBe('already-awaiting-agent');
    expect(readConflictReport(contextRoot)).not.toBeNull();
  });

  // ── pull-only ─────────────────────────────────────────────────────────
  it('pull-only: clean merge delivers content and never pushes (P2/C6)', async () => {
    const state = makeState({ aheadCount: 2, shaSequence: ['sha-before', 'sha-after'] });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'pull-only' }, baseDeps(state));
    expect(result.action).toBe('pulled');
    expect(result.pulledUpdates).toBeGreaterThan(0);
    expect(state.pushCalls).toBe(0);
  });

  it('pull-only: a dirty tree auto-commits (checkpoint message + M1 author) then merges', async () => {
    const state = makeState({ aheadCount: 1, dirty: ['knowledge/y.md'] });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'pull-only' }, baseDeps(state));
    expect(result.action).toBe('pulled');
    expect(state.commitCalls[0].message).toBe('chore: checkpoint local edits before team merge (dreamcontext)');
  });

  it('amendment 2: falls back to the dreamcontext-sync author when git identity is unset', async () => {
    const state = makeState({ aheadCount: 1, dirty: ['knowledge/y.md'], identity: false });
    await runBrainSync({ cwd: contextRoot, mode: 'pull-only' }, baseDeps(state));
    expect(state.commitCalls[0].author).toEqual(FALLBACK_AUTHOR);
  });

  it('amendment 4: pull-only refuses the auto-commit on a WARN-only hit (effective --strict)', async () => {
    const state = makeState({ aheadCount: 1, dirty: ['knowledge/y.md'] });
    const deps = baseDeps(state);
    deps.scrubStagedFiles = () => [{ file: 'knowledge/y.md', line: 1, rule: 'home-path', severity: 'warn', excerpt: 'r' }];
    const result = await runBrainSync({ cwd: contextRoot, mode: 'pull-only' }, deps);
    expect(result.action).toBe('blocked-scrub');
    expect(result.note).toMatch(/looks sensitive/i);
    expect(state.commitCalls).toHaveLength(0);
  });

  it('pull-only: an agent-class conflict aborts the merge to a clean tree and records pendingAgentMerge', async () => {
    const state = makeState({ aheadCount: 1, mergeConflicts: ['knowledge/x.md'] });
    const deps = baseDeps(state, { resolved: [], deferredToAgent: [{ path: 'knowledge/x.md', class: 'knowledge-md' }] });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'pull-only' }, deps);
    expect(result.action).toBe('awaiting-agent');
    expect(state.abortMergeCalls).toBe(1);
    expect(readBrainLocal(projectRoot).pendingAgentMerge).toBe(true);
  });

  // ── reentrancy + concurrency ──────────────────────────────────────────
  it('C3: MERGE_HEAD present (with our conflict report) -> already-awaiting-agent, touches nothing', async () => {
    // A merge dreamcontext started ALWAYS leaves a conflict report — that's what
    // distinguishes it from the user's own git merge (see the item-3 test below).
    writeConflictReport(contextRoot, {
      remoteRef: 'origin/main', resolvedByCli: [],
      deferred: [{ path: 'knowledge/x.md', class: 'knowledge-md', reason: 'r', base: 'b', ours: 'o', theirs: 't' }],
    });
    const state = makeState({ hasMergeHead: true });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto' }, baseDeps(state));
    expect(result.action).toBe('already-awaiting-agent');
    expect(state.fetchCalls).toBe(0);
    expect(state.commitCalls).toHaveLength(0);
  });

  // ── item 3: distinguish the user's OWN merge from a dreamcontext handoff ──
  it("user-merge-in-progress: MERGE_HEAD with NO conflict report is the user's own git merge, not a team handoff", async () => {
    // No conflict report written — this is a `git merge`/`rebase` the user started
    // themselves (common in full-repo, where gitCwd is the project root). Must NOT
    // claim a team merge is awaiting /dream-sync.
    const state = makeState({ hasMergeHead: true });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto' }, baseDeps(state));
    expect(result.action).toBe('user-merge-in-progress');
    expect(result.note).toMatch(/finish your in-progress git merge/i);
    expect(state.fetchCalls).toBe(0);
    expect(state.commitCalls).toHaveLength(0);
  });

  it('a persisted code-conflict report (MERGE_HEAD present) surfaces code-conflict, not already-awaiting-agent', async () => {
    writeConflictReport(contextRoot, {
      remoteRef: 'origin/main', resolvedByCli: [], deferred: [], codeConflicts: ['src/app.ts'],
    });
    const state = makeState({ hasMergeHead: true });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto' }, baseDeps(state));
    expect(result.action).toBe('code-conflict');
    expect(result.codeConflicts).toEqual(['src/app.ts']);
    expect(result.note).toMatch(/code conflict in src\/app\.ts/i);
  });

  it('lock contention: a live holder returns locked (real file-lock, PID-liveness-gated)', async () => {
    expect(acquireBrainLock(contextRoot)).toBe(true); // held by THIS (alive) process
    try {
      const state = makeState({ dirty: ['x.md'] });
      const deps = baseDeps(state);
      delete deps.acquireBrainLock; // use the REAL implementation for this test
      delete deps.releaseBrainLock;
      const result = await runBrainSync({ cwd: contextRoot, mode: 'auto' }, deps);
      expect(result.action).toBe('locked');
    } finally {
      releaseBrainLock(contextRoot);
    }
  });

  // ── C4 non-fast-forward retry loop ───────────────────────────────────
  it('C4: a non-FF push retries once then succeeds', async () => {
    const state = makeState({ pushFailFirstN: 1 });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'push-only' }, baseDeps(state));
    expect(result.action).toBe('pushed');
    expect(state.pushCalls).toBe(2);
    expect(state.fetchCalls).toBe(1);
  });

  it('C4: a non-FF push still rejected after the one retry surfaces loudly (throws)', async () => {
    const state = makeState({ pushFailFirstN: 99 });
    await expect(runBrainSync({ cwd: contextRoot, mode: 'push-only' }, baseDeps(state))).rejects.toThrow(/non-fast-forward/i);
  });

  // ── v3.2 --resume / --continue ────────────────────────────────────────
  it('v3.2 guard: pendingAgentMerge + no MERGE_HEAD -> auto and pull-only both return already-awaiting-agent', async () => {
    writeBrainLocal(projectRoot, { pendingAgentMerge: true });
    for (const mode of ['auto', 'pull-only'] as const) {
      const state = makeState({ hasMergeHead: false });
      const result = await runBrainSync({ cwd: contextRoot, mode }, baseDeps(state));
      expect(result.action).toBe('already-awaiting-agent');
    }
  });

  it('v3.2 misuse: --continue without MERGE_HEAD -> invalid-flag, nothing mutated', async () => {
    const state = makeState({ hasMergeHead: false });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto', continue: true }, baseDeps(state));
    expect(result.action).toBe('invalid-flag');
    expect(state.commitCalls).toHaveLength(0);
    expect(state.pushCalls).toBe(0);
  });

  it('v3.2 misuse: --resume without a pending handoff -> invalid-flag', async () => {
    const state = makeState({ hasMergeHead: false });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto', resume: true }, baseDeps(state));
    expect(result.action).toBe('invalid-flag');
  });

  it('v3.2 misuse: --resume with MERGE_HEAD already present -> invalid-flag', async () => {
    writeBrainLocal(projectRoot, { pendingAgentMerge: true });
    const state = makeState({ hasMergeHead: true });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto', resume: true }, baseDeps(state));
    expect(result.action).toBe('invalid-flag');
  });

  it('v3.2 happy redo: --resume clears the OLD report, re-defers with a fresh report, then --continue completes the loop', async () => {
    writeConflictReport(contextRoot, {
      remoteRef: 'origin/main', resolvedByCli: [],
      deferred: [{ path: 'knowledge/old.md', class: 'knowledge-md', reason: 'r', base: 'b', ours: 'o', theirs: 't' }],
    });
    writeBrainLocal(projectRoot, { pendingAgentMerge: true });

    const resumeState = makeState({ hasMergeHead: false, mergeConflicts: ['knowledge/new.md'] });
    const resumeDeps = baseDeps(resumeState, { resolved: [], deferredToAgent: [{ path: 'knowledge/new.md', class: 'knowledge-md' }] });
    const resumeResult = await runBrainSync({ cwd: contextRoot, mode: 'auto', resume: true }, resumeDeps);
    expect(resumeResult.action).toBe('awaiting-agent');
    expect(resumeState.abortMergeCalls).toBe(0); // --resume leaves the merge IN PROGRESS (classic auto behavior)
    const freshReport = readConflictReport(contextRoot);
    expect(freshReport?.deferred[0].path).toBe('knowledge/new.md'); // OLD report was superseded

    const continueState = makeState({ hasMergeHead: true });
    const continueResult = await runBrainSync({ cwd: contextRoot, mode: 'auto', continue: true }, baseDeps(continueState));
    expect(continueResult.action).toBe('pushed');
    expect(readConflictReport(contextRoot)).toBeNull();
    expect(readBrainLocal(projectRoot).pendingAgentMerge).toBe(false);
  });

  it('v3.2 clean re-resolve: --resume completes alone (pushed) when the remote moved on with no real conflict', async () => {
    writeConflictReport(contextRoot, {
      remoteRef: 'origin/main', resolvedByCli: [],
      deferred: [{ path: 'knowledge/old.md', class: 'knowledge-md', reason: 'r', base: 'b', ours: 'o', theirs: 't' }],
    });
    writeBrainLocal(projectRoot, { pendingAgentMerge: true });

    const state = makeState({ hasMergeHead: false, mergeConflicts: null }); // clean merge this time
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto', resume: true }, baseDeps(state));
    expect(result.action).toBe('pushed');
    expect(readBrainLocal(projectRoot).pendingAgentMerge).toBe(false);
    expect(readConflictReport(contextRoot)).toBeNull();
  });

  it('--resume applies WARN-non-blocking scrub (foreground), unlike headless pull-only', async () => {
    writeBrainLocal(projectRoot, { pendingAgentMerge: true });
    const state = makeState({ hasMergeHead: false, dirty: ['knowledge/y.md'] });
    const deps = baseDeps(state);
    deps.scrubStagedFiles = () => [{ file: 'knowledge/y.md', line: 1, rule: 'home-path', severity: 'warn', excerpt: 'r' }];
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto', resume: true }, deps);
    expect(result.action).not.toBe('blocked-scrub');
  });

  // ── v3.3 master switch ───────────────────────────────────────────────
  it('v3.3: explicit enabled:false returns disabled and touches no git call at all', async () => {
    updateSetupConfig(projectRoot, { brainRepo: { mode: 'full-repo', enabled: false, autoSync: true } });
    const state = makeState({ dirty: ['x.md'] });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto' }, baseDeps(state));
    expect(result.action).toBe('disabled');
    expect(state.fetchCalls).toBe(0);
    expect(state.commitCalls).toHaveLength(0);
  });

  // ── no-remote ────────────────────────────────────────────────────────
  it('no git repo at all -> no-remote', async () => {
    const state = makeState({ isGitRepoResult: false });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto' }, baseDeps(state));
    expect(result.action).toBe('no-remote');
  });

  // ── --strict: WARN escalation (github-cloud-collaboration-brain-repo-sync review) ──
  it('--strict blocks auto sync on a WARN-only scrub hit, but the same hit is non-blocking without --strict', async () => {
    const warnHit = [{ file: 'knowledge/y.md', line: 1, rule: 'home-path' as const, severity: 'warn' as const, excerpt: 'r' }];

    const nonStrictState = makeState({ dirty: ['knowledge/y.md'] });
    const nonStrictDeps = baseDeps(nonStrictState);
    nonStrictDeps.scrubStagedFiles = () => warnHit;
    const nonStrictResult = await runBrainSync({ cwd: contextRoot, mode: 'auto' }, nonStrictDeps);
    expect(nonStrictResult.action).not.toBe('blocked-scrub');
    expect(nonStrictState.commitCalls).toHaveLength(1);

    const strictState = makeState({ dirty: ['knowledge/y.md'] });
    const strictDeps = baseDeps(strictState);
    strictDeps.scrubStagedFiles = () => warnHit;
    const strictResult = await runBrainSync({ cwd: contextRoot, mode: 'auto', strict: true }, strictDeps);
    expect(strictResult.action).toBe('blocked-scrub');
    expect(strictResult.scrub.warns).toHaveLength(1);
    expect(strictState.commitCalls).toHaveLength(0);
  });

  it('--strict blocks push-only on a WARN-only scrub hit', async () => {
    const state = makeState();
    const deps = baseDeps(state);
    deps.scrubStagedFiles = () => [{ file: 'x.md', line: 1, rule: 'home-path', severity: 'warn', excerpt: 'r' }];
    const result = await runBrainSync({ cwd: contextRoot, mode: 'push-only', strict: true }, deps);
    expect(result.action).toBe('blocked-scrub');
    expect(state.commitCalls).toHaveLength(0);
    expect(state.pushCalls).toBe(0);
  });

  it('--strict blocks the --continue re-scrub on a WARN-only hit', async () => {
    const state = makeState({ hasMergeHead: true });
    const deps = baseDeps(state);
    deps.scrubStagedFiles = () => [{ file: 'x.md', line: 1, rule: 'home-path', severity: 'warn', excerpt: 'r' }];
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto', continue: true, strict: true }, deps);
    expect(result.action).toBe('blocked-scrub');
    expect(state.commitCalls).toHaveLength(0);
  });

  it('--strict blocks --resume on a WARN-only hit (foreground WARN normally stays non-blocking without it)', async () => {
    writeBrainLocal(projectRoot, { pendingAgentMerge: true });
    const state = makeState({ hasMergeHead: false, dirty: ['knowledge/y.md'] });
    const deps = baseDeps(state);
    deps.scrubStagedFiles = () => [{ file: 'knowledge/y.md', line: 1, rule: 'home-path', severity: 'warn', excerpt: 'r' }];
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto', resume: true, strict: true }, deps);
    expect(result.action).toBe('blocked-scrub');
    expect(state.commitCalls).toHaveLength(0);
  });

  it('--strict blocks the in-tree commit path on a WARN-only hit', async () => {
    updateSetupConfig(projectRoot, { brainRepo: { mode: 'in-tree', enabled: true, autoSync: false } });
    const state = makeState();
    const deps = baseDeps(state);
    deps.scrubStagedFiles = () => [{ file: '_dream_context/x.md', line: 1, rule: 'home-path', severity: 'warn', excerpt: 'r' }];
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto', strict: true }, deps);
    expect(result.action).toBe('blocked-scrub');
    expect(state.commitCalls).toHaveLength(0);
  });

  // ── post-merge re-scrub gate (github-cloud-collaboration-brain-repo-sync review round 2) ──
  // "re-scrub the merged result before push — a merge can reintroduce a secret",
  // even when there's no textual conflict at all (a clean auto-merge) or when
  // every conflict resolves deterministically (nobody's local edits looked
  // dangerous, but the MERGED result might).
  it('auto: a deterministically-resolved conflict whose merged content contains a BLOCK hit is re-scrubbed before commit — no commit, nothing pushed', async () => {
    const state = makeState({ aheadCount: 1, mergeConflicts: ['core/CHANGELOG.json'] });
    const deps = baseDeps(state, { resolved: ['core/CHANGELOG.json'], deferredToAgent: [] });
    deps.scrubStagedFiles = () => [{ file: 'core/CHANGELOG.json', line: 1, rule: 'github-pat', severity: 'block', excerpt: 'r' }];
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto' }, deps);
    expect(result.action).toBe('blocked-scrub');
    expect(result.scrub.blocks).toHaveLength(1);
    expect(state.commitCalls).toHaveLength(0);
    expect(state.pushCalls).toBe(0);
  });

  it('pull-only: a clean (no-conflict) auto-merge whose content contains a WARN-only hit is blocked (effective --strict) and the merge is aborted back to a clean tree', async () => {
    const state = makeState({ aheadCount: 1, mergeConflicts: null }); // clean merge — no textual conflict
    const deps = baseDeps(state);
    deps.scrubStagedFiles = () => [{ file: 'knowledge/z.md', line: 1, rule: 'home-path', severity: 'warn', excerpt: 'r' }];
    const result = await runBrainSync({ cwd: contextRoot, mode: 'pull-only' }, deps);
    expect(result.action).toBe('blocked-scrub');
    expect(result.scrub.warns).toHaveLength(1);
    expect(state.abortMergeCalls).toBe(1);
    expect(state.commitCalls).toHaveLength(0);
  });

  it('auto: a clean (no-conflict) auto-merge whose content contains a BLOCK hit is blocked before push — no commit, nothing pushed', async () => {
    const state = makeState({ aheadCount: 1, mergeConflicts: null }); // clean merge — no textual conflict
    const deps = baseDeps(state);
    deps.scrubStagedFiles = () => [{ file: 'knowledge/remote-secret.md', line: 1, rule: 'github-pat', severity: 'block', excerpt: 'r' }];
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto' }, deps);
    expect(result.action).toBe('blocked-scrub');
    expect(result.scrub.blocks).toHaveLength(1);
    expect(state.commitCalls).toHaveLength(0);
    expect(state.pushCalls).toBe(0);
  });

  // ── C7 needsTaskSync ─────────────────────────────────────────────────
  it('C7: needsTaskSync is set when a merge resolves task-referencing files under a remote task backend', async () => {
    updateSetupConfig(projectRoot, { taskBackend: 'github' });
    const state = makeState({ aheadCount: 1, mergeConflicts: ['state/foo.md'] });
    const deps = baseDeps(state, { resolved: ['state/foo.md'], deferredToAgent: [] });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto' }, deps);
    expect(result.needsTaskSync).toBe(true);
  });

  // ── C2 (M3): post-pull task-mirror refresh signal ──────────────────────
  // The BACKGROUND path (session-start's detached `brain sync --pull-only`)
  // cannot auto-run the task backend sync itself (best-effort, non-blocking,
  // stdio:'ignore') — it persists the signal to `.brain-local.json` so the
  // NEXT session-start's hook can surface the "refresh your task mirrors"
  // instruction instead. The FOREGROUND path (`sleep done`) reads
  // `result.needsTaskSync` directly off the `SyncResult` and auto-runs
  // `getTaskBackend(root).sync('both')` (src/cli/commands/sleep.ts) — already
  // covered by the C7 assertion above returning `needsTaskSync` on the result.
  it('C2: pull-only persists needsTaskSync to brain-local when the merge touches task-referencing files under taskBackend=github', async () => {
    updateSetupConfig(projectRoot, { taskBackend: 'github', brainRepo: { mode: 'full-repo', enabled: true, autoSync: true } });
    const state = makeState({ aheadCount: 1, mergeConflicts: ['state/foo.md'] });
    const deps = baseDeps(state, { resolved: ['state/foo.md'], deferredToAgent: [] });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'pull-only' }, deps);
    expect(result.needsTaskSync).toBe(true);
    expect(readBrainLocal(projectRoot).needsTaskSync).toBe(true);
  });

  it('C2: pull-only persists needsTaskSync:false when the merge touches no task-referencing files (nothing to surface)', async () => {
    updateSetupConfig(projectRoot, { taskBackend: 'github', brainRepo: { mode: 'full-repo', enabled: true, autoSync: true } });
    const state = makeState({ aheadCount: 1, mergeConflicts: ['knowledge/x.md'] });
    const deps = baseDeps(state, { resolved: ['knowledge/x.md'], deferredToAgent: [] });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'pull-only' }, deps);
    expect(result.needsTaskSync).toBeFalsy();
    expect(readBrainLocal(projectRoot).needsTaskSync).toBe(false);
  });

  // ── full-repo mode: sync the WHOLE project folder to origin on the current branch ──
  const fullRepo = () => updateSetupConfig(projectRoot, { brainRepo: { mode: 'full-repo', enabled: true, autoSync: true } });

  it('full-repo: auto fetches/pushes the CURRENT branch, never assumes main', async () => {
    fullRepo();
    const state = makeState({ dirty: ['src/index.ts'], branch: 'feature/x' });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto' }, baseDeps(state));
    expect(result.action).toBe('pushed');
    // Every fetch/exists/push branch arg is the checked-out branch, not 'main'.
    expect(state.branchCalls.length).toBeGreaterThan(0);
    expect(state.branchCalls.every((b) => b === 'feature/x')).toBe(true);
  });

  it('full-repo: the sync commit message is project-scoped, not (brain)-scoped', async () => {
    fullRepo();
    const state = makeState({ dirty: ['README.md'], branch: 'main' });
    await runBrainSync({ cwd: contextRoot, mode: 'auto' }, baseDeps(state));
    expect(state.commitCalls[0].message).toBe('chore: sync project (dreamcontext)');
    expect(state.commitCalls[0].message).not.toMatch(/\(brain\)/);
  });

  it('full-repo: foreground pull-only keeps a WARN-only hit NON-blocking (a human is watching the dashboard)', async () => {
    fullRepo();
    const state = makeState({ aheadCount: 1, dirty: ['src/app.ts'], branch: 'main' });
    const deps = baseDeps(state);
    // Absolute-path WARNs are common across a whole code repo — they must not block the dashboard pull.
    deps.scrubStagedFiles = () => [{ file: 'src/app.ts', line: 1, rule: 'home-path', severity: 'warn', excerpt: 'r' }];
    const result = await runBrainSync({ cwd: contextRoot, mode: 'pull-only', foreground: true }, deps);
    expect(result.action).not.toBe('blocked-scrub');
    expect(state.commitCalls[0].message).toBe('chore: checkpoint local edits before team merge (dreamcontext)');
  });

  it('full-repo: HEADLESS pull-only still blocks the same WARN hit (no human eye — effective strict preserved)', async () => {
    fullRepo();
    const state = makeState({ aheadCount: 1, dirty: ['src/app.ts'], branch: 'main' });
    const deps = baseDeps(state);
    deps.scrubStagedFiles = () => [{ file: 'src/app.ts', line: 1, rule: 'home-path', severity: 'warn', excerpt: 'r' }];
    const result = await runBrainSync({ cwd: contextRoot, mode: 'pull-only' /* foreground unset */ }, deps);
    expect(result.action).toBe('blocked-scrub');
    expect(state.commitCalls).toHaveLength(0);
  });

  it('full-repo: a real secret (BLOCK) still stops even a foreground pull', async () => {
    fullRepo();
    const state = makeState({ aheadCount: 1, dirty: ['.env'], branch: 'main' });
    const deps = baseDeps(state);
    deps.scrubStagedFiles = () => [{ file: '.env', line: 1, rule: 'github-pat', severity: 'block', excerpt: 'ghp_x' }];
    const result = await runBrainSync({ cwd: contextRoot, mode: 'pull-only', foreground: true }, deps);
    expect(result.action).toBe('blocked-scrub');
    expect(state.commitCalls).toHaveLength(0);
  });

  // ── item 2: detached HEAD in full-repo ──
  it('full-repo: a detached HEAD refuses with detached-head, touching no git network call', async () => {
    fullRepo();
    // currentBranch() returns null on a detached HEAD.
    const state = makeState({ dirty: ['src/app.ts'], branch: null as unknown as string });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto' }, baseDeps(state));
    expect(result.action).toBe('detached-head');
    expect(result.note).toMatch(/detached head/i);
    expect(state.fetchCalls).toBe(0);
    expect(state.pushCalls).toBe(0);
    expect(state.commitCalls).toHaveLength(0);
  });

  // ── item 4: code-conflict policy (full-repo) ──
  it('full-repo: a conflicting CODE file defers to the human (code-conflict) and is never merged/agent-deferred', async () => {
    fullRepo();
    const state = makeState({ aheadCount: 1, mergeConflicts: ['src/app.ts'], branch: 'main' });
    // The REAL resolveConflicts runs here (not the fake) so the fullRepo→code classification is exercised.
    const deps = baseDeps(state);
    delete (deps as { resolveConflicts?: unknown }).resolveConflicts;
    // The dashboard's manual sync is foreground (a human is watching).
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto', foreground: true }, deps);
    expect(result.action).toBe('code-conflict');
    expect(result.codeConflicts).toEqual(['src/app.ts']);
    // Foreground leaves the merge in progress (markers for the human) — never aborts.
    expect(state.abortMergeCalls).toBe(0);
    // A code-conflict report is written and separates code from brain files.
    const report = readConflictReport(contextRoot);
    expect(report?.codeConflicts).toEqual(['src/app.ts']);
    expect(report?.deferred).toEqual([]);
  });

  it('full-repo: HEADLESS pull-only aborts a code conflict to a clean tree (no broken tree with no human watching)', async () => {
    fullRepo();
    const state = makeState({ aheadCount: 1, mergeConflicts: ['src/app.ts'], branch: 'main' });
    const deps = baseDeps(state);
    delete (deps as { resolveConflicts?: unknown }).resolveConflicts;
    const result = await runBrainSync({ cwd: contextRoot, mode: 'pull-only' /* headless */ }, deps);
    expect(result.action).toBe('code-conflict');
    expect(state.abortMergeCalls).toBe(1);
  });

  // ── item 7: auto-checkpoint transparency + opt-out ──
  it('full-repo: pull-only reports checkpointed + a checkpointSha when it auto-commits dirty WIP', async () => {
    fullRepo();
    const state = makeState({ aheadCount: 1, dirty: ['src/app.ts'], branch: 'main' });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'pull-only', foreground: true }, baseDeps(state));
    expect(result.action).toBe('pulled');
    expect(result.checkpointed).toBe(true);
    expect(result.checkpointSha).toBeTruthy();
  });

  it('full-repo: noCheckpoint skips the pull on a dirty tree, leaving WIP untouched (no commit)', async () => {
    fullRepo();
    const state = makeState({ aheadCount: 1, dirty: ['src/app.ts'], branch: 'main' });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'pull-only', foreground: true, noCheckpoint: true }, baseDeps(state));
    expect(result.action).toBe('noop');
    expect(result.note).toMatch(/auto-checkpoint-on-open is off/i);
    expect(state.commitCalls).toHaveLength(0); // WIP left untouched — no auto-commit
    expect(state.pushCalls).toBe(0); // pull-only never pushes, and here it never even merges
  });

  it('pull-only on a CLEAN tree still pulls with noCheckpoint set (opt-out only guards a dirty tree)', async () => {
    fullRepo();
    const state = makeState({ aheadCount: 1, dirty: [], branch: 'main' });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'pull-only', foreground: true, noCheckpoint: true }, baseDeps(state));
    expect(result.action).toBe('pulled');
    expect(result.checkpointed).toBe(false);
  });

  // ── review fix: locally-ahead commits are pushed, but NEVER unscrubbed ──
  it('full-repo: locally-ahead commits (a human-finished merge) push cleanly when there is nothing to scrub', async () => {
    fullRepo();
    // aheadCount 0 (remote not ahead), localAhead 1 (a native merge commit), clean tree.
    const state = makeState({ aheadCount: 0, localAhead: 1, dirty: [], branch: 'main' });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto', foreground: true }, baseDeps(state));
    expect(result.action).toBe('pushed');
    expect(state.pushCalls).toBe(1);
  });

  it('full-repo: a secret in a locally-ahead commit is scrubbed and BLOCKS the push (scrub gate is never bypassed)', async () => {
    fullRepo();
    const state = makeState({ aheadCount: 0, localAhead: 1, dirty: [], branch: 'main' });
    const deps = baseDeps(state);
    // The commit skipped our staged-commit scrub — the pre-push range scrub catches it.
    deps.scrubCommitRange = () => [{ file: 'src/app.ts', line: 3, rule: 'github-pat', severity: 'block', excerpt: 'ghp_[REDACTED]' }];
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto', foreground: true }, deps);
    expect(result.action).toBe('blocked-scrub');
    expect(result.scrub.blocks).toHaveLength(1);
    expect(state.pushCalls).toBe(0);
  });

  it('a clean-tree, remote-not-ahead, no-local-ahead sync is still a plain noop', async () => {
    fullRepo();
    const state = makeState({ aheadCount: 0, localAhead: 0, dirty: [], branch: 'main' });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto', foreground: true }, baseDeps(state));
    expect(result.action).toBe('noop');
  });

  it('push-only ALSO range-scrubs everything being pushed — a secret in a local-ahead commit blocks (--push-only is not a bypass)', async () => {
    fullRepo();
    const state = makeState({ branch: 'main' });
    const deps = baseDeps(state);
    // The staged scrub sees nothing new (clean tree); the pre-push range scrub catches the committed secret.
    deps.scrubCommitRange = () => [{ file: 'src/app.ts', line: 1, rule: 'github-pat', severity: 'block', excerpt: 'ghp_[REDACTED]' }];
    const result = await runBrainSync({ cwd: contextRoot, mode: 'push-only' }, deps);
    expect(result.action).toBe('blocked-scrub');
    expect(state.pushCalls).toBe(0);
  });

  // ── review fix: a mixed code + brain-prose conflict records BOTH (no dropped agent record) ──
  it('full-repo: a merge conflicting on BOTH a code file and a brain file records the agent-deferred file too', async () => {
    fullRepo();
    const state = makeState({ aheadCount: 1, mergeConflicts: ['src/app.ts', 'knowledge/k.md'], branch: 'main' });
    const deps = baseDeps(state, {
      resolved: [],
      deferredToAgent: [{ path: 'knowledge/k.md', class: 'knowledge-md' }],
      deferredToHuman: [{ path: 'src/app.ts', class: 'code' }],
    });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto', foreground: true }, deps);
    expect(result.action).toBe('code-conflict');
    expect(result.codeConflicts).toEqual(['src/app.ts']);
    const report = readConflictReport(contextRoot);
    expect(report?.codeConflicts).toEqual(['src/app.ts']);
    // The coincident brain-prose conflict is NOT silently dropped — it stays in the report.
    expect(report?.deferred.map((d) => d.path)).toEqual(['knowledge/k.md']);
  });
});

// ── stale-per-project-token self-heal (fallback to the signed-in global token) ──
describe('git-sync/sync-engine — stale per-project token self-heal', () => {
  let projectRoot: string;
  let contextRoot: string;

  const STALE = 'stale-project-token';
  const FRESH = 'fresh-global-token';

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dc-heal-'));
    contextRoot = join(projectRoot, '_dream_context');
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    updateSetupConfig(projectRoot, { brainRepo: { mode: 'full-repo', enabled: true, autoSync: true } });
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  function secretsPath() { return join(contextRoot, 'state', '.secrets.json'); }
  function readSecrets() { return JSON.parse(readFileSync(secretsPath(), 'utf-8')); }

  /** A `withGitCredentials` fake that threads the active token into the op env. */
  const withCreds = (async (token: string, fn: (env: NodeJS.ProcessEnv) => unknown) =>
    fn({ DC_TOKEN: token })) as SyncEngineDeps['withGitCredentials'];

  /** Token-aware fake git: network ops throw `throwMessage` when run with a bad token. */
  function tokenAwareGit(state: FakeState, badTokens: string[], throwMessage: string): typeof git {
    const base = makeFakeGit(state);
    return {
      ...base,
      remoteBranchExists: (_c: string, _r: string, branch: string, env?: NodeJS.ProcessEnv) => {
        state.branchCalls.push(branch);
        if (badTokens.includes(String(env?.DC_TOKEN))) throw new Error(throwMessage);
        return state.remoteExists;
      },
      fetch: (_c: string, _r: string, branch: string, env?: NodeJS.ProcessEnv) => {
        state.fetchCalls += 1; state.branchCalls.push(branch);
        if (badTokens.includes(String(env?.DC_TOKEN))) throw new Error(throwMessage);
      },
      push: (_c: string, _r: string, branch: string, env?: NodeJS.ProcessEnv) => {
        state.pushCalls += 1; state.branchCalls.push(branch);
        if (badTokens.includes(String(env?.DC_TOKEN))) throw new Error(throwMessage);
        if (state.pushCalls <= state.pushFailFirstN) throw new Error('push rejected (non-fast-forward)');
      },
    } as typeof git;
  }

  function healDeps(state: FakeState, opts: { global: ResolvedToken | null; badTokens: string[]; throwMessage: string }): Partial<SyncEngineDeps> {
    return {
      git: tokenAwareGit(state, opts.badTokens, opts.throwMessage),
      scrubStagedFiles: () => [],
      scrubCommitRange: () => [],
      resolveConflicts: () => ({ resolved: [], deferredToAgent: [], deferredToHuman: [] }),
      // Per-project token WINS resolution (the shadowing slot) — the real bug.
      resolveBrainSyncToken: () => ({ token: STALE, source: 'secrets', via: 'token' }),
      readGlobalGitHubToken: () => opts.global,
      // Use the REAL demoteProjectGitHubToken (from defaultDeps) so the on-disk
      // self-heal is exercised for real against the temp brain-local file.
      withGitCredentials: withCreds,
      acquireBrainLock: () => true,
      releaseBrainLock: () => {},
    };
  }

  it('per-project auth/permission failure → falls back to global, heals, DEMOTES github.token (kept on disk, every key preserved)', async () => {
    // Real secrets file: the stale github.token PLUS a per-user token map and a clickup block that must survive.
    writeGitHubToken(projectRoot, STALE);
    writeGitHubToken(projectRoot, 'alice-token', 'alice');
    writeClickUpToken(projectRoot, 'cu-token');
    expect(readSecrets().github.token).toBe(STALE);

    const state = makeState({ dirty: ['knowledge/x.md'], branch: 'main' });
    const deps = healDeps(state, { global: { token: FRESH, source: 'secrets', via: 'global' }, badTokens: [STALE], throwMessage: 'remote: Permission to Genevous/genevous-brain.git denied to meanllbrl.' });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto' }, deps);

    expect(result.action).toBe('pushed');
    expect(result.healedStaleProjectToken).toBe(true);
    expect(result.note).toMatch(/switched to your signed-in GitHub account/i);
    // Askpass hygiene: neither token value ever appears in the surfaced note.
    expect(result.note).not.toContain(STALE);
    expect(result.note).not.toContain(FRESH);
    expect(state.pushCalls).toBeGreaterThanOrEqual(1);

    // Self-heal on disk: github.token KEPT (the task backend may own it) — only
    // demoted via the machine-local hash marker; everything else untouched.
    const secrets = readSecrets();
    expect(secrets.github?.token).toBe(STALE);
    expect(secrets.github?.users?.alice).toBe('alice-token');
    expect(secrets.clickup?.token).toBe('cu-token');
    expect(isDemotedProjectToken(projectRoot, STALE)).toBe(true);
    expect(isDemotedProjectToken(projectRoot, 'some-new-token')).toBe(false);
    // The raw token value never lands in the brain-local file — hash only.
    expect(JSON.stringify(readBrainLocal(projectRoot))).not.toContain(STALE);
  });

  it('retry ALSO fails (global rejected too) → surfaces the ORIGINAL failure and does NOT remove the project token', async () => {
    writeGitHubToken(projectRoot, STALE);
    const state = makeState({ dirty: ['knowledge/x.md'], branch: 'main' });
    const deps = healDeps(state, { global: { token: FRESH, source: 'secrets', via: 'global' }, badTokens: [STALE, FRESH], throwMessage: 'remote: Permission to Genevous/genevous-brain.git denied.' });

    await expect(runBrainSync({ cwd: contextRoot, mode: 'auto' }, deps)).rejects.toThrow(/denied/);
    // Stale token NOT removed — the recovery never succeeded.
    expect(readSecrets().github?.token).toBe(STALE);
  });

  it('no global token configured → no retry, stale token left in place', async () => {
    writeGitHubToken(projectRoot, STALE);
    const state = makeState({ dirty: ['knowledge/x.md'], branch: 'main' });
    const deps = healDeps(state, { global: null, badTokens: [STALE], throwMessage: 'fatal: Authentication failed' });

    await expect(runBrainSync({ cwd: contextRoot, mode: 'auto' }, deps)).rejects.toThrow();
    expect(readSecrets().github?.token).toBe(STALE);
  });

  it('a NON-auth failure (network) never triggers the fallback and never touches the secrets file', async () => {
    writeGitHubToken(projectRoot, STALE);
    const state = makeState({ dirty: ['knowledge/x.md'], branch: 'main' });
    const deps = healDeps(state, { global: { token: FRESH, source: 'secrets', via: 'global' }, badTokens: [STALE], throwMessage: 'fatal: unable to access: Could not resolve host: github.com' });

    await expect(runBrainSync({ cwd: contextRoot, mode: 'auto' }, deps)).rejects.toThrow(/resolve host/);
    expect(readSecrets().github?.token).toBe(STALE);
  });

  it('pull-only path also self-heals a stale per-project token on the fetch', async () => {
    writeGitHubToken(projectRoot, STALE);
    const state = makeState({ aheadCount: 1, shaSequence: ['before', 'after'], branch: 'main' });
    const deps = healDeps(state, { global: { token: FRESH, source: 'secrets', via: 'global' }, badTokens: [STALE], throwMessage: 'fatal: Authentication failed' });

    const result = await runBrainSync({ cwd: contextRoot, mode: 'pull-only', foreground: true }, deps);
    expect(result.action).toBe('pulled');
    expect(result.healedStaleProjectToken).toBe(true);
    // The token is DEMOTED, never deleted — the secrets file survives intact.
    expect(existsSync(secretsPath())).toBe(true);
    expect(readSecrets().github?.token).toBe(STALE);
    expect(isDemotedProjectToken(projectRoot, STALE)).toBe(true);
  });
});
