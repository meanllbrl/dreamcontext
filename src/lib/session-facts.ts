import { execFile, execFileSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { currentBranch, isGitRepo } from './git-sync/git.js';
import { canonicalPath } from './paths.js';
import { worktreeIsolationAllowed } from './worktree-gate.js';
import type { EditsElsewhere } from './session-edits.js';

/**
 * The facts a chat session needs to say WHICH checkout it is acting on — the branch, and
 * whether this is a linked git worktree rather than the main checkout.
 *
 * WHY THE SERVER OWNS THESE (and not the agent): the pinned shelf's resting state is one
 * tag line, and the two facts on it that must never be wrong are the ones the user would
 * otherwise have to re-ask for. An agent-pinned branch is only as fresh as the last time
 * the agent thought to mention it; a polled route is correct by construction. The dev-server
 * PORT is the opposite case and is deliberately NOT here: nothing on disk attributes a
 * listening socket to a session, so that one stays an agent-pinned fact.
 *
 * ── Never throws ──────────────────────────────────────────────────────────────────────
 * Every git invocation is individually guarded and any failure — git absent, not a repo,
 * a detached or unborn HEAD, an unreadable config — resolves to {@link UNKNOWN_SESSION_FACTS}.
 * A shelf that renders no branch chip is correct; a shelf that throws takes the composer
 * with it.
 *
 * ── Why two rev-parse calls live here rather than in git-sync/git.ts ──────────────────
 * `git.ts`'s `run()` throws a typed `GitSyncError` by design, which is right for the sync
 * paths that branch on failure. This module's contract is the opposite — it must be total —
 * so the two flag reads below are their own guarded `execFileSync`. The two functions that
 * ALREADY have a never-throw shape (`isGitRepo`, `currentBranch`) are imported, not
 * duplicated.
 */

export interface SessionFacts {
  /** The checked-out branch, or null on a detached/unborn HEAD or a non-repo. */
  branch: string | null;
  /** The repository's DEFAULT branch (`main`, `master`, whatever the remote says), or null when
   *  it cannot be established. Not a decoration: it is what turns the branch chip from a name
   *  into a STATE — the owner read a bare `feat/shelf-pin-drop` as "you are in a different
   *  worktree" (2026-08-25), and the chip can only say "this is a leftover branch on the main
   *  checkout" if it knows which branch would NOT be leftover. See {@link readDefaultBranch}. */
  defaultBranch: string | null;
  /** True when this directory is a LINKED worktree rather than the main checkout. */
  worktree: boolean;
  /** The main checkout's root — set only when `worktree` is true, else null. This is a
   *  REALPATH (see readWorktree): canonicalise before comparing it to a vault path. */
  mainRoot: string | null;
  /** The checkout's OWN directory name, set only when `worktree` is true. The shelf's tag has
   *  room for one word and "worktree" is not the useful one — with several open at once, the
   *  question the user is actually asking is WHICH. */
  worktreeName: string | null;
  /** May a Develop-mode agent create a worktree here? See worktree-gate.ts. */
  worktreeAllowed: boolean;
  /** False when git is unavailable or this is not a work tree — the shelf then shows no
   *  branch chip at all rather than an empty one. */
  isRepo: boolean;
  /** Writes are landing in a DIFFERENT governed checkout than the one described above, or
   *  null when they are not. Unlike every other field this is not read from git and is not
   *  memoized with them: it changes as a turn runs, so the route fills it in per request
   *  (src/lib/session-edits.ts). The chip is MARKED with it; it is never followed. */
  elsewhere: EditsElsewhere | null;
}

/** The one shape every failure resolves to. Frozen so a caller cannot mutate the shared
 *  constant into a lie for every subsequent caller. */
export const UNKNOWN_SESSION_FACTS: SessionFacts = Object.freeze({
  elsewhere: null,
  branch: null,
  defaultBranch: null,
  worktree: false,
  mainRoot: null,
  worktreeName: null,
  worktreeAllowed: false,
  isRepo: false,
});

/**
 * How long a read is reused for the same project root.
 *
 * Deliberately SHORTER than the shelf's 15s poll, so the memo can never mask a real branch
 * switch — the next poll always re-reads. Its job is the CONCURRENT case: four split panes
 * on one project each fire their own poll, and without this that is four `git` forks in the
 * same tick for one answer.
 */
export const SESSION_FACTS_TTL_MS = 12_000;

interface CacheEntry { facts: SessionFacts; at: number }
const cache = new Map<string, CacheEntry>();

/** One git line, or null. Total: a non-zero exit, a missing binary and a timeout all
 *  resolve to null rather than throwing. */
function gitLine(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    const line = out.trim();
    return line || null;
  } catch {
    return null;
  }
}

