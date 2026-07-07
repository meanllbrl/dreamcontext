import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiAdapter, ApiError } from '../task-backend/api-adapter.js';
import { readGitHubTokenSecretsOnly, type ResolvedToken } from '../task-backend/secrets.js';
import { readGlobalGitHubToken } from './auth-store.js';
import { readSetupConfig, type SetupConfig } from '../setup-config.js';
import { acquireFileLock, releaseFileLock } from '../file-lock.js';
import * as git from './git.js';
import { GitSyncError } from './git.js';
import { withGitCredentials } from './credentials.js';
import { scrubStagedFiles, summarizeScrub, type ScrubHit } from './scrub.js';

/**
 * Brain-repo bootstrap/resolve/discover + local-artifact + lock + token
 * resolver — decisions B/D/E/F. Folds in the never-standalone "index-guard"
 * concept (P3): after any clone/pull, local-only artifacts stay gitignored.
 */

export const BRAIN_MARKER_TOPIC = 'dreamcontext-brain';
export const BRAIN_MARKER_FILE = '.dreamcontext-brain';

/** M1 author-tiering fallback — a commit never fails on a missing git identity. */
export const FALLBACK_AUTHOR = { name: 'dreamcontext-sync', email: 'noreply@dreamcontext.local' };

// ─── D. Token resolution — resolveBrainSyncToken ────────────────────────────

/**
 * M1 tiers: per-project `.secrets.json` github token → env
 * (`GITHUB_TOKEN`/`GH_TOKEN`). Secrets-first, env-last — INTENTIONALLY the
 * reverse of `resolveGitHubToken` (secrets.ts, env-first): a stray
 * `GITHUB_TOKEN` in some inherited shell must never silently override the
 * account a non-technical collaborator is actually logged in as.
 *
 * M2 tiering (final): per-project `.secrets.json` → GLOBAL
 * `~/.dreamcontext/.secrets.json` (the account the user signed into the
 * launcher/dashboard as) → env. A per-project token still wins over the global
 * one; the global one still wins over a stray env var.
 */
export function resolveBrainSyncToken(projectRoot: string): ResolvedToken | null {
  const perProject = readGitHubTokenSecretsOnly(projectRoot);
  if (perProject) return perProject;
  const global = readGlobalGitHubToken();
  if (global) return global;
  for (const envVar of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    const v = process.env[envVar];
    if (v && v.trim()) return { token: v.trim(), source: 'env', via: envVar };
  }
  return null;
}

// ─── Own-repo-root guard ─────────────────────────────────────────────────────

/**
 * True only when `contextRoot` is ITSELF a git repo root — not merely nested
 * inside the code repo's work tree. `isGitRepo` cannot tell those two apart
 * (`rev-parse --is-inside-work-tree` is true for both), and every remote/
 * stage/commit/push issued against a nested `_dream_context/` resolves to the
 * ENCLOSING code repo: it would rewrite the code repo's origin, stage the
 * entire working tree, and push the whole code repo to the brain remote.
 */
export function isOwnRepoRoot(
  contextRoot: string,
  gitModule: Pick<typeof git, 'repoToplevel'> = git,
): boolean {
  const toplevel = gitModule.repoToplevel(contextRoot);
  if (!toplevel) return false;
  try {
    return realpathSync(toplevel) === realpathSync(contextRoot);
  } catch {
    return toplevel === contextRoot;
  }
}

// ─── A/B. Mode resolution ────────────────────────────────────────────────────

export function resolveMode(config: SetupConfig | null | undefined): 'separate' | 'in-tree' {
  return config?.brainRepo?.mode === 'separate' ? 'separate' : 'in-tree';
}

// ─── v3.3 master switch — resolveBrainSyncEnabled ───────────────────────────

export interface EnabledResolution {
  enabled: boolean;
  source: 'explicit' | 'derived-github-connected' | 'derived-unconnected';
}

/**
 * Explicit `brainRepo.enabled` always wins. Absent ⇒ derived default: ON iff
 * the project is already GitHub-connected (code repo's `origin` remote is a
 * github.com URL, OR `taskBackend==='github'`, OR a `brainRepo.remote` is
 * configured); OFF otherwise (new/unconnected projects stay off until the
 * user configures it via Settings or `dreamcontext brain enable`).
 */
