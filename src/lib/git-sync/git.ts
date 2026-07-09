import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Thin, testable git wrapper over `execFileSync` (pattern from
 * `src/lib/marketing/git-guard.ts`). All functions take an explicit `cwd`,
 * never shell-interpolate, and parse multi-path output NUL-safely.
 *
 * Networked functions (`fetch`/`push`/`clone`) accept a caller-supplied `env`
 * and are only ever called inside `withGitCredentials` (credentials.ts) —
 * they never embed a token in the URL or argv (S1).
 *
 * Throws a typed `GitSyncError` (git stderr attached) for anything that isn't
 * an expected operational outcome the caller already branches on (e.g. a
 * missing ref). Never swallows — loud fail per engineering standards.
 */

export class GitSyncError extends Error {
  constructor(message: string, public readonly stderr?: string) {
    super(message);
    this.name = 'GitSyncError';
  }
}

/** Every networked call passes this to disable any persisted credential helper (e.g. osxkeychain) — F. */
export const CREDENTIAL_HELPER_DISABLE_ARGS = ['-c', 'credential.helper='];

/**
 * Transport hardening for `clone` (S1). `protocol.ext.allow=never` refuses git's
 * `ext::` transport, which would otherwise run an ARBITRARY shell command for a
 * URL like `ext::sh -c "…"`. `clone` is the ONLY networked call that takes a
 * team-writable URL (the linked-repos feature), so this lives on the clone argv
 * (verified: git.clone has zero other callers). Paired with a `--` end-of-options
 * terminator so a leading-dash URL/dest can never be read as a git flag.
 */
export const SAFE_TRANSPORT_ARGS = ['-c', 'protocol.ext.allow=never'];

function run(
  cwd: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv },
): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      env: opts?.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  } catch (err) {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const stderr = e.stderr !== undefined ? String(e.stderr) : '';
    const stdout = e.stdout !== undefined ? String(e.stdout) : '';
    // git writes some "expected" outcomes (e.g. `commit`'s "nothing to commit,
    // working tree clean") to STDOUT, not stderr — callers like `commit()`
    // pattern-match the thrown message for these, so stdout must not be lost.
    const detail = stderr.trim() || stdout.trim() || e.message || 'unknown error';
    throw new GitSyncError(`git ${args.join(' ')} failed: ${detail}`, stderr || undefined);
  }
}

