/**
 * The folders a sandboxed Codex turn may write besides its project (plan r5 §6): the project's
 * linked code repos and their worktrees. Which of them survive is `policy.ts`'s rule
 * (`writableRoots`: never `~/.dreamcontext`, never home itself); this only lists them.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolveLinkedRepos } from '../linked-repos.js';

const MAX_ROOTS = 32;

/** `git worktree list --porcelain` → the checkouts it names (the repo's main one included). */
export function worktreesIn(porcelain: string): string[] {
  return porcelain.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length).trim()).filter(Boolean);
}

function gitWorktrees(repo: string): string[] {
  try {
    return worktreesIn(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return [];
  }
}

export function linkedWritableRoots(
  projectRoot: string,
  o: { home?: string; worktrees?: (repo: string) => string[] } = {},
): string[] {
  const out: string[] = [];
  const add = (p: string): void => {
    let real = p;
    try { real = realpathSync(p); } catch { return; } // a checkout that is gone is no root
    if (!out.includes(real)) out.push(real);
  };
  try {
    for (const repo of resolveLinkedRepos(projectRoot, o.home)) {
      if (!repo.path) continue;
      add(repo.path);
      for (const w of (o.worktrees ?? gitWorktrees)(repo.path)) add(w);
    }
  } catch { /* an unreadable config degrades to the project alone: narrower, never wider */ }
  return out.slice(0, MAX_ROOTS);
}