export function resolveBrainSyncEnabled(
  projectRoot: string,
  config: SetupConfig | null | undefined,
  gitModule: Pick<typeof git, 'isGitRepo' | 'getRemoteUrl'> = git,
): EnabledResolution {
  const explicit = config?.brainRepo?.enabled;
  if (typeof explicit === 'boolean') return { enabled: explicit, source: 'explicit' };

  let originIsGithub = false;
  try {
    if (gitModule.isGitRepo(projectRoot)) {
      const url = gitModule.getRemoteUrl(projectRoot, 'origin');
      originIsGithub = !!url && /github\.com/i.test(url);
    }
  } catch {
    originIsGithub = false;
  }

  const taskBackendGithub = config?.taskBackend === 'github';
  const hasBrainRemote = !!config?.brainRepo?.remote;
  const connected = originIsGithub || taskBackendGithub || hasBrainRemote;
  return { enabled: connected, source: connected ? 'derived-github-connected' : 'derived-unconnected' };
}

// ─── C. Tracked-vs-local — buildBrainGitignore ──────────────────────────────

/**
 * The brain repo's OWN `.gitignore` (bootstrapped by `brain init`/`attach`,
 * re-synced by `brain sync`). Table lives verbatim in
 * `skill-sync/references/merge-rules.md`.
 */
export function buildBrainGitignore(taskBackend?: SetupConfig['taskBackend']): string {
  const lines: string[] = [
    '# Generated by dreamcontext brain-repo bootstrap.',
    '# This tracks core/, knowledge/, overrides/, and the shared config —',
    '# everything else here is local machine/session state and must never sync.',
    '',
    'state/.secrets.json',
    'state/.sleep.json',
    'state/.sleep-history.json',
    'state/.agent-sessions.json',
    'state/.agent-session-map/',
    'state/.session-digests/',
    'state/.conflicts/',
    'state/.brain-merge/',
    'state/.version-check.json',
    'state/.auto-upgrade.json',
    'state/.brain-local.json',
    'state/.tasks-map.json',
    'state/.tasks-sync.*',
    'state/.tasks-queue.json',
    '.obsidian/',
    'tmp/',
    '**/.env',
    // Lab (analytics insights) credentials — insights + cache DO sync (deny-list
    // gitignore); only the credential file is excluded. lab/scripts/*.env is
    // already covered by the **/.env entry above.
    'lab/credentials.json',
    'lab/credentials.*',
  ];
  if (taskBackend && taskBackend !== 'local') {
    lines.push(
      '',
      '# Tasks are a local mirror under a remote task backend — issues/ClickUp are source of truth.',
      'state/*.md',
    );
  }
  return `${lines.join('\n')}\n`;
}

// ─── Bootstrap (local part) + createBrainRepo (GitHub API + bootstrap) ──────

export interface BootstrapBrainRepoOptions {
  /** Absolute path to `_dream_context/` — the git repo root in `separate` mode. */
  contextRoot: string;
  projectRoot: string;
  /** Remote URL (clean https, or a local path for tests/E2E) — never tokened. */
  remote: string;
  codeRepoUrl?: string;
  taskBackend?: SetupConfig['taskBackend'];
  /** Injectable git wrapper — tests use a fake. */
  gitModule?: typeof git;
  scrubStagedFilesImpl?: typeof scrubStagedFiles;
  withGitCredentialsImpl?: typeof withGitCredentials;
}

export interface BootstrapBrainRepoResult {
  remote: string;
  scrub: { blocks: ScrubHit[]; warns: ScrubHit[] };
  blocked: boolean;
  pushed: boolean;
}

/**
 * The LOCAL half of `brain init`: git-init the brain root (if needed), write
 * the marker + gitignore, wire the remote, then a SCRUBBED first commit (S3)
 * + push. Separated from `createBrainRepo` (which additionally calls the
 * GitHub API to create the actual remote repo) so this half is independently
 * exercisable against a local bare "remote" in tests/E2E, with no network.
 */
