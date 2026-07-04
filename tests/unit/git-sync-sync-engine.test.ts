import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateSetupConfig, readBrainLocal, writeBrainLocal } from '../../src/lib/setup-config.js';
import { writeConflictReport, readConflictReport } from '../../src/lib/git-sync/conflict-report.js';
import { acquireBrainLock, releaseBrainLock, FALLBACK_AUTHOR } from '../../src/lib/git-sync/brain-repo.js';
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
  shaSequence: string[];
  shaIdx: number;
  mergeConflicts: string[] | null; // null => clean; array => conflicted paths
  fetchCalls: number;
  pushCalls: number;
  pushFailFirstN: number;
  commitCalls: { message: string; author?: { name: string; email: string } }[];
  abortMergeCalls: number;
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
    revListCount: () => state.aheadCount,
    currentSha: () => {
      const sha = state.shaSequence[Math.min(state.shaIdx, state.shaSequence.length - 1)];
      state.shaIdx += 1;
      return sha;
    },
    commit: (_cwd: string, message: string, author?: { name: string; email: string }) => {
      state.commitCalls.push({ message, author });
      return 'newsha';
    },
    fetch: () => {
      state.fetchCalls += 1;
    },
    push: () => {
      state.pushCalls += 1;
      if (state.pushCalls <= state.pushFailFirstN) {
        throw new Error('push rejected (non-fast-forward)');
      }
    },
    attemptMerge: () => {
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
    shaSequence: ['sha1', 'sha2'],
    shaIdx: 0,
    mergeConflicts: null,
    fetchCalls: 0,
    pushCalls: 0,
    pushFailFirstN: 0,
    commitCalls: [],
    abortMergeCalls: 0,
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
    updateSetupConfig(projectRoot, { brainRepo: { mode: 'separate', enabled: true, autoSync: true } });
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  function baseDeps(state: FakeState, resolvedConflicts: { resolved: string[]; deferredToAgent: { path: string; class: 'knowledge-md' }[] } = { resolved: [], deferredToAgent: [] }): Partial<SyncEngineDeps> {
    return {
      git: makeFakeGit(state),
      scrubStagedFiles: () => [],
      resolveConflicts: () => resolvedConflicts,
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

  it('scrub BLOCK aborts before commit — separate mode', async () => {
    const state = makeState({ dirty: ['x.md'] });
    const deps = baseDeps(state);
    deps.scrubStagedFiles = () => [{ file: 'x.md', line: 1, rule: 'github-pat', severity: 'block', excerpt: 'r' }];
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto' }, deps);
    expect(result.action).toBe('blocked-scrub');
    expect(state.commitCalls).toHaveLength(0);
    expect(state.pushCalls).toBe(0);
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
    expect(state.commitCalls[0].message).toBe('chore(brain): auto-checkpoint local edits before team merge');
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
  it('C3: MERGE_HEAD present -> already-awaiting-agent, touches nothing', async () => {
    const state = makeState({ hasMergeHead: true });
    const result = await runBrainSync({ cwd: contextRoot, mode: 'auto' }, baseDeps(state));
    expect(result.action).toBe('already-awaiting-agent');
    expect(state.fetchCalls).toBe(0);
    expect(state.commitCalls).toHaveLength(0);
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
    updateSetupConfig(projectRoot, { brainRepo: { mode: 'separate', enabled: false, autoSync: true } });
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
});
