import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { resolveLinkedRepos } from '../linked-repos.js';
import { worktreeIsolationAllowed } from '../worktree-gate.js';
import { safeChildPath } from '../../server/safe-path.js';
import { acceptableWorktree, superWorktreeRoot } from './store.js';
import { SUPER_BRANCH_RE, SUPER_SLUG_RE } from './types.js';

/**
 * The Super Agent's children work in their own git worktrees, and it merges them (plan-r7 D12,
 * decision 6).
 *
 *  - `super delegate --worktree <repo>`: a worktree of a LINKED repo (never the brain's own
 *    checkout, `worktree-gate.ts`), under `~/.claude-worktrees/`, on a new `super/<slug>` branch.
 *  - `super merge <child…> --into <topic>`: the children's branches merged `--no-ff`, one by one,
 *    into `super/<topic>` in that branch's OWN worktree. A child's branch is the one its worktree
 *    is on NOW (it may have moved past the recorded `super/<slug>`); a branch already inside the
 *    topic is `nothingToMerge`, never a merge. A conflict is aborted and reported with its files;
 *    the integration branch stays as it was before that child.
 *  - `super worktree remove`: refuses a dirty or unmerged worktree.
 *
 * EVERY git command here: argv (`execFile`, never a shell string), hooks, fsmonitor and commit
 * signing off (`-c core.hooksPath=/dev/null -c core.fsmonitor=false -c commit.gpgSign=false`),
 * no terminal prompt. Nothing is ever pushed and nothing lands on a default branch: there is no
 * push call in this file, and every merge target is a `super/*` branch checked against the
 * default-branch set.
 */

export const GIT_SAFE_ARGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false'] as const;
const BASE_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const GIT_TIMEOUT_MS = 60_000;

export class WorktreeRefused extends Error {
  constructor(public readonly code: string, message: string, public readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'WorktreeRefused';
  }
}

export interface GitResult { code: number; stdout: string; stderr: string }

/** One git command, safe flags first. Never throws on a non-zero exit (the code says it). */
export function git(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', [...GIT_SAFE_ARGS, ...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

async function gitOk(cwd: string, args: readonly string[], what: string): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new WorktreeRefused('git_failed', `${what} failed: ${r.stderr.trim().slice(0, 400) || `exit ${r.code}`}`);
  return r.stdout;
}

// ─── Validation ─────────────────────────────────────────────────────────────────

export const validSlug = (s: unknown): s is string => typeof s === 'string' && SUPER_SLUG_RE.test(s);

/** A base ref as typed: a ref/sha character set, never an option. */
export function validBase(b: unknown): b is string {
  return typeof b === 'string' && BASE_RE.test(b) && !b.startsWith('-') && !b.includes('..');
}

/** A repo name reduced to the slug alphabet, for the worktree's folder name. */
export function sanitizeRepoName(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'repo';
}

/** The linked repo `name` of this project, present on this machine and allowed a worktree. */
export function resolveWorktreeRepo(projectRoot: string, name: unknown, home?: string): { name: string; path: string } {
  if (typeof name !== 'string' || !name.trim()) throw new WorktreeRefused('invalid_repo', 'name a linked repo with --worktree <repo>');
  if (!worktreeIsolationAllowed(projectRoot, home)) {
    throw new WorktreeRefused('worktrees_not_allowed', 'this project may not create worktrees (its brain lives in the code checkout and no linked repo is present)');
  }
  const repos = resolveLinkedRepos(projectRoot, home).filter((r) => r.present && r.path);
  const repo = repos.find((r) => r.name === name);
  if (!repo || !repo.path) {
    throw new WorktreeRefused('unknown_repo', `no linked repo "${name}" on this machine; linked: ${repos.map((r) => r.name).join(', ') || 'none'}`);
  }
  return { name: repo.name, path: repo.path };
}

// ─── Listing ────────────────────────────────────────────────────────────────────

interface PorcelainEntry { path: string; branch: string | null }

async function porcelain(repoPath: string): Promise<PorcelainEntry[]> {
  const out = await gitOk(repoPath, ['worktree', 'list', '--porcelain'], 'git worktree list');
  const entries: PorcelainEntry[] = [];
  let cur: PorcelainEntry | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9), branch: null }; entries.push(cur); }
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  return entries;
}

const real = async (p: string): Promise<string> => { try { return await fsp.realpath(p); } catch { return p; } };

/** Every worktree path git lists for `repoPath`, in both the listed and the real spelling. */
export async function listedWorktrees(repoPath: string): Promise<Set<string>> {
  const set = new Set<string>();
  for (const e of await porcelain(repoPath)) { set.add(e.path); set.add(await real(e.path)); }
  return set;
}

