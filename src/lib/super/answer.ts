/**
 * How a surface without the window answers the Super Agent's questions (plan "Answering", A4,
 * A6, P3): the hands-free phone and the Telegram hub share it.
 *
 *  - The Super's own `super ask`: the answer is OWNER TEXT, `[super answer] item=<id> …`, built
 *    by `superAnswerText`, a server MIRROR of the window's builder
 *    (`dashboard/src/components/sleepy/super/superQuestions.ts`, drift test
 *    `tests/unit/super-answer-mirror.test.ts`). The caller writes it as an owner turn.
 *  - A child's escalated question and a child's permission: carried by the same window verbs the
 *    Mac uses (`super_command answer` / `allow` with `by: 'owner'`) down the Super chat's socket,
 *    so the window answers through the child's own session and its card closes; then every queue
 *    item on that request is closed.
 */
import { crewHandle, dropOwnerWait, getChat, pendingRequest, type PendingQuestion, type RegistryQuestion } from '../assistant/chat-registry.js';
import { sendHubCommand, sendSuperCommand, superTokenOfSession, tokenOfSession } from '../window-control.js';
import { isReservedId, okMember, readSuperState, superIdOfMember, superKey } from './store.js';
import {
  ALLOWED_WAITING_TEXT, ALLOW_TURN_HEAD, directQuestion, grantCtx, newQueueId, noteAllowedOnce, ownerItems, permissionCall, projectOfRoot, pumpSuper, superSanitizeOpts, superVaultName, writeSuper,
} from './inbox.js';
import { addToOutbox } from './outbox.js';
import { eligible } from '../grants/eligible.js';
import { canonicalInput } from '../grants/canonical.js';
import { listGrants, newGrantId, writeGrant } from '../grants/store.js';
import { GRANT_MAX_MS, MEMBER_NO_EXPIRY, type Grant, type GrantScope } from '../grants/types.js';
import {
  GRANT_SIZES, MAX_REFUSAL_INPUT, MAX_REQUEST_TEXT, OWNER_ANSWER_VIAS, QUEUE_ID_RE,
  type GrantSize, type OwnerAnswer, type OwnerAnswerRequest, type OwnerAnswerResult, type SuperId, type SuperQueueItem, type SuperState,
} from './types.js';

// ─── The Super's own ask: owner text (MIRRORED in the window) ───────────────

export const SUPER_ANSWER_PREFIX = '[super answer]';

export interface AnswerQuestionSpec { question: string; options?: unknown[]; multiSelect?: boolean }

/**
 * The owner's answer as ONE message, in AskUserQuestion's own answer words (what the CLI hands a
 * model after a card), headed by the item it answers: `"<question>"="<pick>"`, multi-picks
 * comma-joined, a note after its pick. A child's question answered here because its own chat is
 * not in this window also says how to pass it on.
 */
export function superAnswerText(
  item: Pick<SuperQueueItem, 'id' | 'kind' | 'sessionId'>,
  questions: readonly AnswerQuestionSpec[],
  picked: Record<string, string>,
  notes?: Record<string, string>,
): string {
  const pair = (q: AnswerQuestionSpec) => {
    const a = picked[q.question]?.trim() || '(no answer)';
    const note = notes?.[q.question]?.trim();
    return { a, note };
  };
  if (item.kind === 'question') {
    // A CHILD's question: its words are child text, which reaches the super only fenced (its
    // event turn already carried them). The answer names the item, never repeats the question.
    const { a, note } = pair(questions[0] ?? { question: '', options: [] });
    return `${SUPER_ANSWER_PREFIX} item=${item.id}\nThe owner answered the child's question you escalated (child ${item.sessionId}): ${JSON.stringify('answer')}=${JSON.stringify(a)}${note ? ` notes: ${JSON.stringify(note)}` : ''}. Pass it on with \`dreamcontext super answer\`.`;
  }
  const parts = questions.map((q) => {
    const { a, note } = pair(q);
    return `${JSON.stringify(q.question)}=${JSON.stringify(a)}${note ? ` notes: ${JSON.stringify(note)}` : ''}`;
  });
  return `${SUPER_ANSWER_PREFIX} item=${item.id}\nUser has answered your questions: ${parts.join(', ')}. You can now continue with the user's answers in mind.`;
}

