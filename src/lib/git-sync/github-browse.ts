import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { ensureParentDir, ParentDirError } from '../project-parent.js';
import { ApiAdapter, ApiError } from '../task-backend/api-adapter.js';
import { githubApiAdapter } from './token-fallback.js';
import { resolveGitHubCredential, type GitHubCredential } from './auth-store.js';
import { canonicalRemote, parseRepoSlug, sanitizeRepoName } from './origin-setup.js';
import { withGitCredentials } from './credentials.js';
import * as git from './git.js';
import { GitSyncError } from './git.js';

/**
 * GitHub repo browsing + clone-to-local for the LAUNCHER "Clone from GitHub"
 * onboarding path. Vault-agnostic by design: the launcher has no project yet,
 * so token resolution is GLOBAL (the account the user signed into the app as)
 * → env — never per-project. The clone itself reuses the hardened primitives
 * every other networked git call uses: `canonicalRemote` (the raw string never
 * reaches git), `withGitCredentials` (askpass, token never in env/argv/URL),
 * and the transport-hardened `git.clone` argv.
 */

// ─── Token resolution (launcher tier: global → env) ──────────────────────────

/**
 * The launcher's credential: C1 for purpose `browse` with no project (there IS no project
 * yet), so the app's sign-in → env.
 */
export function resolveLauncherGitHubToken(home?: string): GitHubCredential | null {
  return resolveGitHubCredential({ purpose: 'browse', home });
}

// ─── List / search the signed-in user's repos ────────────────────────────────

export interface GitHubRepoSummary {
  /** `owner/repo` — the canonical display + clone key. */
  fullName: string;
  private: boolean;
  description: string | null;
  defaultBranch?: string;
  /** ISO timestamp of the last push — the list is sorted by this, newest first. */
  pushedAt?: string;
  /** GitHub's `size` (KB): the free-space check and the "about 2.3 GB" line. */
  sizeKb?: number;
  /**
   * A registered project on this Mac has this repo as its `origin` (no second copy): its project
   * name and folder, so Open lands on THAT project and the line says where it really is.
   */
  onThisMac?: OnThisMac;
}

/** The registered project that already holds a repo. */
export interface OnThisMac { vault: string; path: string }

/** Raw GitHub repo shape (only the fields we read). */
interface GitHubApiRepo {
  full_name: string;
  private: boolean;
  description: string | null;
  default_branch?: string;
  pushed_at?: string;
  size?: number;
}

/** The comparison key of a GitHub remote: `owner/repo`, lower case. Null for anything else. */
export function originKey(url: string | null | undefined): string | null {
  if (!url) return null;
  const slug = parseRepoSlug(url);
  return slug ? `${slug.owner}/${slug.repo}`.toLowerCase() : null;
}

/**
 * The `origin` URL in a folder's `.git/config`, read as a file: never spawns git (on a Mac
 * without the developer tools a `git` call opens Apple's install window). Null when absent.
 */
export function readOriginUrlFromConfig(projectPath: string): string | null {
  try {
    const gitDir = join(projectPath, '.git');
    if (!lstatSync(gitDir).isDirectory()) return null;
    const text = readFileSync(join(gitDir, 'config'), 'utf-8');
    let inOrigin = false;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('[')) { inOrigin = /^\[remote\s+"origin"\]$/.test(line); continue; }
      if (!inOrigin) continue;
      const m = /^url\s*=\s*(.+)$/.exec(line);
      if (m) return m[1].trim();
    }
  } catch { /* none */ }
  return null;
}

/** The registered projects' origins, as keys: read once per list request. */
export function registeredOriginKeys(vaults: ReadonlyArray<{ name: string; path: string }>): Map<string, OnThisMac> {
  const out = new Map<string, OnThisMac>();
  for (const v of vaults) {
    const key = originKey(readOriginUrlFromConfig(v.path));
    if (key && !out.has(key)) out.set(key, { vault: v.name, path: v.path });
  }
  return out;
}