/**
 * The set `SanitizeOpts.listedWorktrees` takes, for the given candidate paths: every listed
 * path, plus each candidate whose real path git lists (git may print the real spelling of a
 * path the record holds through a symlinked home).
 */
export async function listedWorktreesFor(repoPaths: readonly string[], candidates: readonly string[] = []): Promise<Set<string>> {
  const set = new Set<string>();
  for (const repo of repoPaths) {
    try { for (const p of await listedWorktrees(repo)) set.add(p); } catch { /* an unreadable repo lists nothing */ }
  }
  for (const c of candidates) if (set.has(await real(c))) set.add(c);
  return set;
}

/** Is `worktree` an acceptable child worktree that git lists for `repoPath`? Checked before any
 *  git command runs in it. */
export async function assertListedWorktree(repoPath: string, worktree: string, home?: string): Promise<void> {
  const listed = await listedWorktreesFor([repoPath], [worktree]);
  if (!acceptableWorktree(worktree, { home, listedWorktrees: listed })) {
    throw new WorktreeRefused('worktree_not_listed', `${worktree} is not a super worktree git lists for this repo`);
  }
}

// ─── The default-branch set ─────────────────────────────────────────────────────

/** Never a merge target, never deleted: each remote's HEAD branch, main/master/trunk, and the
 *  branch checked out in the repo's main worktree. */
export async function defaultBranchSet(repoPath: string): Promise<Set<string>> {
  const set = new Set(['main', 'master', 'trunk']);
  const remotes = (await git(repoPath, ['remote'])).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  for (const remote of remotes) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(remote)) continue;
    const r = await git(repoPath, ['symbolic-ref', '-q', `refs/remotes/${remote}/HEAD`]);
    const ref = r.stdout.trim();
    if (r.code === 0 && ref.startsWith(`refs/remotes/${remote}/`)) set.add(ref.slice(`refs/remotes/${remote}/`.length));
  }
  try {
    const main = (await porcelain(repoPath))[0];
    if (main?.branch) set.add(main.branch);
  } catch { /* listed above or not at all */ }
  return set;
}

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  return (await git(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
}

async function isDirty(worktree: string): Promise<boolean> {
  const r = await git(worktree, ['status', '--porcelain']);
  if (r.code !== 0) return true;
  return r.stdout.trim().length > 0;
}

/** Is `branch`'s tip contained in some OTHER local branch (merged somewhere)? */
async function isMerged(repoPath: string, branch: string): Promise<boolean> {
  const r = await git(repoPath, ['for-each-ref', '--format=%(refname:short)', '--contains', `refs/heads/${branch}`, 'refs/heads']);
  if (r.code !== 0) return false;
  return r.stdout.split('\n').map((s) => s.trim()).some((b) => b && b !== branch);
}

// ─── Create ─────────────────────────────────────────────────────────────────────

export interface CreatedWorktree { path: string; branch: string; repo: string; repoPath: string; base: string }

export async function createChildWorktree(o: {
  projectRoot: string; repo: unknown; slug: unknown; base?: unknown; home?: string;
}): Promise<CreatedWorktree> {
  const home = o.home ?? homedir();
  const repo = resolveWorktreeRepo(o.projectRoot, o.repo, o.home);
  if (!validSlug(o.slug)) throw new WorktreeRefused('invalid_slug', 'slug must be a-z, 0-9 and -, starting with a letter or digit, at most 60 characters');
  const base = o.base === undefined || o.base === null || o.base === '' ? 'HEAD' : o.base;
  if (!validBase(base)) throw new WorktreeRefused('invalid_base', 'base must be a branch, tag or commit (letters, digits, . _ / -), never an option');
  const branch = `super/${o.slug}`;
  if (!SUPER_BRANCH_RE.test(branch)) throw new WorktreeRefused('invalid_slug', 'the branch name would be invalid');
  const root = superWorktreeRoot(home);
  const path = safeChildPath(root, `${sanitizeRepoName(repo.name)}-super-${o.slug}`);
  if (!path) throw new WorktreeRefused('invalid_slug', 'the worktree path would leave ~/.claude-worktrees');
  const verify = await git(repo.path, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${base}^{commit}`]);
  const sha = verify.stdout.trim();
  if (verify.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) throw new WorktreeRefused('invalid_base', `"${base}" is not a commit in ${repo.name}`);
  if (await branchExists(repo.path, branch)) throw new WorktreeRefused('branch_exists', `${branch} already exists in ${repo.name}; pick another slug`);
  try { await fsp.lstat(path); throw new WorktreeRefused('path_exists', `${path} already exists`); }
  catch (err) { if (err instanceof WorktreeRefused) throw err; }
  await fsp.mkdir(root, { recursive: true });
  await gitOk(repo.path, ['worktree', 'add', '-b', branch, path, sha], 'git worktree add');
  return { path, branch, repo: repo.name, repoPath: repo.path, base: sha };
}

/** Undo a worktree `createChildWorktree` just made, when NO child was told about it (the window
 *  refused, or the frame never left). Never forced: a dirty worktree or a branch that moved past
 *  its base is left where it is. Best effort. */
export async function discardFreshWorktree(w: CreatedWorktree): Promise<void> {
  const tip = (await git(w.repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${w.branch}`])).stdout.trim();
  if (tip !== w.base) return;
  const removed = await git(w.repoPath, ['worktree', 'remove', w.path]);
  if (removed.code !== 0) return;
  await git(w.repoPath, ['branch', '-D', w.branch]);
}