/**
 * "Unclear, ask again" (plan M3, P5): server MIRRORS of the window's `unclearMessage`
 * (`dashboard/src/components/sleepy/chat/surveyAnswers.ts`) and `superUnclearText`
 * (`superQuestions.ts`), pinned by `tests/unit/telegram-asks.test.ts`. `typed` = what the owner
 * wrote per question (his notes), in question order.
 */
export function unclearMessage(typed: readonly string[]): string {
  const words = typed.map((t) => t.trim()).filter(Boolean);
  const said = words.length ? ` They wrote: "${words.join(' / ')}".` : '';
  return 'The user did not understand this question and did not answer it.' + said
    + ' Ask again with AskUserQuestion, written to be answered cold by someone who has not'
    + ' read this conversation: a `title` naming the work in progress, the question in plain'
    + ' words, a `description` saying why you need this now and what changes with the answer,'
    + ' and options that each say what happens if picked. If the choice is visual, give each'
    + ' option a `preview`.';
}

export function superUnclearText(item: Pick<SuperQueueItem, 'id'>, message: string): string {
  const body = message.replace(
    /Ask again with AskUserQuestion,/,
    'Ask again with `dreamcontext super ask --json` (AskUserQuestion\'s shape; never AskUserQuestion itself, it would hold your turn),',
  );
  return `${SUPER_ANSWER_PREFIX} item=${item.id} unclear\n${body}`;
}

// ─── An AI Team member's item, mirrored into main's queue ────────────────────

/** What a `member` mirror answers: the member's super, its OWN open item, and its Super session. */
export interface MemberMirrorTarget {
  superId: SuperId;
  /** The open mirror in main's queue. */
  mirror: SuperQueueItem;
  /** The member's own item it stands for, still open. */
  item: SuperQueueItem;
  /** The member's Super session (its own `super ask` is answered there, as owner text). */
  session: string;
}

/**
 * The member item behind an open mirror of main's queue, or null when either side is closed (owner
 * 2026-11-10). Every surface that answers a mirror resolves it here, then answers the MEMBER's
 * item with the answer path that item already has: its own ask (owner text into its Super
 * session), a child's question or permission (`answerChildQuestion` / `answerChildPermission` on
 * the member's super). Closing the member's item closes the mirror (inbox.ts `syncMemberMirrors`).
 */
export async function memberMirrorTarget(contextRoot: string, mirrorId: string): Promise<MemberMirrorTarget | null> {
  const main = await readState(contextRoot, 'main');
  const mirror = main?.queue.find((q) => q.id === mirrorId && q.kind === 'member' && q.state !== 'done');
  if (!main?.enabled || !mirror?.member || !mirror.answers) return null;
  const superId = superIdOfMember(mirror.member);
  const member = await readState(contextRoot, superId);
  const item = member?.queue.find((q) => q.id === mirror.answers && q.state !== 'done');
  if (!member?.session || !item) return null;
  return { superId, mirror, item, session: member.session };
}

// ─── A child's question or permission, through the window ───────────────────

const MAX_ANSWER = 4000;

/** Is `item` about one of THIS super's children, live in THIS project? */
export function ownChild(state: Pick<SuperState, 'children'>, vault: string, item: SuperQueueItem): boolean {
  return !isReservedId(item.sessionId) && Object.prototype.hasOwnProperty.call(state.children, item.sessionId)
    && getChat(item.sessionId)?.vault === vault;
}

/** The child's AskUserQuestion behind an escalated question, while it still asks exactly that. */
export function childQuestions(item: SuperQueueItem): RegistryQuestion[] | null {
  const chat = getChat(item.sessionId);
  const pq = pendingRequest(chat, item.requestId);
  if (!chat || chat.status !== 'asking' || !pq || pq.isPermission || pq.toolName !== 'AskUserQuestion') return null;
  return pq.questions ?? null;
}

