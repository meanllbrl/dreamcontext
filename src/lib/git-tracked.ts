import { execFileSync } from 'node:child_process';

/**
 * "Does git track these paths?" — the one question several subsystems have to ask before
 * they touch a file that must never be committed (a secret written into `.env`) or that
 * claims to be private (an automation).
 *
 * Injectable so tests need no real repo; `defaultGitTrackedCheck` is the real thing.
 */
export type GitTrackedCheck = (cwd: string, relPaths: string[]) => string[];

/**
 * `git ls-files` resolves the nearest enclosing repository starting from `cwd` and
 * interprets pathspecs relative to that same `cwd` — so running it with the directory the
 * paths are relative to correctly answers "is this path tracked" whether the repo root is
 * that directory or any ancestor, with no repo-root discovery of our own required.
 * `ls-files` lists only the TRACKED subset of the given pathspecs (an untracked path is
 * simply absent, never an error), so the return value already is the answer.
 *
 * Never throws: outside a repo, or with git itself missing, both degrade to `[]` — the
 * same "nothing is tracked" answer a fresh, ungitted project should give.
 */
export const defaultGitTrackedCheck: GitTrackedCheck = (cwd, relPaths) => {
  if (relPaths.length === 0) return [];
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', ...relPaths], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.toString('utf-8').split('\0').filter((p) => p.length > 0);
  } catch {
    return [];
  }
};

/**
 * Does git ALREADY ignore this path? Asked of git rather than derived from `.gitignore`
 * text, because an ignore rule can live in a parent `.gitignore`, in `.git/info/exclude`,
 * or in a pattern (`.env*`, `*.local`) that no exact-line match would ever see.
 *
 * Returns false when git is missing, the path is outside a repo, or the check errors —
 * "I could not prove it is ignored". Callers must treat that as NOT ignored and write the
 * ignore entry themselves; being wrong in that direction costs a redundant `.gitignore`
 * line, and being wrong in the other direction commits a secret.
 */
export function gitIgnoresPath(cwd: string, relPath: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', relPath], {
      cwd,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true; // exit 0 = the path is ignored
  } catch {
    return false; // exit 1 = not ignored; exit 128 / ENOENT = cannot prove it
  }
}
