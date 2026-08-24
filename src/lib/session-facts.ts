import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { currentBranch, isGitRepo } from './git-sync/git.js';
import { worktreeIsolationAllowed } from './worktree-gate.js';

/**
 * The facts a chat session needs to say WHICH checkout it is acting on — the branch, and
 * whether this is a linked git worktree rather than the main checkout.
 *
 * WHY THE SERVER OWNS THESE (and not the agent): the pinned shelf's resting state is one
 * tag line, and the two facts on it that must never be wrong are the ones the user would
 * otherwise have to re-ask for. An agent-pinned branch is only as fresh as the last time
 * the agent thought to mention it; a polled route is correct by construction. The dev-server
 * PORT is the opposite case and is deliberately NOT here: nothing on disk attributes a
 * listening socket to a session, so that one stays an agent-pinned fact.
 *
 * ── Never throws ──────────────────────────────────────────────────────────────────────
 * Every git invocation is individually guarded and any failure — git absent, not a repo,
 * a detached or unborn HEAD, an unreadable config — resolves to {@link UNKNOWN_SESSION_FACTS}.
 * A shelf that renders no branch chip is correct; a shelf that throws takes the composer
 * with it.
 *
 * ── Why two rev-parse calls live here rather than in git-sync/git.ts ──────────────────
 * `git.ts`'s `run()` throws a typed `GitSyncError` by design, which is right for the sync
 * paths that branch on failure. This module's contract is the opposite — it must be total —
 * so the two flag reads below are their own guarded `execFileSync`. The two functions that
 * ALREADY have a never-throw shape (`isGitRepo`, `currentBranch`) are imported, not
 * duplicated.
 */

export interface SessionFacts {
  /** The checked-out branch, or null on a detached/unborn HEAD or a non-repo. */
  branch: string | null;
  /** True when this directory is a LINKED worktree rather than the main checkout. */
  worktree: boolean;
  /** The main checkout's root — set only when `worktree` is true, else null. This is a
   *  REALPATH (see readWorktree): canonicalise before comparing it to a vault path. */
  mainRoot: string | null;
  /** May a Develop-mode agent create a worktree here? See worktree-gate.ts. */
  worktreeAllowed: boolean;
  /** False when git is unavailable or this is not a work tree — the shelf then shows no
   *  branch chip at all rather than an empty one. */
  isRepo: boolean;
}

/** The one shape every failure resolves to. Frozen so a caller cannot mutate the shared
 *  constant into a lie for every subsequent caller. */
export const UNKNOWN_SESSION_FACTS: SessionFacts = Object.freeze({
  branch: null,
  worktree: false,
  mainRoot: null,
  worktreeAllowed: false,
  isRepo: false,
});

/**
 * How long a read is reused for the same project root.
 *
 * Deliberately SHORTER than the shelf's 15s poll, so the memo can never mask a real branch
 * switch — the next poll always re-reads. Its job is the CONCURRENT case: four split panes
 * on one project each fire their own poll, and without this that is four `git` forks in the
 * same tick for one answer.
 */
export const SESSION_FACTS_TTL_MS = 12_000;

interface CacheEntry { facts: SessionFacts; at: number }
const cache = new Map<string, CacheEntry>();

/** One git line, or null. Total: a non-zero exit, a missing binary and a timeout all
 *  resolve to null rather than throwing. */
function gitLine(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    const line = out.trim();
    return line || null;
  } catch {
    return null;
  }
}

/** A path with every symlink resolved, or the input unchanged if it cannot be resolved.
 *  See {@link readWorktree} for why the comparison there cannot skip this. */
function canonical(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/**
 * Is `cwd` a linked worktree, and if so where is the main checkout?
 *
 * `--git-common-dir` names the SHARED git directory (the main checkout's `.git`);
 * `--absolute-git-dir` names THIS tree's own git directory. In the main checkout they are
 * the same directory; in a linked worktree the latter is `<common>/worktrees/<name>`. So the
 * test is inequality — but only after normalising two ways in which git's own two answers
 * disagree about how to spell the same directory:
 *
 *   1. RELATIVE vs absolute. From the main checkout `--git-common-dir` prints `.git`, from a
 *      worktree it prints an absolute path. Hence `resolve(cwd, …)`.
 *   2. SYMLINKS. `--absolute-git-dir` returns a realpath'd answer while `--git-common-dir`
 *      does not, so on macOS — where `/var` is a symlink to `/private/var`, and any project
 *      under `/tmp`, a symlinked home or an APFS firmlink is affected — a plain main checkout
 *      compares `/var/…/.git` against `/private/var/…/.git` and reports itself a WORKTREE.
 *      That false positive would have pinned a permanent "worktree" marker on the shelf of
 *      every such session. Both sides are therefore canonicalised before comparison.
 *
 * Consequence worth knowing at the call site: `mainRoot` is a REALPATH. Do not compare it
 * to a vault path by string equality without canonicalising that too.
 *
 * A submodule correctly reports false: its git dir is `<parent>/.git/modules/<name>` and its
 * common dir is the same path, so they match.
 */
function readWorktree(cwd: string): { worktree: boolean; mainRoot: string | null } {
  const commonRaw = gitLine(cwd, ['rev-parse', '--git-common-dir']);
  const ownRaw = gitLine(cwd, ['rev-parse', '--absolute-git-dir']);
  if (!commonRaw || !ownRaw) return { worktree: false, mainRoot: null };
  const commonDir = canonical(resolve(cwd, commonRaw));
  if (commonDir === canonical(ownRaw)) return { worktree: false, mainRoot: null };
  return { worktree: true, mainRoot: dirname(commonDir) };
}

/**
 * The session facts for `projectRoot`, memoized for {@link SESSION_FACTS_TTL_MS}.
 *
 * `now` is a TEST SEAM ONLY — it exists so the TTL boundary itself can be exercised without
 * a sleep. Production callers pass nothing.
 */
export function readSessionFacts(projectRoot: string, now: number = Date.now()): SessionFacts {
  const hit = cache.get(projectRoot);
  if (hit && now - hit.at < SESSION_FACTS_TTL_MS) return hit.facts;

  const facts = computeSessionFacts(projectRoot);
  cache.set(projectRoot, { facts, at: now });
  return facts;
}

function computeSessionFacts(projectRoot: string): SessionFacts {
  if (!isGitRepo(projectRoot)) return UNKNOWN_SESSION_FACTS;
  const { worktree, mainRoot } = readWorktree(projectRoot);
  return {
    branch: currentBranch(projectRoot),
    worktree,
    mainRoot,
    worktreeAllowed: worktreeIsolationAllowed(projectRoot),
    isRepo: true,
  };
}
