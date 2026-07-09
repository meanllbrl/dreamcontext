import { ApiAdapter, ApiError } from '../task-backend/api-adapter.js';
import { resolveBrainSyncToken } from './brain-repo.js';
import * as git from './git.js';
import { GitSyncError } from './git.js';

/**
 * Origin setup for `full-repo` cloud sync — the "this project has no GitHub
 * `origin` yet" on-ramp. Whole-project sync pushes to the project's OWN `origin`,
 * so before it can be enabled the project needs one. These helpers let the
 * dashboard either CREATE a fresh GitHub repo and wire it as `origin`, or ATTACH
 * an existing repo URL as `origin` — replacing the old dead-end where the only
 * fix was to run `git remote add origin …` by hand.
 *
 * This is NOT the removed `separate`-mode brain repo (commit b45abd4): there is
 * no dedicated brain repo, no `dreamcontext-brain` discovery topic, and no marker
 * file. The target is simply the project's `origin`, rooted at the PROJECT root
 * (never a nested `_dream_context/`).
 */

/** GitHub repo name charset — letters, digits, `-`, `_`, `.` (GitHub's own rule). */
const REPO_NAME_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * Sanitize an arbitrary folder name into a GitHub-legal repo name: keep only
 * `[A-Za-z0-9_.-]`, collapse the rest to `-`, trim leading/trailing separators.
 * Returns null if nothing usable survives (caller then requires an explicit name).
 */
export function sanitizeRepoName(raw: string): string | null {
  const cleaned = raw.trim().replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '');
  return cleaned.length > 0 ? cleaned : null;
}

/** Parse `owner/repo` out of an https / ssh / `owner/repo` GitHub URL. */
export function parseRepoSlug(url: string): { owner: string; repo: string } | null {
  const trimmed = url.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const httpsMatch = trimmed.match(/github\.com[/:]([^/]+)\/([^/]+)$/i);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  const shortMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (shortMatch) return { owner: shortMatch[1], repo: shortMatch[2] };
  return null;
}

/** The canonical HTTPS remote for a slug — token push flows over HTTPS via GIT_ASKPASS. */
function remoteForSlug(slug: { owner: string; repo: string }): string {
  return `https://github.com/${slug.owner}/${slug.repo}.git`;
}

/**
 * Collapse any accepted GitHub URL form (ssh, https, `owner/repo`, with/without
 * `.git` or a trailing slash) to ONE canonical HTTPS remote string, so the same
 * repo always maps to the same key regardless of how it was written. Returns null
 * for a non-GitHub / non-repo string. GitHub-only by construction (v1). Used as
 * the globally-unique join key for the linked-repos registry and as the ONLY URL
 * shape that ever reaches `git clone` (S1 — the raw team-writable string never
 * does).
 */
export function canonicalRemote(url: string): string | null {
  const slug = parseRepoSlug(url);
  return slug ? remoteForSlug(slug) : null;
}

function githubAdapter(projectRoot: string, injected?: ApiAdapter): ApiAdapter {
  return injected ?? new ApiAdapter({
    baseUrl: 'https://api.github.com',
    authHeaders: () => {
      const t = resolveBrainSyncToken(projectRoot);
      if (!t) throw new GitSyncError('No GitHub token found (sign in with GitHub, or set GITHUB_TOKEN/GH_TOKEN).');
      return { Authorization: `token ${t.token}` };
    },
  });
}

// ─── Set / wire the project origin ──────────────────────────────────────────

/**
 * Point the project's `origin` at `remoteUrl`, git-initing the project first if
 * it is not yet a repo. Idempotent: replaces an existing `origin` rather than
 * erroring. Operates on the PROJECT root — full-repo mode syncs the whole folder.
 */
export function setProjectOrigin(projectRoot: string, remoteUrl: string, gitModule: typeof git = git): void {
  if (!gitModule.isGitRepo(projectRoot)) gitModule.initRepo(projectRoot);
  if (gitModule.getRemoteUrl(projectRoot, 'origin')) {
    gitModule.setRemoteUrl(projectRoot, 'origin', remoteUrl);
  } else {
    gitModule.addRemote(projectRoot, 'origin', remoteUrl);
  }
}

// ─── Create ──────────────────────────────────────────────────────────────────

export interface CreateOriginOptions {
  projectRoot: string;
  /** Desired repo name. Defaults (via the caller) to the project folder basename. */
  name: string;
  /** PRIVATE by default (S5). A public repo requires `confirmed: true`. */
  private?: boolean;
  /** DEFENSE-IN-DEPTH (S5): a PUBLIC repo requires an explicit confirmation. */
  confirmed?: boolean;
  /** Injectable ApiAdapter — tests inject a fake `fetchImpl`. */
  adapter?: ApiAdapter;
  /** Injectable git module — tests avoid any real git call. */
  gitModule?: typeof git;
}

