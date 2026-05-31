import { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';
import { readSetupConfig, updateSetupConfig } from '../../lib/setup-config.js';
import { parsePlatformList, PLATFORM_CATALOG } from '../../lib/platforms.js';

/**
 * GET /api/config — Return the current project's setup config.
 * Always 200; returns null config when the config file does not exist.
 */
export async function handleConfigGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const config = readSetupConfig(dirname(contextRoot));
  sendJson(res, 200, { config });
}

/**
 * PATCH /api/config — Update platforms and/or packs via a strict allow-list.
 *
 * Security: the body is NEVER spread. Only 'platforms' and 'packs' are picked
 * explicitly so prototype-pollution and unexpected field injection are impossible.
 */
export async function handleConfigUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Request body must be valid JSON.');
    return;
  }

  // Build a FRESH patch from the explicit allow-list — never spread body.
  const patch: { platforms?: ReturnType<typeof parsePlatformList>['platforms']; packs?: string[] } = {};

  if (body.platforms !== undefined) {
    // Validate: must be an array of strings, then pass through parsePlatformList.
    if (!Array.isArray(body.platforms) || !body.platforms.every((p) => typeof p === 'string')) {
      sendError(res, 400, 'invalid_platforms', `Platforms must be an array of platform IDs. Supported: ${PLATFORM_CATALOG.map(p => p.id).join(', ')}.`);
      return;
    }
    const { platforms: validPlatforms, invalid } = parsePlatformList(body.platforms.join(','));
    if (invalid.length > 0) {
      sendError(res, 400, 'invalid_platforms', `Unknown platform(s): ${invalid.join(', ')}. Supported: ${PLATFORM_CATALOG.map(p => p.id).join(', ')}.`);
      return;
    }
    patch.platforms = validPlatforms;
  }

  if (body.packs !== undefined) {
    if (
      !Array.isArray(body.packs) ||
      !body.packs.every((el) => typeof el === 'string' && el.length > 0)
    ) {
      sendError(res, 400, 'invalid_packs', 'Packs must be a non-empty array of non-empty strings.');
      return;
    }
    patch.packs = body.packs as string[];
  }

  if (patch.platforms === undefined && patch.packs === undefined) {
    sendError(res, 400, 'no_changes', 'Provide at least one of: platforms, packs.');
    return;
  }

  const next = updateSetupConfig(dirname(contextRoot), patch);
  sendJson(res, 200, { config: next });
}