// ─── Merge ──────────────────────────────────────────────────────────────────────

export interface MergeChild { sessionId: string; branch?: string; worktree?: string }
/** `branch` is what was merged; `movedFrom` the recorded branch when the child's worktree had moved
 *  to another one. */
export type MergeOutcome =
  | { sessionId: string; branch: string; movedFrom?: string; merged: true }
  | { sessionId: string; branch: string; movedFrom?: string; merged: false; nothingToMerge: true }
  | { sessionId: string; branch: string; movedFrom?: string; merged: false; conflict: string[]; error?: string };

/** The branch a worktree is on now; null when its HEAD is detached. */
async function currentBranch(worktree: string): Promise<string | null> {
  // The full ref, not `--short`: that one answers `heads/<b>` when a tag has the same name.
  const r = await git(worktree, ['symbolic-ref', '--quiet', 'HEAD']);
  const ref = r.stdout.trim();
  return r.code === 0 && ref.startsWith('refs/heads/') && ref.length > 11 ? ref.slice(11) : null;
}

export async function mergeChildren(o: {
  projectRoot: string; repo: unknown; children: readonly MergeChild[]; topic: unknown; home?: string;
}): Promise<{ branch: string; worktree: string; results: MergeOutcome[] }> {
  const home = o.home ?? homedir();
  const repo = resolveWorktreeRepo(o.projectRoot, o.repo, o.home);
  if (!validSlug(o.topic)) throw new WorktreeRefused('invalid_topic', 'topic must be a-z, 0-9 and -, at most 60 characters');
  if (!o.children.length) throw new WorktreeRefused('no_children', 'name at least one child to merge');
  const target = `super/${o.topic}`;
  const defaults = await defaultBranchSet(repo.path);
  if (defaults.has(target)) throw new WorktreeRefused('default_branch', `${target} is a default branch of ${repo.name}; super verbs never merge into it`);

  // Every member checked before anything changes. A child with a worktree is merged from the
  // branch that worktree is on now: it may have gone on in a new branch after the recorded one
  // (field report 2026-10-21: the old branch merged, the new commit never came). The branch it is
  // on passes the same rules as the recorded one, except the super/* name.
  const plan: Array<{ sessionId: string; branch: string; movedFrom?: string }> = [];
  for (const c of o.children) {
    if (!c.branch || !SUPER_BRANCH_RE.test(c.branch)) throw new WorktreeRefused('no_branch', `child ${c.sessionId} has no super/* branch`);
    let branch = c.branch;
    if (c.worktree) {
      await assertListedWorktree(repo.path, c.worktree, home);
      const now = await currentBranch(c.worktree);
      if (!now) throw new WorktreeRefused('detached', `child ${c.sessionId}'s worktree is not on a branch (detached HEAD); it must switch to a branch first`, { child: c.sessionId });
      // The child names it: never an option, never a ref trick (the same rule as a typed base).
      if (!validBase(now)) throw new WorktreeRefused('no_branch', `child ${c.sessionId}'s branch name is not one super merge accepts (letters, digits, . _ / -, no leading -)`, { child: c.sessionId });
      branch = now;
    }
    if (defaults.has(branch)) throw new WorktreeRefused('default_branch', `${branch} is a default branch; refusing`);
    if (branch === target) throw new WorktreeRefused('invalid_topic', `the topic ${o.topic} is child ${c.sessionId}'s own branch`);
    if (!(await branchExists(repo.path, branch))) throw new WorktreeRefused('missing_branch', `${branch} does not exist in ${repo.name}`);
    if (c.worktree && await isDirty(c.worktree)) throw new WorktreeRefused('dirty', `child ${c.sessionId}'s worktree has uncommitted changes; it must commit first`, { child: c.sessionId });
    plan.push({ sessionId: c.sessionId, branch, ...(branch !== c.branch ? { movedFrom: c.branch } : {}) });
  }

  const root = superWorktreeRoot(home);
  const path = safeChildPath(root, `${sanitizeRepoName(repo.name)}-merge-${o.topic}`);
  if (!path) throw new WorktreeRefused('invalid_topic', 'the integration worktree path would leave ~/.claude-worktrees');
  const entries = await porcelain(repo.path);
  const holding = entries.find((e) => e.branch === target);
  let worktree: string;
  if (holding) {
    // git may list the real spelling of our own path (a symlinked home): keep ours then.
    worktree = (await real(holding.path)) === (await real(path)) ? path : holding.path;
    await assertListedWorktree(repo.path, worktree, home).catch(() => {
      throw new WorktreeRefused('default_branch', `${target} is checked out outside ~/.claude-worktrees; refusing to merge there`);
    });
  } else {
    await fsp.mkdir(root, { recursive: true });
    if (await branchExists(repo.path, target)) {
      await gitOk(repo.path, ['worktree', 'add', path, target], 'git worktree add');
    } else {
      const main = entries[0];
      const startSha = (await gitOk(main?.path ?? repo.path, ['rev-parse', '--verify', 'HEAD^{commit}'], 'git rev-parse')).trim();
      await gitOk(repo.path, ['worktree', 'add', '-b', target, path, startSha], 'git worktree add');
    }
    worktree = path;
  }
  if (await isDirty(worktree)) throw new WorktreeRefused('dirty', `the integration worktree ${worktree} has uncommitted changes`);

  const results: MergeOutcome[] = [];
  for (const c of plan) {
    const { branch } = c;
    // Already inside the topic: git would answer "Already up to date." with exit 0, which used to
    // read as merged: true for a branch that brought nothing.
    if ((await git(worktree, ['merge-base', '--is-ancestor', `refs/heads/${branch}`, 'HEAD'])).code === 0) {
      results.push({ ...c, merged: false, nothingToMerge: true });
      continue;
    }
    // The full ref: what the checks and the ancestor test saw, never a same-named tag or an option.
    const r = await git(worktree, ['merge', '--no-ff', '-m', `Merge branch '${branch}'`, `refs/heads/${branch}`]);
    if (r.code === 0) { results.push({ ...c, merged: true }); continue; }
    const files = (await git(worktree, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    await git(worktree, ['merge', '--abort']);
    results.push({
      ...c, merged: false, conflict: files.slice(0, 200),
      // Not a conflict (no unmerged files): say what git said instead of an empty list.
      ...(files.length ? {} : { error: r.stderr.trim().slice(0, 400) || `exit ${r.code}` }),
    });
  }
  return { branch: target, worktree, results };
}

// ─── List / remove ──────────────────────────────────────────────────────────────

export async function worktreeStatus(repoPath: string, worktree: string, branch: string, home?: string): Promise<{ listed: boolean; dirty: boolean | null; merged: boolean | null }> {
  try { await assertListedWorktree(repoPath, worktree, home); }
  catch { return { listed: false, dirty: null, merged: null }; }
  return { listed: true, dirty: await isDirty(worktree), merged: await isMerged(repoPath, branch) };
}

/** Remove a child's worktree. Refuses a dirty one and an unmerged one (pattern
 *  a-delete-is-never-inferred-from-absence); never `--force`; the branch is kept. */
export async function removeChildWorktree(o: { repoPath: string; worktree: string; branch: string; home?: string }): Promise<void> {
  await assertListedWorktree(o.repoPath, o.worktree, o.home);
  if (!SUPER_BRANCH_RE.test(o.branch)) throw new WorktreeRefused('no_branch', 'not a super/* branch');
  if (await isDirty(o.worktree)) throw new WorktreeRefused('dirty', `${o.worktree} has uncommitted changes`);
  if (!(await isMerged(o.repoPath, o.branch))) throw new WorktreeRefused('unmerged', `${o.branch} is not merged anywhere yet; merge it first`);
  await gitOk(o.repoPath, ['worktree', 'remove', o.worktree], 'git worktree remove');
}

/** Which linked repo holds `worktree` (by git's own listing), for verbs that name a child. */
export async function repoOfWorktree(projectRoot: string, worktree: string, home?: string): Promise<{ name: string; path: string } | null> {
  for (const r of resolveLinkedRepos(projectRoot, home)) {
    if (!r.present || !r.path) continue;
    try {
      const listed = await listedWorktreesFor([r.path], [worktree]);
      if (listed.has(worktree)) return { name: r.name, path: r.path };
    } catch { /* next */ }
  }
  return null;
}

