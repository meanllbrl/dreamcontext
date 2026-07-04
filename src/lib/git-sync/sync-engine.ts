import { dirname } from 'node:path';
import { readSetupConfig, readBrainLocal, writeBrainLocal, type SetupConfig } from '../setup-config.js';
import * as git from './git.js';
import { GitSyncError } from './git.js';
import { scrubStagedFiles, summarizeScrub, type ScrubHit } from './scrub.js';
import { resolveConflicts } from './semantic-merge.js';
import { writeConflictReport, readConflictReport, clearConflictReport } from './conflict-report.js';
import {
  resolveBrainSyncToken,
  resolveMode,
  resolveBrainSyncEnabled,
  acquireBrainLock,
  releaseBrainLock,
  FALLBACK_AUTHOR,
} from './brain-repo.js';
import { withGitCredentials } from './credentials.js';

/**
 * The sync-engine orchestrator — single entry point (`runBrainSync`) for
 * `sleep done`, `/dream-sync`, the session-start background pull, and the
 * dashboard. Implements the full v3.2/v3.3 contract from
 * `skill-sync/references/merge-rules.md`.
 */

const REMOTE_NAME = 'origin';
const REMOTE_BRANCH = 'main';
const REMOTE_REF = `${REMOTE_NAME}/${REMOTE_BRANCH}`;
const AUTO_CHECKPOINT_MESSAGE = 'chore(brain): auto-checkpoint local edits before team merge';
const MERGE_COMMIT_MESSAGE = 'chore(brain): merge team updates';
const AGENT_MERGE_COMMIT_MESSAGE = 'chore(brain): merge team updates (agent-resolved)';

export type SyncAction =
  | 'noop'
  | 'pushed'
  | 'pulled'
  | 'merged'
  | 'blocked-scrub'
  | 'awaiting-agent'
  | 'already-awaiting-agent'
  | 'locked'
  | 'skipped-in-tree'
  | 'no-remote'
  | 'invalid-flag'
  | 'disabled';

export interface SyncOptions {
  /** Absolute path to `_dream_context/` (what `ensureContextRoot()` returns). */
  cwd: string;
  mode: 'auto' | 'pull-only' | 'push-only';
  strict?: boolean;
  /** Commit an IN-PROGRESS merge (requires `MERGE_HEAD`). */
  continue?: boolean;
  /** ATTENDED redo of a pull-only-deferred handoff (requires `pendingAgentMerge && !MERGE_HEAD`). */
  resume?: boolean;
}

export interface SyncResult {
  action: SyncAction;
  scrub: { blocks: ScrubHit[]; warns: ScrubHit[] };
  commitSha?: string;
  pushed?: boolean;
  pulledUpdates?: number;
  conflicts?: string[];
  /** Conflict report path (repo-relative), when one was written. */
  report?: string;
  /** C7: a merge/pull touched task-referencing files under a remote task backend. */
  needsTaskSync?: boolean;
  /** Human-facing guidance (flag-misuse notes, disabled notice, etc). CLI renders via `error()`/`warn()`. */
  note?: string;
}

const EMPTY_SCRUB = { blocks: [] as ScrubHit[], warns: [] as ScrubHit[] };

/**
 * Whether a scrub result should gate a commit: BLOCK hits always do; WARN
 * hits only escalate to blocking when `--strict` is set (per the plan's
 * contract — "warns are non-blocking unless --strict"). Headless pull-only
 * has its own unconditional effective-strict check and does not use this.
 */
function isBlockingScrub(scrub: { blocks: ScrubHit[]; warns: ScrubHit[] }, strict: boolean): boolean {
  return scrub.blocks.length > 0 || (strict && scrub.warns.length > 0);
}

/** Injectable dependencies — tests supply a fake `git` module + fakes for the rest. */
export interface SyncEngineDeps {
  git: typeof git;
  resolveConflicts: typeof resolveConflicts;
  scrubStagedFiles: typeof scrubStagedFiles;
  resolveBrainSyncToken: typeof resolveBrainSyncToken;
  withGitCredentials: typeof withGitCredentials;
  acquireBrainLock: typeof acquireBrainLock;
  releaseBrainLock: typeof releaseBrainLock;
}

