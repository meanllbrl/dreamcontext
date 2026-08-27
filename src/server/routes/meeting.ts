import { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, sendError, parseJsonBody } from '../middleware.js';
import {
  MeetingOrchestrator,
  rosterWithGlances,
} from '../../lib/meeting-delivery.js';
import {
  activeThread,
  appendMessage,
  closeActiveThread,
  createThread,
  isThreadId,
  listThreads,
  meetingRoster,
  readThread,
} from '../../lib/meeting-room.js';
import { readAgentUiChatDefaults } from './launcher.js';

/**
 * MEETING ROOM ROUTES — the launcher window's view of the machine-wide room.
 *
 * Vault-AGNOSTIC by design (`/api/meeting` is in VAULT_AGNOSTIC_PREFIXES): the
 * room is owned by no vault, its store lives under `~/.dreamcontext/`, and its
 * only client is the launcher window, which has no vault to send. The
 * orchestrator is a module singleton in THIS server process — the launcher-mode
 * server is the single process that can open the room, so it is the single
 * writer of thread files (see meeting-room.ts on the no-lock assumption).
 *
 * POST /post and /reply return IMMEDIATELY: the fan-out runs in the background
 * and the UI watches it by polling GET /state. An HTTP handler that awaited N
 * ten-minute headless runs would be a hung request, not an API.
 */

/**
 * One orchestrator per server process, created on first use with default home.
 *
 * `chatDefaults` is what makes the room's model/effort pick GLOBAL: the composer writes it to
 * `~/.dreamcontext/agent-ui.json` (the same app-global blob every project window already
 * shares) and this reads it back per run, so one selection covers every project the room
 * wakes. No room-specific store, and no per-project override to keep in sync.
 */
let orchestrator: MeetingOrchestrator | null = null;
function getOrchestrator(): MeetingOrchestrator {
  if (!orchestrator) orchestrator = new MeetingOrchestrator({ chatDefaults: readAgentUiChatDefaults });
  return orchestrator;
}

/** Test hook: replace the process orchestrator (unit tests inject a fake runner). */
export function setMeetingOrchestrator(o: MeetingOrchestrator | null): void {
  orchestrator = o;
}

/**
 * Roster glances cost a real read of every vault's core files, so they are
 * cached briefly — the state poll runs every ~2s and must stay cheap.
 */
const GLANCE_TTL_MS = 60_000;
let glanceCache: { at: number; roster: Array<{ name: string; whatItIs: string }> } | null = null;
function cachedRoster(): Array<{ name: string; whatItIs: string }> {
  if (glanceCache && Date.now() - glanceCache.at < GLANCE_TTL_MS) return glanceCache.roster;
  const roster = rosterWithGlances(meetingRoster());
  glanceCache = { at: Date.now(), roster };
  return roster;
}

/**
 * GET /api/meeting/state — the room at a glance: the active thread (full), the
 * history list (summaries), and the roster the composer's `@` menu shows.
 */
export async function handleMeetingState(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  sendJson(res, 200, {
    active: activeThread(),
    threads: listThreads(),
    roster: cachedRoster(),
  });
}

/** GET /api/meeting/thread/:id — one thread, full, for the history rail. */
export async function handleMeetingThread(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  const id = params.id ?? '';
  if (!isThreadId(id)) {
    sendError(res, 400, 'invalid_thread', 'Malformed thread id.');
    return;
  }
  const thread = readThread(id);
  if (!thread) {
    sendError(res, 404, 'not_found', `No thread "${id}".`);
    return;
  }
  sendJson(res, 200, { thread });
}

/**
 * POST /api/meeting/post — a new announcement. Archives the active thread (the
 * store's invariant), snapshots the roster as participants, starts the fan-out
 * in the background, and answers with the fresh thread immediately. In-flight
 * runs of the archived thread keep going and land there.
 */
export async function handleMeetingPost(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await parseJsonBody(req);
  const text = body && typeof body.body === 'string' ? body.body : '';
  if (!text.trim()) {
    sendError(res, 400, 'invalid_message', 'body must be a non-empty string.');
    return;
  }
  const participants = cachedRoster();
  if (participants.length === 0) {
    sendError(res, 400, 'empty_room', 'No registered projects to convene.');
    return;
  }
  const thread = createThread({ body: text, participants });
  if (!thread) {
    sendError(res, 400, 'invalid_message', 'The announcement is empty after sanitizing.');
    return;
  }
  getOrchestrator().deliverUserMessage(thread.id, thread.messages[0].id);
  sendJson(res, 200, { thread });
}

/**
 * POST /api/meeting/reply — the user speaks into the ACTIVE thread. Routed per
 * the thread-reply rules (mentions, else the engaged set); background fan-out.
 */
export async function handleMeetingReply(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await parseJsonBody(req);
  const text = body && typeof body.body === 'string' ? body.body : '';
  if (!text.trim()) {
    sendError(res, 400, 'invalid_message', 'body must be a non-empty string.');
    return;
  }
  const thread = activeThread();
  if (!thread) {
    sendError(res, 409, 'no_active_thread', 'No active thread — post an announcement first.');
    return;
  }
  const message = appendMessage(thread.id, { author: 'user', authorKind: 'user', body: text });
  if (!message) {
    sendError(res, 400, 'invalid_message', 'The reply is empty after sanitizing.');
    return;
  }
  getOrchestrator().deliverUserMessage(thread.id, message.id);
  sendJson(res, 200, { thread: readThread(thread.id) });
}

/** POST /api/meeting/close — archive the active thread without opening a new one. */
export async function handleMeetingClose(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const closed = closeActiveThread();
  sendJson(res, 200, { thread: closed });
}
