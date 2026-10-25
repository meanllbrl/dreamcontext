import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';

/**
 * M2, the safe reader of synced or vault content. A synced file is written by whoever pushed it,
 * so a reader never follows a symlink (a teammate's `agents/x.md -> ~/.ssh/id_rsa` would hand the
 * file to the next prompt) and never leaves the root. Every new reader in waves B, C and D goes
 * through here.
 */

function inside(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'));
}

/** The absolute path of `rel` under `root` when it is a regular file reached without a symlink and
 *  resolving inside `root`; null otherwise. Never throws. */
export function safeVaultPath(root: string, rel: string): string | null {
  if (!rel || isAbsolute(rel) || rel.includes('\0')) return null;
  const clean = normalize(rel);
  if (clean.startsWith('..') || clean.split(sep).includes('..')) return null;
  const abs = join(root, clean);
  try {
    if (!lstatSync(abs).isFile()) return null;
    const realRoot = realpathSync(root);
    if (!inside(realRoot, realpathSync(abs))) return null;
    // A symlinked directory on the way in also resolves outside or elsewhere: compare the walk.
    if (relative(realRoot, realpathSync(abs)) !== clean.split(sep).join(sep)) return null;
    return abs;
  } catch {
    return null;
  }
}

/** The text of `rel` under `root`, or null when it is missing, not a regular file, a symlink, or
 *  resolves outside `root`. Never throws. */
export function readVaultFileSafe(root: string, rel: string): string | null {
  const abs = safeVaultPath(root, rel);
  if (!abs) return null;
  try {
    return readFileSync(abs, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * May a writer create or append `abs` inside `root`? True only when `abs` is under `root` and no
 * segment on the way (the folders, and the file itself when it exists) is a symlink. A synced
 * folder can hold a symlink a teammate committed; a writer that followed it would write outside
 * the vault (a day file appended to `~/.zshrc`, a record dropped in another folder). Missing
 * segments are fine: the writer creates real folders. Never throws.
 */
export function safeWriteTarget(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
  let cur = root;
  for (const seg of rel.split(sep)) {
    cur = join(cur, seg);
    try {
      if (lstatSync(cur).isSymbolicLink()) return false;
    } catch {
      return true; // the rest does not exist yet
    }
  }
  return true;
}
