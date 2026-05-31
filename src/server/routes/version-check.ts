import { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { sendJson } from '../middleware.js';
import { readVersionCache, isCacheFresh, buildNudge } from '../../lib/version-check.js';
import { dreamcontextVersion } from '../../lib/manifest.js';
import { readSetupConfig } from '../../lib/setup-config.js';

/**
 * GET /api/version-check — Return cached update nudge data.
 *
 * Cache-only: no network calls or subprocesses in the request path.
 * The networked refreshVersionCache stays out-of-band (hook/CLI).
 *
 * On any read failure, returns a benign payload (never 500).
 */
export async function handleVersionCheckGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const projectRoot = dirname(contextRoot);
    const cache = readVersionCache(projectRoot);
    const fresh = isCacheFresh(cache);
    const installedCli = dreamcontextVersion();
    const installedPacks = readSetupConfig(projectRoot)?.packs ?? [];
    const catalogPackNames = cache?.availablePacks ?? [];
    const nudge = buildNudge(installedCli, fresh ? cache : null, installedPacks, catalogPackNames);
    sendJson(res, 200, { cache, fresh, nudge });
  } catch {
    sendJson(res, 200, { cache: null, fresh: false, nudge: null });
  }
}
