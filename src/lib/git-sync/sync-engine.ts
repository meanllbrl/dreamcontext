import { dirname } from 'node:path';
import { readSetupConfig, readBrainLocal, writeBrainLocal, type SetupConfig } from '../setup-config.js';
import * as git from './git.js';
import { GitSyncError } from './git.js';
import { scrubStagedFiles, scrubCommitRange, summarizeScrub, type ScrubHit } from './scrub.js';
import { resolveConflicts } from './semantic-merge.js';
import { writeConflictReport, readConflictReport, clearConflictReport } from './conflict-report.js';
import {
  resolveBrainSyncToken,
  resolveMode,
  resolveBrainSyncEnabled,
  acquireBrainLock,
  releaseBrainLock,
  ensureFullRepoGitignore,
  demoteProjectGitHubToken,
  FALLBACK_AUTHOR,
} from './brain-repo.js';
import { withGitCredentials } from './credentials.js';
import { readGlobalGitHubLogin, readGlobalGitHubToken } from './auth-store.js';
import { type ResolvedToken } from '../task-backend/secrets.js';
import { BrainSyncTokenSession } from './token-fallback.js';
import { mapLoginToPerson } from '../task-backend/identity.js';
import { slugify } from '../id.js';

/**
 * The sync-engine orchestrator — single entry point (`runBrainSync`) for
 * `sleep done`, `/dream-sync`, the session-start background pull, and the
 * dashboard. Implements the full v3.2/v3.3 contract from
 * `skill-sync/references/merge-rules.md`.
 */

const REMOTE_NAME = 'origin';
const DEFAULT_BRANCH = 'main';
/** git's canonical empty-tree sha — the base for scrubbing a never-pushed branch's whole tree. */
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MERGE_COMMIT_MESSAGE = 'chore(brain): merge team updates';
const AGENT_MERGE_COMMIT_MESSAGE = 'chore(brain): merge team updates (agent-resolved)';

/**
 * Commit-message copy differs by mode: `in-tree` commits only the brain
 * (`_dream_context/`), so `chore(brain): …` reads true; `full-repo` syncs the
 * WHOLE project folder, so a `(brain)` scope would be misleading — it uses a
 * plain `chore: … (dreamcontext sync)` message instead.
 */
function syncCommitMessage(ctx: Ctx): string {
  return ctx.mode === 'full-repo' ? 'chore: sync project (dreamcontext)' : 'chore(brain): sync';
}
function autoCheckpointMessage(ctx: Ctx): string {
  return ctx.mode === 'full-repo'
    ? 'chore: checkpoint local edits before team merge (dreamcontext)'
    : 'chore(brain): auto-checkpoint local edits before team merge';
}

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
  | 'disabled'
  /** full-repo only: the working repo is on a detached HEAD — refuse (never push onto `main`). */
  | 'detached-head'
  /** A merge is mid-flight that dreamcontext did NOT start (the user's own `git merge`/`rebase`). */
  | 'user-merge-in-progress'
  /** full-repo only: a real code file conflicts — defer to the human's editor, never semantically merge. */
  | 'code-conflict';

export interface SyncOptions {
  /** Absolute path to `_dream_context/` (what `ensureContextRoot()` returns). */
  cwd: string;
  mode: 'auto' | 'pull-only' | 'push-only';
  strict?: boolean;
  /**
   * A human/agent is watching (dashboard button, dashboard auto-open pull, CLI).
   * Foreground pull-only keeps WARN-tier scrub hits NON-blocking (only real
   * secrets block); the truly headless session-start background pull leaves this
   * unset and keeps its unconditional effective-strict "any hit blocks" gate.
   */
  foreground?: boolean;
  /** Commit an IN-PROGRESS merge (requires `MERGE_HEAD`). */
  continue?: boolean;
  /** ATTENDED redo of a pull-only-deferred handoff (requires `pendingAgentMerge && !MERGE_HEAD`). */
  resume?: boolean;
  /**
   * The dashboard's on-open auto-pull sets this when the user has disabled
   * "auto-checkpoint on open": pull-only then REFUSES to touch a dirty tree
   * (no WIP auto-commit) and returns a `noop` with guidance instead. Manual
   * syncs never set it — they always checkpoint so nothing is lost.
   */
  noCheckpoint?: boolean;
}

