import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { registeredProjectRoots } from './context-path.js';
import { realPath } from './real-path.js';
import { laneFromGit, type LanePick } from './run-lane.js';

/**
 * The lane a Super asked for on a delegated worktree: `delegate --fast|--full` (plan
 * sirket-yavaslik D3). Its ONE home is a file in the worktree's own git folder, so it never shows
 * in the working tree, never enters a commit, and is read the same by every tool, after `/clear`,
 * by a `--succeeds` successor and by `resume`: no session id, env variable or brief line gives an
 * intent.
 *
 * Written only by the server ({@link writeLaneIntent}, found from the REPO side, never through the
 * worktree's `.git` pointer the child could rewrite), read only by {@link laneIntentAt}. A file
 * that cannot be trusted reads as `full`: it never opens fast and never lowers a recorded full.
 * The child can still write its own git folder; that is the accepted trust model (contract C2),
 * and money stops at the diff gate in run-lane.ts (C1) whatever the file says.
 */
export const LANE_INTENT_FILE = 'dreamcontext-lane.json';
const MAX_INTENT_BYTES = 1024;
const SHA = /^[0-9a-f]{40,64}$/;

export type LaneIntentKind = 'fast' | 'full';
export interface LaneIntent { intent: LaneIntentKind; base: string | null }
export interface LaneIntentRecord { intent: LaneIntentKind; base: string; contextRoot: string; superId: string; child: string; at: string }

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function tryGit(cwd: string, args: string[]): string | null {
  try { return git(cwd, args); } catch { return null; }
}

/** The raw record of this checkout's intent file: undefined = no file, null = a file that cannot be trusted. */
function readRaw(cwd: string): Partial<LaneIntentRecord> | null | undefined {
  const gitDir = tryGit(cwd, ['rev-parse', '--absolute-git-dir']);
  if (!gitDir) return undefined;
  const path = join(gitDir, LANE_INTENT_FILE);
  let st;
  try { st = lstatSync(path); } catch { return undefined; }
  if (!st.isFile() || st.size > MAX_INTENT_BYTES) return null;
  try {
    const v = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Partial<LaneIntentRecord> : null;
  } catch {
    return null;
  }
}

/**
 * The intent recorded for the checkout at `cwd`, or null when none is. A file that is there but
 * broken, whose `base` is no sha, or whose `base` is not an ancestor of HEAD reads as
 * `{ intent: 'full', base: null }`: closed, never fast and never below full.
 */
export function laneIntentAt(cwd: string): LaneIntent | null {
  const raw = readRaw(cwd);
  if (raw === undefined) return null;
  const closed: LaneIntent = { intent: 'full', base: null };
  if (raw === null || (raw.intent !== 'fast' && raw.intent !== 'full')) return closed;
  if (typeof raw.base !== 'string' || !SHA.test(raw.base)) return closed;
  if (tryGit(cwd, ['merge-base', '--is-ancestor', raw.base, 'HEAD']) === null) return closed;
  return { intent: raw.intent, base: raw.base };
}

/**
 * The worktree's own admin folder (`<common-dir>/worktrees/<name>`), found from the repo: the one
 * whose `gitdir` file points at `<worktree>/.git`. Its name is not trusted (git suffixes it on a
 * clash), and the folder must really sit under the repo's common git dir.
 */
function adminDirOf(repoPath: string, worktreePath: string): string {
  const commonRaw = git(repoPath, ['rev-parse', '--git-common-dir']);
  const common = realPath(isAbsolute(commonRaw) ? commonRaw : resolve(repoPath, commonRaw));
  const want = realPath(join(worktreePath, '.git'));
  const root = join(common, 'worktrees');
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    let pointed: string;
    try { pointed = readFileSync(join(dir, 'gitdir'), 'utf-8').trim(); } catch { continue; }
    let real: string;
    try { real = realPath(isAbsolute(pointed) ? pointed : resolve(dir, pointed)); } catch { continue; }
    if (real !== want) continue;
    const realDir = realPath(dir);
    if (!realDir.startsWith(common + sep)) throw new Error(`the worktree's git folder ${realDir} is outside ${common}`);
    return realDir;
  }
  throw new Error(`no git worktree of ${repoPath} is at ${worktreePath}`);
}

/**
 * Write the intent for a worktree the server just set up (or raise it to full). Throws when the
 * target is a symlink or no plain file, or the worktree is not one of the repo's.
 */
export function writeLaneIntent(repoPath: string, worktreePath: string, v: Omit<LaneIntentRecord, 'at'>): void {
  if (!SHA.test(v.base)) throw new Error(`base "${v.base}" is no commit sha`);
  const dir = adminDirOf(repoPath, worktreePath);
  const target = join(dir, LANE_INTENT_FILE);
  try {
    if (!lstatSync(target).isFile()) throw new Error(`${target} is not a plain file; not written`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const record: LaneIntentRecord = { ...v, at: new Date().toISOString() };
  const tmp = `${target}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, { flag: 'wx' });
  renameSync(tmp, target);
}

/**
 * "Tam doğrula" on a delegated worktree: the intent becomes full, its base and brain kept. Only
 * ever raises: there is no way back to fast. Throws when the worktree is gone or not the repo's.
 */
export function raiseLaneIntentToFull(repoPath: string, worktreePath: string, who: { superId: string; child: string; contextRoot: string }): void {
  const raw = readRaw(worktreePath);
  const keptBase = raw && typeof raw.base === 'string' && SHA.test(raw.base) ? raw.base : null;
  const base = keptBase ?? git(worktreePath, ['rev-parse', 'HEAD']);
  const contextRoot = raw && typeof raw.contextRoot === 'string' ? raw.contextRoot : who.contextRoot;
  writeLaneIntent(repoPath, worktreePath, { intent: 'full', base, contextRoot, superId: who.superId, child: who.child });
}

/**
 * The brain whose ops card a worktree may read: the intent file's `contextRoot`, accepted only when
 * its real path is a `_dream_context` folder of a project this machine registered
 * (`taskStepContextRoot`'s rule). Anything else is null: the card is not read.
 */
export function opsRootFromIntent(cwd: string): string | null {
  const raw = readRaw(cwd);
  if (!raw || typeof raw.contextRoot !== 'string' || !isAbsolute(raw.contextRoot)) return null;
  let real: string;
  try { real = realPath(raw.contextRoot); } catch { return null; }
  if (basename(real) !== '_dream_context') return null;
  return registeredProjectRoots().includes(dirname(real)) ? real : null;
}

/**
 * The lane of the change in this checkout, read the one way every caller shares (contract C9):
 * with a recorded intent, from its `base` to the working tree, whatever `--from` or the default
 * branch says; without one, as `builder lane` always read it.
 */
export function laneHere(cwd: string, from?: string, to?: string): { pick: LanePick; intent: LaneIntent | null } {
  const intent = laneIntentAt(cwd);
  if (!intent) return { pick: laneFromGit(cwd, from, to), intent };
  if (!intent.base) return { pick: laneFromGit(cwd, from, to, 'full'), intent };
  return { pick: laneFromGit(cwd, intent.base, undefined, intent.intent), intent };
}