export async function bootstrapBrainRepo(opts: BootstrapBrainRepoOptions): Promise<BootstrapBrainRepoResult> {
  const g = opts.gitModule ?? git;
  const scrub = opts.scrubStagedFilesImpl ?? scrubStagedFiles;
  const withCreds = opts.withGitCredentialsImpl ?? withGitCredentials;

  if (!isOwnRepoRoot(opts.contextRoot, g)) g.initRepo(opts.contextRoot);

  writeFileSync(
    join(opts.contextRoot, BRAIN_MARKER_FILE),
    `${JSON.stringify({ version: 1, codeRepoUrl: opts.codeRepoUrl ?? '' }, null, 2)}\n`,
    'utf-8',
  );
  if (!existsSync(join(opts.contextRoot, '.gitignore'))) {
    writeFileSync(join(opts.contextRoot, '.gitignore'), buildBrainGitignore(opts.taskBackend), 'utf-8');
  }

  if (g.getRemoteUrl(opts.contextRoot, 'origin')) {
    g.setRemoteUrl(opts.contextRoot, 'origin', opts.remote);
  } else {
    g.addRemote(opts.contextRoot, 'origin', opts.remote);
  }

  g.stageAll(opts.contextRoot);
  const hits = scrub(opts.contextRoot);
  const { blocks, warns } = summarizeScrub(hits);
  if (blocks.length > 0) {
    return { remote: opts.remote, scrub: { blocks, warns }, blocked: true, pushed: false };
  }

  const author = g.hasGitIdentity(opts.contextRoot) ? undefined : FALLBACK_AUTHOR;
  g.commit(opts.contextRoot, 'chore(brain): initial import', author);

  const token = resolveBrainSyncToken(opts.projectRoot);
  if (/^https?:\/\//i.test(opts.remote) && !token) {
    throw new GitSyncError('No GitHub token found for the brain repo (per-project secrets or GITHUB_TOKEN/GH_TOKEN env).');
  }
  // A local-path remote (tests/E2E — a bare repo on disk) needs no credential
  // supply at all; the askpass env is harmless but unused in that case.
  await withCreds(token?.token ?? '', async (env) => {
    g.push(opts.contextRoot, 'origin', 'main', env);
  });

  return { remote: opts.remote, scrub: { blocks, warns }, blocked: false, pushed: true };
}

export interface CreateBrainRepoOptions {
  contextRoot: string;
  projectRoot: string;
  owner: string;
  name: string;
  private?: boolean;
  /**
   * DEFENSE-IN-DEPTH (S5): creating a PUBLIC brain repo requires an explicit
   * `confirmed: true`. Mirrors `attachBrainRepo`'s confirmation refusal so the
   * library itself refuses even if a caller (or a future endpoint) forgets the
   * HTTP-layer gate. A private repo does not need it.
   */
  confirmed?: boolean;
  codeRepoUrl?: string;
  taskBackend?: SetupConfig['taskBackend'];
  /** Injectable ApiAdapter — tests inject a fake `fetchImpl`. */
  adapter?: ApiAdapter;
  /** Passthrough injectables for the local-bootstrap half — tests avoid any real git/network call. */
  gitModule?: typeof git;
  scrubStagedFilesImpl?: typeof scrubStagedFiles;
  withGitCredentialsImpl?: typeof withGitCredentials;
}

/** `brain init`: create the GitHub repo (default PRIVATE — S5), set the discovery topic, then bootstrap locally. */
export async function createBrainRepo(opts: CreateBrainRepoOptions): Promise<BootstrapBrainRepoResult> {
  const isPrivate = opts.private ?? true;
  if (!isPrivate && opts.confirmed !== true) {
    throw new GitSyncError('Refusing to create a PUBLIC brain repo without explicit confirmation (S5).');
  }
  const adapter = opts.adapter ?? new ApiAdapter({
    baseUrl: 'https://api.github.com',
    authHeaders: () => {
      const t = resolveBrainSyncToken(opts.projectRoot);
      if (!t) throw new GitSyncError('No GitHub token found (per-project secrets or GITHUB_TOKEN/GH_TOKEN env).');
      return { Authorization: `token ${t.token}` };
    },
  });

  const created = await adapter.request<{ full_name: string }>('POST', '/user/repos', {
    body: { name: opts.name, private: isPrivate },
  });
  await adapter.request('PUT', `/repos/${created.full_name}/topics`, {
    body: { names: [BRAIN_MARKER_TOPIC] },
  });

  const remote = `https://github.com/${created.full_name}.git`;
  return bootstrapBrainRepo({
    contextRoot: opts.contextRoot,
    projectRoot: opts.projectRoot,
    remote,
    codeRepoUrl: opts.codeRepoUrl,
    taskBackend: opts.taskBackend,
    gitModule: opts.gitModule,
    scrubStagedFilesImpl: opts.scrubStagedFilesImpl,
    withGitCredentialsImpl: opts.withGitCredentialsImpl,
  });
}

