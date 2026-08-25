import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
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
  /** The repository's DEFAULT branch (`main`, `master`, whatever the remote says), or null when
   *  it cannot be established. Not a decoration: it is what turns the branch chip from a name
   *  into a STATE — the owner read a bare `feat/shelf-pin-drop` as "you are in a different
   *  worktree" (2026-08-25), and the chip can only say "this is a leftover branch on the main
   *  checkout" if it knows which branch would NOT be leftover. See {@link readDefaultBranch}. */
  defaultBranch: string | null;
  /** True when this directory is a LINKED worktree rather than the main checkout. */
  worktree: boolean;
  /** The main checkout's root — set only when `worktree` is true, else null. This is a
   *  REALPATH (see readWorktree): canonicalise before comparing it to a vault path. */
  mainRoot: string | null;
  /** The checkout's OWN directory name, set only when `worktree` is true. The shelf's tag has
   *  room for one word and "worktree" is not the useful one — with several open at once, the
   *  question the user is actually asking is WHICH. */
  worktreeName: string | null;
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
  defaultBranch: null,
  worktree: false,
  mainRoot: null,
  worktreeName: null,
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
  const commonDir = gitCommonDir(cwd);
  const ownRaw = gitLine(cwd, ['rev-parse', '--absolute-git-dir']);
  if (!commonDir || !ownRaw) return { worktree: false, mainRoot: null };
  if (commonDir === canonical(ownRaw)) return { worktree: false, mainRoot: null };
  return { worktree: true, mainRoot: dirname(commonDir) };
}

/**
 * The repository's DEFAULT branch, or null.
 *
 * ── Why this does not ask for `origin` ────────────────────────────────────────────────
 * `git symbolic-ref refs/remotes/origin/HEAD` is the usual one-liner and it is wrong here:
 * THIS repository's remote is named `main`, not `origin` (measured 2026-08-23 during the
 * brain-separation survey), and a dreamcontext user's remote can be named anything at all.
 * Hardcoding `origin` would have answered null on the very repo the feature was built in. So
 * every remote is asked, in git's own listing order, and the first that has a resolvable HEAD
 * wins — a single-remote repo (the overwhelming case) costs exactly one extra `git remote`.
 *
 * ── Why there is a local fallback at all ──────────────────────────────────────────────
 * `refs/remotes/<remote>/HEAD` only exists if it was ever written — a `git clone` writes it,
 * but a repo created locally with `git init` and later given a remote has no such ref, and
 * neither does one where the ref has been pruned. In that case the honest reading is "whichever
 * of the conventional names actually exists as a local branch", checked in that order and
 * verified rather than assumed. If neither exists the answer is null and the chip simply says
 * less; it never invents a default the user does not have.
 */
export function readDefaultBranch(cwd: string): string | null {
  const remotes = (gitLine(cwd, ['remote']) ?? '').split('\n').map((r) => r.trim()).filter(Boolean);
  for (const remote of remotes) {
    const head = gitLine(cwd, ['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`]);
    // `<remote>/<branch>` → `<branch>`. Sliced by the known prefix rather than split on `/`,
    // because a branch name may itself contain slashes (`release/2026-08`).
    if (head && head.startsWith(`${remote}/`)) {
      const branch = head.slice(remote.length + 1);
      if (branch) return branch;
    }
  }
  for (const name of ['main', 'master']) {
    if (gitLine(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])) return name;
  }
  return null;
}

/** Memo for {@link gitCommonDir}. Bounded, because unlike `cache` above it is keyed by any
 *  directory a chat frame names rather than by the handful of project roots this server
 *  serves. Oldest-first eviction; a dropped entry just costs one fork to recompute. */
const commonDirCache = new Map<string, { value: string | null; at: number }>();
const MAX_COMMON_DIR_CACHE = 128;

/**
 * The SHARED git directory for `cwd`, canonicalised — `null` when `cwd` is not a work tree.
 *
 * Every worktree of one repository answers the same path here, and two different repositories
 * never do. That makes this the identity of a REPOSITORY rather than of a checkout, which is
 * exactly the gate `session-cwd.ts` needs before it will point the shelf at a directory a
 * chat frame named: same common dir ⇒ a sibling checkout of the project already open; anything
 * else ⇒ refused.
 *
 * Both normalisations from {@link readWorktree}'s note apply and are the reason this is one
 * function rather than two call sites: `resolve(cwd, …)` because the main checkout answers a
 * RELATIVE `.git`, and `canonical` because git realpaths `--absolute-git-dir` but not this.
 *
 * ── Why this one is memoized and `readWorktree` is not ────────────────────────────────
 * `readWorktree` is reached once per `readSessionFacts`, which has its own TTL in front of it.
 * This is reached TWICE per same-repository check, and `session-cwd.ts` runs one of those on
 * every read of a session's checkout — i.e. on every shelf poll of every pane. Unmemoized
 * that is four `git` forks per pane per poll to answer a question whose answer, for a given
 * directory, does not change while the directory exists. The case where it DOES change —
 * the worktree was removed — is caught by the caller's `statSync`, which costs no fork at all.
 */
export function gitCommonDir(cwd: string, now: number = Date.now()): string | null {
  const hit = commonDirCache.get(cwd);
  if (hit && now - hit.at < SESSION_FACTS_TTL_MS) return hit.value;

  const raw = gitLine(cwd, ['rev-parse', '--git-common-dir']);
  const value = raw ? canonical(resolve(cwd, raw)) : null;

  commonDirCache.delete(cwd);
  commonDirCache.set(cwd, { value, at: now });
  while (commonDirCache.size > MAX_COMMON_DIR_CACHE) {
    const oldest = commonDirCache.keys().next();
    if (oldest.done) break;
    commonDirCache.delete(oldest.value);
  }
  return value;
}

/**
 * Drop the memoized facts for ONE directory.
 *
 * Called after something in this process CHANGES that directory's git state — today that is
 * `session-start-branch.ts` moving the main checkout to the default branch. Without it the
 * shelf would keep answering the pre-switch branch for the rest of the TTL, which is the same
 * "reports the checkout it left" defect this whole surface exists to end, just from the other
 * direction. Not a test seam: production code calls this.
 */
export function forgetSessionFacts(projectRoot: string): void {
  cache.delete(projectRoot);
}

/** TEST SEAM, shared with `session-cwd.ts`'s own reset: the two memos in this module are
 *  process-global by design, so a test that creates and destroys real worktrees inside one
 *  TTL window needs a way to ask for a clean read. Production code never calls this. */
export function resetSessionFactsCaches(): void {
  cache.clear();
  commonDirCache.clear();
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
    defaultBranch: readDefaultBranch(projectRoot),
    worktree,
    mainRoot,
    worktreeName: worktree ? basename(projectRoot) || null : null,
    worktreeAllowed: worktreeIsolationAllowed(projectRoot),
    isRepo: true,
  };
}
