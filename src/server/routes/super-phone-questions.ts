import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { isAgentRequest } from '../desktop.js';
import { isSameOriginStrict } from './agent-spawn-shared.js';
import { isPhoneSocket } from '../phone-origin.js';
import { isReservedId, readSuperState } from '../../lib/super/store.js';
import { directQuestion, superSanitizeOpts, superVaultName, writeSuper } from '../../lib/super/inbox.js';
import { askSpecFromLegacy, type SuperAskSpec, type SuperQueueItem, type SuperState } from '../../lib/super/types.js';
import { getChat, type RegistryQuestion } from '../../lib/assistant/chat-registry.js';
import { sendSuperCommand, superTokenOfSession } from '../../lib/window-control.js';

/**
 * The Super Agent's open questions to the owner, for a surface that holds neither the super
 * record nor the children's sockets: the hands-free PHONE (owner 2026-10-24: a child's 4-question
 * card escalated with `super queue ask` reached the phone as a push and the Super's prose, but
 * never as a card, so he answered each question by voice).
 *
 * The phone joins the Super Agent's chat as a MIRROR (lib/super/phone-mirror.ts): it reads the
 * stdout, writes only owner text, and every `/api/super/*` route is laptop-only. So:
 *
 *   GET  /api/agent/super-questions — the open owner questions, each with its card: the super's
 *        own `ask` from the record; a child's question from the CHILD's pending AskUserQuestion
 *        as the chat registry holds it (verbatim: the answer is keyed by those exact texts).
 *   POST /api/agent/super-answer — the owner's answer to a CHILD's question, carried by the same
 *        window verb `super answer` uses (`super_command answer` down the super chat's socket):
 *        the window answers through the child's own session, exactly as the child's card would,
 *        so its card leaves there too. The super's own `ask` needs no route: its answer is owner
 *        text, which the mirror carries.
 *
 * Gated like the phone's other chat routes (`isAgentRequest`: the laptop on loopback, a phone
 * with its device session); the phone vault gate already scoped the project.
 */

/** One open question as the phone draws it. `card` null = no card to draw (the child's
 *  question is too large to carry whole): the item's words only, answered to the super. */
export interface PhoneSuperQuestion {
  id: string;
  kind: 'ask' | 'question';
  sessionId: string;
  requestId?: string;
  ownerText?: string;
  createdAt: number;
  card: SuperAskSpec | null;
}

export interface PhoneSuperQuestions {
  /** The super session (its pin id), or null when the project is not handed over. */
  session: string | null;
  questions: PhoneSuperQuestion[];
}

const MAX_ANSWER = 4000;

/** Is `item` about one of THIS super's children, live in THIS project? (The registry spans every
 *  project: never a chat the record does not name, never another project's.) */
function ownChild(state: Pick<SuperState, 'children'>, vault: string, item: SuperQueueItem): boolean {
  return !isReservedId(item.sessionId) && Object.prototype.hasOwnProperty.call(state.children, item.sessionId)
    && getChat(item.sessionId)?.vault === vault;
}

/** The child's AskUserQuestion behind an escalated question, while it still asks exactly that. */
function childQuestions(item: SuperQueueItem): RegistryQuestion[] | null {
  const chat = getChat(item.sessionId);
  const pq = chat?.pendingQuestion;
  if (!chat || chat.status !== 'asking' || !pq || pq.isPermission || pq.toolName !== 'AskUserQuestion') return null;
  if (!item.requestId || pq.requestId !== item.requestId) return null;
  return pq.questions ?? null;
}

/** What the phone may draw, from the record and the live registry. Pure over its inputs. */
export function phoneSuperQuestions(state: Pick<SuperState, 'enabled' | 'session' | 'queue' | 'children'>, questionsOf: (item: SuperQueueItem) => RegistryQuestion[] | null | 'gone' = (item) => {
  const qs = childQuestions(item);
  if (qs) return qs;
  // Still asking it, only too large to carry: the words only. Not asking it: nothing to answer.
  const pq = getChat(item.sessionId)?.pendingQuestion;
  return pq && pq.requestId === item.requestId ? null : 'gone';
}): PhoneSuperQuestions {
  if (!state.enabled || !state.session) return { session: null, questions: [] };
  const open = state.queue
    // A child's question is his from birth (`direct`), not only once the Super escalated it.
    .filter((q) => (q.state === 'escalated' && (q.kind === 'ask' || q.kind === 'question')) || directQuestion(q))
    .sort((a, b) => a.createdAt - b.createdAt);
  const questions: PhoneSuperQuestion[] = [];
  for (const q of open) {
    const base = {
      id: q.id, kind: q.kind as 'ask' | 'question', sessionId: q.sessionId, createdAt: q.createdAt,
      ...(q.requestId ? { requestId: q.requestId } : {}), ...(q.ownerText ? { ownerText: q.ownerText } : {}),
    };
    if (q.kind === 'ask') {
      questions.push({ ...base, card: q.ask ?? askSpecFromLegacy(q.ownerText ?? '', q.options ?? []) });
      continue;
    }
    const qs = questionsOf(q);
    if (qs === 'gone') continue;
    // The super's words lead as the context strip, as on the laptop's card.
    questions.push({ ...base, card: qs ? { ...(q.ownerText ? { title: q.ownerText } : {}), questions: qs.map((x) => ({ ...x, options: x.options.map((o) => ({ ...o })) })) } : null });
  }
  return { session: state.session, questions };
}

