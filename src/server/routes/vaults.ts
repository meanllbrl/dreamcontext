import { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';
import { listVaults, addVault, removeVault, VaultError } from '../../lib/vaults.js';

/**
 * GET /api/vaults — Return registered vaults and the current project's directory.
 *
 * Read-only. Never 500 — returns [] on any registry error (listVaults never throws).
 */
export async function handleVaultsGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  sendJson(res, 200, { vaults: listVaults(), current: dirname(contextRoot) });
}

/**
 * POST /api/vaults — Register a new vault.
 *
 * Body: { name: string; path: string }
 * Returns the updated vault list on success.
 * Errors: 400 invalid_body, 400 invalid_vault.
 */
export async function handleVaultsPost(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (
    !body ||
    typeof body.name !== 'string' ||
    !body.name.trim() ||
    typeof body.path !== 'string' ||
    !body.path.trim()
  ) {
    sendError(res, 400, 'invalid_body', 'name and path are required.');
    return;
  }

  try {
    addVault(body.name.trim(), body.path.trim());
  } catch (e) {
    if (e instanceof VaultError) {
      sendError(res, 400, 'invalid_vault', e.message);
      return;
    }
    throw e;
  }

  sendJson(res, 200, { vaults: listVaults(), current: dirname(contextRoot) });
}

/**
 * DELETE /api/vaults/:name — Unregister a vault by name.
 *
 * Returns the updated vault list on success.
 * Errors: 404 not_found.
 */
export async function handleVaultsDelete(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const name = params.name;
  const removed = removeVault(name);
  if (!removed) {
    sendError(res, 404, 'not_found', `No registered vault: ${name}`);
    return;
  }
  sendJson(res, 200, { vaults: listVaults(), current: dirname(contextRoot) });
}
