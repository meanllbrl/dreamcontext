import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError, sendJson } from '../middleware.js';
import { isAgentHost, isAgentRequest, isDesktop } from '../desktop.js';
import { refreshCodexHealth } from '../../lib/codex-bin.js';
import { listTools } from '../../lib/t3-bridge/registry.js';
import { refreshAntigravityModels } from '../../lib/antigravity-models.js';

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
  await refreshCodexHealth();
  // Antigravity's list is the runtime's last answer; a stale one is re-asked off this request.
  try { refreshAntigravityModels().catch(() => { /* the cached list stands */ }); } catch { /* the cached list stands */ }
  sendJson(res, 200, { tools: listTools() });
}
