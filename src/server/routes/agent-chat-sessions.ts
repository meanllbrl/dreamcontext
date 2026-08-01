import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../middleware.js';
import { isDesktop } from '../desktop.js';
import { projectRootOf } from './agent-spawn-shared.js';
import { listPastSessions, DEFAULT_LIMIT, MAX_LIMIT } from '../../lib/transcript-sessions.js';

/**
 * `GET /api/agent/chat-sessions` — the project's PAST Claude conversations, newest first,
 * for the Agent surface's history picker ("Past chats"). Each row carries the conversation
 * UUID, so picking one is just the resume path the surface already has
 * (`spawn(bypass, id, resume=true)` → `--resume <id>` → `chat-history` replays it).
 *
 * Read-only and derived entirely from `~/.claude/projects/<slug>/*.jsonl` — the same
 * transcript channel `chat-history` and `session-stats` already read, with the same
 * posture: desktop-gated (a browser dashboard gets an empty list, never someone's
 * conversations), server-DERIVED paths only (the client supplies no path, ever), and
 * scoped to the ACTIVE vault's project root, so one project can't list another's history.
 *
 * Search happens here rather than in the client because the index it matches against —
 * every prompt harvested from a session's head — stays server-side; see
 * `lib/transcript-sessions.ts` for why shipping it would be megabytes.
 */

/** Query ceiling. Longer than any real search and short enough that the token split
 *  can't turn into work. */
const MAX_QUERY_CHARS = 200;

export async function handleAgentChatSessions(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string | null,
): Promise<void> {
  const empty = { sessions: [], total: 0, agentRuns: 0, truncated: false };
  if (!isDesktop() || !contextRoot) { sendJson(res, 200, empty); return; }

  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const query = (url.searchParams.get('q') || '').slice(0, MAX_QUERY_CHARS);
  const rawLimit = Number.parseInt(url.searchParams.get('limit') || '', 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(MAX_LIMIT, Math.max(1, rawLimit))
    : DEFAULT_LIMIT;

  // Machine-spawned sessions (goal-skill builders, the Sleep agent, scheduled automations,
  // council personas) are withheld by default — they outnumber real conversations several to
  // one. `agentRuns=1` is the picker's "show them anyway".
  const includeAgentRuns = url.searchParams.get('agentRuns') === '1';

  try {
    sendJson(res, 200, listPastSessions(projectRootOf(contextRoot), { query, limit, includeAgentRuns }));
  } catch {
    // A history list is a convenience surface: an unreadable projects dir degrades to
    // "no past chats", never to a broken popup.
    sendJson(res, 200, empty);
  }
}