export interface OriginSetupResult {
  remote: string;
  fullName?: string;
  private?: boolean;
}

/**
 * Create a new GitHub repo under the authenticated user (default PRIVATE — S5)
 * and wire it as the project's `origin`. Does NOT push — the caller enables
 * full-repo sync and runs the first sync (which bootstraps the initial commit).
 */
export async function createProjectOrigin(opts: CreateOriginOptions): Promise<OriginSetupResult> {
  const isPrivate = opts.private ?? true;
  if (!isPrivate && opts.confirmed !== true) {
    throw new GitSyncError('Refusing to create a PUBLIC repo without explicit confirmation (S5).');
  }
  const name = sanitizeRepoName(opts.name);
  if (!name) throw new GitSyncError('A repo name is required.');
  if (!REPO_NAME_RE.test(name)) throw new GitSyncError('That repo name has characters GitHub does not allow.');

  const adapter = githubAdapter(opts.projectRoot, opts.adapter);
  const created = await adapter.request<{ full_name: string; private: boolean }>('POST', '/user/repos', {
    body: { name, private: isPrivate },
  });

  const slug = parseRepoSlug(created.full_name) ?? { owner: created.full_name.split('/')[0], repo: name };
  const remote = remoteForSlug(slug);
  setProjectOrigin(opts.projectRoot, remote, opts.gitModule);
  return { remote, fullName: created.full_name, private: created.private };
}

// ─── Attach preview (READ-ONLY reachability check) ──────────────────────────

export interface OriginPreviewResult {
  /** The repo exists and the token can read it. */
  reachable: boolean;
  fullName?: string;
  private?: boolean;
  defaultBranch?: string;
  /** True when the repo has no default branch yet (a freshly-created empty repo). */
  empty?: boolean;
  /** Why the preview failed, when `reachable` is false. */
  reason?: string;
}

export interface PreviewOriginOptions {
  projectRoot: string;
  url: string;
  adapter?: ApiAdapter;
}

/**
 * GET a candidate repo's metadata so the UI can confirm reachability + name
 * BEFORE attaching. STRICTLY READ-ONLY. Never throws for a normal "not reachable"
 * outcome (bad URL, 404, auth) — returns `{ reachable: false, reason }`.
 */
export async function previewOrigin(opts: PreviewOriginOptions): Promise<OriginPreviewResult> {
  const slug = parseRepoSlug(opts.url);
  if (!slug) {
    return { reachable: false, reason: 'That does not look like a GitHub repo URL (expected https://github.com/owner/repo or owner/repo).' };
  }
  const api = githubAdapter(opts.projectRoot, opts.adapter);
  try {
    const repo = await api.request<{ full_name: string; private: boolean; default_branch?: string }>(
      'GET',
      `/repos/${slug.owner}/${slug.repo}`,
    );
    return {
      reachable: true,
      fullName: repo.full_name,
      private: repo.private,
      defaultBranch: repo.default_branch,
      // GitHub reports a default_branch even for empty repos, so also probe branches.
      empty: !repo.default_branch,
    };
  } catch (err) {
    const message = err instanceof GitSyncError || err instanceof ApiError ? err.message : (err as Error).message;
    return { reachable: false, reason: message };
  }
}

// ─── Attach ──────────────────────────────────────────────────────────────────

export interface AttachOriginOptions {
  projectRoot: string;
  url: string;
  gitModule?: typeof git;
}

/**
 * Wire an existing GitHub repo (given by URL or `owner/repo`) as the project's
 * `origin`. Canonicalizes to the HTTPS remote so token-based push works. Does
 * NOT fetch/merge — the caller enables full-repo sync and runs the first sync.
 */
export function attachProjectOrigin(opts: AttachOriginOptions): OriginSetupResult {
  const slug = parseRepoSlug(opts.url);
  if (!slug) throw new GitSyncError('That does not look like a GitHub repo URL (expected https://github.com/owner/repo or owner/repo).');
  const remote = remoteForSlug(slug);
  setProjectOrigin(opts.projectRoot, remote, opts.gitModule);
  return { remote, fullName: `${slug.owner}/${slug.repo}` };
}

// ─── Detach ────────────────────────────────────────────────────────────────

/**
 * Remove the project's `origin` remote — the inverse of create/attach, backing the
 * connected-origin card's "Disconnect". Idempotent: a no-op when the project is not
 * a repo or has no `origin`. Local-only (never touches the remote GitHub repo) and
 * reversible (the user can re-attach). The caller reverts config to `in-tree` so
 * cloud sync isn't left "on" pointing at a remote that no longer exists.
 */
export function detachProjectOrigin(projectRoot: string, gitModule: typeof git = git): void {
  if (!gitModule.isGitRepo(projectRoot)) return;
  if (gitModule.getRemoteUrl(projectRoot, 'origin')) gitModule.removeRemote(projectRoot, 'origin');
}
