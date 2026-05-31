import { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../middleware.js';
import { loadCatalog } from '../../lib/catalog.js';

/**
 * GET /api/packs — Return available packs and standalone skills from the catalog.
 *
 * Imports loadCatalog from lib/catalog.ts — NOT from install-skill.ts — to
 * avoid pulling @inquirer/prompts into the server bundle.
 *
 * Returns { packs: [], standalone: [] } when catalog is unreadable (graceful degradation).
 */
export async function handlePacksGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  _contextRoot: string,
): Promise<void> {
  const loaded = loadCatalog();
  if (!loaded) {
    sendJson(res, 200, { packs: [], standalone: [] });
    return;
  }
  sendJson(res, 200, { packs: loaded.catalog.packs, standalone: loaded.catalog.standalone });
}
