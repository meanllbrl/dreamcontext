import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as git from './git.js';
import { GitSyncError } from './git.js';
import { withGitCredentials } from './credentials.js';
import { scrubStagedFiles, scrubContent, summarizeScrub, type ScrubHit } from './scrub.js';
import { ensureGitignoreEntries, gitignoreCovers } from '../gitignore.js';
import {
  BRAIN_MARKER_FILE,
  buildBrainGitignore,
  resolveBrainSyncToken,
  FALLBACK_AUTHOR,
} from './brain-repo.js';
import type { SetupConfig } from '../setup-config.js';

/**
 * `brain detach` (github-cloud-collaboration-brain-repo-sync, M3, C4) — turn
 * the CURRENT brain (in-tree, nested in the code repo, or an already-separate
 * repo pointed at a different remote) into its own PRIVATE separate repo,
 * with the same S3/S4 scrub-before-push discipline as `brain init`.
 *
 * Showcase-safety (C5): a project that already deliberately tracks
 * `_dream_context/core` and `_dream_context/knowledge` in the code repo (this
 * repo, for example) must NEVER have its curated `.gitignore` blanket-clobbered
 * by detach — the default there is `--keep-tracked` (leave the code repo's own
 * tracking exactly as it is). Ordinary projects default to
 * `--gitignore-in-tree` (idempotently ADD `_dream_context/` to the code repo's
 * `.gitignore` — never overwrite the file).
 */

const EMPTY_SCRUB: { blocks: ScrubHit[]; warns: ScrubHit[] } = { blocks: [], warns: [] };

export type DetachAction = 'detached' | 'already-detached' | 'blocked-scrub' | 'refused-preserve-history';

export interface DetachResult {
  action: DetachAction;
  remote: string;
  /** Showcase pattern detected on the code repo (tracked core/knowledge, no blanket ignore). */
  showcase: boolean;
  /** Whether the code repo's own tracking of `_dream_context/` was left untouched. */
  keptTracked: boolean;
  /** `.gitignore` entries actually added to the code repo (empty when `keptTracked` or already covered). */
  gitignoreAdded: string[];
  scrub: { blocks: ScrubHit[]; warns: ScrubHit[] };
  note?: string;
}

export interface DetachOptions {
  /** Absolute path to `_dream_context/`. */
  contextRoot: string;
  projectRoot: string;
  /** Target remote for the NEW separate brain repo (clean https URL, or a local path for tests/E2E — never tokened). */
  remote: string;
  codeRepoUrl?: string;
  taskBackend?: SetupConfig['taskBackend'];
  /**
   * Carry over full git history instead of a fresh single commit. Only
   * supported when the brain is ALREADY in `separate` mode (it has its own
   * git history to scan + carry over) — replaying a code-repo subtree's
   * history without an external tool (git-subtree/filter-repo) is out of
   * scope, so an in-tree source is REFUSED rather than silently squashed or
   * half-rewritten.
   */
  preserveHistory?: boolean;
  /** Explicit override: never touch the code repo's `.gitignore`. */
  keepTracked?: boolean;
  /** Explicit override: add `_dream_context/` to the code repo's `.gitignore`. Mutually exclusive with `keepTracked`. */
  gitignoreInTree?: boolean;
  /** Injectable git wrapper — tests use a fake. */
  gitModule?: typeof git;
  scrubStagedFilesImpl?: typeof scrubStagedFiles;
  withGitCredentialsImpl?: typeof withGitCredentials;
  /** Injectable showcase-detector — tests avoid a real git repo. */
  detectShowcaseImpl?: (projectRoot: string, gitModule: typeof git) => boolean;
  /** Injectable full-history scrub scan — tests avoid a real multi-commit repo. */
  scrubHistoryImpl?: (cwd: string) => ScrubHit[];
}

