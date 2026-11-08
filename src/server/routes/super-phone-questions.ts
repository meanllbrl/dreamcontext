import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { isAgentRequest } from '../desktop.js';
import { isPhoneSocket } from '../phone-origin.js';
import { readSuperState } from '../../lib/super/store.js';
import { querySuperId } from '../super-id-query.js';
import { directQuestion, superSanitizeOpts, superVaultName } from '../../lib/super/inbox.js';
import { answerChildPermission, answerChildQuestion, childPermission, childQuestions, ownChild } from '../../lib/super/answer.js';
export { cleanPhoneAnswer, phoneAnswerOpen } from '../../lib/super/answer.js';
import { askSpecFromLegacy, type SuperAskSpec, type SuperQueueItem, type SuperState } from '../../lib/super/types.js';
import { getChat, pendingRequest, type PendingQuestion, type RegistryQuestion } from '../../lib/assistant/chat-registry.js';

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
 *   POST /api/agent/super-permission — the owner's Allow/Deny on a child's permission that waits
 *        for HIM (never the Super's to decide first), carried by the `super allow` window verb
 *        with `by: 'owner'`. The GET lists those permissions too (tool and capped command text).
 *
 * The read is gated like the phone's other chat routes (`isAgentRequest`: the laptop on loopback,
 * a phone with its device session); the phone vault gate already scoped the project. The answer
 * is the phone's alone: the laptop answers through the child's own card, so a loopback caller
 * here could only be something other than the owner.
 */

/** One open question as the phone draws it. `card` null = no card to draw (the child's
 *  question is too large to carry whole): the item's words only, answered to the super. */
export interface PhoneSuperQuestion {
  id: string;
  kind: 'ask' | 'question' | 'permission';
  sessionId: string;
  requestId?: string;
  ownerText?: string;
  createdAt: number;
  card: SuperAskSpec | null;
  /** A permission that waits for the owner: the tool and the registry's capped command/path
   *  text, the agent's one-line description and the CLI's own reason for asking. This response
   *  travels only to the signed-in phone. */
  permission?: PhonePermission;
}

export interface PhonePermission { tool: string; text: string; description?: string; reason?: string; reasonType?: string }

export interface PhoneSuperQuestions {
  /** The super session (its pin id), or null when the project is not handed over. */
  session: string | null;
  questions: PhoneSuperQuestion[];
}

const MAX_ANSWER = 4000;

/** A refusal from the shared answer core, as the phone routes have always worded it. */
function sendAnswerFailure(res: ServerResponse, error: string): void {
  if (error === 'unavailable') { sendError(res, 503, 'unavailable', 'The Super Agent record could not be read; try again.'); return; }
  if (error === 'not_handed_over') { sendError(res, 409, 'not_handed_over', 'The Super Agent is not handed over.'); return; }
  if (error === 'stale_request') { sendError(res, 409, 'stale_request', 'That question is no longer open.'); return; }
  if (error === 'stale_permission') { sendError(res, 409, 'stale_request', 'That permission request is no longer open.'); return; }
  if (error === 'invalid_args') { sendError(res, 400, 'invalid_args', 'give an answer for at least one of the child\'s questions'); return; }
  if (error === 'no_window') { sendError(res, 409, 'no_window', 'The Mac window that holds the Super Agent is not open.'); return; }
  sendJson(res, 200, { ok: false, error });
}

/** A permission item that waits for the OWNER: not the Super's to decide first, not answered. */
export function ownerPermissionOpen(item: SuperQueueItem): boolean {
  return item.kind === 'permission' && !item.toSuper && item.state !== 'done' && !!item.requestId;
}

/**
 * A permission the phone draws: the owner's, AND a Bypass child's the Super decides first
 * (`toSuper`). Owner 2026-11-05: in hands-free a child's permission never reached the phone,
 * because a `toSuper` one is nobody's card for up to SUPER_PERMISSION_GRACE_MS, and the Super
 * that was asking HIM a question meanwhile never got the event. The Mac draws it in the child's
 * own tab from the first second; the phone now does too. Whoever answers first wins: the other
 * side's answer finds the request gone (`stale_request`). It stays out of the push and the
 * waiting rows (phone-mirror.ts) until it is his alone, so the Super's grace still means quiet.
 */
export function phonePermissionOpen(item: SuperQueueItem): boolean {
  return item.kind === 'permission' && item.state !== 'done' && !!item.requestId;
}

