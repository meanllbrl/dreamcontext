import { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../middleware.js';

/**
 * API capabilities the CURRENT server process supports. The dashboard bundle
 * is served fresh from disk on every request, but this process keeps its
 * route table in memory — after an update, a long-running server serves a
 * NEW bundle with an OLD API. The bundle compares this list against what it
 * needs and shows a restart banner on mismatch. Append a name whenever a
 * route the dashboard depends on is added.
 */
const CAPABILITIES = [
  'tasks.members',
  'tasks.delete',
  'tasks.sync',
  'tasks.sync-status',
  'tasks.sync-test',
  'config.task-backend',
];

export async function handleHealthGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  sendJson(res, 200, { ok: true, contextRoot, capabilities: CAPABILITIES });
}
