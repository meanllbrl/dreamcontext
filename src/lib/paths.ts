import { realpathSync } from 'node:fs';
import { relative, sep, type PlatformPath } from 'node:path';

/**
 * `abs` relative to `root`, with forward slashes: the shape every manifest key, recall id,
 * safe-delete check and on-disk comparison uses. `abs.replace(root + '/', '')` only works for
 * POSIX paths: on Windows `join` yields backslashes (and fast-glob yields forward slashes), the
 * replace never matched, and the key became an absolute path with mixed separators. `pathApi`
 * is injectable so the Windows shape is testable anywhere.
 */
export function relPosix(root: string, abs: string, pathApi: Pick<PlatformPath, 'relative' | 'sep'> = { relative, sep }): string {
  return pathApi.relative(root, abs).split(pathApi.sep).join('/');
}

/**
 * The one spelling of a path two answers can be compared in (throws like realpathSync).
 * Windows: the NATIVE resolver, which also expands 8.3 short names. `%TEMP%` is often
 * `C:\Users\RUNNER~1\…` while git reports the same folder as `C:/Users/runneradmin/…`, and the
 * JavaScript resolver keeps both spellings, so a worktree never matched its own repository.
 * Elsewhere: realpathSync, exactly as before.
 */
export function canonicalPath(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? realpathSync.native(path) : realpathSync(path);
}
