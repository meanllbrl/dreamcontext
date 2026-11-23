import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { normalize } from 'node:path';
import { resolveLinkedRepos } from '../linked-repos.js';
import { worktreeIsolationAllowed } from '../worktree-gate.js';
import { safeChildPath } from '../../server/safe-path.js';
import { acceptableWorktree, superWorktreeRoot } from './store.js';
import { SUPER_BRANCH_RE, SUPER_SLUG_RE, validBase } from './types.js';
import type { SuperChild } from './types.js';

export { validBase };

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

/** git prints `D:/a/b` on Windows; the paths compared against these are `D:\a\b`. */
async function porcelain(repoPath: string): Promise<PorcelainEntry[]> {
  const out = await gitOk(repoPath, ['worktree', 'list', '--porcelain'], 'git worktree list');
  const entries: PorcelainEntry[] = [];
  let cur: PorcelainEntry | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: normalize(line.slice(9)), branch: null }; entries.push(cur); }
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

/** `lazy`: `['--no-lazy-fetch']` on the task path, where a ref to a missing object must never be
 *  fetched through the transport the repo config names (`show-ref --verify` reads the object). */
async function branchExists(repoPath: string, branch: string, lazy: readonly string[] = []): Promise<boolean> {
  return (await git(repoPath, [...lazy, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
}

async function isDirty(worktree: string): Promise<boolean> {
  const r = await git(worktree, ['status', '--porcelain']);
  if (r.code !== 0) return true;
  return r.stdout.trim().length > 0;
}

/** A commit sha for `ref`, or null (not a commit here, or not a ref we accept). */
export async function resolveCommit(repoPath: string, ref: string, lazy: readonly string[] = []): Promise<string | null> {
  if (!validBase(ref) && !/^[0-9a-f]{7,64}$/.test(ref)) return null;
  const r = await git(repoPath, [...lazy, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  const sha = r.stdout.trim();
  return r.code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/**
 * D9: has `ref`'s tip reached home? Home = a remote-tracking branch (never a remote's HEAD, never
 * a pushed `super/*` cut), or a local default branch, `dev` or `beta` (never a `super/*` name).
 * null = git could not say (the ref is unknown, the repo unreadable). A label and the janitor's
 * release rule read it; nothing else decides by it.
 */
export async function homeContains(repoPath: string, ref: string): Promise<boolean | null> {
  const sha = await resolveCommit(repoPath, ref);
  if (!sha) return null;
  return homeContainsRefs(repoPath, sha);
}

/** Per repo for a minute: the sweep asks it once per worktree. */
const homeSets = new Map<string, { at: number; set: Promise<Set<string>> }>();
async function homeBranches(repoPath: string): Promise<Set<string>> {
  const now = Date.now();
  const hit = homeSets.get(repoPath);
  if (hit && now - hit.at < 60_000) return hit.set;
  const set = defaultBranchSet(repoPath).then((s) => { s.add('dev'); s.add('beta'); return s; });
  homeSets.set(repoPath, { at: now, set });
  return set;
}

/** Does any ref in `refs` (full names, from `for-each-ref --contains`) count as home (D9)? */
export async function refsAreHome(repoPath: string, refs: readonly string[]): Promise<boolean> {
  let local: Set<string> | null = null;
  for (const r of refs) {
    if (r.startsWith('refs/remotes/')) {
      const rest = r.slice('refs/remotes/'.length);
      const slash = rest.indexOf('/');
      const name = slash < 0 ? '' : rest.slice(slash + 1);
      if (!name || name === 'HEAD' || name.startsWith('super/')) continue;
      return true;
    }
    if (r.startsWith('refs/heads/')) {
      const b = r.slice('refs/heads/'.length);
      if (b.startsWith('super/')) continue;
      local ??= await homeBranches(repoPath);
      if (local.has(b)) return true;
    }
  }
  return false;
}

async function homeContainsRefs(repoPath: string, sha: string): Promise<boolean | null> {
  const r = await git(repoPath, ['for-each-ref', '--contains', sha, '--format=%(refname)', 'refs/heads', 'refs/remotes']);
  if (r.code !== 0) return null;
  return refsAreHome(repoPath, r.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
}

/** The removability rule's git half (D13): is this tree's HEAD on a branch (the branch keeps its
 *  commits), or contained in another ref? A detached HEAD whose commits no other ref holds stays. */
async function headIsKept(worktree: string): Promise<boolean> {
  if (await currentBranch(worktree)) return true;
  const r = await git(worktree, ['for-each-ref', '--contains', 'HEAD', '--format=%(refname)', 'refs/heads', 'refs/remotes']);
  return r.code === 0 && r.stdout.split('\n').some((l) => l.trim() && !/^refs\/remotes\/[^/]+\/HEAD$/.test(l.trim()));
}

// ─── Create ─────────────────────────────────────────────────────────────────────

export interface CreatedWorktree { path: string; branch: string; repo: string; repoPath: string; base: string; /** D10: the base moved to its remote ref. */ baseNote?: string }

export async function createChildWorktree(o: {
  projectRoot: string; repo: unknown; slug: unknown; base?: unknown; home?: string;
  /** A task job's worktree: made with `--no-checkout`, the caller fills it (agents/raw-checkout.ts),
   *  so the host never runs a conversion the repo's config names. */
  noCheckout?: boolean;
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
  // A task worktree never fetches a missing object lazily: that runs the repo config's transport.
  const lazy = o.noCheckout ? ['--no-lazy-fetch'] : [];
  const verify = await git(repo.path, [...lazy, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${base}^{commit}`]);
  let sha = verify.stdout.trim();
  if (verify.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) throw new WorktreeRefused('invalid_base', `"${base}" is not a commit in ${repo.name}`);
  // D10: a local branch whose same-named remote ref went on past it starts from the remote ref
  // (a stale local dev must not seed new work). No fetch: the last known remote ref.
  const ahead = base === 'HEAD' ? null : await remoteAhead(repo.path, base, sha, lazy);
  let baseNote: string | undefined;
  if (ahead) { sha = ahead.sha; baseNote = `started from ${ahead.ref} (${ahead.count} commit${ahead.count === 1 ? '' : 's'} ahead of local ${base})`; }
  if (await branchExists(repo.path, branch, lazy)) throw new WorktreeRefused('branch_exists', `${branch} already exists in ${repo.name}; pick another slug`);
  try { await fsp.lstat(path); throw new WorktreeRefused('path_exists', `${path} already exists`); }
  catch (err) { if (err instanceof WorktreeRefused) throw err; }
  await fsp.mkdir(root, { recursive: true });
  await gitOk(repo.path, [...lazy, 'worktree', 'add', ...(o.noCheckout ? ['--no-checkout'] : []), '-b', branch, path, sha], 'git worktree add');
  return { path, branch, repo: repo.name, repoPath: repo.path, base: sha, ...(baseNote ? { baseNote } : {}) };
}

/** The same-named remote ref of a LOCAL branch `base`, when it is a strict descendant of it. */
async function remoteAhead(repoPath: string, base: string, localSha: string, lazy: readonly string[]): Promise<{ ref: string; sha: string; count: number } | null> {
  if ((await git(repoPath, [...lazy, 'show-ref', '--verify', '--quiet', `refs/heads/${base}`])).code !== 0) return null;
  const remotes = (await git(repoPath, ['remote'])).stdout.split('\n').map((s) => s.trim()).filter((r) => /^[A-Za-z0-9._-]{1,100}$/.test(r)).sort();
  for (const remote of remotes) {
    const ref = `${remote}/${base}`;
    const r = await git(repoPath, [...lazy, 'rev-parse', '--verify', '--quiet', `refs/remotes/${ref}^{commit}`]);
    const sha = r.stdout.trim();
    if (r.code !== 0 || !sha || sha === localSha) continue;
    if ((await git(repoPath, [...lazy, 'merge-base', '--is-ancestor', localSha, sha])).code !== 0) continue;
    const count = Number((await git(repoPath, [...lazy, 'rev-list', '--count', `${localSha}..${sha}`])).stdout.trim()) || 0;
    return { ref, sha, count };
  }
  return null;
}

/**
 * A task job's worktree (AI Team v2 C1-6): `<repo>-super-<slug>` on branch `super/<slug>`, made
 * ONCE and reused by every later step. Listed on that branch → reused as it is; the branch exists
 * but no worktree has it (a removed worktree, a retry after a failed spawn) → re-attached without
 * `-b`; neither → created from `base`. Every add is `--no-checkout` (`added: true`): the caller
 * fills it raw (agents/raw-checkout.ts). `base` in the result is the branch's fork point only when
 * this call created it; on reuse it is null and the caller keeps the one it recorded.
 */
export async function attachChildWorktree(o: {
  projectRoot: string; repo: unknown; slug: unknown; base?: unknown; home?: string;
}): Promise<Omit<CreatedWorktree, 'base'> & { base: string | null; created: boolean; added: boolean }> {
  const home = o.home ?? homedir();
  const repo = resolveWorktreeRepo(o.projectRoot, o.repo, o.home);
  if (!validSlug(o.slug)) throw new WorktreeRefused('invalid_slug', 'slug must be a-z, 0-9 and -, starting with a letter or digit, at most 60 characters');
  const branch = `super/${o.slug}`;
  if (!SUPER_BRANCH_RE.test(branch)) throw new WorktreeRefused('invalid_slug', 'the branch name would be invalid');
  const root = superWorktreeRoot(home);
  const path = safeChildPath(root, `${sanitizeRepoName(repo.name)}-super-${o.slug}`);
  if (!path) throw new WorktreeRefused('invalid_slug', 'the worktree path would leave ~/.claude-worktrees');
  const realPath = await real(path);
  const listed = (await porcelain(repo.path)).find((e) => e.path === path || e.path === realPath);
  if (listed) {
    if (listed.branch !== branch) throw new WorktreeRefused('path_exists', `${path} is a worktree of another branch`);
    return { path, branch, repo: repo.name, repoPath: repo.path, base: null, created: false, added: false };
  }
  try { await fsp.lstat(path); throw new WorktreeRefused('path_exists', `${path} already exists and is not this task's worktree`); }
  catch (err) { if (err instanceof WorktreeRefused) throw err; }
  await fsp.mkdir(root, { recursive: true });
  if (await branchExists(repo.path, branch, ['--no-lazy-fetch'])) {
    // Re-attaching a branch the agent wrote, with a config the agent could write: no checkout here.
    await gitOk(repo.path, ['--no-lazy-fetch', 'worktree', 'add', '--no-checkout', path, branch], 'git worktree add');
    return { path, branch, repo: repo.name, repoPath: repo.path, base: null, created: false, added: true };
  }
  const created = await createChildWorktree({ projectRoot: o.projectRoot, repo: repo.name, slug: o.slug, base: o.base, home: o.home, noCheckout: true });
  return { ...created, created: true, added: true };
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

/** K2: how long the merge result waits for its returns report; past it, `returns.error`. */
export const MERGE_RETURNS_MS = 120_000;

export async function mergeChildren<R = unknown>(o: {
  projectRoot: string; repo: unknown; children: readonly MergeChild[]; topic: unknown; home?: string;
  /** D10: a NEW topic opens at this ref (an existing one ignores it and says so). */
  base?: unknown;
  /** K2: the returns report of the topic after the merges (returns.ts `pendingReturns`). Bounded;
   *  a failure or the bound is `{ error }`, never a failed merge. */
  returns?: (repoPath: string, topicBranch: string) => Promise<R>;
  returnsMs?: number;
}): Promise<{ branch: string; worktree: string; results: MergeOutcome[]; baseNote?: string; returns?: R | { error: string } }> {
  const home = o.home ?? homedir();
  const repo = resolveWorktreeRepo(o.projectRoot, o.repo, o.home);
  if (!validSlug(o.topic)) throw new WorktreeRefused('invalid_topic', 'topic must be a-z, 0-9 and -, at most 60 characters');
  if (!o.children.length) throw new WorktreeRefused('no_children', 'name at least one child to merge');
  const base = o.base === undefined || o.base === null || o.base === '' ? null : o.base;
  if (base !== null && !validBase(base)) throw new WorktreeRefused('invalid_base', 'base must be a branch, tag or commit (letters, digits, . _ / -), never an option');
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
  let baseNote: string | undefined;
  // A topic that exists never moves to a base (a merged topic is never rebased): say so.
  if (base !== null && (holding || await branchExists(repo.path, target))) baseNote = `${target} already exists: --base ${base} ignored (start a fresh topic to take a new base)`;
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
      let startSha: string;
      if (base !== null) {
        const sha = await resolveCommit(repo.path, base);
        if (!sha) throw new WorktreeRefused('invalid_base', `"${base}" is not a commit in ${repo.name}`);
        startSha = sha;
        baseNote = `${target} opened at ${base}`;
      } else {
        startSha = (await gitOk(main?.path ?? repo.path, ['rev-parse', '--verify', 'HEAD^{commit}'], 'git rev-parse')).trim();
      }
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
  const out: { branch: string; worktree: string; results: MergeOutcome[]; baseNote?: string; returns?: R | { error: string } } = { branch: target, worktree, results, ...(baseNote ? { baseNote } : {}) };
  if (o.returns) out.returns = await bounded(() => o.returns!(repo.path, target), o.returnsMs ?? MERGE_RETURNS_MS);
  return out;
}

/** `fn`'s answer within `ms`, else `{ error }`; never throws. */
export async function bounded<R>(fn: () => Promise<R>, ms: number): Promise<R | { error: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<{ error: string }>((done) => { timer = setTimeout(() => done({ error: `no answer within ${Math.round(ms / 1000)} s` }), ms); timer.unref?.(); }),
    ]);
  } catch (err) {
    return { error: String((err as Error)?.message ?? err).slice(0, 400) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── List / remove ──────────────────────────────────────────────────────────────

export async function worktreeStatus(repoPath: string, worktree: string, branch: string, home?: string): Promise<{ listed: boolean; dirty: boolean | null; merged: boolean | null }> {
  try { await assertListedWorktree(repoPath, worktree, home); }
  catch { return { listed: false, dirty: null, merged: null }; }
  // `merged` is the "home" label (D9): only a label.
  return { listed: true, dirty: await isDirty(worktree), merged: await homeContains(repoPath, `refs/heads/${branch}`) };
}

/** Remove a child's worktree by the sweep's one rule (D13): clean, and its HEAD on a branch (the
 *  branch keeps the commits) or contained in another ref. Never `--force`; the branch is kept,
 *  merged or not (pattern a-delete-is-never-inferred-from-absence). */
export async function removeChildWorktree(o: { repoPath: string; worktree: string; branch: string; home?: string }): Promise<void> {
  await assertListedWorktree(o.repoPath, o.worktree, o.home);
  if (!SUPER_BRANCH_RE.test(o.branch)) throw new WorktreeRefused('no_branch', 'not a super/* branch');
  if (await isDirty(o.worktree)) throw new WorktreeRefused('dirty', `${o.worktree} has uncommitted changes`);
  if (!(await headIsKept(o.worktree))) throw new WorktreeRefused('unmerged', `${o.worktree} is on a detached HEAD whose commits no branch holds; switch to a branch first`);
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


// ─── A child's checkout, from git (K7, D15) ─────────────────────────────────────

export interface ChildCheckout {
  repo: { name: string; path: string } | null;
  /** The branch its work is on: the live worktree's when it is `super/*`, else `lastBranch`, else
   *  `branch`. */
  branch: string | null;
  /** Only a worktree git lists right now, not being removed, with its HEAD on a branch. */
  worktree: string | null;
  /** The branch that worktree is on, whatever its name (`super/*` or not). */
  liveBranch?: string;
  /** Why `repo` is null. */
  why?: string;
  /** The child's work is NOT on `branch` (review r1, class merge-source-not-where-the-work-is):
   *  its listed worktree is on a detached HEAD, or the sweep saw it moved to a non-`super/*`
   *  branch. Merge and resume refuse to act on `branch` then and name this place; the release
   *  pass keeps the child. */
  elsewhere?: { kind: 'detached' | 'moved'; where: string; message: string };
}

/**
 * Where a child's work is NOW, read from git; the record's `worktree` is only a hint (D15). Every
 * reader of a child's checkout calls this: a child whose worktree the sweep removed is a
 * dal-yalnız child, merged and resumed through its branch.
 */
export async function childCheckout(projectRoot: string, child: SuperChild, o: { removing?: ReadonlySet<string>; home?: string } = {}): Promise<ChildCheckout> {
  const repos = resolveLinkedRepos(projectRoot, o.home).filter((r) => r.present && r.path).map((r) => ({ name: r.name, path: r.path as string }));
  let repo: { name: string; path: string } | null = null;
  let why: string | undefined;
  if (child.repo) {
    repo = repos.find((r) => r.name === child.repo) ?? null;
    if (!repo) why = `linked repo ${child.repo} is not on this machine`;
  }
  if (!repo && !child.repo && child.worktree) repo = await repoOfWorktree(projectRoot, child.worktree, o.home);
  if (!repo && !child.repo) {
    const named = [child.lastBranch, child.branch].filter((b): b is string => !!b);
    const holders: Array<{ name: string; path: string }> = [];
    for (const r of repos) {
      for (const b of named) { if (await branchExists(r.path, b)) { holders.push(r); break; } }
    }
    if (holders.length === 1) repo = holders[0];
    else if (holders.length > 1) why = `${named[0]} is in several linked repos (${holders.map((h) => h.name).join(', ')}); name one with --repo`;
    else why = named.length ? `no linked repo holds ${named.join(' or ')}` : 'the child has no branch';
  }
  let worktree: string | null = null;
  let live: string | null = null;
  let elsewhere: ChildCheckout['elsewhere'];
  if (repo && child.worktree && !o.removing?.has(child.worktree)) {
    try {
      const listed = await listedWorktreesFor([repo.path], [child.worktree]);
      if (listed.has(child.worktree) && acceptableWorktree(child.worktree, { home: o.home, listedWorktrees: listed })) {
        live = await currentBranch(child.worktree);
        if (live) worktree = child.worktree;
        else elsewhere = { kind: 'detached', where: child.worktree, message: `its worktree ${child.worktree} is on a detached HEAD; it must switch to a branch first` };
      }
    } catch { /* not listed */ }
  }
  const branch = (live && SUPER_BRANCH_RE.test(live) ? live : null) ?? child.lastBranch ?? child.branch ?? null;
  // Moved past `branch`: only when that branch still exists and holds commits `branch` lacks.
  // A super branch deleted by hand while movedTo still exists: the work is there too.
  if (repo && branch && !worktree && !elsewhere && child.movedTo && validBase(child.movedTo) && await branchExists(repo.path, child.movedTo)
    && (!(await branchExists(repo.path, branch))
      || Number((await git(repo.path, ['rev-list', '--count', `refs/heads/${child.movedTo}`, `^refs/heads/${branch}`, '--'])).stdout.trim()) > 0)) {
    elsewhere = { kind: 'moved', where: child.movedTo, message: `its work moved to ${child.movedTo}, not a super/* branch; merge that branch by hand` };
  }
  return { repo, branch, worktree, ...(live ? { liveBranch: live } : {}), ...(repo ? {} : { why: why ?? 'no linked repo found' }), ...(elsewhere ? { elsewhere } : {}) };
}

/** The path a child's worktree is made at (and re-attached at: its Claude session is keyed by it). */
export function childWorktreePath(repoName: string, branch: string, home?: string): string | null {
  if (!SUPER_BRANCH_RE.test(branch)) return null;
  return safeChildPath(superWorktreeRoot(home ?? homedir()), `${sanitizeRepoName(repoName)}-super-${branch.slice('super/'.length)}`);
}

/**
 * `super resume` of a dal-yalnız child (K7): its worktree back at the original path, on its branch,
 * checked out. A path the sweep is still removing is waited for (bounded); the branch checked out
 * elsewhere, missing, or the path taken → `{ why }`, and the child starts without a worktree.
 */
export async function reattachChildWorktree(o: {
  projectRoot: string; child: SuperChild; home?: string; removing?: ReadonlySet<string>; waitMs?: number;
}): Promise<{ worktree: string; branch: string; repo: string } | { why: string }> {
  const co = await childCheckout(o.projectRoot, o.child, { removing: o.removing, home: o.home });
  if (co.worktree && co.branch) return { worktree: co.worktree, branch: co.branch, repo: co.repo!.name };
  if (!co.repo) return { why: co.why ?? 'no linked repo found' };
  if (co.elsewhere) return { why: co.elsewhere.message };
  const branch = co.branch;
  if (!branch || !SUPER_BRANCH_RE.test(branch)) return { why: 'the child has no super/* branch' };
  if (!(await branchExists(co.repo.path, branch))) return { why: `${branch} does not exist in ${co.repo.name}` };
  const hint = o.child.worktree && acceptableWorktree(o.child.worktree, { home: o.home }) ? o.child.worktree : null;
  const path = hint ?? childWorktreePath(co.repo.name, o.child.branch ?? branch, o.home);
  if (!path) return { why: 'the worktree path would leave ~/.claude-worktrees' };
  const until = Date.now() + (o.waitMs ?? 30_000);
  while (o.removing?.has(path) && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  if (o.removing?.has(path)) return { why: `${path} is still being removed; resume again in a moment` };
  const holder = (await porcelain(co.repo.path)).find((e) => e.branch === branch);
  if (holder) return { why: `${branch} is checked out at ${holder.path}` };
  try { await fsp.lstat(path); return { why: `${path} exists and is not a worktree of ${branch}` }; } catch { /* free */ }
  await fsp.mkdir(superWorktreeRoot(o.home ?? homedir()), { recursive: true });
  const r = await git(co.repo.path, ['worktree', 'add', path, branch]);
  if (r.code !== 0) return { why: `git worktree add: ${r.stderr.trim().slice(0, 300) || `exit ${r.code}`}` };
  return { worktree: path, branch, repo: co.repo.name };
}
