import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { ApiAdapter, ApiError } from '../task-backend/api-adapter.js';
import { readGlobalGitHubToken } from './auth-store.js';
import type { ResolvedToken } from '../task-backend/secrets.js';
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
 * The launcher counterpart of `resolveBrainSyncToken`: identical tiering minus
 * the per-project store (there IS no project yet). Global secrets first so a
 * stray `GITHUB_TOKEN` in an inherited shell never overrides the account the
 * user actually signed in as.
 */
export function resolveLauncherGitHubToken(home?: string): ResolvedToken | null {
  const global = readGlobalGitHubToken(home);
  if (global) return global;
  for (const envVar of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    const v = process.env[envVar];
    if (v && v.trim()) return { token: v.trim(), source: 'env', via: envVar };
  }
  return null;
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
}

/** Raw GitHub repo shape (only the fields we read). */
interface GitHubApiRepo {
  full_name: string;
  private: boolean;
  description: string | null;
  default_branch?: string;
  pushed_at?: string;
}

function toSummary(r: GitHubApiRepo): GitHubRepoSummary {
  return {
    fullName: r.full_name,
    private: r.private,
    description: r.description ?? null,
    defaultBranch: r.default_branch,
    pushedAt: r.pushed_at,
  };
}

function defaultAdapter(token: string): ApiAdapter {
  return new ApiAdapter({
    baseUrl: 'https://api.github.com',
    authHeaders: () => ({ Authorization: `token ${token}` }),
  });
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

  return results.slice(0, REPOS_MAX_RESULTS).map(toSummary);
}

// ─── Clone to a local folder ──────────────────────────────────────────────────

/** The fully-validated shape of a clone-to-local: safe URL + safe destination. */
export interface ClonePlan {
  /** The ONLY URL shape that ever reaches git — canonical https. */
  cloneUrl: string;
  /** Absolute destination the clone lands at (`parent/<repo>`). Does not exist yet. */
  dest: string;
  /** The folder basename (= sanitized repo name) — the natural vault name. */
  name: string;
}

/**
 * Validate a clone request WITHOUT touching git or the network — every gate a
 * clone needs, exported separately so the route can 400 synchronously before
 * it spawns a background job (mirrors `cloneLinkedRepo`'s gates 1–6):
 *  1. `canonicalRemote(url)` — the raw string never reaches git (S1);
 *  2. `parentDir` must be an absolute, existing directory;
 *  3. folder name = sanitized repo name; the resolved dest must be its DIRECT
 *     child (no traversal) and must not already exist.
 */
export function planGitHubClone(url: string, parentDir: string): ClonePlan {
  const cloneUrl = canonicalRemote(url);
  if (!cloneUrl) {
    throw new GitSyncError(
      'That does not look like a GitHub repo URL (expected https://github.com/owner/repo or owner/repo).',
    );
  }

  const parentRaw = (parentDir ?? '').trim();
  if (!parentRaw || !isAbsolute(parentRaw)) {
    throw new GitSyncError('parentDir must be an absolute path.');
  }
  const parent = resolve(parentRaw);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw new GitSyncError(`Parent directory does not exist: ${parent}`);
  }

  const slug = parseRepoSlug(cloneUrl)!; // canonicalRemote already proved it parses
  const base = sanitizeRepoName(slug.repo);
  if (!base) throw new GitSyncError('Could not derive a safe folder name from that repo.');

  const dest = resolve(parent, base);
  if (dest !== join(parent, base) || !dest.startsWith(parent + sep)) {
    throw new GitSyncError('Resolved clone path escapes the parent directory.');
  }
  if (existsSync(dest)) {
    throw new GitSyncError(`A folder already exists at ${dest}. Move it or pick another location.`);
  }

  return { cloneUrl, dest, name: base };
}

export interface CloneGitHubRepoOptions {
  /** Any accepted GitHub form (https / ssh / `owner/repo`) — canonicalized before git sees it. */
  url: string;
  /** Absolute, existing parent directory the clone lands under. */
  parentDir: string;
  token: string;
  /** Live git progress chunks (stderr: "Receiving objects: 42%…") for a UI. */
  onProgress?: (chunk: string) => void;
  /** Receives an abort handle once the clone child is running. */
  registerCancel?: (cancel: () => void) => void;
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
  const plan = planGitHubClone(opts.url, opts.parentDir);

  await withGitCredentials(opts.token, (env) => {
    const handle = gitModule.cloneStreaming(plan.cloneUrl, plan.dest, env, opts.onProgress);
    opts.registerCancel?.(handle.cancel);
    return handle.promise;
  });

  return {
    path: plan.dest,
    name: plan.name,
    hasContext: existsSync(join(plan.dest, '_dream_context')),
  };
}
