import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { sendJson } from '../middleware.js';
import { isAgentHost } from '../desktop.js';
import { projectRootOf } from './agent-spawn-shared.js';
import { listPastSessions, listTranscriptFiles, DEFAULT_LIMIT, MAX_LIMIT } from '../../lib/transcript-sessions.js';
import { contentOf, ensureContentIndex } from '../../lib/transcript-content-index.js';
import { readSessionTitles } from '../../lib/session-titles.js';
import { readSuperState } from '../../lib/super/store.js';
import { appChatIds, appChatRoot } from '../../lib/apps/chat-store.js';
import { getApp, real } from '../../lib/apps/registry.js';
import { superSanitizeOpts } from '../../lib/super/inbox.js';
import { listCodexSessions, mergeSessionRows } from '../../lib/t3-bridge/codex-sessions.js';
import { listInstanceSessions } from '../../lib/t3-bridge/instance-threads.js';
import { runSessionCheck } from '../../lib/automations/run-chat.js';
import { isPhoneSocket } from '../phone-origin.js';

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
    sendJson(res, 200, await computeChatSessions(contextRoot, query, { phone: isPhoneSocket(req) }));
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
  opts: { home?: string; waitMs?: number; phone?: boolean } = {},
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
  // K4: a run's title, snippet and search hits are its prompt and its steps. A phone reads runs on
  // the AI Team page; here it is told nothing of them, not even by a count.
  // Whoever owns it: a tab the Super adopted is still that run, and a phone asks with `super=`.
  const isRun = opts.phone ? runSessionCheck(contextRoot, opts.home) : null;
  const hidden = isRun ? (s: { id: string; unattended: boolean }): boolean => s.unattended || isRun(s.id) : null;

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

  const superRows = q.super === 'group' || q.super === 'only' ? { owned: await superOwned(contextRoot), mode: q.super as 'group' | 'only' } : undefined;
  // An app's window lists its own conversations and nothing else (`?app=<slug>`).
  const appRec = q.app ? getApp(opts.home ?? homedir(), real(projectRoot), q.app) : null;
  const onlyIds = q.app ? (appRec ? appChatIds(appRec.hash, appRec.projectRoot, opts.home ?? homedir()) : new Set<string>()) : null;
  const result = listPastSessions(projectRoot, {
    home: opts.home, query, limit, includeAgentRuns, files,
    ...(onlyIds ? { onlyIds } : {}),
    ...(hidden ? { hide: hidden } : {}),
    content: contentOf,
    // A closed tab's name, so the list says what the tab said (see `session-titles.ts`).
    titles: readSessionTitles(contextRoot),
    ...(superRows ? { superRows } : {}),
  });
  // A rotated chain is one row, under its pin, as the strip knows it: newest first, so its current
  // name wins. A second row would be a second tab on one conversation.
  if (onlyIds) {
    const seen = new Set<string>();
    const sessions = result.sessions.flatMap((s) => {
      const id = appChatRoot(s.id, opts.home ?? homedir());
      if (seen.has(id)) return [];
      seen.add(id);
      return [{ ...s, id }];
    });
    return { ...result, sessions, total: sessions.length };
  }
  const merged = withCodexRows(result, contextRoot, projectRoot, { query, limit, superOnly: superRows?.mode === 'only', home: opts.home, hidden });
  return query.trim() && !indexed
    ? { ...merged, indexing: { done: build.progress.done, total: build.progress.total } }
    : merged;
}

/** This project's Codex threads beside its Claude conversations (Track T). The Super-only listing
 *  has none: a Super Agent runs on Claude. A failed read is simply no Codex rows. */
function withCodexRows<R extends { sessions: Array<{ updatedAt: number; matchIn?: string }>; total: number }>(
  result: R, contextRoot: string, projectRoot: string,
  o: { query: string; limit: number; superOnly: boolean; home?: string; hidden?: ((s: { id: string; unattended: boolean }) => boolean) | null },
): R {
  if (o.superOnly) return result;
  try {
    const titles = readSessionTitles(contextRoot);
    const rows = [
      ...listCodexSessions(projectRoot, { home: o.home, query: o.query, limit: o.limit, contextRoot, titles }),
      ...listInstanceSessions(projectRoot, { home: o.home, query: o.query, limit: o.limit, contextRoot, titles }),
    ].filter((r) => !o.hidden?.(r)) as ReturnType<typeof listCodexSessions>;
    if (!rows.length) return result;
    return { ...result, sessions: mergeSessionRows(result.sessions, rows, o.limit, !!o.query.trim()), total: result.total + rows.length };
  } catch {
    return result;
  }
}

/** Every session the project's Super record owns. No readable record: none, the list stays whole. */
export async function superOwned(contextRoot: string): Promise<Set<string>> {
  try {
    const s = await readSuperState(contextRoot, superSanitizeOpts());
    // Released at turn-off: the owner's chats, so History lists them.
    const released = new Set(s.enabled ? [] : s.released ?? []);
    return new Set([...Object.keys(s.children).filter((id) => !released.has(id)), ...(s.formerChildren ?? []), ...(s.session ? [s.session] : [])]);
  } catch {
    return new Set();
  }
}