/** `git ls-files -- <pathspec>` — true when the pathspec has at least one tracked entry. */
function hasTrackedFilesUnder(cwd: string, pathspec: string): boolean {
  try {
    const out = execFileSync('git', ['ls-files', '--', pathspec], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * The showcase pattern (C5): the code repo already tracks
 * `_dream_context/core` and/or `_dream_context/knowledge` directly, WITHOUT a
 * blanket `_dream_context/` ignore entry — a project that deliberately
 * documents its own brain in its own history (this repo is exactly this
 * case). Detecting it drives detach's default to `--keep-tracked`.
 */
export function detectShowcaseTracking(projectRoot: string, gitModule: typeof git = git): boolean {
  if (!gitModule.isGitRepo(projectRoot)) return false;
  if (gitignoreCovers(projectRoot, ['_dream_context/']) || gitignoreCovers(projectRoot, ['_dream_context'])) return false;
  return (
    hasTrackedFilesUnder(projectRoot, '_dream_context/core') ||
    hasTrackedFilesUnder(projectRoot, '_dream_context/knowledge')
  );
}

/**
 * Coarse full-history scrub scan for `--preserve-history` (S4): scans every
 * reachable commit's patch text for a scrub hit. Deliberately whole-history
 * text (not per-blob) — good enough to DETECT a hit and refuse; file/line
 * attribution on a history hit is intentionally approximate (the caller
 * refuses outright rather than trying to pinpoint-and-fix historical content).
 */
export function scrubEntireHistory(cwd: string): ScrubHit[] {
  let patch: string;
  try {
    patch = execFileSync('git', ['log', '--all', '-p', '--no-color'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1024 * 1024 * 64,
    });
  } catch {
    return [];
  }
  return scrubContent('(brain repo history)', patch);
}

/**
 * `brain detach`'s LOCAL + push half — fully testable against a local bare
 * "remote" directory (like `bootstrapBrainRepo`), no GitHub API call. The CLI
 * layer creates/resolves the actual remote URL first (mirroring
 * `createBrainRepo`'s split from `bootstrapBrainRepo`), then calls this.
 */
export async function detachBrain(opts: DetachOptions): Promise<DetachResult> {
  const g = opts.gitModule ?? git;
  const scrub = opts.scrubStagedFilesImpl ?? scrubStagedFiles;
  const withCreds = opts.withGitCredentialsImpl ?? withGitCredentials;
  const detectShowcase = opts.detectShowcaseImpl ?? detectShowcaseTracking;
  const scrubHistory = opts.scrubHistoryImpl ?? scrubEntireHistory;

  if (opts.keepTracked && opts.gitignoreInTree) {
    throw new GitSyncError('--keep-tracked and --gitignore-in-tree are mutually exclusive.');
  }

  const wasSeparateAlready = g.isGitRepo(opts.contextRoot);
  const priorRemote = wasSeparateAlready ? g.getRemoteUrl(opts.contextRoot, 'origin') : null;
  const alreadyDetachedSameRemote = wasSeparateAlready && priorRemote === opts.remote;

  const showcase = detectShowcase(opts.projectRoot, g);
  const keepTracked = opts.gitignoreInTree ? false : (opts.keepTracked ?? showcase);

  if (opts.preserveHistory) {
    if (!wasSeparateAlready) {
      return {
        action: 'refused-preserve-history',
        remote: opts.remote,
        showcase,
        keptTracked: keepTracked,
        gitignoreAdded: [],
        scrub: EMPTY_SCRUB,
        note: '--preserve-history is only supported when the brain is already in `separate` mode (it needs its own git history to carry over). Run `brain detach` without the flag for a fresh single commit, or run `brain sync` first to establish separate mode.',
      };
    }
    const historyHits = scrubHistory(opts.contextRoot);
    const historySummary = summarizeScrub(historyHits);
    if (historySummary.blocks.length > 0 || historySummary.warns.length > 0) {
      return {
        action: 'refused-preserve-history',
        remote: opts.remote,
        showcase,
        keptTracked: keepTracked,
        gitignoreAdded: [],
        scrub: historySummary,
        note: 'Historical commits contain something that looks sensitive — clean history manually before using --preserve-history, or omit the flag for a fresh single-commit detach.',
      };
    }
  }

  // The no-`--preserve-history` default MUST be a genuine fresh single commit
  // (its documented contract) — NOT "commit the marker on top of whatever
  // history already happens to be there". `scrubStagedFiles` only scans
  // `git diff --cached` (index vs HEAD): if the brain is ALREADY separate and
  // nothing in its tracked tree changes this run besides the marker, a
  // pre-existing secret sitting unchanged in HEAD's tree would never surface
  // as "staged" and would ship — to a possibly-DIFFERENT (possibly
  // public-after-confirm) remote — completely unscanned. Resetting to a fresh
  // `.git` before re-staging makes `git diff --cached` compare against the
  // EMPTY tree, so the scrub below covers the brain's ENTIRE current content,
  // not just this run's diff.
  //
  // Idempotency is preserved: re-detaching to the SAME remote it's already on
  // (`!freshHistory`) never touches `.git` at all.
  const freshHistory = !opts.preserveHistory && (!wasSeparateAlready || priorRemote !== opts.remote);

  if (freshHistory) {
    if (wasSeparateAlready) {
      rmSync(join(opts.contextRoot, '.git'), { recursive: true, force: true });
    }
    g.initRepo(opts.contextRoot);
  }

  writeFileSync(
    join(opts.contextRoot, BRAIN_MARKER_FILE),
    `${JSON.stringify({ version: 1, codeRepoUrl: opts.codeRepoUrl ?? '' }, null, 2)}\n`,
    'utf-8',
  );
  if (!existsSync(join(opts.contextRoot, '.gitignore'))) {
    writeFileSync(join(opts.contextRoot, '.gitignore'), buildBrainGitignore(opts.taskBackend), 'utf-8');
  }

  if (g.getRemoteUrl(opts.contextRoot, 'origin')) {
    g.setRemoteUrl(opts.contextRoot, 'origin', opts.remote);
  } else {
    g.addRemote(opts.contextRoot, 'origin', opts.remote);
  }

  g.stageAll(opts.contextRoot);
  const hits = scrub(opts.contextRoot);
  const { blocks, warns } = summarizeScrub(hits);
  if (blocks.length > 0) {
    return { action: 'blocked-scrub', remote: opts.remote, showcase, keptTracked: keepTracked, gitignoreAdded: [], scrub: { blocks, warns } };
  }

  const author = g.hasGitIdentity(opts.contextRoot) ? undefined : FALLBACK_AUTHOR;
  const sha = g.commit(opts.contextRoot, 'chore(brain): detach into a separate repo', author);

  const token = resolveBrainSyncToken(opts.projectRoot);
  if (/^https?:\/\//i.test(opts.remote) && !token) {
    throw new GitSyncError('No GitHub token found for the brain repo (per-project secrets or GITHUB_TOKEN/GH_TOKEN env).');
  }
  await withCreds(token?.token ?? '', async (env) => {
    g.push(opts.contextRoot, 'origin', 'main', env);
  });

  // Code-repo side (C5): showcase-safe by default — never touch a curated
  // .gitignore. Ordinary projects get an idempotent ADD, never an overwrite.
  let gitignoreAdded: string[] = [];
  if (!keepTracked && g.isGitRepo(opts.projectRoot)) {
    gitignoreAdded = ensureGitignoreEntries(opts.projectRoot, ['_dream_context/'], {
      comment: 'dreamcontext brain — now tracked separately after `brain detach`',
    });
  }

  const noopRepeat = alreadyDetachedSameRemote && sha === null && gitignoreAdded.length === 0;

  return {
    action: noopRepeat ? 'already-detached' : 'detached',
    remote: opts.remote,
    showcase,
    keptTracked: keepTracked,
    gitignoreAdded,
    scrub: { blocks, warns },
  };
}
