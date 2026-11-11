/**
 * The folders a sandboxed Codex turn may write besides its project (plan r5 §6): the project's
 * linked code repos and their worktrees. Which of them survive is `policy.ts`'s rule
 * (`writableRoots`: never `~/.dreamcontext`, never home itself); this only lists them.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
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

function gitCommonDir(repo: string): string | null {
  try {
    return realpathSync(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    return null;
  }
}

/**
 * Is this folder really a worktree of that repo? `git worktree list` keeps naming a deleted
 * worktree, and a sandboxed turn may write a symlink at that path: resolved blindly, the next
 * chat would get whatever the link points at as a writable root. So the folder must point back:
 * its `.git` file names a folder under `<common>/worktrees/`.
 */
export function isWorktreeOf(commonDir: string, folder: string): boolean {
  try {
    const gitdir = /^gitdir: (.+)$/m.exec(readFileSync(join(folder, '.git'), 'utf-8'))?.[1]?.trim();
    return !!gitdir && realpathSync(resolve(folder, gitdir)).startsWith(join(commonDir, 'worktrees') + sep);
  } catch {
    return false; // a real repo's `.git` is a folder; anything unreadable is no worktree
  }
}

/** The worktrees of the project's own repo (when the project is one), each proven to point back. */
export function ownWorktrees(project: string, o: { worktrees?: (repo: string) => string[] } = {}): string[] {
  const common = gitCommonDir(project);
  if (!common) return [];
  const out: string[] = [];
  for (const w of (o.worktrees ?? gitWorktrees)(project)) {
    let folder = w;
    try { folder = realpathSync(w); } catch { continue; }
    if (isWorktreeOf(common, folder) && !out.includes(folder)) out.push(folder);
  }
  return out.slice(0, MAX_ROOTS);
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
      const common = gitCommonDir(repo.path);
      if (!common) continue;
      for (const w of (o.worktrees ?? gitWorktrees)(repo.path)) {
        let folder = w;
        try { folder = realpathSync(w); } catch { continue; }
        if (isWorktreeOf(common, folder)) add(folder);
      }
    }
  } catch { /* an unreadable config degrades to the project alone: narrower, never wider */ }
  return out.slice(0, MAX_ROOTS);
}