/** A path with every symlink resolved, or the input unchanged if it cannot be resolved.
 *  See {@link readWorktree} for why the comparison there cannot skip this. */
function canonical(path: string): string {
  try { return canonicalPath(path); } catch { return path; }
}

/**
 * Is `cwd` a linked worktree, and if so where is the main checkout?
 *
 * `--git-common-dir` names the SHARED git directory (the main checkout's `.git`);
 * `--absolute-git-dir` names THIS tree's own git directory. In the main checkout they are
 * the same directory; in a linked worktree the latter is `<common>/worktrees/<name>`. So the
 * test is inequality — but only after normalising two ways in which git's own two answers
 * disagree about how to spell the same directory:
 *
 *   1. RELATIVE vs absolute. From the main checkout `--git-common-dir` prints `.git`, from a
 *      worktree it prints an absolute path. Hence `resolve(cwd, …)`.
 *   2. SYMLINKS. `--absolute-git-dir` returns a realpath'd answer while `--git-common-dir`
 *      does not, so on macOS — where `/var` is a symlink to `/private/var`, and any project
 *      under `/tmp`, a symlinked home or an APFS firmlink is affected — a plain main checkout
 *      compares `/var/…/.git` against `/private/var/…/.git` and reports itself a WORKTREE.
 *      That false positive would have pinned a permanent "worktree" marker on the shelf of
 *      every such session. Both sides are therefore canonicalised before comparison.
 *
 * Consequence worth knowing at the call site: `mainRoot` is a REALPATH. Do not compare it
 * to a vault path by string equality without canonicalising that too.
 *
 * A submodule correctly reports false: its git dir is `<parent>/.git/modules/<name>` and its
 * common dir is the same path, so they match.
 */
function readWorktree(cwd: string): { worktree: boolean; mainRoot: string | null } {
  const commonDir = gitCommonDir(cwd);
  const ownRaw = gitLine(cwd, ['rev-parse', '--absolute-git-dir']);
  if (!commonDir || !ownRaw) return { worktree: false, mainRoot: null };
  if (commonDir === canonical(ownRaw)) return { worktree: false, mainRoot: null };
  return { worktree: true, mainRoot: dirname(commonDir) };
}

/**
 * The repository's DEFAULT branch, or null.
 *
 * ── Why this does not ask for `origin` ────────────────────────────────────────────────
 * `git symbolic-ref refs/remotes/origin/HEAD` is the usual one-liner and it is wrong here:
 * THIS repository's remote is named `main`, not `origin` (measured 2026-08-23 during the
 * brain-separation survey), and a dreamcontext user's remote can be named anything at all.
 * Hardcoding `origin` would have answered null on the very repo the feature was built in. So
 * every remote is asked, in git's own listing order, and the first that has a resolvable HEAD
 * wins — a single-remote repo (the overwhelming case) costs exactly one extra `git remote`.
 *
 * ── Why there is a local fallback at all ──────────────────────────────────────────────
 * `refs/remotes/<remote>/HEAD` only exists if it was ever written — a `git clone` writes it,
 * but a repo created locally with `git init` and later given a remote has no such ref, and
 * neither does one where the ref has been pruned. In that case the honest reading is "whichever
 * of the conventional names actually exists as a local branch", checked in that order and
 * verified rather than assumed. If neither exists the answer is null and the chip simply says
 * less; it never invents a default the user does not have.
 */