export function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function isGitRepo(cwd: string): boolean {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

export function initRepo(cwd: string): void {
  run(cwd, ['init']);
}

export function currentSha(cwd: string): string | null {
  try {
    return run(cwd, ['rev-parse', 'HEAD']).trim();
  } catch {
    return null;
  }
}

/**
 * The checked-out branch name, or null on a detached HEAD / non-repo.
 * `full-repo` mode syncs the WHOLE project repo on whatever branch the user is
 * actually on — never assume `main` there (a teammate may be on a feature
 * branch). Uses `symbolic-ref` (not `rev-parse --abbrev-ref`) so it returns the
 * real branch name even on an UNBORN branch (a fresh repo with zero commits,
 * where `rev-parse --abbrev-ref HEAD` degrades to the literal `HEAD`).
 * `in-tree` only commits locally and never calls this.
 */
export function currentBranch(cwd: string): string | null {
  try {
    const branch = run(cwd, ['symbolic-ref', '--short', 'HEAD']).trim();
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}

export function addRemote(cwd: string, name: string, url: string): void {
  run(cwd, ['remote', 'add', name, url]);
}

export function setRemoteUrl(cwd: string, name: string, url: string): void {
  run(cwd, ['remote', 'set-url', name, url]);
}

export function getRemoteUrl(cwd: string, name: string): string | null {
  try {
    return run(cwd, ['remote', 'get-url', name]).trim();
  } catch {
    return null;
  }
}

/**
 * Absolute path of the work-tree root enclosing `cwd`, or null when not in a
 * repo. `isGitRepo` can't distinguish "is its own repo" from "is nested inside
 * some other repo's work tree" — callers that are about to mutate remotes or
 * the index need this to know WHICH repo they'd be touching.
 */
export function repoToplevel(cwd: string): string | null {
  try {
    return run(cwd, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    return null;
  }
}

export function removeRemote(cwd: string, name: string): void {
  run(cwd, ['remote', 'remove', name]);
}

/** True when `user.name`/`user.email` resolve (local or global config). */
export function hasGitIdentity(cwd: string): boolean {
  try {
    const email = run(cwd, ['config', 'user.email']).trim();
    const name = run(cwd, ['config', 'user.name']).trim();
    return email.length > 0 && name.length > 0;
  } catch {
    return false;
  }
}

/** Networked. Must be called with the env from `withGitCredentials`. */
export function fetch(cwd: string, remote: string, branch: string, env: NodeJS.ProcessEnv): void {
  run(cwd, [...CREDENTIAL_HELPER_DISABLE_ARGS, 'fetch', remote, branch], { env });
}

/**
 * Networked (ls-remote). True iff `branch` exists on `remote` — false for a
 * freshly created, ref-less repo. Must be called with the env from
 * `withGitCredentials` for private https remotes. Throws on network/auth
 * failure (an unreachable remote is NOT "empty").
 */
export function remoteBranchExists(cwd: string, remote: string, branch: string, env: NodeJS.ProcessEnv): boolean {
  const out = run(cwd, [...CREDENTIAL_HELPER_DISABLE_ARGS, 'ls-remote', '--heads', remote, branch], { env });
  return out.trim().length > 0;
}

/** Networked. Must be called with the env from `withGitCredentials`. */
export function push(cwd: string, remote: string, branch: string, env: NodeJS.ProcessEnv): void {
  run(cwd, [...CREDENTIAL_HELPER_DISABLE_ARGS, 'push', remote, `HEAD:${branch}`], { env });
}

/**
 * Networked. Must be called with the env from `withGitCredentials`. `dest` must
 * not yet exist. Transport-hardened (S1): `protocol.ext.allow=never` refuses the
 * `ext::` RCE transport, and the `--` terminator stops any leading-dash `url`/
 * `dest` being parsed as a flag. The caller (`cloneLinkedRepo`) additionally
 * rebuilds `url` into a canonical `https://github.com/…` form BEFORE it reaches
 * here, so a raw team-writable string never lands on this argv.
 */
export function clone(url: string, dest: string, env: NodeJS.ProcessEnv): void {
  run(process.cwd(), [...CREDENTIAL_HELPER_DISABLE_ARGS, ...SAFE_TRANSPORT_ARGS, 'clone', '--', url, dest], { env });
}

export function mergeBase(cwd: string, a: string, b: string): string | null {
  try {
    return run(cwd, ['merge-base', a, b]).trim();
  } catch {
    return null;
  }
}

export function revParse(cwd: string, ref: string): string | null {
  try {
    return run(cwd, ['rev-parse', ref]).trim();
  } catch {
    return null;
  }
}

export function revListCount(cwd: string, range: string): number {
  try {
    const n = parseInt(run(cwd, ['rev-list', '--count', range]).trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/** Reentrancy guard primitive (C3) — a merge is mid-flight iff `.git/MERGE_HEAD` exists. */
export function hasMergeHead(cwd: string): boolean {
  return existsSync(join(cwd, '.git', 'MERGE_HEAD'));
}

/**
 * Uncommitted changes — modified TRACKED files AND new (untracked, non-ignored)
 * files. Drives both the auto-mode "is there local work to commit" check and
 * pull-only's dirty-tree checkpoint decision. Untracked files are included
 * deliberately: a newly-created knowledge file is exactly the kind of local
 * edit that must be committed/checkpointed too (an already-ignored file never
 * shows up here regardless — `git status` never lists ignored paths without
 * `--ignored`).
 */
export function statusPorcelainTracked(cwd: string): string[] {
  let raw: string;
  try {
    raw = execFileSync('git', ['status', '--porcelain', '-z'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  if (!raw) return [];
  return raw.split('\0').filter((e) => e.length > 0).map((e) => e.slice(3).trim());
}

/** Stage every change in the repo (used when `cwd` IS the brain repo root — `separate` mode). */
export function stageAll(cwd: string): void {
  run(cwd, ['add', '-A']);
}

/** Stage only a path scope (used for `in-tree` mode — must never touch the rest of the code repo). */
export function stagePath(cwd: string, relPath: string): void {
  run(cwd, ['add', '-A', '--', relPath]);
}

/**
 * Commit staged changes. `author`, when given, sets BOTH author and committer
 * via env (the `dreamcontext-sync` fallback tier — a commit never fails on a
 * missing git identity). Returns the new commit sha, or `null` when there was
 * nothing to commit (never throws for that expected case).
 */
export function commit(
  cwd: string,
  message: string,
  author?: { name: string; email: string },
): string | null {
  const env = author
    ? {
        ...process.env,
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
      }
    : undefined;
  try {
    run(cwd, ['commit', '--no-verify', '-m', message], { env });
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (/nothing to commit|nothing added to commit/i.test(msg)) return null;
    throw err;
  }
  return currentSha(cwd);
}

/** Parse `git diff --name-only --diff-filter=U -z` — NUL-split conflicted paths. */
export function listConflictedFiles(cwd: string): string[] {
  let raw: string;
  try {
    raw = execFileSync('git', ['diff', '--name-only', '--diff-filter=U', '-z'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  if (!raw) return [];
  return raw.split('\0').filter((p) => p.length > 0);
}

/** Read the 3 merge stages for a conflicted path via `git show :<stage>:<path>`. Missing stage ⇒ ''. */
export function readOursTheirsBase(cwd: string, path: string): { base: string; ours: string; theirs: string } {
  const read = (stage: 1 | 2 | 3): string => {
    try {
      return run(cwd, ['show', `:${stage}:${path}`]);
    } catch {
      return '';
    }
  };
  return { base: read(1), ours: read(2), theirs: read(3) };
}

/** Stage a single resolved path (used by the semantic-merge resolver). */
export function addPath(cwd: string, relPath: string): void {
  run(cwd, ['add', '--', relPath]);
}

/**
 * Attempt a merge of `remoteRef` into HEAD. `clean:true` on a fast-forward
 * (nothing to commit — the ref just moved, nothing new to scrub) or an
 * auto-mergeable result (staged via `--no-commit`, NOT yet committed — the
 * caller must re-scrub the staged merge result before committing, since a
 * merge can reintroduce a secret with no textual conflict); `clean:false`
 * with the conflicted paths on a real conflict (merge left mid-flight,
 * `MERGE_HEAD` set). Rethrows for any OTHER failure (not a conflict — e.g.
 * no such ref).
 */
export function attemptMerge(cwd: string, remoteRef: string): { clean: boolean; conflicts: string[] } {
  try {
    run(cwd, ['merge', '--no-commit', '--no-edit', remoteRef]);
    return { clean: true, conflicts: [] };
  } catch (err) {
    const conflicts = listConflictedFiles(cwd);
    if (conflicts.length > 0) return { clean: false, conflicts };
    throw err;
  }
}

/** Best-effort abort of an in-progress merge, restoring a clean committed tree. */
export function abortMerge(cwd: string): void {
  try {
    run(cwd, ['merge', '--abort']);
  } catch {
    /* best-effort — if there's nothing to abort, the tree is already clean */
  }
}
