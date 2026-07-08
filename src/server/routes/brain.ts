import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';
import { isDesktop } from '../desktop.js';
import { readSetupConfig, updateSetupConfig, readBrainLocal } from '../../lib/setup-config.js';
import * as git from '../../lib/git-sync/git.js';
import { GitSyncError } from '../../lib/git-sync/git.js';
import { ApiError } from '../../lib/task-backend/api-adapter.js';
import {
  resolveMode,
  resolveBrainSyncEnabled,
  resolveBrainSyncToken,
  isOwnRepoRoot,
  createBrainRepo,
  discoverBrainRepos,
  attachBrainRepo,
  bootstrapBrainRepo,
  previewAttach,
  ensureFullRepoGitignore,
} from '../../lib/git-sync/brain-repo.js';
import { withGitCredentials } from '../../lib/git-sync/credentials.js';
import { runBrainSync } from '../../lib/git-sync/sync-engine.js';
import { readGlobalGitHubLogin } from '../../lib/git-sync/auth-store.js';
import { runTeamFetch } from '../../lib/git-sync/team-fetch.js';
import { readConflictReport } from '../../lib/git-sync/conflict-report.js';
import { classifySyncError, type SyncFailure } from '../../lib/git-sync/failure.js';
import { ensureGitignoreEntries } from '../../lib/gitignore.js';
import { listVaults } from '../../lib/vaults.js';

/**
 * The KIND of an in-progress merge, so the dashboard renders the right banner:
 *  - `agent` — a dreamcontext team-merge deferred to /dream-sync (prose overlap).
 *  - `code`  — a full-repo code conflict for the human's editor (never an agent job).
 *  - `user`  — the user's OWN `git merge`/`rebase` (nothing for us to resolve).
 * A merge dreamcontext started ALWAYS leaves a conflict report; the user's own leaves none.
 */
export type MergeKind = 'agent' | 'code' | 'user' | null;

function mergeKindFor(contextRoot: string, hasMergeHead: boolean, pendingAgentMerge: boolean): MergeKind {
  if (hasMergeHead) {
    const report = readConflictReport(contextRoot);
    if (!report) return 'user';
    if (report.codeConflicts && report.codeConflicts.length > 0) return 'code';
    return 'agent';
  }
  // A pull-only defer aborts the merge but records the handoff — still an agent job.
  if (pendingAgentMerge) return 'agent';
  return null;
}

/**
 * `/api/brain/*` — the vault-scoped brain-repo cloud-sync routes. Every handler
 * is a THIN LAYER over M1's in-process functions (createBrainRepo /
 * discoverBrainRepos / attachBrainRepo / runBrainSync / updateSetupConfig) — it
 * NEVER spawns the CLI.
 *
 * `contextRoot` is `<vault>/_dream_context` (the strict header-resolved vault);
 * `projectRoot = dirname(contextRoot)`. Desktop-gated + loopback + CSRF (server
 * entry) + STRICT-PICK bodies (each field read by name, never spread).
 */

function gate(res: ServerResponse): boolean {
  if (!isDesktop()) {
    sendError(res, 403, 'desktop_only', 'Brain cloud-sync is only available in the desktop app.');
    return false;
  }
  return true;
}

// ─── GET /api/brain/status ───────────────────────────────────────────────────

