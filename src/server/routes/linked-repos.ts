import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';
import { isDesktop } from '../desktop.js';
import { resolveBrainSyncToken } from '../../lib/git-sync/brain-repo.js';
import {
  resolveLinkedRepos,
  linkRepo,
  unlinkRepo,
  cloneLinkedRepo,
  LinkedRepoError,
} from '../../lib/linked-repos.js';

/**
 * `/api/linked-repos/*` — the vault-scoped linked-repos routes. Every handler is
 * a THIN layer over the in-process `linked-repos.ts` functions. Desktop-gated
 * (403 otherwise) + loopback + CSRF (server entry) + STRICT-PICK bodies (each
 * field read by name, never spread). `/link` delegates ALL validation to
 * `linkRepo`; `/clone` requires `confirmed===true` (400) + a token (401) before
 * cloning. A `LinkedRepoError` maps to 400.
 *
 * `contextRoot` is `<vault>/_dream_context`; `projectRoot = dirname(contextRoot)`.
 */

function gate(res: ServerResponse): boolean {
  if (!isDesktop()) {
    sendError(res, 403, 'desktop_only', 'Linked repos are only available in the desktop app.');
    return false;
  }
  return true;
}

// ─── GET /api/linked-repos (present/missing + resolved path — no net/git) ──────

export async function handleLinkedReposList(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!gate(res)) return;
  const projectRoot = dirname(contextRoot);
  sendJson(res, 200, { repos: resolveLinkedRepos(projectRoot) });
}

// ─── POST /api/linked-repos/link ───────────────────────────────────────────────

export async function handleLinkedReposLink(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!gate(res)) return;
  const projectRoot = dirname(contextRoot);
  const body = await parseJsonBody(req);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const path = typeof body?.path === 'string' ? body.path.trim() : '';
  const url = typeof body?.url === 'string' && body.url.trim() ? body.url.trim() : undefined;
  if (!name || !path) {
    sendError(res, 400, 'invalid_body', 'name and path are required.');
    return;
  }
  try {
    const entry = linkRepo(projectRoot, name, path, { url });
    sendJson(res, 200, { ok: true, entry, repos: resolveLinkedRepos(projectRoot) });
  } catch (err) {
    if (err instanceof LinkedRepoError) {
      sendError(res, 400, 'link_failed', err.message);
      return;
    }
    throw err;
  }
}

// ─── POST /api/linked-repos/clone (trust-gated) ────────────────────────────────

export async function handleLinkedReposClone(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!gate(res)) return;
  const projectRoot = dirname(contextRoot);
  const body = await parseJsonBody(req);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const dir = typeof body?.dir === 'string' && body.dir.trim() ? body.dir.trim() : undefined;
  const confirmed = body?.confirmed === true;
  if (!name) {
    sendError(res, 400, 'invalid_body', 'name is required.');
    return;
  }
  if (!confirmed) {
    sendError(res, 400, 'needs_confirm', 'Cloning a linked repo needs an explicit confirmation (the URL is team-writable).');
    return;
  }
  if (!resolveBrainSyncToken(projectRoot)) {
    sendError(res, 401, 'no_token', 'Sign in with GitHub before cloning a linked repo.');
    return;
  }
  try {
    const dest = await cloneLinkedRepo(projectRoot, name, { dir, confirmed: true });
    sendJson(res, 200, { ok: true, path: dest, repos: resolveLinkedRepos(projectRoot) });
  } catch (err) {
    if (err instanceof LinkedRepoError) {
      sendError(res, 400, 'clone_failed', err.message);
      return;
    }
    throw err;
  }
}

// ─── POST /api/linked-repos/unlink ─────────────────────────────────────────────

export async function handleLinkedReposUnlink(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!gate(res)) return;
  const projectRoot = dirname(contextRoot);
  const body = await parseJsonBody(req);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) {
    sendError(res, 400, 'invalid_body', 'name is required.');
    return;
  }
  const removed = unlinkRepo(projectRoot, name);
  sendJson(res, 200, { ok: true, removed, repos: resolveLinkedRepos(projectRoot) });
}