/** What the phone may draw, from the record and the live registry. Pure over its inputs. */
export function phoneSuperQuestions(state: Pick<SuperState, 'enabled' | 'session' | 'queue' | 'children'>, questionsOf: (item: SuperQueueItem) => RegistryQuestion[] | null | 'gone' = (item) => {
  const qs = childQuestions(item);
  if (qs) return qs;
  // Still asking it, only too large to carry: the words only. Not asking it: nothing to answer.
  return pendingRequest(getChat(item.sessionId), item.requestId) ? null : 'gone';
}, permissionOf: (item: SuperQueueItem) => PendingQuestion | null = childPermission): PhoneSuperQuestions {
  if (!state.enabled || !state.session) return { session: null, questions: [] };
  const open = state.queue
    // A child's question is his from birth (`direct`), not only once the Super escalated it.
    .filter((q) => (q.state === 'escalated' && (q.kind === 'ask' || q.kind === 'question')) || directQuestion(q) || phonePermissionOpen(q))
    .sort((a, b) => a.createdAt - b.createdAt);
  const questions: PhoneSuperQuestion[] = [];
  for (const q of open) {
    const base = {
      id: q.id, kind: q.kind as PhoneSuperQuestion['kind'], sessionId: q.sessionId, createdAt: q.createdAt,
      ...(q.requestId ? { requestId: q.requestId } : {}), ...(q.ownerText ? { ownerText: q.ownerText } : {}),
    };
    if (q.kind === 'permission') {
      // Hands-free: a permission that waits for the owner reaches his phone with Allow/Deny.
      const pq = permissionOf(q);
      if (pq) {
        questions.push({
          ...base, card: null,
          permission: {
            tool: pq.toolName, text: pq.text,
            ...(pq.description ? { description: pq.description } : {}),
            ...(pq.reason ? { reason: pq.reason } : {}),
            ...(pq.reasonType ? { reasonType: pq.reasonType } : {}),
          },
        });
      }
      continue;
    }
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
  const superId = querySuperId(req, res, contextRoot);
  if (!superId) return;
  let state: SuperState;
  try {
    state = await readSuperState(contextRoot, superId, superSanitizeOpts());
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
    return pendingRequest(getChat(item.sessionId), item.requestId) ? null : 'gone';
  }, (item) => {
    if (!ownChild(state, vault, item)) return null;
    const pq = childPermission(item);
    // The command text (and what describes it) goes to the signed-in phone only: the laptop
    // answers in the child's tab.
    if (!pq || isPhoneSocket(req)) return pq;
    const { description: _d, reason: _r, ...rest } = pq;
    return { ...rest, text: '' };
  }));
}

/** POST /api/agent/super-answer {item, requestId, picked?, notes?, unclear?} */
export async function handleSuperPhoneAnswer(req: IncomingMessage, res: ServerResponse, _params: unknown, contextRoot: string): Promise<void> {
  // The phone gate already judged the write's Origin (the tunnel's own); the device session is
  // judged here again so this never relies on its order.
  if (!isPhoneSocket(req) || !isAgentRequest(req)) { sendError(res, 403, 'forbidden', 'Available only on a signed-in phone.'); return; }
  const b = (await parseJsonBody(req)) ?? {};
  const id = typeof b.item === 'string' ? b.item : '';
  const requestId = typeof b.requestId === 'string' ? b.requestId : '';
  if (!id || !requestId || requestId.length > 200) { sendError(res, 400, 'invalid_args', 'item and requestId are required'); return; }
  const answerSuper = querySuperId(req, res, contextRoot);
  if (!answerSuper) return;
  const r = await answerChildQuestion(contextRoot, answerSuper, {
    item: id, requestId, picked: b.picked, notes: b.notes, unclear: typeof b.unclear === 'string' ? b.unclear.slice(0, MAX_ANSWER) : null,
  });
  if (!r.ok) { sendAnswerFailure(res, r.error); return; }
  sendJson(res, 200, { ok: true });
}

/** POST /api/agent/super-permission {item, requestId, choice: 'allow'|'deny'}: the owner's answer,
 *  from the phone, to a Super child's permission that waits for him (hands-free: never only the
 *  Mac window). Carried by the window verb `super allow` uses, marked as the owner's (`by`). */
export async function handleSuperPhonePermission(req: IncomingMessage, res: ServerResponse, _params: unknown, contextRoot: string): Promise<void> {
  if (!isPhoneSocket(req) || !isAgentRequest(req)) { sendError(res, 403, 'forbidden', 'Available only on a signed-in phone.'); return; }
  const b = (await parseJsonBody(req)) ?? {};
  const id = typeof b.item === 'string' ? b.item : '';
  const requestId = typeof b.requestId === 'string' ? b.requestId : '';
  const choice = b.choice === 'allow' || b.choice === 'deny' ? b.choice : null;
  if (!id || !requestId || requestId.length > 200 || !choice) { sendError(res, 400, 'invalid_args', 'item, requestId and choice (allow or deny) are required'); return; }
  // A member's Super answers through its own record (`?superId=m:<slug>`), as the GET listed it.
  const permSuper = querySuperId(req, res, contextRoot);
  if (!permSuper) return;
  const r = await answerChildPermission(contextRoot, permSuper, { item: id, requestId, choice });
  if (!r.ok) { sendAnswerFailure(res, r.error === 'stale_request' ? 'stale_permission' : r.error); return; }
  sendJson(res, 200, { ok: true });
}