const defaultDeps: SyncEngineDeps = {
  git,
  resolveConflicts,
  scrubStagedFiles,
  resolveBrainSyncToken,
  withGitCredentials,
  acquireBrainLock,
  releaseBrainLock,
};

interface Ctx {
  d: SyncEngineDeps;
  contextRoot: string;
  gitCwd: string;
  projectRoot: string;
  config: SetupConfig | null;
  /** `--strict`: escalate WARN-tier scrub hits to blocking on every gated commit path. */
  strict: boolean;
}

function computeNeedsTaskSync(config: SetupConfig | null, paths: string[]): boolean {
  if (config?.taskBackend !== 'github' && config?.taskBackend !== 'clickup') return false;
  return paths.some((p) => {
    const norm = p.replace(/^_dream_context\//, '');
    return norm === 'state/.active-version.json' || norm === 'core/CHANGELOG.json' || /^state\/[^/]+\.md$/.test(norm);
  });
}

function authorFor(ctx: Ctx): { name: string; email: string } | undefined {
  return ctx.d.git.hasGitIdentity(ctx.gitCwd) ? undefined : FALLBACK_AUTHOR;
}

/** Single entry point. Never throws for operational outcomes — a persistent push failure is the one true programmer-facing GitSyncError. */
export async function runBrainSync(opts: SyncOptions, depsOverride: Partial<SyncEngineDeps> = {}): Promise<SyncResult> {
  const d: SyncEngineDeps = { ...defaultDeps, ...depsOverride };
  const contextRoot = opts.cwd;
  const projectRoot = dirname(contextRoot);
  const config = readSetupConfig(projectRoot);

  const enabledResolution = resolveBrainSyncEnabled(projectRoot, config, d.git);
  if (!enabledResolution.enabled) {
    return {
      action: 'disabled',
      scrub: EMPTY_SCRUB,
      note: 'Cloud sync is off for this project. Enable it with `dreamcontext brain enable` or in Settings.',
    };
  }

  const mode = resolveMode(config);
  const gitCwd = mode === 'separate' ? contextRoot : projectRoot;
  const ctx: Ctx = { d, contextRoot, gitCwd, projectRoot, config, strict: !!opts.strict };

  if (!d.git.isGitRepo(gitCwd)) {
    return {
      action: 'no-remote',
      scrub: EMPTY_SCRUB,
      note: 'No git repository found for the brain. Run `dreamcontext brain init` or `brain attach` first.',
    };
  }

  // In-tree NEVER syncs/merges with a remote — commit-only, always scrubbed
  // (S2). It bypasses the reentrancy guard entirely: that machinery exists
  // for the separate-repo merge lifecycle, which in-tree never enters, and
  // gating on an unrelated in-progress CODE-repo merge would be a false positive.
  if (mode === 'in-tree') {
    if (!d.acquireBrainLock(contextRoot)) return { action: 'locked', scrub: EMPTY_SCRUB };
    try {
      return commitInTree(ctx);
    } finally {
      d.releaseBrainLock(contextRoot);
    }
  }

  // ── Reentrancy guard — 5-clause precedence (v3.2) ──────────────────────
  const hasMerge = d.git.hasMergeHead(gitCwd);
  const brainLocal = readBrainLocal(projectRoot);
  const pending = brainLocal.pendingAgentMerge === true;

  if (opts.continue && !hasMerge) {
    return {
      action: 'invalid-flag',
      scrub: EMPTY_SCRUB,
      note: 'No merge in progress to continue. If a team update is waiting, run `dreamcontext brain sync --resume` (or /dream-sync).',
    };
  }
  if (opts.resume && hasMerge) {
    return { action: 'invalid-flag', scrub: EMPTY_SCRUB, note: 'A merge is already in progress — run `dreamcontext brain sync --continue`.' };
  }
  if (opts.resume && !pending) {
    return { action: 'invalid-flag', scrub: EMPTY_SCRUB, note: 'No pending team-merge handoff to resume.' };
  }

  if (hasMerge && !opts.continue) {
    return { action: 'already-awaiting-agent', scrub: EMPTY_SCRUB, note: 'A team merge is awaiting resolution — run /dream-sync to reconcile.' };
  }
  if (pending && !hasMerge && !opts.resume) {
    return { action: 'already-awaiting-agent', scrub: EMPTY_SCRUB, note: 'A team merge is awaiting resolution — run /dream-sync to reconcile.' };
  }

  if (!hasMerge && !pending && readConflictReport(contextRoot)) {
    clearConflictReport(contextRoot);
  }

  if (!d.acquireBrainLock(contextRoot)) return { action: 'locked', scrub: EMPTY_SCRUB };

  try {
    if (opts.continue) return await continueMerge(ctx);
    if (opts.resume) return await resumeHandoff(ctx);
    if (opts.mode === 'pull-only') return await pullOnlySync(ctx);
    if (opts.mode === 'push-only') return await pushOnlySync(ctx);
    return await autoSync(ctx);
  } finally {
    d.releaseBrainLock(contextRoot);
  }
}

// ─── in-tree: commit-only, never pushes ─────────────────────────────────────

function commitInTree(ctx: Ctx): SyncResult {
  const { d, gitCwd } = ctx;
  d.git.stagePath(gitCwd, '_dream_context');
  const hits = d.scrubStagedFiles(gitCwd, { pathPrefix: '_dream_context/' });
  const scrub = summarizeScrub(hits);
  if (isBlockingScrub(scrub, ctx.strict)) return { action: 'blocked-scrub', scrub };

  const sha = d.git.commit(gitCwd, 'chore(brain): sync (in-tree)', authorFor(ctx));
  if (!sha) return { action: 'noop', scrub };
  return { action: 'skipped-in-tree', scrub, commitSha: sha };
}

// ─── shared: merge + defer-or-resolve a conflict set ────────────────────────

interface MergeOutcome {
  result: SyncResult | null; // non-null ⇒ caller should return this immediately (awaiting-agent / blocked-scrub)
  needsTaskSync: boolean;
}

interface MergeAndMaybeDeferOpts {
  abortOnDefer: boolean;
  markPendingOnDefer: boolean;
  /**
   * Headless pull-only: ANY scrub hit (even WARN) blocks, regardless of
   * `ctx.strict` — same "no human eye" reasoning as pull-only's own
   * pre-merge dirty-scrub (amendment 4). Foreground callers (auto,
   * `--resume`, the push-retry re-merge) leave this unset and fall back to
   * `ctx.strict`.
   */
  effectiveStrict?: boolean;
}

/**
 * Re-scrub whatever the merge just staged (or committed, for a git-internal
 * fast-forward — nothing to scrub there since nothing new is staged) BEFORE
 * it is allowed to land: a merge can reintroduce a secret with no textual
 * conflict at all. Returns a `blocked-scrub` outcome on a blocking hit;
 * otherwise commits the merge and returns null (caller proceeds to push).
 */
function scrubAndCommitMerge(ctx: Ctx, effectiveStrict: boolean, message: string): SyncResult | null {
  const { d, gitCwd } = ctx;
  const hits = d.scrubStagedFiles(gitCwd);
  const scrub = summarizeScrub(hits);
  const strict = effectiveStrict || ctx.strict;
  if (isBlockingScrub(scrub, strict)) {
    // Unlike an "awaiting-agent" content conflict (which auto mode
    // deliberately leaves in progress for /dream-sync's --continue), a
    // security block must never sit around in a live merge in ANY mode —
    // abort immediately so nothing sensitive lingers staged/mid-merge.
    d.git.abortMerge(gitCwd);
    return { action: 'blocked-scrub', scrub, note: 'The merge result contains something that looks sensitive — review and run `dreamcontext brain sync` manually.' };
  }
  d.git.commit(gitCwd, message, authorFor(ctx));
  return null;
}

/**
 * Fold a `mergeAndMaybeDefer` outcome into the caller's result. Never let the
 * caller's own PRE-merge `scrub` clobber a `blocked-scrub` outcome's OWN
 * hits — those are the actual reason it blocked, not the (possibly empty)
 * pre-merge value.
 */
function withMergeOutcome(result: SyncResult, preMergeScrub: { blocks: ScrubHit[]; warns: ScrubHit[] }): SyncResult {
  return result.action === 'blocked-scrub' ? result : { ...result, scrub: preMergeScrub };
}

/** Attempt `attemptMerge`; on conflict, resolve deterministically and defer the rest to the agent. */
function mergeAndMaybeDefer(ctx: Ctx, opts: MergeAndMaybeDeferOpts): MergeOutcome {
  const { d, gitCwd, contextRoot, projectRoot, config } = ctx;
  const mergeResult = d.git.attemptMerge(gitCwd, REMOTE_REF);

  if (mergeResult.clean) {
    // A pure fast-forward already advanced the ref (nothing staged, nothing
    // to scrub/commit — `commit()` no-ops on "nothing to commit"). A REAL
    // clean auto-merge is staged via `--no-commit`, NOT yet committed — it
    // must clear the same re-scrub gate as every other merge-commit path.
    const blocked = scrubAndCommitMerge(ctx, !!opts.effectiveStrict, MERGE_COMMIT_MESSAGE);
    return { result: blocked, needsTaskSync: false };
  }

  const resolution = d.resolveConflicts(gitCwd, mergeResult.conflicts);
  const needsTaskSync = computeNeedsTaskSync(config, resolution.resolved);

  if (resolution.deferredToAgent.length > 0) {
    writeConflictReport(contextRoot, {
      remoteRef: REMOTE_REF,
      resolvedByCli: resolution.resolved,
      deferred: resolution.deferredToAgent.map((x) => {
        const snap = d.git.readOursTheirsBase(gitCwd, x.path);
        return { path: x.path, class: x.class, reason: 'overlapping edits to same section', ...snap };
      }),
    });
    if (opts.abortOnDefer) d.git.abortMerge(gitCwd);
    if (opts.markPendingOnDefer) writeBrainLocal(projectRoot, { pendingAgentMerge: true });
    return {
      result: {
        action: 'awaiting-agent',
        scrub: EMPTY_SCRUB,
        conflicts: mergeResult.conflicts,
        report: 'state/.brain-merge/report.json',
        needsTaskSync,
      },
      needsTaskSync,
    };
  }

  // All-deterministic: the resolved paths (plus anything the merge itself
  // auto-staged cleanly) are re-scrubbed before the commit — same invariant.
  const blocked = scrubAndCommitMerge(ctx, !!opts.effectiveStrict, MERGE_COMMIT_MESSAGE);
  return { result: blocked, needsTaskSync };
}

// ─── push with the C4 non-fast-forward retry loop ───────────────────────────

async function pushWithRetry(ctx: Ctx, scrub: { blocks: ScrubHit[]; warns: ScrubHit[] }): Promise<SyncResult> {
  const { d, gitCwd, projectRoot } = ctx;
  const token = d.resolveBrainSyncToken(projectRoot);
  if (!token) {
    return { action: 'no-remote', scrub, note: 'No GitHub token found for the brain repo (per-project secrets or GITHUB_TOKEN/GH_TOKEN env).' };
  }

  const tryPush = async (): Promise<boolean> => {
    try {
      await d.withGitCredentials(token.token, async (env) => {
        d.git.push(gitCwd, REMOTE_NAME, REMOTE_BRANCH, env);
      });
      return true;
    } catch {
      return false;
    }
  };

  if (await tryPush()) return { action: 'pushed', scrub, pushed: true };

  // Rejected (presumed non-FF): fetch → merge → retry ONCE.
  await d.withGitCredentials(token.token, async (env) => {
    d.git.fetch(gitCwd, REMOTE_NAME, REMOTE_BRANCH, env);
  });
  const outcome = mergeAndMaybeDefer(ctx, { abortOnDefer: false, markPendingOnDefer: false });
  if (outcome.result) return outcome.result;

  if (await tryPush()) return { action: 'pushed', scrub, pushed: true };

  throw new GitSyncError('Push rejected (non-fast-forward) twice — the remote is still ahead after a merge + one retry. Run `dreamcontext brain sync` again or resolve manually.');
}

// ─── auto (separate mode, default) ──────────────────────────────────────────

async function autoSync(ctx: Ctx): Promise<SyncResult> {
  const { d, gitCwd, projectRoot } = ctx;
  const token = d.resolveBrainSyncToken(projectRoot);
  if (!token) return { action: 'no-remote', scrub: EMPTY_SCRUB, note: 'No GitHub token found for the brain repo (per-project secrets or GITHUB_TOKEN/GH_TOKEN env).' };

  await d.withGitCredentials(token.token, async (env) => {
    d.git.fetch(gitCwd, REMOTE_NAME, REMOTE_BRANCH, env);
  });

  const aheadCount = d.git.revListCount(gitCwd, `HEAD..${REMOTE_REF}`);
  const dirty = d.git.statusPorcelainTracked(gitCwd);

  if (aheadCount === 0 && dirty.length === 0) return { action: 'noop', scrub: EMPTY_SCRUB };

  let scrub = EMPTY_SCRUB;
  if (dirty.length > 0) {
    d.git.stageAll(gitCwd);
    const hits = d.scrubStagedFiles(gitCwd);
    scrub = summarizeScrub(hits);
    if (isBlockingScrub(scrub, ctx.strict)) return { action: 'blocked-scrub', scrub };
    d.git.commit(gitCwd, 'chore(brain): sync', authorFor(ctx));
  }

  let needsTaskSync = false;
  if (aheadCount > 0) {
    const outcome = mergeAndMaybeDefer(ctx, { abortOnDefer: false, markPendingOnDefer: false });
    if (outcome.result) return withMergeOutcome(outcome.result, scrub);
    needsTaskSync = outcome.needsTaskSync;
  }

  const pushResult = await pushWithRetry(ctx, scrub);
  return { ...pushResult, needsTaskSync: needsTaskSync || pushResult.needsTaskSync };
}

// ─── pull-only — content delivery, safe headless (P2/C6, amendment 4) ──────

async function pullOnlySync(ctx: Ctx): Promise<SyncResult> {
  const { d, gitCwd, projectRoot, contextRoot } = ctx;
  const token = d.resolveBrainSyncToken(projectRoot);
  if (!token) return { action: 'no-remote', scrub: EMPTY_SCRUB, note: 'No GitHub token found for the brain repo (per-project secrets or GITHUB_TOKEN/GH_TOKEN env).' };

  await d.withGitCredentials(token.token, async (env) => {
    d.git.fetch(gitCwd, REMOTE_NAME, REMOTE_BRANCH, env);
  });

  const beforeSha = d.git.currentSha(gitCwd);
  const aheadCount = d.git.revListCount(gitCwd, `HEAD..${REMOTE_REF}`);
  if (aheadCount === 0) return { action: 'noop', scrub: EMPTY_SCRUB };

  const dirty = d.git.statusPorcelainTracked(gitCwd);
  let scrub = EMPTY_SCRUB;
  if (dirty.length > 0) {
    d.git.stageAll(gitCwd);
    const hits = d.scrubStagedFiles(gitCwd);
    scrub = summarizeScrub(hits);
    // Effective --strict (amendment 4): headless, no human eye — ANY hit blocks.
    if (scrub.blocks.length > 0 || scrub.warns.length > 0) {
      return {
        action: 'blocked-scrub',
        scrub,
        note: 'Your local brain edits contain something that looks sensitive — review and run `dreamcontext brain sync` manually.',
      };
    }
    d.git.commit(gitCwd, AUTO_CHECKPOINT_MESSAGE, authorFor(ctx));
  }

  const outcome = mergeAndMaybeDefer(ctx, { abortOnDefer: true, markPendingOnDefer: true, effectiveStrict: true });
  if (outcome.result) return withMergeOutcome(outcome.result, scrub);

  const afterSha = d.git.currentSha(gitCwd);
  const pulledUpdates = beforeSha && afterSha ? d.git.revListCount(gitCwd, `${beforeSha}..${afterSha}`) : aheadCount;
  writeBrainLocal(projectRoot, { lastFetchAt: Date.now(), pulledUpdates, pendingAgentMerge: false });

  return { action: 'pulled', scrub, pulledUpdates, needsTaskSync: outcome.needsTaskSync };
}

// ─── push-only ───────────────────────────────────────────────────────────────

async function pushOnlySync(ctx: Ctx): Promise<SyncResult> {
  const { d, gitCwd } = ctx;
  d.git.stageAll(gitCwd);
  const hits = d.scrubStagedFiles(gitCwd);
  const scrub = summarizeScrub(hits);
  if (isBlockingScrub(scrub, ctx.strict)) return { action: 'blocked-scrub', scrub };
  d.git.commit(gitCwd, 'chore(brain): sync', authorFor(ctx));
  return pushWithRetry(ctx, scrub);
}

// ─── --continue: commit an IN-PROGRESS merge (guard clause 2's sole path) ──

async function continueMerge(ctx: Ctx): Promise<SyncResult> {
  const { d, gitCwd, contextRoot, projectRoot } = ctx;
  d.git.stageAll(gitCwd);
  const hits = d.scrubStagedFiles(gitCwd);
  const scrub = summarizeScrub(hits);
  if (isBlockingScrub(scrub, ctx.strict)) return { action: 'blocked-scrub', scrub };

  d.git.commit(gitCwd, AGENT_MERGE_COMMIT_MESSAGE, authorFor(ctx));

  const pushResult = await pushWithRetry(ctx, scrub);
  if (pushResult.action === 'pushed') {
    clearConflictReport(contextRoot);
    writeBrainLocal(projectRoot, { pendingAgentMerge: false });
  }
  return pushResult;
}

// ─── --resume: attended redo of a pull-only-deferred handoff (v3.2) ────────

async function resumeHandoff(ctx: Ctx): Promise<SyncResult> {
  const { d, gitCwd, contextRoot, projectRoot } = ctx;

  // Pre-clear the OLD report — it described an aborted merge, about to be superseded.
  clearConflictReport(contextRoot);

  const token = d.resolveBrainSyncToken(projectRoot);
  if (!token) return { action: 'no-remote', scrub: EMPTY_SCRUB, note: 'No GitHub token found for the brain repo (per-project secrets or GITHUB_TOKEN/GH_TOKEN env).' };

  await d.withGitCredentials(token.token, async (env) => {
    d.git.fetch(gitCwd, REMOTE_NAME, REMOTE_BRANCH, env);
  });

  // FOREGROUND flow: WARN stays non-blocking here UNLESS --strict is set
  // (a human/agent is present, so it's not effective-strict like headless pull-only).
  const dirty = d.git.statusPorcelainTracked(gitCwd);
  const scrub = EMPTY_SCRUB;
  if (dirty.length > 0) {
    d.git.stageAll(gitCwd);
    const hits = d.scrubStagedFiles(gitCwd);
    const s = summarizeScrub(hits);
    if (isBlockingScrub(s, ctx.strict)) return { action: 'blocked-scrub', scrub: s };
    d.git.commit(gitCwd, 'chore(brain): sync', authorFor(ctx));
  }

  // Leave the merge IN PROGRESS on a re-defer (classic auto behavior) — do NOT abort here.
  const outcome = mergeAndMaybeDefer(ctx, { abortOnDefer: false, markPendingOnDefer: false });
  if (outcome.result) return withMergeOutcome(outcome.result, scrub);

  const pushResult = await pushWithRetry(ctx, scrub);
  if (pushResult.action === 'pushed') {
    writeBrainLocal(projectRoot, { pendingAgentMerge: false });
  }
  return pushResult;
}
