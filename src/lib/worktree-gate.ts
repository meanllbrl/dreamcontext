import { readSetupConfig } from './setup-config.js';
import { resolveMode } from './git-sync/brain-repo.js';
import { resolveLinkedRepos } from './linked-repos.js';

/**
 * May an agent working in this project create a git worktree?
 *
 * The hazard this gates is specific: `_dream_context/` is the brain, and in the DEFAULT
 * layout it lives inside the code checkout. A second checkout of that repo is therefore a
 * second copy of the brain — two working trees writing tasks, changelogs and knowledge that
 * diverge silently and get reconciled by nobody. That is why the answer is not "worktrees are
 * fine, it's just git".
 *
 * It is safe in exactly the two layouts where the brain does NOT ride the code tree:
 *  - `brainRepo.mode === 'full-repo'` (git-sync/brain-repo.ts) — the brain is its own repo,
 *    synced independently, so a worktree of the code checkout never duplicates it;
 *  - a LINKED repo present on this machine (linked-repos.ts) — the code lives in a bare repo
 *    with no `_dream_context/` of its own, governed by this brain from outside it.
 *
 * Never throws: a missing/corrupt config, an unreadable home registry or anything else
 * resolves to `false`. Refusing a worktree costs an agent one convenience; wrongly permitting
 * one forks the brain, so `false` is the only safe failure.
 *
 * `home` is a TEST SEAM ONLY — it threads through to `resolveLinkedRepos`' machine-global
 * registry (`~/.dreamcontext/linked-repos.json`) so a test can exercise the linked-repo arm
 * against a scratch HOME instead of the developer's real one. Production callers pass
 * nothing.
 */
export function worktreeIsolationAllowed(projectRoot: string, home?: string): boolean {
  try {
    if (resolveMode(readSetupConfig(projectRoot)) === 'full-repo') return true;
    return resolveLinkedRepos(projectRoot, home).some((repo) => repo.present);
  } catch {
    return false;
  }
}