function toSummary(r: GitHubApiRepo, onMac?: ReadonlyMap<string, OnThisMac>): GitHubRepoSummary {
  const key = originKey(r.full_name);
  return {
    fullName: r.full_name,
    private: r.private,
    description: r.description ?? null,
    defaultBranch: r.default_branch,
    pushedAt: r.pushed_at,
    ...(typeof r.size === 'number' && Number.isFinite(r.size) && r.size >= 0 ? { sizeKb: r.size } : {}),
    ...(onMac && key && onMac.has(key) ? { onThisMac: { ...onMac.get(key)! } } : {}),
  };
}

function defaultAdapter(token: string): ApiAdapter {
  return githubApiAdapter({ authHeaders: () => ({ Authorization: `token ${token}` }) });
}

/** Deterministic bounds: 3 pages × 100 = the newest 300 repos the user can push to. */
const REPOS_PER_PAGE = 100;
const REPOS_MAX_PAGES = 3;
/** Result-set ceiling — the picker is a search box, not an infinite scroller. */
const REPOS_MAX_RESULTS = 50;

export interface ListGitHubReposOptions {
  token: string;
  /** Substring filter on `owner/repo` (case-insensitive). `owner/repo` forms also try a direct lookup. */
  query?: string;
  /** Injectable adapter — tests inject a fake `fetchImpl`. */
  adapter?: ApiAdapter;
  /** `owner/repo` keys of the registered projects' origins ({@link registeredOriginKeys}). */
  onThisMac?: ReadonlyMap<string, OnThisMac>;
}

/**
 * The signed-in user's repos, newest-push first, optionally filtered by a
 * substring query. Deliberately NOT the GitHub search API: `/user/repos` with
 * `affiliation=owner,collaborator,organization_member` is the only endpoint
 * that reliably covers private org/collaborator repos, and a local substring
 * filter over ≤300 repos is deterministic (no search-index lag, no separate
 * rate bucket). A `owner/repo`-shaped query ADDITIONALLY tries a direct
 * `GET /repos/:owner/:repo` so any reachable repo (e.g. a public repo the user
 * doesn't own) can be found by exact name; its 404 is swallowed.
 */
export async function listGitHubRepos(opts: ListGitHubReposOptions): Promise<GitHubRepoSummary[]> {
  const api = opts.adapter ?? defaultAdapter(opts.token);
  const q = (opts.query ?? '').trim().toLowerCase();

  const all: GitHubApiRepo[] = [];
  for (let page = 1; page <= REPOS_MAX_PAGES; page++) {
    const batch = await api.request<GitHubApiRepo[]>('GET', '/user/repos', {
      query: {
        sort: 'pushed',
        per_page: REPOS_PER_PAGE,
        page,
        affiliation: 'owner,collaborator,organization_member',
      },
    });
    all.push(...(batch ?? []));
    if (!batch || batch.length < REPOS_PER_PAGE) break;
  }

  let results = q ? all.filter((r) => r.full_name.toLowerCase().includes(q)) : all;

  // Exact `owner/repo` query not in the affiliation list (someone else's public
  // repo, an org outside the affiliation set) → direct lookup, prepended.
  if (q.includes('/')) {
    const slug = parseRepoSlug(q);
    const already = slug && results.some(
      (r) => r.full_name.toLowerCase() === `${slug.owner}/${slug.repo}`.toLowerCase(),
    );
    if (slug && !already) {
      try {
        const direct = await api.request<GitHubApiRepo>('GET', `/repos/${slug.owner}/${slug.repo}`);
        if (direct) results = [direct, ...results];
      } catch (err) {
        if (!(err instanceof ApiError && err.kind === 'not_found')) throw err;
      }
    }
  }

  return results.slice(0, REPOS_MAX_RESULTS).map((r) => toSummary(r, opts.onThisMac));
}

// ─── Clone to a local folder ──────────────────────────────────────────────────

/** The fully-validated shape of a clone-to-local: safe URL + safe destination. */
export interface ClonePlan {
  /** The ONLY URL shape that ever reaches git — canonical https. */
  cloneUrl: string;
  /** `owner/repo` as GitHub spells it (the size lookup and the "on this Mac" key). */
  slug: { owner: string; repo: string };
  /** Absolute destination the clone lands at (`parent/<repo>`, or `-2`, `-3`… when taken). Does not exist yet. */
  dest: string;
  /** The folder basename — the natural vault name. */
  name: string;
}

