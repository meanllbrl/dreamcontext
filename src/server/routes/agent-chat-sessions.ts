import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../middleware.js';
import { isAgentHost } from '../desktop.js';
import { projectRootOf } from './agent-spawn-shared.js';
import { listPastSessions, listTranscriptFiles, DEFAULT_LIMIT, MAX_LIMIT } from '../../lib/transcript-sessions.js';
import { contentOf, ensureContentIndex } from '../../lib/transcript-content-index.js';
import { readSessionTitles } from '../../lib/session-titles.js';

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
 * every prompt harvested from a session's head, plus the full conversation text kept by
 * `lib/transcript-content-index.ts` — stays server-side; shipping it would be megabytes.
 *
 * Content indexing is ASYNC and starts on any listing (the picker's open is the warm-up). A
 * queried listing waits at most {@link CONTENT_WAIT_MS} for it; if the index is still being
 * built it answers from what is indexed so far and says so with `indexing: {done,total}`,
 * which the picker uses to ask again. The server is never blocked by it.
 */

/** How long a search waits for a running content index before answering partially. */
const CONTENT_WAIT_MS = 1500;

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
  if (!isAgentHost() || !contextRoot) { sendJson(res, 200, empty); return; }
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const query = Object.fromEntries(url.searchParams);
  try {
    sendJson(res, 200, await computeChatSessions(contextRoot, query));
  } catch {
    // A history list is a convenience surface: an unreadable projects dir degrades to
    // "no past chats", never to a broken popup.
    sendJson(res, 200, empty);
  }
}

/** The list itself. Throws on an unreadable dir. */
export async function computeChatSessions(
  contextRoot: string,
  q: Record<string, string>,
  opts: { home?: string; waitMs?: number } = {},
): Promise<unknown> {
  const query = (q.q || '').slice(0, MAX_QUERY_CHARS);
  const rawLimit = Number.parseInt(q.limit || '', 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(MAX_LIMIT, Math.max(1, rawLimit))
    : DEFAULT_LIMIT;

  // Machine-spawned sessions (goal-skill builders, the Sleep agent, scheduled automations,
  // council personas) are withheld by default — they outnumber real conversations several to
  // one. `agentRuns=1` is the picker's "show them anyway".
  const includeAgentRuns = q.agentRuns === '1';

  const projectRoot = projectRootOf(contextRoot);
  const files = listTranscriptFiles(projectRoot, opts.home);
  const build = ensureContentIndex(files.files);
  let indexed = false;
  if (query.trim()) {
    let timer: NodeJS.Timeout | undefined;
    const wait = new Promise<void>((r) => { timer = setTimeout(r, opts.waitMs ?? CONTENT_WAIT_MS); });
    indexed = await Promise.race([build.promise.then(() => true), wait.then(() => false)]);
    clearTimeout(timer);
  } else {
    // A plain listing never waits; it only starts the warm-up.
    build.promise.catch(() => {});
  }

  const result = listPastSessions(projectRoot, {
    home: opts.home, query, limit, includeAgentRuns, files,
    content: contentOf,
    // A closed tab's name, so the list says what the tab said (see `session-titles.ts`).
    titles: readSessionTitles(contextRoot),
  });
  return query.trim() && !indexed
    ? { ...result, indexing: { done: build.progress.done, total: build.progress.total } }
    : result;
}