export async function handleBrainStatus(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!gate(res)) return;
  const projectRoot = dirname(contextRoot);
  const config = readSetupConfig(projectRoot);
  const mode = resolveMode(config);
  const enabled = resolveBrainSyncEnabled(projectRoot, config);
  const local = readBrainLocal(projectRoot);

  // `remote` is the repo cloud-sync actually pushes to. `separate` → the brain
  // repo's own origin (rooted at `_dream_context/`), falling back to the
  // configured remote. `full-repo` → the PROJECT's own `origin` (the whole
  // folder is the synced unit). `in-tree` is commit-only and never pushes, so
  // it has NO sync remote; the code origin still goes out as `codeOrigin`
  // (display context only).
  let remote: string | null = null;
  let mergeInProgress = false;
  if (mode === 'separate') {
    const ownRoot = isOwnRepoRoot(contextRoot);
    try { remote = ownRoot ? git.getRemoteUrl(contextRoot, 'origin') : null; } catch { remote = null; }
    remote = remote ?? config?.brainRepo?.remote ?? null;
    try { mergeInProgress = ownRoot && git.hasMergeHead(contextRoot); } catch { mergeInProgress = false; }
  } else if (mode === 'full-repo') {
    try { remote = git.isGitRepo(projectRoot) ? git.getRemoteUrl(projectRoot, 'origin') : null; } catch { remote = null; }
    try { mergeInProgress = git.hasMergeHead(projectRoot); } catch { mergeInProgress = false; }
  }
  let codeOrigin: string | null = null;
  try { codeOrigin = git.isGitRepo(projectRoot) ? git.getRemoteUrl(projectRoot, 'origin') : null; } catch { codeOrigin = null; }

  // Distinguish OUR deferred team-merge (agent), a full-repo CODE conflict (human's
  // editor), and the user's OWN unrelated git merge — so the sidebar shows the right
  // banner instead of a blanket "Resolve with AI" for every in-progress merge.
  const mergeKind = mergeKindFor(contextRoot, mergeInProgress, !!local.pendingAgentMerge);
  // The specific code files a full-repo code conflict left for the human (banner detail).
  let codeConflicts: string[] = [];
  if (mergeKind === 'code') {
    try { codeConflicts = readConflictReport(contextRoot)?.codeConflicts ?? []; } catch { codeConflicts = []; }
  }

  sendJson(res, 200, {
    enabled: enabled.enabled,
    source: enabled.source,
    mode,
    remote,
    hasRemote: !!remote,
    codeOrigin,
    mergeInProgress,
    mergeKind,
    codeConflicts,
    pendingAgentMerge: !!local.pendingAgentMerge,
    pulledUpdates: local.pulledUpdates ?? 0,
  });
}

// ─── GET /api/brain/discover ─────────────────────────────────────────────────

export async function handleBrainDiscover(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!gate(res)) return;
  const projectRoot = dirname(contextRoot);
  // Pre-resolve the token: with none, the ApiAdapter's lazy authHeaders would
  // throw inside its retry loop and surface as a slow network error, not a clean
  // auth signal — so short-circuit to auth_required here (thin, no network).
  if (!resolveBrainSyncToken(projectRoot)) {
    sendError(res, 400, 'auth_required', 'Sign in with GitHub first to discover brain repos.');
    return;
  }
  try {
    const repos = await discoverBrainRepos(projectRoot);
    sendJson(res, 200, { repos: repos.map((r) => ({ fullName: r.fullName, htmlUrl: r.htmlUrl, private: r.private })) });
  } catch (err) {
    // A bad/expired token (ApiError kind:auth) also means "you need to sign in".
    if (err instanceof GitSyncError || (err instanceof ApiError && err.kind === 'auth')) {
      sendError(res, 400, 'auth_required', 'Sign in with GitHub first to discover brain repos.');
      return;
    }
    sendError(res, 502, 'discover_failed', (err as Error).message);
  }
}

// ─── POST /api/brain/create ──────────────────────────────────────────────────

export async function handleBrainCreate(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!gate(res)) return;
  const projectRoot = dirname(contextRoot);
  const body = await parseJsonBody(req);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const makePublic = body?.public === true;
  const confirmed = body?.confirmed === true;
  const codeRepo = typeof body?.codeRepo === 'string' ? body.codeRepo.trim() : undefined;
  if (!name) {
    sendError(res, 400, 'invalid_body', 'name is required.');
    return;
  }
  // Server-side S5 gate (defense-in-depth — the library also refuses).
  if (makePublic && confirmed !== true) {
    sendError(res, 400, 'confirmation_required', 'Creating a PUBLIC brain repo requires explicit confirmation.');
    return;
  }

  const config = readSetupConfig(projectRoot);
  const owner = readGlobalGitHubLogin() ?? '';
  try {
    const result = await createBrainRepo({
      contextRoot,
      projectRoot,
      owner,
      name,
      private: !makePublic,
      confirmed,
      codeRepoUrl: codeRepo,
      taskBackend: config?.taskBackend,
    });
    if (result.blocked) {
      sendJson(res, 200, { ok: false, blocked: true, scrub: { blocks: result.scrub.blocks } });
      return;
    }
    updateSetupConfig(projectRoot, {
      brainRepo: { mode: 'separate', remote: result.remote, codeRepoUrl: codeRepo, autoSync: true, enabled: true },
    });
    sendJson(res, 200, { ok: true, remote: result.remote });
  } catch (err) {
    if (err instanceof GitSyncError) {
      sendError(res, 400, 'create_refused', err.message);
      return;
    }
    if (err instanceof ApiError && err.kind === 'auth') {
      sendError(res, 400, 'auth_required', 'Sign in with GitHub first to create a brain repo.');
      return;
    }
    sendError(res, 502, 'create_failed', (err as Error).message);
  }
}

