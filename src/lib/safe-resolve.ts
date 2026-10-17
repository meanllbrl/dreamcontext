import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * One containment rule for every task-system read and write that builds a path
 * from data (a parent slug off a synced card, a session id off a hook payload,
 * a journal next to its card): the path must stay inside `root`, and no
 * component between `root` and the target may be a symlink. A symlinked
 * `state/journal/` or `state/.session-task/` would otherwise let a hand-edited
 * or pulled value read or write anywhere the process can.
 */
export class UnsafePathError extends Error {}

/**
 * `root/rel`, refused when `rel` is absolute, climbs out (`..`), carries a NUL,
 * or crosses a symlink (checked with lstat on every existing component, then
 * realpath containment as the last word). Missing tail components are fine: a
 * file about to be written does not exist yet.
 */
export function safeResolveInside(root: string, rel: string): string {
  if (!rel || rel.includes('\0') || isAbsolute(rel)) throw new UnsafePathError(`Unsafe path: ${rel}`);
  const base = resolve(root);
  const target = resolve(base, rel);
  const back = relative(base, target);
  if (!back || back.startsWith('..') || isAbsolute(back)) throw new UnsafePathError(`Path escapes ${base}: ${rel}`);
  let cur = base;
  for (const part of back.split(sep)) {
    cur = join(cur, part);
    if (!existsSync(cur) && !isDanglingLink(cur)) break;
    if (lstatSync(cur).isSymbolicLink()) throw new UnsafePathError(`Refusing a symlink: ${cur}`);
  }
  if (existsSync(target)) {
    const realBase = realpathSync(base);
    const realTarget = realpathSync(target);
    if (realTarget !== realBase && !realTarget.startsWith(realBase + sep)) {
      throw new UnsafePathError(`Path resolves outside ${base}: ${rel}`);
    }
  }
  return target;
}

function isDanglingLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

