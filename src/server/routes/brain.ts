import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, dirname } from 'node:path';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';
import { isDesktop } from '../desktop.js';
import { readSetupConfig, updateSetupConfig, readBrainLocal } from '../../lib/setup-config.js';
import * as git from '../../lib/git-sync/git.js';
import {
  resolveMode,
  resolveBrainSyncEnabled,
  ensureFullRepoGitignore,
  resolveBrainSyncToken,
} from '../../lib/git-sync/brain-repo.js';
import {
  createProjectOrigin,
  attachProjectOrigin,
  previewOrigin,
} from '../../lib/git-sync/origin-setup.js';
import { runBrainSync } from '../../lib/git-sync/sync-engine.js';
import { runTeamFetch } from '../../lib/git-sync/team-fetch.js';
import { readConflictReport } from '../../lib/git-sync/conflict-report.js';
import { classifySyncError, type SyncFailure } from '../../lib/git-sync/failure.js';
import { setGlobalGitHubAuthValid } from '../../lib/git-sync/auth-store.js';
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
 * `/api/brain/*` — the vault-scoped whole-project cloud-sync routes. Every
 * handler is a THIN LAYER over the in-process sync functions (runBrainSync /
 * updateSetupConfig / ensureFullRepoGitignore) — it NEVER spawns the CLI.
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

  // `remote` is the repo cloud-sync actually pushes to. `full-repo` → the
  // PROJECT's own `origin` (the whole folder is the synced unit). `in-tree` is
  // commit-only and never pushes, so it has NO sync remote; the code origin
  // still goes out as `codeOrigin` (display context only).
  let remote: string | null = null;
  let mergeInProgress = false;
  if (mode === 'full-repo') {
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
  sendJson(res, 200, await runSyncPayload(projectRoot, contextRoot, { mode, foreground, noCheckpoint }));
}

interface SyncPayload {
  action: string;
  pulledUpdates: number;
  scrub: { blocks: unknown[]; warns: unknown[] };
  note?: string;
  checkpointed?: boolean;
  checkpointSha?: string;
  codeConflicts?: string[];
  failure?: SyncFailure;
}

/**
 * Run one sync and shape it into the dashboard's `BrainSyncResult` payload —
 * shared by `POST /brain/sync` and the origin create/attach first-sync. A thrown
 * GitSyncError (push-rejected, auth, network, permission, unrelated histories) is
 * classified into a specific, recoverable failure — never a bare "Sync failed" —
 * and returned as `action:'error'` (HTTP 200) so the UI can render the message +
 * its recovery affordance. A `no-remote` with a "no token" note is a NOT-CONNECTED
 * state (not an expired sign-in), so it gets a `no-token` failure — never the
 * alarming "sign-in expired" copy.
 *
 * The ACTUAL git auth result is the single source of truth for the session's
 * validity: a talked-to-the-remote outcome (or an authenticated-then-rejected
 * permission error) clears the reconnect flag; an auth-rejected op sets it. The
 * Settings session chip reads the SAME flag, so the two surfaces cannot disagree.
 */
async function runSyncPayload(
  projectRoot: string,
  contextRoot: string,
  opts: { mode: 'pull-only' | 'auto'; foreground: boolean; noCheckpoint?: boolean },
): Promise<SyncPayload> {
  try {
    const result = await runBrainSync({ cwd: contextRoot, mode: opts.mode, foreground: opts.foreground, noCheckpoint: opts.noCheckpoint });
    // Any outcome that REACHED the remote proves the stored token still authenticates.
    if (AUTH_OK_ACTIONS.has(result.action)) setGlobalGitHubAuthValid(true);
    let failure: SyncFailure | undefined;
    if (result.action === 'no-remote' && /token/i.test(result.note ?? '')) {
      failure = classifySyncError(result.note ?? 'no github token found', syncRepoHint(projectRoot));
    }
    return {
      action: result.action,
      pulledUpdates: result.pulledUpdates ?? 0,
      scrub: { blocks: result.scrub.blocks, warns: result.scrub.warns },
      note: result.note,
      checkpointed: !!result.checkpointed,
      checkpointSha: result.checkpointSha,
      codeConflicts: result.codeConflicts,
      failure,
    };
  } catch (err) {
    const failure = classifySyncError((err as Error).message, syncRepoHint(projectRoot));
    // Only a GENUINELY auth-rejected op flags the session invalid. A permission
    // error means GitHub accepted the credential (it just lacks a scope), so the
    // session is still valid; network/unknown leave validity untouched.
    if (failure.kind === 'auth') setGlobalGitHubAuthValid(false);
    else if (failure.kind === 'permission') setGlobalGitHubAuthValid(true);
    return {
      action: 'error',
      pulledUpdates: 0,
      scrub: { blocks: [], warns: [] },
      note: failure.message,
      failure,
    };
  }
}