// ─── POST /api/brain/attach-preview ──────────────────────────────────────────

export async function handleBrainAttachPreview(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!gate(res)) return;
  const projectRoot = dirname(contextRoot);
  const body = await parseJsonBody(req);
  const url = typeof body?.url === 'string' ? body.url.trim() : '';
  if (!url) {
    sendError(res, 400, 'invalid_body', 'url is required.');
    return;
  }
  try {
    const preview = await previewAttach({ projectRoot, url });
    sendJson(res, 200, preview);
  } catch (err) {
    if (err instanceof GitSyncError || (err instanceof ApiError && err.kind === 'auth')) {
      sendError(res, 400, 'auth_required', 'Sign in with GitHub first to preview a brain repo.');
      return;
    }
    sendError(res, 502, 'preview_failed', (err as Error).message);
  }
}

// ─── POST /api/brain/attach ──────────────────────────────────────────────────

export async function handleBrainAttach(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!gate(res)) return;
  const projectRoot = dirname(contextRoot);
  const body = await parseJsonBody(req);
  const url = typeof body?.url === 'string' ? body.url.trim() : '';
  const confirmed = body?.confirmed === true;
  if (!url) {
    sendError(res, 400, 'invalid_body', 'url is required.');
    return;
  }
  const config = readSetupConfig(projectRoot);
  const result = attachBrainRepo({ contextRoot, projectRoot, url, confirmed, taskBackend: config?.taskBackend });
  if (!result.ok) {
    sendJson(res, 200, { ok: false, reason: result.reason });
    return;
  }
  updateSetupConfig(projectRoot, { brainRepo: { mode: 'separate', remote: url, autoSync: true, enabled: true } });

  // Empty-remote bootstrap (best-effort — attach itself already succeeded):
  // a freshly created repo has NO refs, so every later fetch-first sync would
  // find nothing to pull and the repo would sit empty until an auto/push-only
  // sync. Give it its scrubbed first commit + push right here, the same
  // primitive Create uses. An existing brain repo (branch present) is left
  // for the first `brain sync` to pull/merge — attach never merges (S6).
  let bootstrap: 'pushed' | 'blocked-scrub' | 'skipped' | undefined;
  const token = resolveBrainSyncToken(projectRoot);
  if (token || !/^https?:\/\//i.test(url)) {
    try {
      const empty = await withGitCredentials(token?.token ?? '', async (env) =>
        !git.remoteBranchExists(contextRoot, 'origin', 'main', env));
      if (empty) {
        const boot = await bootstrapBrainRepo({ contextRoot, projectRoot, remote: url, taskBackend: config?.taskBackend });
        bootstrap = boot.blocked ? 'blocked-scrub' : 'pushed';
      }
    } catch {
      bootstrap = 'skipped'; // unreachable remote / push failure — the next brain sync reports it loudly
    }
  }
  sendJson(res, 200, { ok: true, bootstrap });
}

// ─── POST /api/brain/disconnect ──────────────────────────────────────────────