export function readDefaultBranch(cwd: string): string | null {
  const remotes = (gitLine(cwd, ['remote']) ?? '').split('\n').map((r) => r.trim()).filter(Boolean);
  for (const remote of remotes) {
    const head = gitLine(cwd, ['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`]);
    // `<remote>/<branch>` → `<branch>`. Sliced by the known prefix rather than split on `/`,
    // because a branch name may itself contain slashes (`release/2026-08`).
    if (head && head.startsWith(`${remote}/`)) {
      const branch = head.slice(remote.length + 1);
      if (branch) return branch;
    }
  }
  for (const name of ['main', 'master']) {
    if (gitLine(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])) return name;
  }
  return null;
}

/** Memo for {@link gitCommonDir}. Bounded, because unlike `cache` above it is keyed by any
 *  directory a chat frame names rather than by the handful of project roots this server
 *  serves. Oldest-first eviction; a dropped entry just costs one fork to recompute. */
const commonDirCache = new Map<string, { value: string | null; at: number }>();
const MAX_COMMON_DIR_CACHE = 128;
/** How long {@link gitCommonDir}'s answer is reused. Longer than the shelf's 15 s poll on
 *  purpose (task: the desktop app stays light on an 8GB MacBook Air): the answer names a
 *  REPOSITORY, which no branch switch changes, and a 12 s memo under a 15 s poll missed every
 *  time — one sync fork per pane per poll. */
export const COMMON_DIR_TTL_MS = 60_000;

/**
 * The SHARED git directory for `cwd`, canonicalised — `null` when `cwd` is not a work tree.
 *
 * Every worktree of one repository answers the same path here, and two different repositories
 * never do. That makes this the identity of a REPOSITORY rather than of a checkout, which is
 * exactly the gate `session-cwd.ts` needs before it will point the shelf at a directory a
 * chat frame named: same common dir ⇒ a sibling checkout of the project already open; anything
 * else ⇒ refused.
 *
 * Both normalisations from {@link readWorktree}'s note apply and are the reason this is one
 * function rather than two call sites: `resolve(cwd, …)` because the main checkout answers a
 * RELATIVE `.git`, and `canonical` because git realpaths `--absolute-git-dir` but not this.
 *
 * ── Why this one is memoized and `readWorktree` is not ────────────────────────────────
 * `readWorktree` is reached once per `readSessionFacts`, which has its own TTL in front of it.
 * This is reached TWICE per same-repository check, and `session-cwd.ts` runs one of those on
 * every read of a session's checkout — i.e. on every shelf poll of every pane. Unmemoized
 * that is four `git` forks per pane per poll to answer a question whose answer, for a given
 * directory, does not change while the directory exists. The case where it DOES change —
 * the worktree was removed — is caught by the caller's `statSync`, which costs no fork at all.
 */
export function gitCommonDir(cwd: string, now: number = Date.now()): string | null {
  const hit = commonDirCache.get(cwd);
  if (hit && now - hit.at < COMMON_DIR_TTL_MS) return hit.value;
  // An EXPIRED answer is served as-is and re-read off the event loop: the answer names a
  // repository, which does not change while the directory exists (a removed worktree is the
  // caller's `statSync`), so only the very first read of a directory forks synchronously. Before
  // this every shelf poll past the TTL stalled the server on one `git rev-parse` per pane.
  if (hit) {
    refreshCommonDir(cwd, now);
    return hit.value;
  }

  const raw = gitLine(cwd, ['rev-parse', '--git-common-dir']);
  storeCommonDir(cwd, raw ? canonical(resolve(cwd, raw)) : null, now);
  return commonDirCache.get(cwd)?.value ?? null;
}

const commonDirRefreshing = new Set<string>();

function refreshCommonDir(cwd: string, now: number): void {
  if (commonDirRefreshing.has(cwd)) return;
  commonDirRefreshing.add(cwd);
  const gen = asyncGeneration;
  void gitLineAsync(cwd, ['rev-parse', '--git-common-dir'])
    .then((raw) => {
      // A reset while this ran (tests, `forgetSessionFacts`) wins over a read that predates it.
      if (gen === asyncGeneration) storeCommonDir(cwd, raw ? canonical(resolve(cwd, raw)) : null, now);
    })
    .finally(() => { commonDirRefreshing.delete(cwd); });
}

function storeCommonDir(cwd: string, value: string | null, now: number): void {
  commonDirCache.delete(cwd);
  commonDirCache.set(cwd, { value, at: now });
  while (commonDirCache.size > MAX_COMMON_DIR_CACHE) {
    const oldest = commonDirCache.keys().next();
    if (oldest.done) break;
    commonDirCache.delete(oldest.value);
  }
}

/**
 * Drop the memoized facts for ONE directory.
 *
 * Called after something in this process CHANGES that directory's git state — today that is
 * `session-start-branch.ts` moving the main checkout to the default branch. Without it the
 * shelf would keep answering the pre-switch branch for the rest of the TTL, which is the same
 * "reports the checkout it left" defect this whole surface exists to end, just from the other
 * direction. Not a test seam: production code calls this.
 */
export function forgetSessionFacts(dir: string): void {
  // A prefix sweep rather than one delete, because the key is `<dir> NUL <gateRoot>` and one
  // directory can be cached under several gates — the vault's own root is read both as the
  // session's checkout and as the gate for a session that moved into a linked repo.
  for (const key of cache.keys()) {
    if (key === dir || key.startsWith(`${dir}\0`)) cache.delete(key);
  }
  // The async reader too — and a read of `dir` already in flight was started before the
  // change, so it is neither stored nor shared (the generation check in readSessionFactsAsync).
  asyncCache.delete(dir);
  asyncInflight.delete(dir);
  asyncGeneration += 1;
}

/** TEST SEAM, shared with `session-cwd.ts`'s own reset: the memos in this module are
 *  process-global by design, so a test that creates and destroys real worktrees inside one
 *  TTL window needs a way to ask for a clean read. Production code never calls this. */
export function resetSessionFactsCaches(): void {
  cache.clear();
  commonDirCache.clear();
  asyncCache.clear();
  asyncInflight.clear();
  asyncGeneration += 1;
  asyncGitRuns = 0;
}

// ─── The polled reader: async, and keyed on the checkout's HEAD ─────────────────────────
//
// The shelf polls `/api/agent/session-facts` every 15 s per pane, and the sync reader above
// (12 s memo — it always missed) forked git five or six times per poll on the server's event
// loop. The polled route uses this reader instead (task: the desktop app stays light on an
// 8GB MacBook Air): git runs through async `execFile`, and a reading stays valid while the
// checkout's own HEAD file and the repository's `worktrees/` directory are unchanged — a
// branch switch rewrites HEAD, a `git worktree add/remove` rewrites `worktrees/` — up to
// {@link SESSION_FACTS_ASYNC_MAX_AGE_MS}. Both paths are made ABSOLUTE once (`--absolute-git-dir`
// + `/HEAD`: right in a main checkout and in a linked worktree, on every git version), and
// their stats are taken BEFORE git reads the branch, so a switch racing the read is seen on
// the next poll. A path that is missing is stored as such: missing → missing is unchanged, so
// a repo with no linked worktree still hits. `session-start-branch.ts` and the chat frame
// handler keep the sync {@link readSessionFacts}.

/** The longest a HEAD-keyed reading is reused (the default branch, read from the remote's
 *  HEAD ref, is not watched — this bounds how stale it can be). */
export const SESSION_FACTS_ASYNC_MAX_AGE_MS = 60_000;

/** Everything but `worktreeAllowed` and `elsewhere`, which are never cached. */
type GitFacts = Omit<SessionFacts, 'worktreeAllowed' | 'elsewhere'>;

interface AsyncEntry {
  /** null: not a repository (valid by age alone). */
  facts: GitFacts | null;
  at: number;
  headPath: string | null;
  headSig: string | null;
  worktreesPath: string | null;
  worktreesSig: string | null;
}

const asyncCache = new Map<string, AsyncEntry>();
const asyncInflight = new Map<string, Promise<AsyncEntry>>();
let asyncGeneration = 0;
let asyncGitRuns = 0;
const MAX_ASYNC_CACHE = 64;

/** Test counter: how many git processes the async reader has started. */
export function sessionFactsGitRuns(): number {
  return asyncGitRuns;
}

function gitLineAsync(cwd: string, args: string[]): Promise<string | null> {
  asyncGitRuns += 1;
  return new Promise((resolveLine) => {
    execFile('git', args, { cwd, encoding: 'utf-8', timeout: 5_000 }, (err, stdout) => {
      if (err) { resolveLine(null); return; }
      const line = String(stdout).trim();
      resolveLine(line || null);
    });
  });
}

/** `mtime:size:ino` of a path, or null when it is missing. */
async function pathSig(path: string | null): Promise<string | null> {
  if (!path) return null;
  try {
    const st = await stat(path);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch { return null; }
}

/** {@link readDefaultBranch}, asynchronously — same rules, same order. */
async function readDefaultBranchAsync(cwd: string): Promise<string | null> {
  const remotes = ((await gitLineAsync(cwd, ['remote'])) ?? '').split('\n').map((r) => r.trim()).filter(Boolean);
  for (const remote of remotes) {
    const head = await gitLineAsync(cwd, ['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`]);
    if (head && head.startsWith(`${remote}/`)) {
      const branch = head.slice(remote.length + 1);
      if (branch) return branch;
    }
  }
  for (const name of ['main', 'master']) {
    if (await gitLineAsync(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])) return name;
  }
  return null;
}

async function computeAsync(dir: string, now: number): Promise<AsyncEntry> {
  // One rev-parse answers all three: inside a work tree? this tree's git dir? the shared one?
  const out = await gitLineAsync(dir, ['rev-parse', '--is-inside-work-tree', '--absolute-git-dir', '--git-common-dir']);
  const [inside, ownRaw, commonRaw] = (out ?? '').split('\n').map((l) => l.trim());
  if (inside !== 'true' || !ownRaw || !commonRaw) {
    return { facts: null, at: now, headPath: null, headSig: null, worktreesPath: null, worktreesSig: null };
  }
  const commonDir = canonical(resolve(dir, commonRaw));
  const headPath = join(ownRaw, 'HEAD');
  const worktreesPath = join(commonDir, 'worktrees');
  // Stats BEFORE the branch read: a switch landing during it leaves a newer HEAD behind.
  const [headSig, worktreesSig] = await Promise.all([pathSig(headPath), pathSig(worktreesPath)]);
  const symbolic = await gitLineAsync(dir, ['symbolic-ref', '--short', 'HEAD']);
  const branch = symbolic && symbolic !== 'HEAD' ? symbolic : null;
  const defaultBranch = await readDefaultBranchAsync(dir);
  const worktree = commonDir !== canonical(ownRaw);
  return {
    facts: {
      branch,
      defaultBranch,
      worktree,
      mainRoot: worktree ? dirname(commonDir) : null,
      worktreeName: worktree ? basename(dir) || null : null,
      isRepo: true,
    },
    at: now,
    headPath,
    headSig,
    worktreesPath,
    worktreesSig,
  };
}

async function stillValid(e: AsyncEntry, now: number): Promise<boolean> {
  if (now - e.at >= SESSION_FACTS_ASYNC_MAX_AGE_MS) return false;
  if (!e.facts) return true;
  const [head, wt] = await Promise.all([pathSig(e.headPath), pathSig(e.worktreesPath)]);
  return head === e.headSig && wt === e.worktreesSig;
}

function toSessionFacts(e: AsyncEntry, gateRoot: string): SessionFacts {
  if (!e.facts) return UNKNOWN_SESSION_FACTS;
  const f = e.facts;
  // Same key order as the sync reader, so the route's JSON is unchanged.
  return {
    branch: f.branch,
    defaultBranch: f.defaultBranch,
    worktree: f.worktree,
    mainRoot: f.mainRoot,
    worktreeName: f.worktreeName,
    // Read fresh every call, outside the cache: it is the VAULT's `.config.json`, not git.
    worktreeAllowed: worktreeIsolationAllowed(gateRoot),
    isRepo: true,
    elsewhere: null,
  };
}

/**
 * {@link readSessionFacts} for the POLLED route — never blocks the event loop on git, and
 * re-reads git only when the checkout's HEAD or the repository's worktree list moved (or the
 * reading is {@link SESSION_FACTS_ASYNC_MAX_AGE_MS} old). Concurrent callers for one directory
 * share one read. Never throws. `now` is a TEST SEAM.
 */
export async function readSessionFactsAsync(
  dir: string,
  now: number = Date.now(),
  gateRoot: string = dir,
): Promise<SessionFacts> {
  const hit = asyncCache.get(dir);
  if (hit && await stillValid(hit, now)) return toSessionFacts(hit, gateRoot);

  let running = asyncInflight.get(dir);
  if (!running) {
    const gen = asyncGeneration;
    const p: Promise<AsyncEntry> = computeAsync(dir, now)
      .catch(() => ({ facts: null, at: now, headPath: null, headSig: null, worktreesPath: null, worktreesSig: null }))
      .then((entry) => {
        // A `forgetSessionFacts` while this ran: the read may describe the state it left.
        if (gen === asyncGeneration) {
          asyncCache.delete(dir);
          asyncCache.set(dir, entry);
          while (asyncCache.size > MAX_ASYNC_CACHE) {
            const oldest = asyncCache.keys().next();
            if (oldest.done) break;
            asyncCache.delete(oldest.value);
          }
        }
        return entry;
      })
      .finally(() => { if (asyncInflight.get(dir) === p) asyncInflight.delete(dir); });
    asyncInflight.set(dir, p);
    running = p;
  }
  try { return toSessionFacts(await running, gateRoot); } catch { return UNKNOWN_SESSION_FACTS; }
}

/**
 * The session facts for `dir`, memoized for {@link SESSION_FACTS_TTL_MS}.
 *
 * ── Why `gateRoot` is separate from `dir` ─────────────────────────────────────────────
 * Every field here but one describes the CHECKOUT the session is in, and is read from git
 * there. `worktreeAllowed` is not that kind of fact: it is a property of the VAULT — may an
 * agent working for this brain open a worktree at all (worktree-gate.ts, answered from the
 * brain's own `.config.json` and its linked repos). Asked at the checkout instead, it inverts
 * exactly where it matters: a session working in a linked code repo has no `.config.json`
 * under it, so the gate that says "yes, this brain is split, worktrees are safe" would answer
 * "no" from inside the very worktree it permitted. `gateRoot` defaults to `dir`, so a caller
 * that reads facts for the vault's own root — `session-start-branch.ts` — is unchanged.
 *
 * `now` is a TEST SEAM ONLY — it exists so the TTL boundary itself can be exercised without
 * a sleep. Production callers pass nothing.
 */
export function readSessionFacts(
  dir: string,
  now: number = Date.now(),
  gateRoot: string = dir,
): SessionFacts {
  const key = gateRoot === dir ? dir : `${dir}\0${gateRoot}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < SESSION_FACTS_TTL_MS) return hit.facts;

  const facts = computeSessionFacts(dir, gateRoot);
  cache.set(key, { facts, at: now });
  return facts;
}

function computeSessionFacts(dir: string, gateRoot: string): SessionFacts {
  if (!isGitRepo(dir)) return UNKNOWN_SESSION_FACTS;
  const { worktree, mainRoot } = readWorktree(dir);
  return {
    branch: currentBranch(dir),
    defaultBranch: readDefaultBranch(dir),
    worktree,
    mainRoot,
    worktreeName: worktree ? basename(dir) || null : null,
    worktreeAllowed: worktreeIsolationAllowed(gateRoot),
    isRepo: true,
    // Filled by the route, which knows the session. Null here so the memoized git reading
    // can never freeze a count that moves during a turn.
    elsewhere: null,
  };
}