/** GET /api/agent/super-questions */
export async function handleSuperPhoneQuestions(req: IncomingMessage, res: ServerResponse, _params: unknown, contextRoot: string): Promise<void> {
  if (!isAgentRequest(req)) { sendError(res, 403, 'forbidden', 'Available only in the desktop app or a signed-in phone.'); return; }
  let state: SuperState;
  try {
    state = await readSuperState(contextRoot, superSanitizeOpts());
  } catch (err) {
    // Unread is not "not handed over": the phone keeps what it draws and reads again.
    console.warn(`[super-phone] ${contextRoot}: the record could not be read: ${(err as Error).message}`);
    sendError(res, 503, 'unavailable', 'The Super Agent record could not be read; try again.');
    return;
  }
  const vault = superVaultName(contextRoot);
  sendJson(res, 200, phoneSuperQuestions(state, (item) => {
    if (!ownChild(state, vault, item)) return 'gone';
    const qs = childQuestions(item);
    if (qs) return qs;
    const pq = getChat(item.sessionId)?.pendingQuestion;
    return pq && pq.requestId === item.requestId ? null : 'gone';
  }));
}

/** The owner's picks, checked against the child's own questions: every key is one of its question
 *  texts, every value a non-empty line. Null when anything is off. */
export function cleanPhoneAnswer(questions: readonly RegistryQuestion[], raw: unknown): Record<string, string> | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const known = new Set(questions.map((q) => q.question));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(k) || typeof v !== 'string' || !v.trim() || v.length > MAX_ANSWER) return null;
    out[k] = v;
  }
  return out;
}

/** POST /api/agent/super-answer {item, requestId, picked?, notes?, unclear?} */
export async function handleSuperPhoneAnswer(req: IncomingMessage, res: ServerResponse, _params: unknown, contextRoot: string): Promise<void> {
  // The phone gate already judged a phone write's Origin (the tunnel's own); on the laptop only
  // the app's own page answers for the owner (the strict T0 test of the super's owner routes).
  if (!isAgentRequest(req) || (!isPhoneSocket(req) && !isSameOriginStrict(req))) { sendError(res, 403, 'forbidden', 'Available only in the desktop app or a signed-in phone.'); return; }
  const b = (await parseJsonBody(req)) ?? {};
  const id = typeof b.item === 'string' ? b.item : '';
  const requestId = typeof b.requestId === 'string' ? b.requestId : '';
  if (!id || !requestId || requestId.length > 200) { sendError(res, 400, 'invalid_args', 'item and requestId are required'); return; }
  let state: SuperState;
  try { state = await readSuperState(contextRoot, superSanitizeOpts()); } catch (err) {
    // Unread is not "not handed over": a retry may land (the card comes back with its picks).
    console.warn(`[super-phone] ${contextRoot}: the record could not be read for an answer: ${(err as Error).message}`);
    sendError(res, 503, 'unavailable', 'The Super Agent record could not be read; try again.');
    return;
  }
  if (!state.enabled || !state.session) { sendError(res, 409, 'not_handed_over', 'The Super Agent is not handed over.'); return; }
  const item = state.queue.find((q) => q.id === id);
  if (!item || item.kind !== 'question' || item.state !== 'escalated' || item.requestId !== requestId) {
    sendError(res, 409, 'stale_request', 'That question is no longer open.');
    return;
  }
  const questions = ownChild(state, superVaultName(contextRoot), item) ? childQuestions(item) : null;
  if (!questions) { sendError(res, 409, 'stale_request', 'That child is not asking this question any more.'); return; }
  const unclear = typeof b.unclear === 'string' ? b.unclear.slice(0, MAX_ANSWER) : null;
  const picked = cleanPhoneAnswer(questions, b.picked);
  const notes = cleanPhoneAnswer(questions, b.notes);
  if (unclear === null && (!picked || !notes || !Object.keys(picked).length)) {
    sendError(res, 400, 'invalid_args', 'give an answer for at least one of the child\'s questions');
    return;
  }
  const token = superTokenOfSession(state.session);
  if (!token) { sendError(res, 409, 'no_window', 'The Mac window that holds the Super Agent is not open.'); return; }
  const args = unclear !== null
    ? { child: item.sessionId, requestId, unclear }
    : { child: item.sessionId, requestId, picked, ...(notes && Object.keys(notes).length ? { notes } : {}) };
  const r = await sendSuperCommand(token, 'answer', args);
  if (!r.ok) { sendJson(res, r.error === 'no_window' ? 409 : 200, { ok: false, error: r.error }); return; }
  // The child HAS its answer: the reply says so whatever the record write does. Closed like the
  // super's own `answer` closes it: every item on that request (an item escalated twice too).
  try {
    await writeSuper(contextRoot, (s) => {
      for (const q of s.queue) if (q.kind === 'question' && q.sessionId === item.sessionId && q.requestId === requestId) q.state = 'done';
    });
  } catch (err) {
    console.warn(`[super-phone] ${id}: the child was answered but the record was not closed: ${(err as Error).message}`);
  }
  sendJson(res, 200, { ok: true });
}
