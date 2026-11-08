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
import { getChat, pendingRequest, type PendingQuestion, type RegistryQuestion } from '../assistant/chat-registry.js';
import { sendSuperCommand, superTokenOfSession } from '../window-control.js';
import { isReservedId, readSuperState } from './store.js';
import { directQuestion, superSanitizeOpts, superVaultName, writeSuper } from './inbox.js';
import type { SuperId, SuperQueueItem, SuperState } from './types.js';

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