/**
 * Sync outcomes that could only happen AFTER a successful fetch/push handshake
 * with the remote — i.e. the stored token authenticated. Pre-network outcomes
 * (`no-remote`, `disabled`, `locked`, `invalid-flag`, `already-awaiting-agent`,
 * `user-merge-in-progress`, `detached-head`, `skipped-in-tree`) are excluded: they
 * prove nothing about the token, so they must not clear a real reconnect flag.
 */
const AUTH_OK_ACTIONS = new Set(['pulled', 'pushed', 'noop', 'merged', 'blocked-scrub', 'awaiting-agent', 'code-conflict']);

/** Best-effort `owner/repo` (or remote URL) for a failure message — the repo sync pushes to. */
function syncRepoHint(projectRoot: string, _result?: unknown): string | undefined {
  try {
    return (git.isGitRepo(projectRoot) ? git.getRemoteUrl(projectRoot, 'origin') : null) ?? undefined;
  } catch {
    return undefined;
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
  const mode = resolveMode(config);
  const remote = mode === 'full-repo' && git.isGitRepo(projectRoot)
    ? (git.getRemoteUrl(projectRoot, 'origin') ?? null)
    : null;
  sendJson(res, 200, {
    enabled: enabled.enabled,
    source: enabled.source,
    mode,
    autoSync: config?.brainRepo?.autoSync ?? false,
    remote,
  });
}

// ─── POST /api/brain/settings (master toggle — enable = whole-project sync) ───

/**
 * The single cloud-sync switch. Enabling turns on `full-repo` sync (the whole
 * project → the project's own `origin`) — it requires a GitHub `origin` (400
 * `no_origin` without one) and lays down the gitignore-first machine-local
 * excludes. Disabling reverts to `in-tree` (commit-only, never pushes).
 */
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
  const config = readSetupConfig(projectRoot);

  if (body.enabled) {
    let origin: string | null = null;
    try { origin = git.isGitRepo(projectRoot) ? git.getRemoteUrl(projectRoot, 'origin') : null; } catch { origin = null; }
    if (!origin) {
      sendError(res, 400, 'no_origin', 'Whole-project sync needs a GitHub `origin` on this project. Add one (git remote add origin …) and try again.');
      return;
    }
    updateSetupConfig(projectRoot, {
      brainRepo: { ...(config?.brainRepo ?? {}), mode: 'full-repo', enabled: true, autoSync: true },
    });
    // Gitignore-first: exclude machine-local brain state + secrets before the
    // first whole-project sync can stage them.
    ensureFullRepoGitignore(projectRoot, config?.taskBackend);
  } else {
    updateSetupConfig(projectRoot, {
      brainRepo: { ...(config?.brainRepo ?? {}), mode: 'in-tree', enabled: false },
    });
  }

  const next = readSetupConfig(projectRoot);
  const resolved = resolveBrainSyncEnabled(projectRoot, next);
  const nextMode = resolveMode(next);
  const remote = nextMode === 'full-repo' && git.isGitRepo(projectRoot)
    ? (git.getRemoteUrl(projectRoot, 'origin') ?? null)
    : null;
  sendJson(res, 200, {
    enabled: resolved.enabled,
    source: resolved.source,
    mode: nextMode,
    autoSync: next?.brainRepo?.autoSync ?? false,
    remote,
  });
}

// ─── Origin setup (create / attach a GitHub `origin` for whole-project sync) ──

/**
 * Flip config to `full-repo` + enabled + autoSync and lay down the gitignore-first
 * machine-local excludes — the exact "enable" side-effects, factored so the origin
 * create/attach routes can enable then immediately run the first sync.
 */