export async function handleBrainDisconnect(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!gate(res)) return;
  const projectRoot = dirname(contextRoot);
  const config = readSetupConfig(projectRoot);
  const mode = resolveMode(config);
  // Drop the brain repo's own origin — only when `_dream_context/` is its own
  // repo root. The enclosing code repo's remotes are NEVER touched.
  if (mode === 'separate' && isOwnRepoRoot(contextRoot)) {
    try {
      if (git.getRemoteUrl(contextRoot, 'origin')) git.removeRemote(contextRoot, 'origin');
    } catch (err) {
      sendError(res, 502, 'disconnect_failed', (err as Error).message);
      return;
    }
  }
  // Replace brainRepo wholesale: keep the mode, drop remote/autoSync, and pin
  // enabled:false so the derived default can't silently re-enable sync.
  updateSetupConfig(projectRoot, { brainRepo: { mode, enabled: false } });
  sendJson(res, 200, { ok: true });
}

// ─── POST /api/brain/sync ────────────────────────────────────────────────────

export async function handleBrainSync(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!gate(res)) return;
  const projectRoot = dirname(contextRoot);
  const body = await parseJsonBody(req);
  const mode: 'pull-only' | 'auto' = body?.mode === 'auto' ? 'auto' : 'pull-only';
  // Dashboard-initiated syncs are FOREGROUND (a human is watching): WARN-tier
  // scrub hits stay non-blocking, only real secrets stop the sync. Defaults to
  // true here because every caller of THIS route is the dashboard UI; the truly
  // headless session-start pull calls runBrainSync directly, not this endpoint.
  const foreground = body?.foreground !== false;
  // The on-open auto-pull passes `noCheckpoint:true` when the user has disabled
  // auto-checkpoint-on-open — pull-only then skips a dirty tree instead of
  // auto-committing WIP. Manual syncs never set it (they always checkpoint).
  const noCheckpoint = body?.noCheckpoint === true;
  try {
    const result = await runBrainSync({ cwd: contextRoot, mode, foreground, noCheckpoint });
    // `no-remote` with a token-shaped note is really an auth failure — attach a
    // reconnect affordance so the sidebar can offer a concrete recovery, not a
    // dead-end "sync failed". Every other operational action carries its own UI.
    let failure: SyncFailure | undefined;
    if (result.action === 'no-remote' && /token/i.test(result.note ?? '')) {
      failure = classifySyncError(result.note ?? 'no github token found', syncRepoHint(projectRoot, result));
    }
    sendJson(res, 200, {
      action: result.action,
      pulledUpdates: result.pulledUpdates ?? 0,
      scrub: { blocks: result.scrub.blocks, warns: result.scrub.warns },
      note: result.note,
      checkpointed: !!result.checkpointed,
      checkpointSha: result.checkpointSha,
      codeConflicts: result.codeConflicts,
      failure,
    });
  } catch (err) {
    // A thrown GitSyncError (push-rejected-twice, auth, network, permission,
    // unrelated histories) is classified into a specific, recoverable failure —
    // never a bare "Sync failed". Returned 200 with `action:'error'` so the UI
    // can render the message + its recovery affordance (Reconnect / Retry / …).
    const failure = classifySyncError((err as Error).message, syncRepoHint(projectRoot));
    sendJson(res, 200, {
      action: 'error',
      pulledUpdates: 0,
      scrub: { blocks: [], warns: [] },
      note: failure.message,
      failure,
    });
  }
}

/** Best-effort `owner/repo` (or remote URL) for a failure message — the repo sync pushes to. */
function syncRepoHint(projectRoot: string, _result?: unknown): string | undefined {
  const config = readSetupConfig(projectRoot);
  const mode = resolveMode(config);
  try {
    if (mode === 'full-repo' || mode === 'in-tree') {
      return (git.isGitRepo(projectRoot) ? git.getRemoteUrl(projectRoot, 'origin') : null) ?? undefined;
    }
    return config?.brainRepo?.remote ?? undefined;
  } catch {
    return config?.brainRepo?.remote ?? undefined;
  }
}

// ─── GET /api/brain/settings ─────────────────────────────────────────────────

