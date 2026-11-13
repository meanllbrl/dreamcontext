import { realpathSync } from 'node:fs';

/**
 * The one real path of a file or folder, with the case it really has on disk.
 *
 * Node's `realpathSync` resolves symlinks but keeps the case it was GIVEN: on a case-insensitive
 * disk (every Mac by default, Windows) `/Users/x/projects/app` and `/Users/x/Projects/app` are one
 * folder, yet come back as two different strings. A registered project then reads as "not
 * registered" when an agent spells the folder differently from the registry (owner 2026-11-13,
 * app-kurulum-claude: four red `project_not_registered` lines on a teammate's Mac). The native
 * call asks the OS, which answers with the on-disk spelling, so every comparison built on this
 * agrees however the path was typed.
 *
 * Same contract as `realpathSync`: a missing path throws (ENOENT/ENOTDIR), so the callers'
 * "missing is not a containment answer" logic is unchanged. Any other native failure (a
 * filesystem the native call cannot walk) falls back to the JS resolver.
 */
export function realPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' || code === 'EACCES') throw e;
    return realpathSync(p);
  }
}

/**
 * A path that NAMES stored state (a hash key, a folder name, a stored root): symlinks resolved,
 * case kept as given, exactly as before {@link realPath} existed. Every per-project store on this
 * Mac was keyed this way; switching a key to the on-disk case would orphan it on upgrade for any
 * project registered under another spelling (review r1, app-kurulum-claude): a quiet Telegram
 * bot, missing MCP servers, a new app data folder. Compare with {@link realPath}; key with this.
 */
export function keyPath(p: string): string {
  return realpathSync(p);
}
