import { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../middleware.js';
import { requestShutdown } from '../lifecycle.js';

/**
 * POST /api/admin/shutdown — ask this server process to exit gracefully.
 *
 * Exists for version-skew healing: `hook ensure-dashboard` calls it when the
 * running server's /api/health version doesn't match the CLI's, then spawns a
 * fresh server on the same port. Loopback-only exposure + the global
 * cross-site-write guard (isCrossSiteWrite in index.ts) cover it; the worst a
 * local caller can do is stop a server the same user could kill anyway.
 *
 * Responds BEFORE exiting so the caller gets a clean 200 instead of a reset
 * socket; the actual shutdown runs on a short timer.
 */
export async function handleAdminShutdown(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  sendJson(res, 200, { ok: true, shuttingDown: true });
  setTimeout(() => {
    if (!requestShutdown()) {
      // No handler registered (should not happen once listening) — hard exit
      // beats living on as exactly the stale server this route exists to kill.
      process.exit(0);
    }
  }, 150).unref?.();
}