export async function handleBrainSettingsGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!gate(res)) return;
  const projectRoot = dirname(contextRoot);
  const config = readSetupConfig(projectRoot);
  const enabled = resolveBrainSyncEnabled(projectRoot, config);
  sendJson(res, 200, {
    enabled: enabled.enabled,
    source: enabled.source,
    mode: resolveMode(config),
    autoSync: config?.brainRepo?.autoSync ?? false,
    remote: config?.brainRepo?.remote ?? null,
  });
}

// ─── POST /api/brain/settings (SW2 master toggle) ────────────────────────────

export async function handleBrainSettingsPost(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!gate(res)) return;
  const projectRoot = dirname(contextRoot);
  const body = await parseJsonBody(req);
  if (typeof body?.enabled !== 'boolean') {
    sendError(res, 400, 'invalid_body', 'enabled (boolean) is required.');
    return;
  }
  const enabledValue = body.enabled;
  const config = readSetupConfig(projectRoot);
  // MUST spread the existing brainRepo — updateSetupConfig replaces it wholesale.
  updateSetupConfig(projectRoot, {
    brainRepo: { ...(config?.brainRepo ?? { mode: 'in-tree' }), enabled: enabledValue },
  });
  const next = readSetupConfig(projectRoot);
  const resolved = resolveBrainSyncEnabled(projectRoot, next);
  sendJson(res, 200, {
    enabled: resolved.enabled,
    source: resolved.source,
    mode: resolveMode(next),
    autoSync: next?.brainRepo?.autoSync ?? false,
    remote: next?.brainRepo?.remote ?? null,
  });
}

// ─── POST /api/brain/scope (switch what cloud sync covers) ───────────────────

/**
 * Switch the sync SCOPE for this project:
 *   `full-repo` — sync the WHOLE project folder (code + `_dream_context/`) to
 *                 the project's own `origin`, on the current branch.
 *   `brain`     — revert to brain-only: `separate` if a dedicated brain remote
 *                 is configured, otherwise `in-tree` (commit-only).
 * `full-repo` requires the project to already have a GitHub `origin` — that's
 * the repo it will push to. Enabling it flips the master switch on and sets
 * autoSync so `sleep done` keeps the folder in sync too.
 */
export async function handleBrainScope(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!gate(res)) return;
  const projectRoot = dirname(contextRoot);
  const body = await parseJsonBody(req);
  const scope = body?.scope === 'full-repo' ? 'full-repo' : body?.scope === 'brain' ? 'brain' : null;
  if (!scope) {
    sendError(res, 400, 'invalid_body', "scope must be 'full-repo' or 'brain'.");
    return;
  }
  const config = readSetupConfig(projectRoot);
  const existing = config?.brainRepo ?? { mode: 'in-tree' as const };

  if (scope === 'full-repo') {
    let origin: string | null = null;
    try { origin = git.isGitRepo(projectRoot) ? git.getRemoteUrl(projectRoot, 'origin') : null; } catch { origin = null; }
    if (!origin) {
      sendError(res, 400, 'no_origin', 'Whole-project sync needs a GitHub `origin` on this project. Add one (git remote add origin …) and try again.');
      return;
    }
    updateSetupConfig(projectRoot, {
      brainRepo: { ...existing, mode: 'full-repo', enabled: true, autoSync: true },
    });
    // Gitignore-first: exclude machine-local brain state + secrets before the
    // first whole-project sync can stage them.
    ensureFullRepoGitignore(projectRoot, config?.taskBackend);
  } else {
    // brain-only: keep a dedicated brain remote if one was configured, else in-tree.
    const nextMode = existing.remote ? 'separate' : 'in-tree';
    updateSetupConfig(projectRoot, { brainRepo: { ...existing, mode: nextMode } });
  }

  const next = readSetupConfig(projectRoot);
  const resolved = resolveBrainSyncEnabled(projectRoot, next);
  sendJson(res, 200, {
    enabled: resolved.enabled,
    source: resolved.source,
    mode: resolveMode(next),
    autoSync: next?.brainRepo?.autoSync ?? false,
    remote: next?.brainRepo?.remote ?? null,
  });
}

// ─── POST /api/brain/scrub/ignore (one-click "add <path> to .gitignore") ─────

