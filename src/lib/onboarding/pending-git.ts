import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { gitAvailable as defaultGitAvailable, initRepo as defaultInitRepo } from '../git-sync/git.js';
import { listVaults } from '../vaults.js';
import { findGitDir } from './folder.js';

/**
 * Projects that asked for Git while Git was still installing.
 *
 * On a Mac without the developer tools, onboarding starts the Git install in the
 * background and lets the user create a project in the meantime. A project created
 * with "Track changes with Git" before Git is usable is recorded here, and the
 * `git init` happens once Git turns usable: when the server's `git-install` run ends,
 * when readiness is polled, or at the start of `dreamcontext setup` / `doctor --machine`.
 *
 * The record is `~/.dreamcontext/onboarding.json`. Both the server and the CLI write it,
 * so every write goes to a temp file in the same folder and is renamed over the file: a
 * reader never sees half a file. A symlinked `~/.dreamcontext` or `onboarding.json` is
 * refused, so this never writes through a link to somewhere else.
 */

const FILE_NAME = 'onboarding.json';
/** A bound on the list: it only ever holds projects created while Git was installing. */
const MAX_PENDING = 50;

interface OnboardingFile {
  pendingGitInits?: unknown;
  [key: string]: unknown;
}

export interface PendingGitDeps {
  home?: string;
  gitAvailable?: () => boolean;
  initRepo?: (dir: string) => void;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function stateDir(home: string): string {
  return join(home, '.dreamcontext');
}

/** The onboarding file path, or null when `~/.dreamcontext` or the file is a symlink. */
function safeFilePath(home: string): string | null {
  const dir = stateDir(home);
  const dirSt = lstatOrNull(dir);
  if (dirSt && (dirSt.isSymbolicLink() || !dirSt.isDirectory())) return null;
  const file = join(dir, FILE_NAME);
  const fileSt = lstatOrNull(file);
  if (fileSt && (fileSt.isSymbolicLink() || !fileSt.isFile())) return null;
  return file;
}

function readFile(file: string): OnboardingFile {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as OnboardingFile) : {};
  } catch {
    return {};
  }
}

function pendingList(data: OnboardingFile): string[] {
  const raw = Array.isArray(data.pendingGitInits) ? data.pendingGitInits : [];
  return raw.filter((p): p is string => typeof p === 'string' && p.length > 0);
}

/** Write via a temp file in the same folder, then rename over the file. */
function writeAtomic(file: string, data: OnboardingFile): void {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function normalizePath(path: string): string {
  return resolve(path.normalize('NFC'));
}

/**
 * Remember that `path` wants `git init` once Git is usable. Returns false when the record
 * could not be written (a symlinked state folder, an unwritable home), so the caller can
 * report that honestly instead of promising a Git setup that will never happen.
 */
export function recordPendingGitInit(path: string, home: string = homedir()): boolean {
  const target = normalizePath(path);
  const dir = stateDir(home);
  if (!lstatOrNull(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      console.error(`[onboarding] could not create ${dir} to record a pending git init:`, err);
      return false;
    }
  }
  const file = safeFilePath(home);
  if (!file) {
    console.error(`[onboarding] refused to record a pending git init: ${dir} or ${FILE_NAME} is a symlink`);
    return false;
  }
  const data = readFile(file);
  const list = pendingList(data);
  if (!list.includes(target)) list.push(target);
  try {
    writeAtomic(file, { ...data, pendingGitInits: list.slice(-MAX_PENDING) });
    return true;
  } catch (err) {
    console.error(`[onboarding] could not record a pending git init for ${target}:`, err);
    return false;
  }
}

/** The recorded paths, for reporting. Empty when nothing is pending or the file is refused. */
export function listPendingGitInits(home: string = homedir()): string[] {
  const file = safeFilePath(home);
  if (!file || !lstatOrNull(file)) return [];
  return pendingList(readFile(file));
}

type EntryOutcome = 'initialized' | 'drop' | 'keep';

function settleEntry(path: string, registered: Set<string>, init: (dir: string) => void): EntryOutcome {
  // Only a project the user still has registered, still a real folder (never a symlink),
  // and not already inside a repository gets a `git init`.
  if (!registered.has(path)) return 'drop';
  const st = lstatOrNull(path);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return 'drop';
  if (findGitDir(path)) return 'drop';
  try {
    init(path);
    return 'initialized';
  } catch (err) {
    // Kept for the next trigger: a transient failure must not silently lose the request.
    console.error(`[onboarding] git init failed for pending project ${path}:`, err);
    return 'keep';
  }
}

/**
 * Run `git init` for every pending project now that Git is usable. Returns the folders
 * that were set up. Entries for projects that were removed, moved, replaced by a symlink
 * or already became repositories are dropped. Does nothing (and spawns nothing) while
 * Git is still unusable or nothing is pending.
 */
export function runPendingGitInits(deps: PendingGitDeps = {}): string[] {
  const home = deps.home ?? homedir();
  const file = safeFilePath(home);
  if (!file || !lstatOrNull(file)) return [];
  const data = readFile(file);
  const list = pendingList(data);
  if (list.length === 0) return [];
  if (!(deps.gitAvailable ?? (() => defaultGitAvailable()))()) return [];

  const init = deps.initRepo ?? defaultInitRepo;
  const registered = new Set(listVaults(home).map((v) => normalizePath(v.path)));
  const initialized: string[] = [];
  const remaining: string[] = [];
  for (const entry of list) {
    const outcome = settleEntry(normalizePath(entry), registered, init);
    if (outcome === 'initialized') initialized.push(entry);
    else if (outcome === 'keep') remaining.push(entry);
  }
  try {
    writeAtomic(file, { ...data, pendingGitInits: remaining });
  } catch (err) {
    console.error('[onboarding] could not update the pending git init list:', err);
  }
  return initialized;
}
