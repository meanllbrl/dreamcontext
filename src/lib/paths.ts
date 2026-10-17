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
