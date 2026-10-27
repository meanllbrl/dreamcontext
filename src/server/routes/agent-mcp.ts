import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError } from '../middleware.js';

/**
 * The old `/mcp` panel's routes (a `claude -p "/mcp"` probe and `claude mcp login/logout`),
 * retired by task mcp-management W1: `claude mcp login` cannot see a `--mcp-config` server,
 * so the panel could never sign one in. W2 replaces them with the live-session routes.
 */
function gone(res: ServerResponse): void {
  sendError(res, 410, 'gone', 'This MCP panel was replaced. Use /mcp in the chat or Settings → MCP.');
}

export async function handleAgentMcpList(_req: IncomingMessage, res: ServerResponse): Promise<void> { gone(res); }
export async function handleAgentMcpLogin(_req: IncomingMessage, res: ServerResponse): Promise<void> { gone(res); }
export async function handleAgentMcpLogout(_req: IncomingMessage, res: ServerResponse): Promise<void> { gone(res); }
