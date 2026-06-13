import { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';
import {
  addConnection,
  listConnections,
  removeConnection,
  type ConnectionDirection,
} from '../../lib/connections.js';
import { currentVaultTarget } from '../../lib/federation-recall.js';
import { VaultError } from '../../lib/vaults.js';

const DIRECTIONS: ConnectionDirection[] = ['out', 'in', 'both'];

/** Resolve the current vault's registered name (or basename) from the context root. */
function currentVaultName(contextRoot: string): string {
  return currentVaultTarget(dirname(contextRoot)).name;
}

/**
 * GET /api/connections — list the current vault's federation connections (P2.2).
 * Read-only; never throws (the underlying read is never-throw).
 */
export async function handleConnectionsList(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  sendJson(res, 200, { connections: listConnections(contextRoot) });
}

/**
 * POST /api/connections — add or upsert a connection (P2.2).
 *
 * Security: STRICT-PICK. Only `vault`, `direction`, and `topics` are read off
 * the body BY NAME — the body is NEVER spread, so a crafted `__proto__` /
 * `constructor` / extra-field payload cannot pollute or smuggle anything.
 * Direction is enum-validated (400 invalid_direction), an unknown peer is
 * rejected (400 invalid_vault), and a self-connect is rejected (400 self_connect).
 *
 * On success returns the full updated connection list so the client never needs
 * a second round-trip to refresh.
 */
export async function handleConnectionsCreate(
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

  // ── Strict-pick: read ONLY known fields by name; never spread the body. ──
  const vault = body.vault;
  if (typeof vault !== 'string' || !vault.trim()) {
    sendError(res, 400, 'invalid_vault', 'vault must be a non-empty string.');
    return;
  }

  const direction = body.direction;
  if (typeof direction !== 'string' || !(DIRECTIONS as string[]).includes(direction)) {
    sendError(res, 400, 'invalid_direction', `direction must be one of: ${DIRECTIONS.join(', ')}.`);
    return;
  }

  let topics: string[] | null = null;
  if (body.topics !== undefined && body.topics !== null) {
    if (!Array.isArray(body.topics) || !body.topics.every((t) => typeof t === 'string')) {
      sendError(res, 400, 'invalid_topics', 'topics must be an array of strings or null.');
      return;
    }
    const cleaned = (body.topics as string[]).map((t) => t.trim()).filter(Boolean);
    topics = cleaned.length > 0 ? cleaned : null;
  }

  try {
    const connections = addConnection(
      contextRoot,
      currentVaultName(contextRoot),
      vault.trim(),
      direction as ConnectionDirection,
      topics,
    );
    sendJson(res, 200, { connections });
  } catch (err) {
    if (err instanceof VaultError) {
      // Map the two business-rule rejections to stable codes the client checks.
      const message = err.message;
      if (/cannot connect to itself/i.test(message)) {
        sendError(res, 400, 'self_connect', message);
        return;
      }
      sendError(res, 400, 'invalid_vault', message);
      return;
    }
    console.error('[connections] create failed:', err);
    sendError(res, 500, 'connection_failed', 'Failed to add connection.');
  }
}

/**
 * DELETE /api/connections/:vault — remove a connection (P2.2). Idempotent at the
 * registry level: a 404 only when no such connection exists.
 *
 * Security: the `:vault` param is used ONLY for connections filtering by name —
 * it is NEVER joined into a filesystem path, so traversal sequences are inert.
 */
export async function handleConnectionsDelete(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const vault = params.vault ?? '';
  const removed = removeConnection(contextRoot, vault);
  if (!removed) {
    sendError(res, 404, 'not_found', `No connection to "${vault}".`);
    return;
  }
  sendJson(res, 200, { connections: listConnections(contextRoot) });
}
