import { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../middleware.js';
import { dreamcontextVersion } from '../../lib/manifest.js';

/**
 * LEGACY capability list, kept only so OLDER dashboard bundles (which compare
 * against it) don't false-positive their stale-server banner against a new
 * server. Version skew is now detected by the `version` field below — an exact
 * bundle↔server version handshake — plus the server-side version-drift watch
 * that exits an upgraded-under server outright (lifecycle.ts). Do NOT extend
 * this list for new routes; it proved unmaintainable (the tasks.token routes
 * shipped in v0.10.0 without an entry, so the banner never fired and users hit
 * raw "No route" errors).
 */
const CAPABILITIES = [
  'tasks.members',
  'tasks.delete',
  'tasks.sync',
  'tasks.sync-status',
  'tasks.sync-test',
  'config.task-backend',
  'tasks.containers',
  'tasks.provision',
  'tasks.token',
  'tasks.token-status',
];

export async function handleHealthGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  sendJson(res, 200, {
    ok: true,
    contextRoot,
    capabilities: CAPABILITIES,
    // The version this PROCESS is running (not what's on disk) — the bundle
    // and ensure-dashboard compare it against their own to detect skew.
    version: dreamcontextVersion(),
  });
}
