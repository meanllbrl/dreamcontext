import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError, sendJson } from '../middleware.js';
import { isAgentHost, isAgentRequest, isDesktop } from '../desktop.js';
import { claudeAwarePath } from '../../lib/claude-path.js';
import { listTools } from '../../lib/t3-bridge/registry.js';

/**
 * GET /api/agent/tools — the tools a chat can run on (Track T W1: Claude, Codex) with their
 * readiness and models. Read from disk (registry.ts): no process, no model call, no credential
 * content; the same gate as `/api/agent/model-config` beside it.
 */
export async function handleAgentTools(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!(isAgentHost() && (isDesktop() || isAgentRequest(req)))) {
    sendError(res, 403, 'desktop_only', 'Agent tools are desktop-only.');
    return;
  }
  sendJson(res, 200, { tools: listTools({ path: claudeAwarePath() }) });
}