// ─── Discover ────────────────────────────────────────────────────────────────

export interface DiscoveredBrainRepo {
  fullName: string;
  htmlUrl: string;
  private: boolean;
}

export async function discoverBrainRepos(projectRoot: string, adapter?: ApiAdapter): Promise<DiscoveredBrainRepo[]> {
  const api = adapter ?? new ApiAdapter({
    baseUrl: 'https://api.github.com',
    authHeaders: () => {
      const t = resolveBrainSyncToken(projectRoot);
      if (!t) throw new GitSyncError('No GitHub token found (per-project secrets or GITHUB_TOKEN/GH_TOKEN env).');
      return { Authorization: `token ${t.token}` };
    },
  });
  const result = await api.request<{ items: { full_name: string; html_url: string; private: boolean }[] }>(
    'GET',
    '/search/repositories',
    { query: { q: `topic:${BRAIN_MARKER_TOPIC}` } },
  );
  return (result.items ?? []).map((i) => ({ fullName: i.full_name, htmlUrl: i.html_url, private: i.private }));
}

// ─── Attach ──────────────────────────────────────────────────────────────────

export interface AttachBrainRepoOptions {
  contextRoot: string;
  projectRoot: string;
  url: string;
  /** REQUIRED — the S6 trust confirmation. Refuses without it. */
  confirmed: boolean;
  taskBackend?: SetupConfig['taskBackend'];
  gitModule?: typeof git;
}

export interface AttachBrainRepoResult {
  ok: boolean;
  reason?: string;
}

/**
 * `brain attach <url>` — a TRUST decision (S6): the brain's content is loaded
 * verbatim into every future AI session via SessionStart, so this refuses
 * without an explicit confirmation. On confirm, wires the remote into the
 * existing `_dream_context/` (fetches, does not force-merge — a human/agent
 * still drives the first real sync via `brain sync`).
 */
export function attachBrainRepo(opts: AttachBrainRepoOptions): AttachBrainRepoResult {
  if (!opts.confirmed) {
    return { ok: false, reason: 'Attach refused: this repo\'s content loads verbatim into every future AI session — explicit confirmation is required (S6).' };
  }
  const g = opts.gitModule ?? git;
  if (!isOwnRepoRoot(opts.contextRoot, g)) g.initRepo(opts.contextRoot);
  if (g.getRemoteUrl(opts.contextRoot, 'origin')) {
    g.setRemoteUrl(opts.contextRoot, 'origin', opts.url);
  } else {
    g.addRemote(opts.contextRoot, 'origin', opts.url);
  }
  ensureLocalOnlyArtifacts(opts.contextRoot, opts.taskBackend, g);
  return { ok: true };
}

// ─── Attach preview (READ-ONLY — the S6 trust surface) ──────────────────────

export interface AttachPreviewResult {
  /** The repo exists and the token can read it. */
  reachable: boolean;
  fullName?: string;
  private?: boolean;
  /** Carries the discovery topic `dreamcontext-brain` — a genuine brain repo. */
  isBrainRepo?: boolean;
  defaultBranch?: string;
  /**
   * DEFERRED: a recursive tree fetch would under-report on GitHub's tree
   * truncation and no AC needs it. Left optional so a later enhancement can
   * populate it without a signature change.
   */
  trackedFileCount?: number;
  /** Why the preview failed, when `reachable` is false. */
  reason?: string;
}