/** One GitHub name part: letters, digits, `.`, `_`, `-`; never leading `-` or `.`, never `..`. */
const SLUG_PART_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;

/**
 * S2: the request's `repo` (an `owner/name` from the listed set, or a pasted github.com URL)
 * to `owner/name`, each part checked so no value can reach an option position or a path.
 */
export function parseCloneRepo(raw: string): { owner: string; repo: string } | null {
  const slug = parseRepoSlug((raw ?? '').trim());
  if (!slug) return null;
  const { owner, repo } = slug;
  for (const part of [owner, repo]) {
    if (!SLUG_PART_RE.test(part) || part.includes('..')) return null;
    if (sanitizeRepoName(part) !== part) return null;
  }
  return { owner, repo };
}

/**
 * Validate a clone request WITHOUT touching git or the network: every gate a clone needs,
 * exported so the route can 400 synchronously before it spawns a background job.
 *  1. `repo` parsed to owner/name ({@link parseCloneRepo}); only the canonical https URL reaches git;
 *  2. `parent` absolute, created when missing inside home (C9, never through a symlink);
 *  3. folder name = the repo name, `<name>-2`, `<name>-3`… when taken (never into an existing
 *     folder); the resolved dest must be the parent's DIRECT child.
 */
export function planGitHubClone(repoRaw: string, parentDir: string, home?: string): ClonePlan {
  const slug = parseCloneRepo(repoRaw);
  if (!slug) {
    throw new GitSyncError(
      'That does not look like a GitHub repo (expected https://github.com/owner/repo or owner/repo).',
    );
  }
  const cloneUrl = canonicalRemote(`${slug.owner}/${slug.repo}`)!;

  const parentRaw = (parentDir ?? '').trim();
  if (!parentRaw || !isAbsolute(parentRaw)) {
    throw new GitSyncError('parentDir must be an absolute path.');
  }
  let parent: string;
  try {
    parent = ensureParentDir(resolve(parentRaw), home ?? homedir());
  } catch (err) {
    if (err instanceof ParentDirError) throw new GitSyncError(err.message);
    throw err;
  }

  const base = sanitizeRepoName(slug.repo);
  if (!base) throw new GitSyncError('Could not derive a safe folder name from that repo.');

  for (let n = 1; n <= 99; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    const dest = resolve(parent, name);
    if (dest !== join(parent, name) || !dest.startsWith(parent + sep)) {
      throw new GitSyncError('Resolved clone path escapes the parent directory.');
    }
    let taken = true;
    try { lstatSync(dest); } catch { taken = false; }
    if (!taken) return { cloneUrl, slug, dest, name };
  }
  throw new GitSyncError(`Every folder name for ${base} is taken in ${parent}. Pick another location.`);
}

// ─── Clone progress (C10) ─────────────────────────────────────────────────────

export type ClonePhase = 'waiting-git' | 'receiving' | 'resolving' | 'checkout' | 'done';
export interface CloneProgress {
  phase: ClonePhase;
  /** 0-100, only from git's own line; absent until git printed one. */
  percent?: number;
  /** Bytes received so far, from "Receiving objects: … 61.00 MiB". */
  receivedBytes?: number;
}

const UNIT: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, bytes: 1 };

/**
 * Pure: fold one chunk of `git clone --progress` output into the last value. Only git's own
 * lines move it ("Receiving objects", "Resolving deltas", "Updating files"); any other line
 * leaves the last value (never a made-up number).
 */
export function foldCloneProgress(prev: CloneProgress, chunk: string): CloneProgress {
  let cur = prev;
  for (const line of chunk.split(/[\r\n]+/)) {
    const recv = /Receiving objects:\s+(\d{1,3})%(?:.*?,\s*([\d.]+)\s*(B|bytes|KiB|MiB|GiB))?/.exec(line);
    if (recv) {
      const pct = Math.min(100, Number(recv[1]));
      const bytes = recv[2] ? Math.round(Number(recv[2]) * (UNIT[recv[3]] ?? 1)) : cur.receivedBytes;
      cur = { phase: 'receiving', percent: pct, ...(bytes !== undefined ? { receivedBytes: bytes } : {}) };
      continue;
    }
    const res = /Resolving deltas:\s+(\d{1,3})%/.exec(line);
    if (res) {
      cur = { phase: 'resolving', percent: Math.min(100, Number(res[1])), ...(cur.receivedBytes !== undefined ? { receivedBytes: cur.receivedBytes } : {}) };
      continue;
    }
    const co = /Updating files:\s+(\d{1,3})%/.exec(line);
    if (co) {
      cur = { phase: 'checkout', percent: Math.min(100, Number(co[1])), ...(cur.receivedBytes !== undefined ? { receivedBytes: cur.receivedBytes } : {}) };
    }
  }
  return cur;
}

