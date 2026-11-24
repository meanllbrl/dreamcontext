import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Where a new project or a clone lands (plan ilk-acilis D6, C9): ONE rule used by scaffold and
 * clone alike.
 *
 *  - {@link defaultParent}: an existing `projects` folder in home, in any letter case, found by
 *    reading the home folder's entries (existing users keep theirs); else `~/Projects`.
 *  - {@link ensureParentDir}: a missing parent is created only inside home, and never through a
 *    symlink: every existing ancestor between home and the parent is `lstat`ed, and the nearest
 *    existing one must `realpath` inside the real home.
 */

export class ParentDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParentDirError';
  }
}

/** D6: `<home>/<projects in any case>` when a real folder of that name exists, else `<home>/Projects`. */
export function defaultParent(home: string): string {
  try {
    for (const name of readdirSync(home)) {
      if (name.toLowerCase() !== 'projects') continue;
      const p = join(home, name);
      try {
        const st = lstatSync(p);
        if (st.isDirectory() && !st.isSymbolicLink()) return p;
      } catch { /* gone */ }
    }
  } catch { /* unreadable home: fall back */ }
  return join(home, 'Projects');
}

function realOrNull(p: string): string | null {
  try { return realpathSync(p); } catch { return null; }
}

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}

/**
 * Make sure `parent` (absolute) is a folder. An existing folder is accepted as is. A missing one
 * is created only when it sits inside `home` and no existing ancestor on the way is a symlink.
 */
export function ensureParentDir(parent: string, home: string): string {
  const resolved = resolve(parent);
  if (existsSync(resolved)) {
    if (!statSync(resolved).isDirectory()) throw new ParentDirError(`Parent directory does not exist: ${resolved}`);
    return resolved;
  }
  const realHome = realOrNull(home);
  const absHome = resolve(home);
  if (!realHome || !inside(resolved, absHome)) {
    throw new ParentDirError(`Parent directory does not exist: ${resolved}`);
  }
  // Every existing ancestor below home must be a plain folder, never a link.
  let current = dirname(resolved);
  while (current !== absHome && inside(current, absHome)) {
    let st;
    try { st = lstatSync(current); } catch { st = null; }
    if (st) {
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new ParentDirError(`The folder ${current} is a link to another place; choose the real folder.`);
      }
      const real = realOrNull(current);
      if (!real || !inside(real, realHome)) throw new ParentDirError(`Parent directory does not exist: ${resolved}`);
    }
    current = dirname(current);
  }
  mkdirSync(resolved, { recursive: true });
  return resolved;
}
