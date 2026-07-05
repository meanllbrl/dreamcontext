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
  createBrainRepo,
  discoverBrainRepos,
  attachBrainRepo,
  previewAttach,
} from '../../lib/git-sync/brain-repo.js';
import { runBrainSync } from '../../lib/git-sync/sync-engine.js';
import { readGlobalGitHubLogin } from '../../lib/git-sync/auth-store.js';
import { runTeamFetch } from '../../lib/git-sync/team-fetch.js';
import { listVaults } from '../../lib/vaults.js';

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
  const gitCwd = mode === 'separate' ? contextRoot : projectRoot;
  let remote: string | null = null;
  try { remote = git.isGitRepo(gitCwd) ? git.getRemoteUrl(gitCwd, 'origin') : null; } catch { remote = null; }
  let mergeInProgress = false;
  try { mergeInProgress = git.isGitRepo(gitCwd) && git.hasMergeHead(gitCwd); } catch { mergeInProgress = false; }

  sendJson(res, 200, {
    enabled: enabled.enabled,
    source: enabled.source,
    mode,
    remote,
    hasRemote: !!remote,
    mergeInProgress,
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
  const body = await parseJsonBody(req);
  const mode: 'pull-only' | 'auto' = body?.mode === 'auto' ? 'auto' : 'pull-only';
  try {
    const result = await runBrainSync({ cwd: contextRoot, mode });
    sendJson(res, 200, {
      action: result.action,
      pulledUpdates: result.pulledUpdates ?? 0,
      scrub: { blocks: result.scrub.blocks, warns: result.scrub.warns },
      note: result.note,
    });
  } catch (err) {
    sendError(res, 502, 'sync_failed', (err as Error).message);
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