export interface SyncResult {
  action: SyncAction;
  scrub: { blocks: ScrubHit[]; warns: ScrubHit[] };
  commitSha?: string;
  pushed?: boolean;
  pulledUpdates?: number;
  conflicts?: string[];
  /** full-repo `code-conflict`: the real code files git couldn't auto-merge, for the human. */
  codeConflicts?: string[];
  /** A dirty tree was auto-committed ("checkpoint") before a pull-only merge. */
  checkpointed?: boolean;
  /** The checkpoint commit sha — surfaced so the user can trivially undo it (`git reset --soft <sha>^`). */
  checkpointSha?: string;
  /** Conflict report path (repo-relative), when one was written. */
  report?: string;
  /** C7: a merge/pull touched task-referencing files under a remote task backend. */
  needsTaskSync?: boolean;
  /** Human-facing guidance (flag-misuse notes, disabled notice, etc). CLI renders via `error()`/`warn()`. */
  note?: string;
  /**
   * The sync detected a STALE per-project GitHub token that was shadowing the
   * signed-in account, transparently fell back to the global token, and removed
   * the stale project token. Surfaced so the CLI/dashboard can tell the user what
   * self-healed. Never carries any token value.
   */
  healedStaleProjectToken?: boolean;
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
  /** Pre-push gate over a commit RANGE — scrubs commits that skipped the staged-commit gate. */
  scrubCommitRange: typeof scrubCommitRange;
  resolveBrainSyncToken: typeof resolveBrainSyncToken;
  withGitCredentials: typeof withGitCredentials;
  acquireBrainLock: typeof acquireBrainLock;
  releaseBrainLock: typeof releaseBrainLock;
  /** C3 (M3): who is signed into dreamcontext right now (global auth-store), if anyone. */
  readGlobalGitHubLogin: typeof readGlobalGitHubLogin;
  /** Stale-per-project-token self-heal: the signed-in global token to fall back to. */
  readGlobalGitHubToken: typeof readGlobalGitHubToken;
  /** Stale-per-project-token self-heal: demote (never delete) the shadowing per-project `github.token`. */
  demoteProjectGitHubToken: typeof demoteProjectGitHubToken;
}

const defaultDeps: SyncEngineDeps = {
  git,
  resolveConflicts,
  scrubStagedFiles,
  scrubCommitRange,
  resolveBrainSyncToken,
  withGitCredentials,
  acquireBrainLock,
  releaseBrainLock,
  readGlobalGitHubLogin,
  readGlobalGitHubToken,
  demoteProjectGitHubToken,
};

interface Ctx {
  d: SyncEngineDeps;
  contextRoot: string;
  gitCwd: string;
  projectRoot: string;
  config: SetupConfig | null;
  /** Resolved sync mode — drives branch + commit-message copy. */
  mode: 'in-tree' | 'full-repo';
  /** Remote branch to fetch/merge/push. `main` for in-tree (unused — never pushes); the CURRENT branch for full-repo. */
  branch: string;
  /** `origin/${branch}` — the remote-tracking ref to merge from. */
  remoteRef: string;
  /** `--strict`: escalate WARN-tier scrub hits to blocking on every gated commit path. */
  strict: boolean;
  /** A human/agent is present (see SyncOptions.foreground) — relaxes pull-only's headless scrub gate. */
  foreground: boolean;
  /** Disable the pull-only dirty-tree auto-checkpoint (the on-open "don't touch my WIP" preference). */
  noCheckpoint: boolean;
  /**
   * The active token session for THIS run — set by whichever sync function first
   * resolves a token. Carries the stale-per-project-token self-heal state so
   * `runBrainSync` can stamp `healedStaleProjectToken` onto the final result.
   */
  session?: BrainSyncTokenSession;
}