// ─── Failure reasons and the space check (C10) ────────────────────────────────

export type CloneFailReason = 'network' | 'timeout' | 'cancelled' | 'no-space' | 'auth' | 'git-missing' | 'unknown';

const NETWORK_RE = /could not resolve host|unable to access|connection (?:timed out|reset|refused)|early eof|the remote end hung up|network is unreachable|RPC failed|transfer closed/i;
const AUTH_RE = /authentication failed|could not read username|permission denied|repository not found|403/i;
const SPACE_RE = /no space left on device/i;

/** Pure: name why a clone failed, from how it ended and git's stderr. */
export function cloneFailReason(end: 'timeout' | 'cancelled' | 'failed' | undefined, stderr: string): CloneFailReason {
  if (end === 'timeout') return 'timeout';
  if (end === 'cancelled') return 'cancelled';
  if (SPACE_RE.test(stderr)) return 'no-space';
  if (AUTH_RE.test(stderr)) return 'auth';
  if (NETWORK_RE.test(stderr)) return 'network';
  return 'unknown';
}

/** Free bytes on the volume that holds `path` (its nearest existing folder). Null when unknown. */
export async function freeBytesAt(path: string): Promise<number | null> {
  let p = path;
  for (let i = 0; i < 64; i++) {
    if (existsSync(p)) break;
    const up = dirname(p);
    if (up === p) break;
    p = up;
  }
  try {
    const st = await statfs(p);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

/** Pure: the space a clone of `sizeKb` needs (twice GitHub's size: the pack plus the files). */
export function cloneNeedsBytes(sizeKb: number): number {
  return sizeKb * 1024 * 2;
}

/** 1 GB by GitHub's size: above it the UI offers "Get the latest version only". */
export const BIG_REPO_KB = 1024 * 1024;

export interface CloneGitHubRepoOptions {
  /** A planned clone ({@link planGitHubClone}): the only URL and folder git sees. */
  plan: ClonePlan;
  token: string;
  /** Live git progress chunks (stderr: "Receiving objects: 42%…") for a UI. */
  onProgress?: (chunk: string) => void;
  /** Receives an abort handle once the clone child is running. */
  registerCancel?: (cancel: () => void) => void;
  /** `--depth 1 --single-branch`. */
  shallow?: boolean;
  /** Injectable git module — tests avoid any real network clone. */
  gitModule?: Pick<typeof git, 'cloneStreaming'>;
}

export interface CloneGitHubRepoResult {
  /** Absolute path of the fresh clone. */
  path: string;
  /** The folder basename (= sanitized repo name) — the natural vault name. */
  name: string;
  /** True when the clone already contains `_dream_context/` (a ready project). */
  hasContext: boolean;
}

/**
 * Clone a GitHub repo under `parentDir`. Every gate fires BEFORE any git call
 * ({@link planGitHubClone}); the clone itself runs under `withGitCredentials`
 * (askpass; token never in env/argv/URL), streams progress, and is cancelable
 * via `registerCancel`.
 */
export async function cloneGitHubRepo(opts: CloneGitHubRepoOptions): Promise<CloneGitHubRepoResult> {
  const gitModule = opts.gitModule ?? git;
  const plan = opts.plan;

  await withGitCredentials(opts.token, (env) => {
    const handle = gitModule.cloneStreaming(plan.cloneUrl, plan.dest, env, opts.onProgress, { shallow: opts.shallow === true });
    opts.registerCancel?.(handle.cancel);
    return handle.promise;
  });

  return {
    path: plan.dest,
    name: plan.name,
    hasContext: existsSync(join(plan.dest, '_dream_context')),
  };
}