/** Parse `owner/repo` out of an https or `owner/repo` brain-repo URL. */
export function parseRepoSlug(url: string): { owner: string; repo: string } | null {
  const trimmed = url.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const httpsMatch = trimmed.match(/github\.com[/:]([^/]+)\/([^/]+)$/i);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  const shortMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (shortMatch) return { owner: shortMatch[1], repo: shortMatch[2] };
  return null;
}

export interface PreviewAttachOptions {
  projectRoot: string;
  url: string;
  /** Injectable ApiAdapter — tests inject a fake `fetchImpl`. READ-ONLY (GETs only). */
  adapter?: ApiAdapter;
}

/**
 * The S6 trust surface: given a candidate brain-repo URL, GET its metadata +
 * topics so the UI can render a diff-preview-style confirmation BEFORE the user
 * commits to attaching. STRICTLY READ-ONLY — no mutation, no fetch into the
 * working tree. Never throws for a normal "not reachable" outcome (bad URL,
 * 404, auth) — it returns `{ reachable: false, reason }` so the UI can explain.
 */
export async function previewAttach(opts: PreviewAttachOptions): Promise<AttachPreviewResult> {
  const slug = parseRepoSlug(opts.url);
  if (!slug) return { reachable: false, reason: 'That does not look like a GitHub repo URL (expected https://github.com/owner/repo or owner/repo).' };

  const api = opts.adapter ?? new ApiAdapter({
    baseUrl: 'https://api.github.com',
    authHeaders: () => {
      const t = resolveBrainSyncToken(opts.projectRoot);
      if (!t) throw new GitSyncError('No GitHub token found (per-project secrets or GITHUB_TOKEN/GH_TOKEN env).');
      return { Authorization: `token ${t.token}` };
    },
  });

  try {
    const repo = await api.request<{ full_name: string; private: boolean; default_branch: string }>(
      'GET',
      `/repos/${slug.owner}/${slug.repo}`,
    );
    let isBrainRepo = false;
    try {
      const topics = await api.request<{ names: string[] }>('GET', `/repos/${slug.owner}/${slug.repo}/topics`);
      isBrainRepo = (topics.names ?? []).includes(BRAIN_MARKER_TOPIC);
    } catch {
      // Topics are best-effort — a token without the preview scope for topics
      // still yields a valid reachability + metadata preview.
      isBrainRepo = false;
    }
    return {
      reachable: true,
      fullName: repo.full_name,
      private: repo.private,
      isBrainRepo,
      defaultBranch: repo.default_branch,
    };
  } catch (err) {
    const message = err instanceof GitSyncError || err instanceof ApiError ? err.message : (err as Error).message;
    return { reachable: false, reason: message };
  }
}

// ─── Local-only artifacts (folded index-guard, P3) ──────────────────────────

/** After any clone/pull, make sure local-only artifacts stay gitignored (never staged). */
export function ensureLocalOnlyArtifacts(
  contextRoot: string,
  taskBackend?: SetupConfig['taskBackend'],
  gitModule: typeof git = git,
): void {
  const gitignorePath = join(contextRoot, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, buildBrainGitignore(taskBackend), 'utf-8');
  }
  void gitModule; // reserved for a future "assert nothing local-only is staged" check
}

// ─── Lock (reuses file-lock.ts, PID-liveness-gated — amendment 3) ──────────

const BRAIN_LOCK_STALE_MS = 5 * 60_000; // 5 minutes

export function brainLockPath(contextRoot: string): string {
  return join(contextRoot, 'state', '.brain-merge', '.lock');
}

export function acquireBrainLock(contextRoot: string, nowMs: number = Date.now()): boolean {
  return acquireFileLock(brainLockPath(contextRoot), nowMs, BRAIN_LOCK_STALE_MS, { verifyPidLiveness: true });
}

export function releaseBrainLock(contextRoot: string): void {
  releaseFileLock(brainLockPath(contextRoot));
}

// Re-exported for CLI/tests convenience (avoids importing setup-config.js separately just for this).
export function currentTaskBackend(projectRoot: string): SetupConfig['taskBackend'] {
  return readSetupConfig(projectRoot)?.taskBackend;
}
