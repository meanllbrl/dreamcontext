import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

/**
 * Where the built CLI keeps Node's compile cache (src/cli/bin.ts), or null for no cache.
 *
 * The cache is compiled code the CLI will RUN, so it lives only in the user's own cache folder
 * under an absolute home, never in a temp folder: Node's default is the OS temp folder, a shared
 * `/tmp` on Linux, and on macOS too when TMPDIR is unset (cron, launchd, ssh), where another
 * account could plant code first. Every base must be absolute: a relative one (empty HOME, a
 * relative XDG_CACHE_HOME or LOCALAPPDATA) would resolve against the working folder, a cloned
 * repo's own files.
 */
export function compileCacheDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string | null {
  const { isAbsolute, join } = platform === 'win32' ? win32 : posix;
  const own = (p: string | undefined): p is string => !!p && isAbsolute(p);
  if (!own(home)) return null;
  const base = platform === 'darwin' ? join(home, 'Library', 'Caches')
    : platform === 'win32' ? (own(env.LOCALAPPDATA) ? env.LOCALAPPDATA : join(home, 'AppData', 'Local'))
      : (own(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : join(home, '.cache'));
  return join(base, 'dreamcontext', 'node-compile-cache');
}