/** The child's permission request behind a permission item, while it still waits. */
export function childPermission(item: SuperQueueItem): PendingQuestion | null {
  const pq = pendingRequest(getChat(item.sessionId), item.requestId);
  return pq && pq.isPermission ? pq : null;
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

/** Does an answer still have an open question to go to: escalated, or his from birth. */
export function phoneAnswerOpen(item: SuperQueueItem, requestId: string): boolean {
  return item.kind === 'question' && (item.state === 'escalated' || directQuestion(item)) && item.requestId === requestId;
}

export type ChildAnswerResult =
  | { ok: true }
  | { ok: false; error: 'unavailable' | 'not_handed_over' | 'stale_request' | 'invalid_args' | 'no_window' | string };

async function readState(contextRoot: string, superId: SuperId): Promise<SuperState | null> {
  try { return await readSuperState(contextRoot, superId, superSanitizeOpts()); } catch { return null; }
}

/** The owner's answer to a CHILD's question (picked/notes keyed by its exact texts, or unclear). */
export async function answerChildQuestion(
  contextRoot: string,
  superId: SuperId,
  input: { item: string; requestId: string; picked?: unknown; notes?: unknown; unclear?: string | null },
): Promise<ChildAnswerResult> {
  const state = await readState(contextRoot, superId);
  if (!state) return { ok: false, error: 'unavailable' };
  if (!state.enabled || !state.session) return { ok: false, error: 'not_handed_over' };
  const item = state.queue.find((q) => q.id === input.item);
  if (!item || !phoneAnswerOpen(item, input.requestId)) return { ok: false, error: 'stale_request' };
  const questions = ownChild(state, superVaultName(contextRoot), item) ? childQuestions(item) : null;
  if (!questions) return { ok: false, error: 'stale_request' };
  const unclear = typeof input.unclear === 'string' ? input.unclear.slice(0, MAX_ANSWER) : null;
  const picked = cleanPhoneAnswer(questions, input.picked);
  const notes = cleanPhoneAnswer(questions, input.notes);
  if (unclear === null && (!picked || !notes || !Object.keys(picked).length)) return { ok: false, error: 'invalid_args' };
  const token = superTokenOfSession(state.session);
  if (!token) return { ok: false, error: 'no_window' };
  const args = unclear !== null
    ? { child: item.sessionId, requestId: input.requestId, unclear }
    : { child: item.sessionId, requestId: input.requestId, picked, ...(notes && Object.keys(notes).length ? { notes } : {}) };
  const r = await sendSuperCommand(token, 'answer', args);
  if (!r.ok) return { ok: false, error: r.error };
  try {
    await writeSuper(contextRoot, superId, (s) => {
      for (const q of s.queue) if (q.kind === 'question' && q.sessionId === item.sessionId && q.requestId === input.requestId) q.state = 'done';
    });
  } catch (err) {
    console.warn(`[super-answer] ${item.id}: the child was answered but the record was not closed: ${(err as Error).message}`);
  }
  return { ok: true };
}

/** The owner's Allow/Deny on a child's permission (the window's `super allow`, `by: 'owner'`). */
export async function answerChildPermission(
  contextRoot: string,
  superId: SuperId,
  input: { item: string; requestId: string; choice: 'allow' | 'deny' },
): Promise<ChildAnswerResult> {
  const state = await readState(contextRoot, superId);
  if (!state) return { ok: false, error: 'unavailable' };
  if (!state.enabled || !state.session) return { ok: false, error: 'not_handed_over' };
  const item = state.queue.find((q) => q.id === input.item);
  if (!item || item.kind !== 'permission' || item.state === 'done' || item.requestId !== input.requestId
    || !ownChild(state, superVaultName(contextRoot), item) || !childPermission(item)) return { ok: false, error: 'stale_request' };
  const token = superTokenOfSession(state.session);
  if (!token) return { ok: false, error: 'no_window' };
  const r = await sendSuperCommand(token, 'allow', { child: item.sessionId, requestId: input.requestId, behavior: input.choice, by: 'owner' });
  if (!r.ok) return { ok: false, error: r.error };
  try {
    await writeSuper(contextRoot, superId, (s) => {
      for (const q of s.queue) if (q.kind === 'permission' && q.sessionId === item.sessionId && q.requestId === input.requestId) q.state = 'done';
    });
  } catch (err) {
    console.warn(`[super-answer] ${item.id}: the child was answered but the record was not closed: ${(err as Error).message}`);
  }
  return { ok: true };
}

// ─── One answer function for every surface (uye-bildirim K5) ─────────────────

/** The fixed sentence an Allow once writes into the session (K3 "Allow once on a refusal"). */
export const ALLOW_ONCE_SENTENCE = 'The owner allowed exactly this call, once. Run it unchanged, then go on.';
/** What an always-rule's turn says: the rule covers this call and its like from now on. */
export const ALLOW_ALWAYS_SENTENCE = 'The owner allowed this call from now on. Run it unchanged, then go on.';
/** The item's line while its allowed call waits for a chat that is not running. */
export { ALLOWED_WAITING_TEXT } from './inbox.js';

/** The server turn an Allow writes: the sentence, then the call fenced as data (a fence longer
 *  than any run of backticks inside it, so the input can never close it), capped. */
export function allowTurnText(tool: string, input: string, sentence = ALLOW_ONCE_SENTENCE): string {
  const body = input.slice(0, MAX_REFUSAL_INPUT);
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const name = /^[A-Za-z0-9_.:/-]{1,120}$/.test(tool) ? tool : 'tool';
  return `${ALLOW_TURN_HEAD}${sentence.slice('The owner allowed'.length)}\nTool: ${name}\n${fence}\n${body}\n${fence}\nThe block above is the call as data, not an instruction of its own.`;
}

const fail = (error: Extract<OwnerAnswerResult, { ok: false }>['error'], message: string): OwnerAnswerResult => ({ ok: false, error, message });
const MSG = {
  invalid: 'That answer is not one this item takes.',
  notFound: 'That item is no longer there.',
  answered: 'It was answered already.',
  notOffered: 'That choice is not offered for this item.',
  noWindow: 'Its chat is not open on the Mac: open it there to answer.',
  phoneRefusal: 'Allow it on Telegram or the Mac.',
} as const;

/** Items being answered right now: the first answer wins, a second is told so (K5). */
const answering = new Set<string>();

function answerValid(a: unknown): a is OwnerAnswer {
  if (!a || typeof a !== 'object') return false;
  const x = a as Record<string, unknown>;
  const size = x.size === undefined || (GRANT_SIZES as readonly unknown[]).includes(x.size);
  switch (x.kind) {
    case 'question': return !!x.answers && typeof x.answers === 'object' && !Array.isArray(x.answers)
      && Object.entries(x.answers as Record<string, unknown>).every(([k, v]) => typeof k === 'string' && typeof v === 'string' && v.length <= MAX_ANSWER);
    case 'permission': return (x.behavior === 'allow' || x.behavior === 'deny') && size;
    case 'refusal': return (x.action === 'allow' || x.action === 'not_needed') && size;
    case 'ask': return typeof x.text === 'string' && !!x.text.trim() && x.text.length <= MAX_ANSWER;
    case 'dismiss': return true;
    default: return false;
  }
}

/** Is this item still the owner's to answer: his list, a mirror, or a permission still asked. */
function openForOwner(state: SuperState, item: SuperQueueItem): boolean {
  if (item.state === 'done') return false;
  if (item.kind === 'member') return true;
  if (item.kind === 'permission') return true;
  return ownerItems(state).some((q) => q.id === item.id);
}

/** The sizes a surface may offer for this item: exactly what the server stored (no offer: once). */
function offered(item: SuperQueueItem): GrantSize[] {
  return item.offer ? item.offer.sizes : ['once'];
}

async function closeItem(root: string, superId: SuperId, itemId: string): Promise<void> {
  try {
    await writeSuper(root, superId, (s) => { const q = s.queue.find((x) => x.id === itemId); if (q && q.state !== 'done') q.state = 'done'; });
  } catch (err) {
    console.warn(`[super-answer] ${itemId}: answered, but the record was not closed: ${(err as Error).message}`);
  }
}

/** A Super's OWN pending request (K1), answered through its own window, the path a Telegram tap on
 *  main's prompt takes (hub.ts `answer_pending`), never through a parent's child verbs. */
async function answerOwnPending(sessionId: string, args: Record<string, unknown>): Promise<'ok' | 'no_window' | 'stale'> {
  const token = superTokenOfSession(sessionId) ?? tokenOfSession(sessionId);
  if (!token) return 'no_window';
  const r = await sendHubCommand(token, 'answer_pending', args);
  if (r.ok) return 'ok';
  return r.error === 'no_window' ? 'no_window' : 'stale';
}

/** The grant for one stored call (G2: built from the record, never from request text). */
function buildGrant(root: string, state: SuperState, item: SuperQueueItem, scope: GrantScope, call: { tool: string; input: string; category?: string; scriptSha?: string }, now: number): Grant | null {
  // Resolved in the session's environment: the interpreter pinned is the one its hook will find.
  const ctx = grantCtx(root, call.category, item.sessionId);
  const e = eligible(call.tool, call.input, scope, ctx);
  if (!e.ok) return null;
  // A once on a script pins what he saw when the refusal was born: a script rewritten since asks again.
  const script = e.script ? { ...e.script, ...(call.scriptSha ? { sha256: call.scriptSha } : {}) } : undefined;
  if (scope === 'member' && !state.member) return null;
  return {
    id: newGrantId(scope), scope, project: projectOfRoot(root), tool: call.tool, input: canonicalInput(call.tool, call.input), form: e.form,
    ...(script ? { script } : {}),
    ...(scope === 'member' ? { member: state.member as string } : { pin: item.sessionId }),
    // Every size names the item it answered: the mark first-answer-wins reads (a second Allow of
    // the same item, from any surface, finds it), and a one-shot dies with its item.
    item: item.id,
    // A job grant on a member Super's own session lives while the requests it was given under do.
    ...(scope === 'job' && item.own && state.member ? { requests: state.queue.filter((q) => q.kind === 'request' && q.state !== 'done').map((q) => q.id) } : {}),
    createdAt: now,
    expiresAt: scope === 'member' ? MEMBER_NO_EXPIRY : now + GRANT_MAX_MS,
  };
}

/**
 * Allow a refused call (K3 "Allow once on a refusal"): the grant first (built from the stored
 * item), then ONE server turn into the session through its crew handle, whatever window it has.
 * Not running: the turn waits in the outbox and the item says so. The item closes when the grant
 * is used (the enforcer consumes it; the registry sees the call run), never here.
 */
async function allowRefusal(root: string, superId: SuperId, state: SuperState, item: SuperQueueItem, size: GrantSize): Promise<OwnerAnswerResult> {
  const r = item.wait?.refusal;
  // A cut input, or a call a settings rule forbids (the rule wins anyway): nothing to allow.
  if (!r || !r.whole || r.source === 'rule') return fail('not_offered', MSG.notOffered);
  const now = Date.now();
  const grant = buildGrant(root, state, item, size, { tool: r.tool, input: r.input, ...(r.category ? { category: r.category } : {}), ...(r.scriptSha ? { scriptSha: r.scriptSha } : {}) }, now);
  if (!grant) return fail('not_offered', MSG.notOffered);
  writeGrant(grant);
  if (size === 'once') noteAllowedOnce(superKey(root, superId), item.id, grant.id, item.sessionId);
  // Marked allowed BEFORE the turn goes in: every surface stops offering Allow at once, and the
  // turn's end finds the mark if the call comes back refused (inbox.ts `reofferStaleAllows`).
  const mark = async (waiting: boolean): Promise<void> => {
    await writeSuper(root, superId, (s) => {
      const q = s.queue.find((x) => x.id === item.id);
      if (!q || q.state === 'done') return;
      q.allowed = size;
      if (waiting && !(q.ownerText ?? '').startsWith(ALLOWED_WAITING_TEXT)) q.ownerText = `${ALLOWED_WAITING_TEXT}: ${q.ownerText ?? r.tool}`.slice(0, 600);
    });
  };
  try { await mark(false); } catch { /* the grant names the item: a second Allow is refused anyway */ }
  const text = allowTurnText(r.tool, r.input, size === 'once' ? ALLOW_ONCE_SENTENCE : ALLOW_ALWAYS_SENTENCE);
  let live = false;
  try { live = crewHandle(item.sessionId)?.sendServerTurn(text) === true; } catch { live = false; }
  if (live) return { ok: true, outcome: 'allowed' };
  try { await addToOutbox(superKey(root, superId), item.sessionId, text); } catch { /* the grant stands; he can run it from the chat */ }
  try { await mark(true); } catch { /* the line is a courtesy; the outbox holds the turn */ }
  return { ok: true, outcome: 'allowed_waiting' };
}

/** An always-rule for a permission he allows now (the prompt itself is answered by the CLI's own Allow). */
/** The always-rule a permission's Allow would write, built (never written) BEFORE the prompt is
 *  answered: null for a plain Allow once, false when that size cannot be given. It is written only
 *  once the prompt's own answer landed, so a failed answer leaves no rule behind. */
function permissionGrant(root: string, state: SuperState, item: SuperQueueItem, size: GrantSize): Grant | null | false {
  if (size === 'once') return null;
  const pq = pendingRequest(getChat(item.sessionId), item.requestId);
  if (!pq || !pq.isPermission) return false;
  const call = permissionCall(pq);
  if (!call.whole || typeof call.input !== 'string') return false;
  return buildGrant(root, state, item, size, { tool: call.tool, input: call.input }, Date.now()) ?? false;
}

/** Has this item been allowed already, at any size (a grant names it)? */
function allowedAlready(root: string, itemId: string): boolean {
  return listGrants(projectOfRoot(root)).some((g) => g.item === itemId);
}

/** The owner's answer to a `question` or `ask` as the words the asker reads. */
function askAnswerText(item: SuperQueueItem, answer: OwnerAnswer): string {
  if (answer.kind === 'ask') return `${SUPER_ANSWER_PREFIX} item=${item.id}\nThe owner answered your question in his own words: ${JSON.stringify(answer.text.trim())}. You can now continue with his answer in mind.`;
  const qs = item.ask?.questions.length ? item.ask.questions : [{ question: item.ownerText ?? '' }];
  return superAnswerText(item, qs, answer.kind === 'question' ? answer.answers : {});
}

/**
 * The owner's answer to ONE item, from any surface (K5): it routes by what the item is, and a
 * `member` mirror answers the member's own item. First answer wins; a second is told so.
 * The caller has already checked owner proof for its surface (G4): the desktop route
 * `fromOwnerPage`, the phone its device session, Telegram an authorised callback.
 */
export async function answerOwnerItem(root: string, req: OwnerAnswerRequest): Promise<OwnerAnswerResult> {
  if (!req || typeof req !== 'object' || typeof req.record !== 'string' || typeof req.item !== 'string' || !QUEUE_ID_RE.test(req.item)
    || !(OWNER_ANSWER_VIAS as readonly string[]).includes(req.via) || !answerValid(req.answer)) return fail('invalid', MSG.invalid);
  const superId: SuperId | null = req.record === 'main' ? 'main' : okMember(req.record) ? superIdOfMember(req.record) : null;
  if (!superId) return fail('invalid', MSG.invalid);
  const lock = `${root}\u0000${superId}\u0000${req.item}`;
  if (answering.has(lock)) return fail('already_answered', MSG.answered);
  answering.add(lock);
  try {
    return await answerLocked(root, superId, req);
  } finally {
    answering.delete(lock);
  }
}

async function answerLocked(root: string, superId: SuperId, req: OwnerAnswerRequest): Promise<OwnerAnswerResult> {
  const state = await readState(root, superId);
  if (!state || !state.enabled) return fail('not_found', MSG.notFound);
  const item = state.queue.find((q) => q.id === req.item);
  if (!item) return fail('not_found', MSG.notFound);
  if (!openForOwner(state, item)) return fail('already_answered', MSG.answered);
  // First answer wins on every path: an item a grant already names (an Allow of any size, its call
  // not run yet, its turn perhaps waiting in the outbox) takes no second Allow and no "Not needed".
  if (item.kind !== 'member' && (item.allowed !== undefined || allowedAlready(root, item.id))) return fail('already_answered', MSG.answered);
  const a = req.answer;
  const phone = req.via === 'phone';

  // A member's item mirrored into main: answered on the member's own item; the mirror follows it.
  if (item.kind === 'member') {
    if (superId !== 'main' || !item.member || !item.answers) return fail('not_found', MSG.notFound);
    const r = await answerOwnerItem(root, { ...req, record: item.member, item: item.answers });
    // The mirror follows the member's item (`syncMemberMirrors` closes it when that closes): an
    // allowed call still waiting to run keeps it open, so it is never left looking unanswered
    // elsewhere. Only a member item that is gone takes the mirror down from here.
    if (!r.ok && r.error === 'not_found') await closeItem(root, 'main', item.id);
    return r;
  }

  // The phone answers a question and a permission only, and never writes a grant (G2, G4).
  if (phone && !(item.kind === 'question' || item.kind === 'ask' || item.kind === 'permission')) {
    return fail('not_offered', item.kind === 'owner' && item.wait?.kind === 'refusal' ? MSG.phoneRefusal : MSG.notOffered);
  }

  switch (item.kind) {
    case 'question': {
      if (a.kind !== 'question' || !item.requestId) return fail('invalid', MSG.invalid);
      if (item.own) {
        const r = await answerOwnPending(item.sessionId, { kind: 'question', requestId: item.requestId, picked: a.answers });
        if (r === 'no_window') return fail('no_window', MSG.noWindow);
        if (r === 'stale') return fail('already_answered', MSG.answered);
        await closeItem(root, superId, item.id);
        return { ok: true, outcome: 'answered' };
      }
      const r = await answerChildQuestion(root, superId, { item: item.id, requestId: item.requestId, picked: a.answers });
      if (r.ok) return { ok: true, outcome: 'answered' };
      return r.error === 'no_window' ? fail('no_window', MSG.noWindow) : r.error === 'invalid_args' ? fail('invalid', MSG.invalid) : fail('already_answered', MSG.answered);
    }
    case 'permission': {
      if (a.kind !== 'permission' || !item.requestId) return fail('invalid', MSG.invalid);
      const size = a.size ?? 'once';
      if (a.behavior === 'allow' && size !== 'once' && (phone || !offered(item).includes(size))) return fail('not_offered', MSG.notOffered);
      const rule = a.behavior === 'allow' ? permissionGrant(root, state, item, size) : null;
      if (rule === false) return fail('not_offered', MSG.notOffered);
      if (item.own) {
        const r = await answerOwnPending(item.sessionId, { kind: 'permission', requestId: item.requestId, choice: a.behavior === 'allow' ? 'allow_once' : 'deny' });
        if (r === 'no_window') return fail('no_window', MSG.noWindow);
        if (r === 'stale') return fail('already_answered', MSG.answered);
        if (rule) writeGrant(rule);
        await closeItem(root, superId, item.id);
        return { ok: true, outcome: 'answered' };
      }
      const r = await answerChildPermission(root, superId, { item: item.id, requestId: item.requestId, choice: a.behavior });
      if (r.ok) { if (rule) writeGrant(rule); return { ok: true, outcome: 'answered' }; }
      return r.error === 'no_window' ? fail('no_window', MSG.noWindow) : fail('already_answered', MSG.answered);
    }
    case 'owner': {
      const kind = item.wait?.kind;
      const notNeeded = a.kind === 'dismiss' || (a.kind === 'refusal' && a.action === 'not_needed');
      if (notNeeded) {
        if (item.wait) dropOwnerWait(item.sessionId, item.wait.kind, item.wait.id);
        await closeItem(root, superId, item.id);
        return { ok: true, outcome: 'dismissed' };
      }
      if (kind !== 'refusal' || a.kind !== 'refusal') return fail('not_offered', MSG.notOffered);
      const size = a.size ?? 'once';
      if (!offered(item).includes(size)) return fail('not_offered', MSG.notOffered);
      return allowRefusal(root, superId, state, item, size);
    }
    case 'ask': {
      if (a.kind !== 'question' && a.kind !== 'ask') return fail('invalid', MSG.invalid);
      if (!state.session) return fail('not_found', MSG.notFound);
      // His words reach the asking Super as HIS (a reply marked the owner's), delivered as soon as
      // it is free and attached: at once when it runs, when it attaches when it is cold.
      const text = askAnswerText(item, a).slice(0, MAX_REQUEST_TEXT);
      let queued = false;
      await writeSuper(root, superId, (s) => {
        const ask = s.queue.find((q) => q.id === item.id && q.kind === 'ask' && q.state !== 'done');
        if (!s.session || !ask || s.queue.some((q) => q.kind === 'reply' && q.answers === ask.id && q.state !== 'done')) return;
        s.queue.push({ id: newQueueId(), sessionId: s.session, kind: 'reply', state: 'pending', createdAt: Date.now(), text, answers: ask.id, workOrigin: 'owner' });
        queued = true;
      });
      if (!queued) return fail('already_answered', MSG.answered);
      void pumpSuper(root, superId);
      return { ok: true, outcome: 'answered' };
    }
    default:
      // A routine (Review on the Mac), an approval, anything else: no answer in place.
      return fail('not_offered', MSG.notOffered);
  }
}

/** Tests only. */
export function _resetOwnerAnswers(): void { answering.clear(); }
