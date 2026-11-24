import { closeSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import { keyPath } from './real-path.js';

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
    const realRoot = keyPath(root);
    if (!inside(realRoot, keyPath(abs))) return null;
    // A symlinked directory on the way in also resolves outside or elsewhere: compare the walk.
    // keyPath keeps the case it was given, so this compares the walk, not the spelling (review r1).
    if (relative(realRoot, keyPath(abs)) !== clean.split(sep).join(sep)) return null;
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

/** At most `maxBytes` from the start of `rel` under `root` (same guards as {@link readVaultFileSafe}),
 *  a split UTF-8 character at the cut dropped; null when unsafe or unreadable. Never throws. */
export function readVaultHeadSafe(root: string, rel: string, maxBytes: number): string | null {
  const abs = safeVaultPath(root, rel);
  if (!abs || !(maxBytes > 0)) return null;
  let fd: number | null = null;
  try {
    fd = openSync(abs, 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString('utf-8').replace(/\uFFFD+$/, '');
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* closed */ }
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
