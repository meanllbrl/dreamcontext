import { execFileSync } from 'node:child_process';

/**
 * Pre-commit binary guard for marketing assets.
 *
 * Two patterns are blocked under `_dream_context/marketing/`:
 *   - **\/_assets/\**   (creative source files)
 *   - **\/_media/\**    (competitor frames, downloaded mp4)
 *
 * These dirs are .gitignore'd, but `git add -f` can override that. The pre-commit
 * hook is the second line of defense.
 */

const BLOCKED_SEGMENTS = ['_assets', '_media'];
const MARKETING_PREFIX = '_dream_context/marketing/';

/**
 * Return true iff the given (POSIX-style, repo-relative) path is inside
 * `_dream_context/marketing/` AND has either `_assets` or `_media` as one
 * of its directory segments.
 */
export function isBlockedMarketingPath(repoRelPath: string): boolean {
  if (typeof repoRelPath !== 'string' || repoRelPath.length === 0) return false;
  // Normalize Windows separators just in case `git diff` ever yields them.
  const norm = repoRelPath.replace(/\\/g, '/');
  if (!norm.startsWith(MARKETING_PREFIX)) return false;
  const segments = norm.slice(MARKETING_PREFIX.length).split('/');
  // The blocked segment must be a directory, i.e. not the final segment.
  // (A file literally named `_assets` at the root is implausible but harmless.)
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (BLOCKED_SEGMENTS.includes(segments[i])) return true;
  }
  return false;
}

/**
 * Read the list of staged files from git. Uses NUL-delimited output so paths
 * with spaces / newlines parse safely.
 *
 * Returns empty array if git is unavailable or there's no staging area.
 */
export function getStagedFiles(cwd?: string): string[] {
  let raw: string;
  try {
    raw = execFileSync('git', ['diff', '--cached', '--name-only', '-z'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  if (!raw) return [];
  // NUL-delimited; trailing NUL produces an empty final entry — drop it.
  return raw.split('\0').filter((p) => p.length > 0);
}

/**
 * Filter staged paths down to those that violate the binary guard.
 */
export function findBlockedPaths(stagedPaths: readonly string[]): string[] {
  return stagedPaths.filter((p) => isBlockedMarketingPath(p));
}
