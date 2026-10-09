import { accessSync, constants, lstatSync, readdirSync, type Stats } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { classifyBrain, detectDocSources } from '../initializer-detect.js';
import { detectTechStack } from '../tech-stack.js';
import type { FolderState } from './types.js';

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * Is `dir` inside a git repository? Walks up looking for a `.git` folder or file (a
 * worktree or submodule has a file), with lstat only: it never runs git, so it can never
 * open the macOS developer-tools dialog, and a symlinked `.git` does not count.
 */
export function findGitDir(dir: string): string | null {
  let current = resolve(dir);
  for (;;) {
    const candidate = join(current, '.git');
    const st = lstatOrNull(candidate);
    if (st && !st.isSymbolicLink() && (st.isDirectory() || st.isFile())) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function emptyState(path: string, exists: boolean, isSymlink: boolean, isDirectory: boolean): FolderState {
  return {
    path,
    name: basename(path),
    exists,
    isDirectory,
    isSymlink,
    empty: false,
    writable: false,
    brain: 'missing',
    isGitRepo: false,
    docs: { count: 0, folders: [] },
    stack: null,
  };
}

/**
 * Everything onboarding needs to know about a project folder, from the filesystem only:
 * never spawns git or anything else.
 *
 * The path is NFC-normalised first, so a Turkish name picked through the macOS folder
 * panel (`Öğretmen Notları`) compares equal to the one typed. A symlinked folder is
 * reported (`isSymlink`) and never read. A symlinked `_dream_context` counts as no brain.
 */
export function probeFolder(pathIn: string): FolderState {
  const path = resolve(pathIn.normalize('NFC'));
  const st = lstatOrNull(path);
  if (!st) return emptyState(path, false, false, false);
  if (st.isSymbolicLink()) return emptyState(path, true, true, false);
  if (!st.isDirectory()) return emptyState(path, true, false, false);

  let empty = false;
  try {
    empty = readdirSync(path).length === 0;
  } catch {
    empty = false;
  }
  let writable = false;
  try {
    accessSync(path, constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }
  const brainDir = join(path, '_dream_context');
  const brainSt = lstatOrNull(brainDir);
  const brain = brainSt && brainSt.isDirectory() && !brainSt.isSymbolicLink() ? classifyBrain(brainDir) : 'missing';

  return {
    path,
    name: basename(path),
    exists: true,
    isDirectory: true,
    isSymlink: false,
    empty,
    writable,
    brain,
    isGitRepo: findGitDir(path) !== null,
    docs: detectDocSources(path),
    stack: detectTechStack(path),
  };
}
