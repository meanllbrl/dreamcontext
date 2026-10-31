import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../middleware.js';
import { isAgentHost } from '../desktop.js';
import { projectRootOf } from './agent-spawn-shared.js';
import { listPastSessions, listTranscriptFiles, DEFAULT_LIMIT, MAX_LIMIT } from '../../lib/transcript-sessions.js';
import { contentOf, ensureContentIndex } from '../../lib/transcript-content-index.js';
import { readSessionTitles } from '../../lib/session-titles.js';
import { readSuperState } from '../../lib/super/store.js';
import { superSanitizeOpts } from '../../lib/super/inbox.js';

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

  const listing = (o: { limit: number; includeAgentRuns: boolean }) => listPastSessions(projectRoot, {
    home: opts.home, query, ...o, files,
    content: contentOf,
    // A closed tab's name, so the list says what the tab said (see `session-titles.ts`).
    titles: readSessionTitles(contextRoot),
  });
  const result = q.super === 'group' || q.super === 'only'
    ? await withSuperGrouped(contextRoot, q.super, !!query.trim(), limit, includeAgentRuns, listing)
    : listing({ limit, includeAgentRuns });
  return query.trim() && !indexed
    ? { ...result, indexing: { done: build.progress.done, total: build.progress.total } }
    : result;
}

type Listing = ReturnType<typeof listPastSessions>;

/**
 * The new shell's History (owner 2026-10-31): one "Super Agent" entry per project, never its
 * sessions one by one. A view over the listing, read from the Super record's ownership:
 *  - `group`, no query: the owner's chats plus `superGroup` (how many, the last activity);
 *  - `group`, a query: every match, a Super session's marked `super`, so a search hides nothing;
 *  - `only`: the project's Super sessions, for the entry opened.
 * A Super session counts whether or not the listing files it under agent runs.
 */
export async function withSuperGrouped(
  contextRoot: string,
  mode: 'group' | 'only',
  queried: boolean,
  limit: number,
  includeAgentRuns: boolean,
  listing: (o: { limit: number; includeAgentRuns: boolean }) => Listing,
): Promise<Listing & { superGroup?: { count: number; lastAt: number } }> {
  let owned = new Set<string>();
  try {
    const s = await readSuperState(contextRoot, superSanitizeOpts());
    owned = new Set([...Object.keys(s.children), ...(s.formerChildren ?? []), ...(s.session ? [s.session] : [])]);
  } catch { /* no readable record: nothing is the Super's, the list stays whole */ }
  const asked = listing({ limit: queried ? MAX_LIMIT : limit, includeAgentRuns });
  const all = listing({ limit: MAX_LIMIT, includeAgentRuns: true });
  const supers = all.sessions.filter((s) => owned.has(s.id));
  if (mode === 'only') return { ...asked, sessions: supers.slice(0, limit).map((s) => ({ ...s, super: true })), total: supers.length, agentRuns: 0 };
  const shownIds = new Set(asked.sessions.map((s) => s.id));
  const hiddenSupers = supers.filter((s) => !shownIds.has(s.id)).length;
  const agentRuns = Math.max(0, asked.agentRuns - hiddenSupers);
  if (queried) {
    const rows = all.sessions.filter((s) => owned.has(s.id) || shownIds.has(s.id)).slice(0, limit);
    return { ...asked, sessions: rows.map((s) => (owned.has(s.id) ? { ...s, super: true } : s)), agentRuns };
  }
  const mine = asked.sessions.filter((s) => !owned.has(s.id));
  return {
    ...asked, sessions: mine, total: Math.max(0, asked.total - (supers.length - hiddenSupers)), agentRuns,
    ...(supers.length ? { superGroup: { count: supers.length, lastAt: Math.max(...supers.map((s) => s.updatedAt)) } } : {}),
  };
}