/**
 * A blocked-scrub file whose basename/extension marks it as a local secret/config
 * file that should NEVER be tracked (`.env`, `credentials*`, `*.pem`, `*.key`, …).
 * ONLY these are safe to gitignore in one click — a real source file with an inline
 * secret must be edited (remove the secret), not un-tracked (that would silently drop
 * real code from the repo). The dashboard mirrors this to decide whether to show the button.
 */
export const SAFE_TO_GITIGNORE = /(^|\/)([^/]*\.env(\.[^/]+)?|[^/]*\.local\.[^/]+|[^/]*secrets?[^/]*\.(json|ya?ml|toml|env)|credentials?[^/]*\.(json|ya?ml|toml|env)|[^/]*\.(pem|key|p12|pfx|keystore|jks)|id_rsa[^/]*|id_ed25519[^/]*)$/i;

export function isSafeToGitignore(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/').trim();
  if (!p) return false;
  // Reject gitignore METACHARACTERS + control chars: a leading `!` is a NEGATION that
  // would UN-ignore an already-excluded secret (e.g. `!_dream_context/state/.secrets.json`);
  // `#` is a comment, newlines inject arbitrary extra rules, and `*?[]` are globs. The
  // input must be a plain relative file path — nothing that can alter .gitignore semantics.
  if (/[!#*?[\]\r\n\0]/.test(p)) return false;
  if (p.startsWith('/') || p.split('/').includes('..')) return false;
  return SAFE_TO_GITIGNORE.test(p);
}

export async function handleBrainScrubIgnore(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!gate(res)) return;
  const projectRoot = dirname(contextRoot);
  const body = await parseJsonBody(req);
  const rawPath = typeof body?.path === 'string' ? body.path.trim() : '';
  if (!rawPath) {
    sendError(res, 400, 'invalid_body', 'path is required.');
    return;
  }
  const relPath = rawPath.replace(/\\/g, '/');
  // Hard traversal/absolute guard, then the "is it safe to un-track" gate.
  if (relPath.startsWith('/') || relPath.split('/').includes('..')) {
    sendError(res, 400, 'invalid_path', 'That path is not allowed.');
    return;
  }
  if (!isSafeToGitignore(relPath)) {
    sendError(res, 400, 'unsafe_path', 'That looks like a real source file — remove the secret from it instead of un-tracking it.');
    return;
  }
  // Where the ignore rule belongs: full-repo/in-tree stage the whole project (root
  // .gitignore); separate stages `_dream_context/` (its own .gitignore).
  const mode = resolveMode(readSetupConfig(projectRoot));
  const root = mode === 'separate' ? contextRoot : projectRoot;
  try {
    const added = ensureGitignoreEntries(root, [relPath], {
      comment: 'dreamcontext: excluded a scrub-blocked local secret file (added from the dashboard)',
    });
    sendJson(res, 200, { ok: true, added, path: relPath });
  } catch (err) {
    sendError(res, 502, 'gitignore_failed', (err as Error).message);
  }
}

// ─── GET /api/brain/team/updates (cache-only, NO network) ────────────────────

export async function handleBrainTeamUpdates(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!gate(res)) return;
  const vaults = listVaults().map((v) => {
    const projectRoot = v.path;
    const config = readSetupConfig(projectRoot);
    const enabled = resolveBrainSyncEnabled(projectRoot, config);
    const local = readBrainLocal(projectRoot);
    return {
      name: v.name,
      enabled: enabled.enabled,
      mode: resolveMode(config),
      updates: local.pulledUpdates ?? 0,
      pendingAgentMerge: !!local.pendingAgentMerge,
    };
  });
  sendJson(res, 200, { vaults });
}

// ─── POST /api/brain/team/fetch (in-process pull-only across vaults) ─────────

export async function handleBrainTeamFetch(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!gate(res)) return;
  const body = await parseJsonBody(req);
  const vault = typeof body?.vault === 'string' ? body.vault.trim() : undefined;
  try {
    const results = await runTeamFetch({ vault });
    sendJson(res, 200, { results });
  } catch (err) {
    sendError(res, 502, 'team_fetch_failed', (err as Error).message);
  }
}