/** Human-facing copy for a full-repo code conflict — names the file + how to finish. */
function codeConflictNote(paths: string[]): string {
  const first = paths[0] ?? 'a code file';
  const more = paths.length > 1 ? ` (+${paths.length - 1} more)` : '';
  return `Code conflict in ${first}${more} — the team changed it too. Resolve it in your editor, commit the merge, then run sync again.`;
}

function computeNeedsTaskSync(config: SetupConfig | null, paths: string[]): boolean {
  if (config?.taskBackend !== 'github' && config?.taskBackend !== 'clickup') return false;
  return paths.some((p) => {
    const norm = p.replace(/^_dream_context\//, '');
    return norm === 'state/.active-version.json' || norm === 'core/CHANGELOG.json' || /^state\/[^/]+\.md$/.test(norm);
  });
}

/**
 * C3 (M3): if the signed-in GitHub login maps to a roster person, the commit
 * reflects THEM — regardless of the local git identity. Layered ON TOP of the
 * M1 tiering (never a prerequisite): no login, no mapping, or no config simply
 * falls through to `undefined` here and `authorFor` proceeds exactly as M1
 * always has.
 */
function personAuthorFor(ctx: Ctx): { name: string; email: string } | undefined {
  const login = ctx.d.readGlobalGitHubLogin();
  if (!login) return undefined;
  const slug = mapLoginToPerson(login, ctx.config);
  if (!slug) return undefined;
  const displayName = (ctx.config?.people ?? []).find((p) => slugify(p) === slug) ?? slug;
  return { name: displayName, email: `${login}@users.noreply.github.com` };
}

function authorFor(ctx: Ctx): { name: string; email: string } | undefined {
  return personAuthorFor(ctx) ?? (ctx.d.git.hasGitIdentity(ctx.gitCwd) ? undefined : FALLBACK_AUTHOR);
}

/**
 * Resolve the brain sync token and wrap it in a `BrainSyncTokenSession` (the
 * stale-per-project-token self-heal), storing it on the ctx so `runBrainSync`
 * can read the heal flag. Returns null when NO token is configured at all (the
 * caller returns the `no-remote` "no token" outcome). Reuses an existing session
 * on the ctx so a fetch that already healed carries the global token into the push.
 */
function resolveTokenSession(ctx: Ctx): BrainSyncTokenSession | null {
  if (ctx.session) return ctx.session;
  const token: ResolvedToken | null = ctx.d.resolveBrainSyncToken(ctx.projectRoot);
  if (!token) return null;
  const session = new BrainSyncTokenSession(token, ctx.projectRoot, {
    withGitCredentials: ctx.d.withGitCredentials,
    readGlobalGitHubToken: ctx.d.readGlobalGitHubToken,
    demoteProjectGitHubToken: ctx.d.demoteProjectGitHubToken,
  });
  ctx.session = session;
  return session;
}

const NO_TOKEN_NOTE = 'No GitHub token found for the brain repo (per-project secrets or GITHUB_TOKEN/GH_TOKEN env).';

/** Human-facing note when a stale per-project token was self-healed mid-sync. */
const HEALED_STALE_TOKEN_NOTE =
  "This project's own GitHub token didn't work for cloud sync — sync switched to your signed-in GitHub account and will keep using it. The project token was kept (task sync may still need it).";

/**
 * Stamp the stale-per-project-token heal onto a returned result. No-op when
 * nothing healed. Appends (never clobbers) any existing note. Applied once,
 * centrally, in `runBrainSync` — every successful entry-point result flows through it.
 */
function applyHealInfo(ctx: Ctx, result: SyncResult): SyncResult {
  if (!ctx.session?.healedStaleProjectToken) return result;
  return {
    ...result,
    healedStaleProjectToken: true,
    note: result.note ? `${result.note} ${HEALED_STALE_TOKEN_NOTE}` : HEALED_STALE_TOKEN_NOTE,
  };
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
  // Both modes operate on the whole project repo at the project root — the brain
  // lives inside it at `_dream_context/`.
  const gitCwd = projectRoot;

  if (!d.git.isGitRepo(gitCwd)) {
    return {
      action: 'no-remote',
      scrub: EMPTY_SCRUB,
      note: 'No git repository found for this project. Run `git init` and add a GitHub `origin` first.',
    };
  }

  // `full-repo` syncs whatever branch the user is on (never assume `main` — a
  // teammate could be on a feature branch). A DETACHED HEAD (`currentBranch` →
  // null) has no branch to push: refuse LOUDLY rather than fall back to `main`
  // (which would push the detached HEAD's commits onto the team's `main`).
  // `in-tree` only commits locally, so its branch value is unused.
  let branch = DEFAULT_BRANCH;
  if (mode === 'full-repo') {
    const live = d.git.currentBranch(gitCwd);
    if (!live) {
      return {
        action: 'detached-head',
        scrub: EMPTY_SCRUB,
        note: "You're on a detached HEAD — check out a branch before syncing the whole project.",
      };
    }
    branch = live;
  }

  const ctx: Ctx = {
    d, contextRoot, gitCwd, projectRoot, config, mode, branch,
    remoteRef: `${REMOTE_NAME}/${branch}`,
    strict: !!opts.strict,
    foreground: !!opts.foreground,
    noCheckpoint: !!opts.noCheckpoint,
  };

  // full-repo stages the WHOLE project (`git add -A` at the root), so the
  // project's own `.gitignore` MUST exclude machine-local brain state + secrets
  // BEFORE anything is staged — else the sync lock (and worse, secrets) get
  // committed and pushed. Gitignore-first, on every sync, defensively.
  if (mode === 'full-repo') ensureFullRepoGitignore(projectRoot, config?.taskBackend);

  // In-tree NEVER syncs/merges with a remote — commit-only, always scrubbed
  // (S2). It bypasses the reentrancy guard entirely: that machinery exists
  // for the full-repo merge lifecycle, which in-tree never enters, and gating
  // on an unrelated in-progress CODE-repo merge would be a false positive.
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
    // An in-progress merge that dreamcontext STARTED always leaves a conflict
    // report; the user's OWN unrelated `git merge`/`rebase` (common in full-repo,
    // where gitCwd is the project root) leaves none. Telling the user to run
    // /dream-sync on their own merge would be wrong — there's nothing for the
    // agent to resolve. Distinguish the two by the report's presence.
    const report = readConflictReport(contextRoot);
    if (!report) {
      return {
        action: 'user-merge-in-progress',
        scrub: EMPTY_SCRUB,
        note: 'Finish your in-progress git merge first, then run sync again.',
      };
    }
    // A full-repo CODE conflict left in the tree for the human — never an agent job.
    if (report.codeConflicts && report.codeConflicts.length > 0) {
      return {
        action: 'code-conflict',
        scrub: EMPTY_SCRUB,
        conflicts: report.codeConflicts,
        codeConflicts: report.codeConflicts,
        report: 'state/.brain-merge/report.json',
        note: codeConflictNote(report.codeConflicts),
      };
    }
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
    let result: SyncResult;
    if (opts.continue) result = await continueMerge(ctx);
    else if (opts.resume) result = await resumeHandoff(ctx);
    else if (opts.mode === 'pull-only') result = await pullOnlySync(ctx);
    else if (opts.mode === 'push-only') result = await pushOnlySync(ctx);
    else result = await autoSync(ctx);
    // Stamp the stale-per-project-token self-heal (if it fired) onto the result.
    return applyHealInfo(ctx, result);
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

/**
 * Fetch `origin/main` only if it exists on the remote; returns whether it does.
 * A brand-new attached repo has NO refs at all — a blind `git fetch origin
 * main` there dies with `couldn't find remote ref main`, killing every sync
 * before the first commit/push can ever happen. Callers treat `false` as
 * "nothing to pull/merge" and (in pushing modes) proceed to bootstrap `main`.
 */
async function fetchRemoteIfExists(ctx: Ctx, session: BrainSyncTokenSession): Promise<boolean> {
  const { d, gitCwd } = ctx;
  return session.run(async (env) => {
    const exists = d.git.remoteBranchExists(gitCwd, REMOTE_NAME, ctx.branch, env);
    if (exists) d.git.fetch(gitCwd, REMOTE_NAME, ctx.branch, env);
    return exists;
  });
}

/** Attempt `attemptMerge`; on conflict, resolve deterministically and defer the rest to the agent. */
function mergeAndMaybeDefer(ctx: Ctx, opts: MergeAndMaybeDeferOpts): MergeOutcome {
  const { d, gitCwd, contextRoot, projectRoot, config } = ctx;
  let mergeResult: { clean: boolean; conflicts: string[] };
  try {
    mergeResult = d.git.attemptMerge(gitCwd, ctx.remoteRef);
  } catch (err) {
    // Surface git's rawest failure mode with an actionable message: a repo
    // created on GitHub WITH a README/gitignore shares no ancestry with the
    // local brain. Auto-merging unrelated histories is never safe under the
    // S6 trust model, so this stays an error — but a human-readable one.
    if (err instanceof Error && /unrelated histories/i.test(err.message)) {
      throw new GitSyncError(
        'The brain and its remote have unrelated histories — the remote already contains content that did not come from this brain (e.g. a README added when the repo was created). Attach an EMPTY repo or an existing brain repo, or reconcile the histories manually.',
      );
    }
    throw err;
  }

  if (mergeResult.clean) {
    // A pure fast-forward already advanced the ref (nothing staged, nothing
    // to scrub/commit — `commit()` no-ops on "nothing to commit"). A REAL
    // clean auto-merge is staged via `--no-commit`, NOT yet committed — it
    // must clear the same re-scrub gate as every other merge-commit path.
    const blocked = scrubAndCommitMerge(ctx, !!opts.effectiveStrict, MERGE_COMMIT_MESSAGE);
    return { result: blocked, needsTaskSync: false };
  }

  const resolution = d.resolveConflicts(gitCwd, mergeResult.conflicts, { fullRepo: ctx.mode === 'full-repo' });
  const needsTaskSync = computeNeedsTaskSync(config, resolution.resolved);

  // CODE conflict (full-repo, a file outside `_dream_context/`): git's semantic
  // 3-way merge must NEVER touch source — leave its native markers for the human.
  // Foreground (a human just triggered/opened the sync): leave the merge in
  // progress so they resolve in their editor + commit. Headless background pull:
  // abort to a clean tree (never break a working tree with no one watching) — the
  // next foreground sync re-surfaces it with markers.
  if (resolution.deferredToHuman.length > 0) {
    const codePaths = resolution.deferredToHuman.map((x) => x.path);
    if (ctx.foreground) {
      // Record BOTH the code files (human) AND any coincident brain-prose files
      // (agent) — a merge can conflict on both at once. Dropping the prose entries
      // would strand them in the tree with markers and no record for /dream-sync or
      // the user, risking a silently-wrong hand-resolution (the exact loss the
      // agent-merge path exists to prevent). The human resolves everything, but the
      // report stays truthful.
      writeConflictReport(contextRoot, {
        remoteRef: ctx.remoteRef,
        resolvedByCli: resolution.resolved,
        deferred: resolution.deferredToAgent.map((x) => {
          const snap = d.git.readOursTheirsBase(gitCwd, x.path);
          return { path: x.path, class: x.class, reason: 'overlapping edits to same section', ...snap };
        }),
        codeConflicts: codePaths,
      });
    } else {
      d.git.abortMerge(gitCwd);
    }
    return {
      result: {
        action: 'code-conflict',
        scrub: EMPTY_SCRUB,
        conflicts: codePaths,
        codeConflicts: codePaths,
        report: ctx.foreground ? 'state/.brain-merge/report.json' : undefined,
        note: codeConflictNote(codePaths),
        needsTaskSync,
      },
      needsTaskSync,
    };
  }

  if (resolution.deferredToAgent.length > 0) {
    writeConflictReport(contextRoot, {
      remoteRef: ctx.remoteRef,
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

async function pushWithRetry(
  ctx: Ctx,
  scrub: { blocks: ScrubHit[]; warns: ScrubHit[] },
  session?: BrainSyncTokenSession,
): Promise<SyncResult> {
  const { d, gitCwd } = ctx;
  // Reuse the caller's session (so a fetch that already healed carries the global
  // token into the push); otherwise resolve one now (`--push-only`, `--continue`).
  const s = session ?? resolveTokenSession(ctx);
  if (!s) {
    return { action: 'no-remote', scrub, note: NO_TOKEN_NOTE };
  }

  const tryPush = async (): Promise<boolean> => {
    try {
      await s.run(async (env) => {
        d.git.push(gitCwd, REMOTE_NAME, ctx.branch, env);
      });
      return true;
    } catch {
      return false;
    }
  };

  if (await tryPush()) return { action: 'pushed', scrub, pushed: true };

  // Rejected (presumed non-FF): fetch → merge → retry ONCE. But non-FF only
  // makes sense when the remote branch exists — a failed push to an EMPTY
  // remote failed for some other reason (auth, protection, network), and the
  // fetch would just die with `couldn't find remote ref main` on top of it.
  const remoteExists = await fetchRemoteIfExists(ctx, s);
  if (!remoteExists) {
    throw new GitSyncError('Push to the empty brain remote failed — check the token has Contents read/write on that repo and the remote URL is correct.');
  }
  const outcome = mergeAndMaybeDefer(ctx, { abortOnDefer: false, markPendingOnDefer: false });
  if (outcome.result) return outcome.result;

  if (await tryPush()) return { action: 'pushed', scrub, pushed: true };

  throw new GitSyncError('Push rejected (non-fast-forward) twice — the remote is still ahead after a merge + one retry. Run `dreamcontext brain sync` again or resolve manually.');
}

// ─── auto (full-repo: fetch → merge → commit → push) ────────────────────────

async function autoSync(ctx: Ctx): Promise<SyncResult> {
  const { d, gitCwd } = ctx;
  const session = resolveTokenSession(ctx);
  if (!session) return { action: 'no-remote', scrub: EMPTY_SCRUB, note: NO_TOKEN_NOTE };

  // Empty remote (freshly attached, zero commits): nothing to fetch/merge —
  // fall through to the commit+push half, which bootstraps `main` (push is
  // `HEAD:main`, and `commit` on an unborn HEAD creates the root commit).
  const remoteExists = await fetchRemoteIfExists(ctx, session);

  const aheadCount = remoteExists ? d.git.revListCount(gitCwd, `HEAD..${ctx.remoteRef}`) : 0;
  // Commits we have that the remote does NOT — e.g. a merge the HUMAN finished
  // natively after resolving a full-repo code conflict, or any locally-committed
  // work never pushed. Without this the next sync would noop and silently strand
  // those commits (the tree is clean, the remote isn't ahead) — they must go out.
  const localAhead = remoteExists ? d.git.revListCount(gitCwd, `${ctx.remoteRef}..HEAD`) : 0;
  const dirty = d.git.statusPorcelainTracked(gitCwd);
  // Empty remote + existing local commits (e.g. attach right after a detach):
  // there's nothing to fetch OR commit, but the branch still has to be born.
  const needsBootstrapPush = !remoteExists && !!d.git.currentSha(gitCwd);

  if (aheadCount === 0 && localAhead === 0 && dirty.length === 0 && !needsBootstrapPush) return { action: 'noop', scrub: EMPTY_SCRUB };

  let scrub = EMPTY_SCRUB;
  if (dirty.length > 0) {
    d.git.stageAll(gitCwd);
    const hits = d.scrubStagedFiles(gitCwd);
    scrub = summarizeScrub(hits);
    if (isBlockingScrub(scrub, ctx.strict)) return { action: 'blocked-scrub', scrub };
    d.git.commit(gitCwd, syncCommitMessage(ctx), authorFor(ctx));
  }

  let needsTaskSync = false;
  if (aheadCount > 0) {
    const outcome = mergeAndMaybeDefer(ctx, { abortOnDefer: false, markPendingOnDefer: false });
    if (outcome.result) return withMergeOutcome(outcome.result, scrub);
    needsTaskSync = outcome.needsTaskSync;
  }

  // Final pre-push gate (the scrub is MANDATORY before ANY push, never bypassed).
  // The dirty-commit path above scrubs only THIS run's staging; commits made outside
  // it — a human-finished full-repo code-conflict merge, or any locally-ahead work —
  // would otherwise reach the remote unscrubbed. Scrub everything about to be pushed.
  if (remoteExists && localAhead > 0) {
    const rangeScrub = summarizeScrub(d.scrubCommitRange(gitCwd, `${ctx.remoteRef}..HEAD`));
    if (isBlockingScrub(rangeScrub, ctx.strict)) return { action: 'blocked-scrub', scrub: rangeScrub };
    if (rangeScrub.blocks.length > 0 || rangeScrub.warns.length > 0) scrub = rangeScrub;
  }

  const pushResult = await pushWithRetry(ctx, scrub, session);
  return { ...pushResult, needsTaskSync: needsTaskSync || pushResult.needsTaskSync };
}

// ─── pull-only — content delivery, safe headless (P2/C6, amendment 4) ──────

async function pullOnlySync(ctx: Ctx): Promise<SyncResult> {
  const { d, gitCwd, projectRoot } = ctx;
  const session = resolveTokenSession(ctx);
  if (!session) return { action: 'no-remote', scrub: EMPTY_SCRUB, note: NO_TOKEN_NOTE };

  // Pull-only NEVER pushes — an empty remote simply has nothing to deliver.
  // The first push happens via auto/push-only (or the attach-time bootstrap).
  if (!(await fetchRemoteIfExists(ctx, session))) {
    return { action: 'noop', scrub: EMPTY_SCRUB, note: 'Remote brain repo is empty — nothing to pull yet. Run `dreamcontext brain sync` to push the first commit.' };
  }

  const beforeSha = d.git.currentSha(gitCwd);
  const aheadCount = d.git.revListCount(gitCwd, `HEAD..${ctx.remoteRef}`);
  if (aheadCount === 0) return { action: 'noop', scrub: EMPTY_SCRUB };

  const dirty = d.git.statusPorcelainTracked(gitCwd);
  let scrub = EMPTY_SCRUB;
  let checkpointSha: string | undefined;
  if (dirty.length > 0) {
    // Auto-checkpoint disabled (the on-open "don't touch my WIP" preference): skip
    // the pull entirely rather than auto-commit uncommitted work. Nothing is lost —
    // the manual sidebar sync (which always checkpoints) is one click away.
    if (ctx.noCheckpoint) {
      return {
        action: 'noop',
        scrub: EMPTY_SCRUB,
        note: 'You have uncommitted local edits and auto-checkpoint-on-open is off — skipped the pull so your WIP is untouched. Sync from the sidebar when ready.',
      };
    }
    d.git.stageAll(gitCwd);
    const hits = d.scrubStagedFiles(gitCwd);
    scrub = summarizeScrub(hits);
    // Headless (background session-start pull, `foreground` unset) has no human
    // eye, so it stays effective-strict — ANY hit (even WARN) blocks. Foreground
    // callers (the dashboard's auto-open pull + manual button) have a human
    // present, so only real secrets (BLOCK) stop them; absolute-path WARNs —
    // common across a whole code repo in `full-repo` mode — stay non-blocking.
    const blocks = ctx.foreground ? scrub.blocks.length > 0 : scrub.blocks.length > 0 || scrub.warns.length > 0;
    if (blocks) {
      return {
        action: 'blocked-scrub',
        scrub,
        note: 'Your local edits contain something that looks sensitive — review and run sync manually.',
      };
    }
    // The auto-checkpoint commit is deliberately identifiable (its own message)
    // and trivially undoable (`git reset --soft <sha>^`) — surfaced via checkpointSha.
    checkpointSha = d.git.commit(gitCwd, autoCheckpointMessage(ctx), authorFor(ctx)) ?? undefined;
  }

  const outcome = mergeAndMaybeDefer(ctx, { abortOnDefer: true, markPendingOnDefer: true, effectiveStrict: !ctx.foreground });
  if (outcome.result) return withMergeOutcome(outcome.result, scrub);

  const afterSha = d.git.currentSha(gitCwd);
  const pulledUpdates = beforeSha && afterSha ? d.git.revListCount(gitCwd, `${beforeSha}..${afterSha}`) : aheadCount;
  // C2 (M3): pull-only is the BACKGROUND path (session-start's detached spawn)
  // — it must never auto-run the task backend sync itself (best-effort,
  // non-blocking, no stdio). Persist the signal so the NEXT session-start can
  // surface the "refresh your task mirrors" instruction instead.
  writeBrainLocal(projectRoot, {
    lastFetchAt: Date.now(),
    pulledUpdates,
    pendingAgentMerge: false,
    needsTaskSync: outcome.needsTaskSync,
  });

  return { action: 'pulled', scrub, pulledUpdates, needsTaskSync: outcome.needsTaskSync, checkpointed: !!checkpointSha, checkpointSha };
}

// ─── push-only ───────────────────────────────────────────────────────────────

async function pushOnlySync(ctx: Ctx): Promise<SyncResult> {
  const { d, gitCwd } = ctx;
  d.git.stageAll(gitCwd);
  const hits = d.scrubStagedFiles(gitCwd);
  let scrub = summarizeScrub(hits);
  if (isBlockingScrub(scrub, ctx.strict)) return { action: 'blocked-scrub', scrub };
  d.git.commit(gitCwd, syncCommitMessage(ctx), authorFor(ctx));

  // Mandatory pre-push gate over EVERYTHING being pushed — not just this run's staged
  // changes. Pre-existing local-ahead commits (e.g. a human-finished full-repo
  // code-conflict merge) never hit the staged scrub above; without this, `brain sync
  // --push-only` on a clean tree would push them unscrubbed. Range from the
  // locally-known remote ref (or the empty tree, for a never-pushed branch) to HEAD.
  const base = d.git.revParse(gitCwd, ctx.remoteRef) ? ctx.remoteRef : EMPTY_TREE_SHA;
  const rangeScrub = summarizeScrub(d.scrubCommitRange(gitCwd, `${base}..HEAD`));
  if (isBlockingScrub(rangeScrub, ctx.strict)) return { action: 'blocked-scrub', scrub: rangeScrub };
  if (rangeScrub.blocks.length > 0 || rangeScrub.warns.length > 0) scrub = rangeScrub;

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

  const session = resolveTokenSession(ctx);
  if (!session) return { action: 'no-remote', scrub: EMPTY_SCRUB, note: NO_TOKEN_NOTE };

  // A pending handoff implies origin/main was fetched before; guard the
  // re-fetch anyway (the remote could have been force-emptied since) and
  // merge against the locally-known ref.
  await fetchRemoteIfExists(ctx, session);

  // FOREGROUND flow: WARN stays non-blocking here UNLESS --strict is set
  // (a human/agent is present, so it's not effective-strict like headless pull-only).
  const dirty = d.git.statusPorcelainTracked(gitCwd);
  const scrub = EMPTY_SCRUB;
  if (dirty.length > 0) {
    d.git.stageAll(gitCwd);
    const hits = d.scrubStagedFiles(gitCwd);
    const s = summarizeScrub(hits);
    if (isBlockingScrub(s, ctx.strict)) return { action: 'blocked-scrub', scrub: s };
    d.git.commit(gitCwd, syncCommitMessage(ctx), authorFor(ctx));
  }

  // Leave the merge IN PROGRESS on a re-defer (classic auto behavior) — do NOT abort here.
  const outcome = mergeAndMaybeDefer(ctx, { abortOnDefer: false, markPendingOnDefer: false });
  if (outcome.result) return withMergeOutcome(outcome.result, scrub);

  const pushResult = await pushWithRetry(ctx, scrub, session);
  if (pushResult.action === 'pushed') {
    writeBrainLocal(projectRoot, { pendingAgentMerge: false });
  }
  return pushResult;
}
