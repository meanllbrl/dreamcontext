import { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { sendJson } from '../middleware.js';
import { listVaults } from '../../lib/vaults.js';

/**
 * GET /api/vaults — list every registered vault and identify the current one
 * (P2.2). The dashboard uses this to render the connections manager with the
 * current vault highlighted.
 *
 * `current` is the registered name of the vault whose path matches the project
 * this server is serving (`dirname(contextRoot)`), or `null` when the current
 * project is not itself registered.
 *
 * NET-NEW route — the issue's claim that `/api/vaults` already exists is wrong.
 * Read-only; no body, no params used for any filesystem access.
 */
export async function handleVaultsGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string | null,
): Promise<void> {
  const vaults = listVaults();
  // In launcher mode there is no pinned project, so `current` is null.
  const current = contextRoot
    ? (vaults.find((v) => resolve(v.path) === resolve(dirname(contextRoot)))?.name ?? null)
    : null;
  sendJson(res, 200, { vaults, current });
}