function enableFullRepo(projectRoot: string): void {
  const config = readSetupConfig(projectRoot);
  updateSetupConfig(projectRoot, {
    brainRepo: { ...(config?.brainRepo ?? {}), mode: 'full-repo', enabled: true, autoSync: true },
  });
  ensureFullRepoGitignore(projectRoot, config?.taskBackend);
}

/** Best-effort current `origin` (null when not a repo / no origin). */
function currentOrigin(projectRoot: string): string | null {
  try { return git.isGitRepo(projectRoot) ? git.getRemoteUrl(projectRoot, 'origin') : null; } catch { return null; }
}

// ─── POST /api/brain/origin/create (new private GitHub repo → project origin) ─

/**
 * Create a new GitHub repo (default PRIVATE — S5) under the signed-in account,
 * wire it as the project's `origin`, enable full-repo sync, and run the first
 * sync to bootstrap+push the initial commit. Refuses if the project already has
 * an `origin` (409 — just turn Cloud sync on) or no GitHub token (401).
 */
export async function handleBrainOriginCreate(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!gate(res)) return;
  const projectRoot = dirname(contextRoot);
  const body = await parseJsonBody(req);

  if (!resolveBrainSyncToken(projectRoot)) {
    sendError(res, 401, 'no_token', 'Sign in with GitHub before creating a repo.');
    return;
  }
  if (currentOrigin(projectRoot)) {
    sendError(res, 409, 'origin_exists', 'This project already has a git origin — turn on Cloud sync to use it.');
    return;
  }

  const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : basename(projectRoot);
  const isPrivate = body?.private !== false; // default PRIVATE
  const confirmed = body?.confirmed === true;

  try {
    const created = await createProjectOrigin({ projectRoot, name, private: isPrivate, confirmed });
    enableFullRepo(projectRoot);
    const sync = await runSyncPayload(projectRoot, contextRoot, { mode: 'auto', foreground: true });
    sendJson(res, 200, { ok: true, remote: created.remote, fullName: created.fullName, private: created.private, sync });
  } catch (err) {
    // The repo-creation call failed (name taken, missing `repo` scope, public
    // without confirm, …) — surface the GitHub/validation message verbatim. No
    // origin was wired, so the UI stays on the setup panel.
    sendError(res, 400, 'create_failed', (err as Error).message);
  }
}

// ─── POST /api/brain/origin/preview (READ-ONLY reachability for attach) ──────

/** GET-metadata for a candidate repo so the UI can confirm before attaching. */
export async function handleBrainOriginPreview(
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
  const preview = await previewOrigin({ projectRoot, url });
  sendJson(res, 200, preview);
}

// ─── POST /api/brain/origin/attach (existing repo URL → project origin) ──────

/**
 * Wire an existing GitHub repo as the project's `origin`, enable full-repo sync,
 * and run the first sync. Validates reachability first (a bad URL / unreadable
 * repo returns 400 with the reason). Refuses if the project already has an
 * `origin` (409) or no GitHub token (401).
 */
export async function handleBrainOriginAttach(
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
  if (!resolveBrainSyncToken(projectRoot)) {
    sendError(res, 401, 'no_token', 'Sign in with GitHub before attaching a repo.');
    return;
  }
  if (currentOrigin(projectRoot)) {
    sendError(res, 409, 'origin_exists', 'This project already has a git origin — turn on Cloud sync to use it.');
    return;
  }

  const preview = await previewOrigin({ projectRoot, url });
  if (!preview.reachable) {
    sendError(res, 400, 'unreachable', preview.reason ?? 'That repo could not be reached with your GitHub account.');
    return;
  }

  try {
    const attached = attachProjectOrigin({ projectRoot, url });
    enableFullRepo(projectRoot);
    const sync = await runSyncPayload(projectRoot, contextRoot, { mode: 'auto', foreground: true });
    sendJson(res, 200, { ok: true, remote: attached.remote, fullName: attached.fullName, private: preview.private, sync });
  } catch (err) {
    sendError(res, 400, 'attach_failed', (err as Error).message);
  }
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
  // full-repo/in-tree both stage the whole project, so the ignore rule belongs
  // in the project-root .gitignore.
  try {
    const added = ensureGitignoreEntries(projectRoot, [relPath], {
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
