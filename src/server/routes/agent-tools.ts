import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError, sendJson } from '../middleware.js';
import { isAgentHost, isAgentRequest, isDesktop } from '../desktop.js';
import { listTools } from '../../lib/t3-bridge/registry.js';

/**
 * GET /api/agent/tools — the tools a chat can run on (Track T W1: Claude, Codex) with their
 * readiness and models (registry.ts): no model call, no credential content, and the same finder
 * a chat starts Codex with; the same gate as `/api/agent/model-config` beside it.
 */
export async function handleAgentTools(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!(isAgentHost() && (isDesktop() || isAgentRequest(req)))) {
    sendError(res, 403, 'desktop_only', 'Agent tools are desktop-only.');
    return;
  }
  sendJson(res, 200, { tools: listTools() });
}
