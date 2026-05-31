import { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { sendJson } from '../middleware.js';
import { listVaults } from '../../lib/vaults.js';

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
