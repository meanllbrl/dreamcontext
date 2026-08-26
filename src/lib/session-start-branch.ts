import { execFileSync } from 'node:child_process';
import { currentBranch, isGitRepo } from './git-sync/git.js';
import { forgetSessionFacts, readDefaultBranch, readSessionFacts } from './session-facts.js';

/**
 * A FRESH chat session starts on the repository's default branch.
 *
 * ── The defect ────────────────────────────────────────────────────────────────────────
 * `claude` is always spawned in the vault's project root, so a new session never starts in a
 * worktree — but nothing ever returns the MAIN checkout to its default branch. A session that
 * ran `git checkout -b feat/x` there leaves the branch standing, and every session opened
 * afterwards inherits it, forever. The owner hit this on 2026-08-25: shown a chip reading
 * `feat/shelf-pin-drop`, they read "you are in a different worktree" — and asked for new
 * sessions to start from the default branch instead.
 *
 * ── Why this refuses more often than it acts, and why that is the design ──────────────
 * A `git checkout` is a mutation of the user's working tree that nobody asked for in this
 * turn. Three guards stand in front of it, and in THIS repository the second one is the common
 * path, not the edge case:
 *
 *  1. FRESH ONLY. A `--resume` continues a conversation whose whole history assumes a branch;
 *     moving it out from under the transcript would be worse than the defect. The caller owns
 *     this one — it is the only guard this module cannot check for itself.
 *  2. CLEAN ONLY. Tracked changes are never switched away from. `_dream_context/` rides the
 *     working tree here, so an in-flight brain edit means "dirty" — which is exactly why this
 *     arm must be REPORTED rather than silently skipped.
 *  3. MAIN CHECKOUT ONLY. If the app has a linked worktree open as its project root, the
 *     branch is the worktree's whole point.
 *
 * UNTRACKED files are deliberately not a blocker. They never prevent a checkout and they carry
 * across it unharmed, and treating them as dirt would refuse forever in any project with a
 * scratch directory — `_dream_context/tmp/agent-drops/` here holds the very screenshots that
 * reported this bug.
 *
 * ── What it will never do ─────────────────────────────────────────────────────────────
 * No stash, no `-f`, no branch creation, no fetch. Every one of those turns "put me back on
 * main" into a data-loss surface. If the switch cannot be done plainly, it is not done.
 */

/** What happened, in the caller's own vocabulary. Every arm is reportable; `describeFreshStart`
 *  decides which ones are worth a sentence on screen. */
export type FreshStartOutcome =
  /** The checkout was moved. `from` is where it was. */
  | { kind: 'switched'; from: string; to: string }
  /** Already there — the ordinary, silent case. */
  | { kind: 'already-default'; branch: string }
  /** Tracked changes present, so nothing was touched. `changed` is how many paths. */
  | { kind: 'blocked-dirty'; branch: string; to: string; changed: number }
  /** The project root is a linked worktree; its branch is not ours to change. */
  | { kind: 'skipped-worktree'; branch: string | null }
  /** The switch failed at the git level despite a clean tree (a hook, a permission, a lock). */
  | { kind: 'failed'; branch: string; to: string; detail: string }
  /** Nothing to do and nothing to say: not a repo, no resolvable default, a detached HEAD, or
   *  a default branch that has no local ref to check out. */
  | { kind: 'unavailable'; reason: 'not-a-repo' | 'no-default' | 'detached' | 'no-local-ref' };

/** Tracked, non-ignored changes — staged or unstaged. `??` (untracked) entries are dropped:
 *  see the header for why they are not dirt. Never throws; an unreadable status answers `[]`,
 *  which reads as clean, and the `git checkout` that follows is itself refused by git if the
 *  tree really was dirty. */
export function trackedChanges(cwd: string): string[] {
  let raw: string;
  try {
    raw = execFileSync('git', ['status', '--porcelain', '-z'], {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
    });
  } catch {
    return [];
  }
  if (!raw) return [];
  return raw
    .split('\0')
    .filter((e) => e.length > 3)
    .filter((e) => !e.startsWith('??'))
    .map((e) => e.slice(3).trim())
    .filter(Boolean);
}

/** Does `<branch>` exist as a LOCAL branch? A default branch named by a remote's HEAD is not
 *  necessarily checked out locally, and this module never creates one. */
function localBranchExists(cwd: string, branch: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd, stdio: ['ignore', 'ignore', 'ignore'], timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Put `projectRoot` back on its default branch, or explain why not.
 *
 * `apply` is a TEST SEAM: `false` runs every guard and reports the outcome WITHOUT touching
 * the tree, which is how the guard matrix is exercised against a real repo. Production callers
 * pass nothing.
 */
export function freshSessionOnDefaultBranch(
  projectRoot: string,
  opts: { apply?: boolean } = {},
): FreshStartOutcome {
  const apply = opts.apply !== false;
  if (!isGitRepo(projectRoot)) return { kind: 'unavailable', reason: 'not-a-repo' };

  const facts = readSessionFacts(projectRoot);
  if (facts.worktree) return { kind: 'skipped-worktree', branch: facts.branch };

  const branch = currentBranch(projectRoot);
  if (!branch) return { kind: 'unavailable', reason: 'detached' };

  const to = readDefaultBranch(projectRoot);
  if (!to) return { kind: 'unavailable', reason: 'no-default' };
  if (branch === to) return { kind: 'already-default', branch };
  if (!localBranchExists(projectRoot, to)) return { kind: 'unavailable', reason: 'no-local-ref' };

  const changed = trackedChanges(projectRoot);
  if (changed.length > 0) {
    return { kind: 'blocked-dirty', branch, to, changed: changed.length };
  }
  if (!apply) return { kind: 'switched', from: branch, to };

  try {
    execFileSync('git', ['checkout', to], {
      cwd: projectRoot, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf-8', timeout: 30_000,
    });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = (e.stderr || e.message || 'unknown error').trim().split('\n')[0];
    return { kind: 'failed', branch, to, detail };
  }
  // The memo in front of `readSessionFacts` is 12s deep and we have just invalidated it from
  // the outside — without this the shelf would report the branch we just left, which is the
  // exact defect this surface exists to end.
  forgetSessionFacts(projectRoot);
  return { kind: 'switched', from: branch, to };
}

/**
 * The one sentence to put in front of the user, or `null` for the outcomes that are not news.
 *
 * `already-default` is the ordinary case and says nothing; `unavailable` and
 * `skipped-worktree` are standing properties of the project rather than events. The two that
 * MUST speak are the two that changed something or wanted to: a checkout the user did not ask
 * for, and a checkout that was refused — the refusal especially, because it is the arm that
 * leaves the session on a branch the user was told new sessions would not start on.
 */
export function describeFreshStart(o: FreshStartOutcome): string | null {
  switch (o.kind) {
    case 'switched':
      return `New session: moved the main checkout from ${o.from} to ${o.to}. Files tracked by git — including this project's brain — are now ${o.to}'s.`;
    case 'blocked-dirty':
      return `New session: staying on ${o.branch} rather than ${o.to} — ${o.changed} tracked file${o.changed === 1 ? '' : 's'} have uncommitted changes, and this never switches a dirty tree.`;
    case 'failed':
      return `New session: could not move from ${o.branch} to ${o.to} — ${o.detail}`;
    case 'already-default':
    case 'skipped-worktree':
    case 'unavailable':
      return null;
  }
}
