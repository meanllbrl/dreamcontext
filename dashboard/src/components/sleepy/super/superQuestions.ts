import { useSyncExternalStore } from 'react';
import type { SuperAskSpec, SuperQueueItem } from '../../../lib/superTypes';
import type { QuestionSpec } from '../../../lib/chatProtocol';
import type { ChatItem, ChatSession, ChatToolItem, PendingQuestion } from '../chatSession';
import { splitShellSegments, tokenizeShell } from '../chat/dreamCommand';
import { toolResultText } from '../chat/chatEntities';
import { OPEN_LATCH, latchClick, latchSeen, type AnswerLatch } from './superHandover';

/**
 * The Super Agent's question to the owner, asked EXACTLY the way any agent asks (owner
 * 2026-10-22: "atomik olarak normal agent nasıl soru soruyorsa Super Agent de öyle sormalı").
 * There is no super question card: the chat mounts its own AskUserQuestion card (`SurveyCard`)
 * over the question through a two-method adapter (SuperQuestionCard.tsx), the way the #agents
 * channel already does for an automation's question.
 *
 *   • the super's own `super ask`: its record item carries AskUserQuestion's input shape
 *     (`ask`: title, questions, options with descriptions and previews, multiSelect, source);
 *     `askPendingOf` turns it into the card's `PendingQuestion`. The answer is ONE message into
 *     the super chat in AskUserQuestion's answer form (`superAnswerText`); "Unclear" is one
 *     message asking it to ask again (`superUnclearText`). Its turn is never held: `super ask`
 *     returned at once (AskUserQuestion held the super's turn for 82 minutes in the field).
 *   • a child's question it escalated (`super queue ask`): the card IS the child's own pending
 *     AskUserQuestion, answered through the child's own session, exactly as in the child's chat.
 *
 * Pure parts (parse, placement, the answer's words) are tested in tests/unit/super-question-card;
 * the latch store below is what the job bar's permission row answers through.
 */

// ─── The anchor: the call that asked ──────────────────────────────────────────

/** A question the transcript shows the super agent asking. */
export interface AskRef {
  /** The queue item id the server answered with. */
  item: string;
  kind: 'ask' | 'question';
  /** The tool row that asked. */
  toolItemId: string;
}

/** The `dreamcontext super ask|queue ask` argv of one segment, or null. */
function superAskArgv(segment: string): { kind: 'ask' | 'question'; args: string[] } | null {
  const argv = tokenizeShell(segment);
  const at = argv.findIndex((tok) => /(^|\/)dreamcontext$/.test(tok) || /dist\/index\.js$/.test(tok));
  if (at < 0) return null;
  const rest = argv.slice(at + 1);
  if (rest[0] !== 'super') return null;
  if (rest[1] === 'ask') return { kind: 'ask', args: rest.slice(2) };
  if (rest[1] === 'queue' && rest[2] === 'ask') return { kind: 'question', args: rest.slice(3) };
  return null;
}

/** Every top-level JSON object in a text, in order (the CLI pretty-prints one; a chained command
 *  can print more, or other lines around it). String-aware brace matching; bad blocks skipped. */
export function jsonBlocks(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') { i += 1; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"' && depth > 0) { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth += 1; continue; }
    if (c === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          const v = JSON.parse(text.slice(start, i + 1)) as unknown;
          if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Record<string, unknown>);
        } catch { /* not JSON: skip */ }
        start = -1;
      }
    }
  }
  return out;
}

function bashCommandOf(tool: ChatToolItem): string | null {
  if (tool.name !== 'Bash') return null;
  const input = tool.input as { command?: unknown } | null;
  return input && typeof input.command === 'string' ? input.command : null;
}

/**
 * The question a tool row asked, or null: a `Bash` call of `dreamcontext super ask <text>
 * [--options a|b]` or `dreamcontext super queue ask <item> <text>` (any segment of a chained
 * line, `npx` tolerated) whose result holds the server's acceptance (`asked`/`escalated` with
 * `item`). A refused call (exit 1, the reason on stderr) has none: no card.
 */
const askRefs = new WeakMap<ChatToolItem, AskRef | null>();

export function askRefOf(tool: ChatToolItem): AskRef | null {
  if (tool.status !== 'done') return null;
  // A finished row never changes (the reducer replaces an item it updates): read it once.
  if (askRefs.has(tool)) return askRefs.get(tool) ?? null;
  const ref = readAskRef(tool);
  askRefs.set(tool, ref);
  return ref;
}

function readAskRef(tool: ChatToolItem): AskRef | null {
  const command = bashCommandOf(tool);
  if (!command || !command.includes('super')) return null;
  const calls = splitShellSegments(command).map(superAskArgv).filter((c): c is NonNullable<typeof c> => !!c);
  if (!calls.length) return null;
  const accepted = jsonBlocks(toolResultText(tool.result))
    .filter((b) => typeof b.item === 'string' && (b.asked === true || b.escalated === true));
  for (const call of calls) {
    const block = accepted.find((b) => (call.kind === 'ask' ? b.asked === true : b.escalated === true)
      && (call.kind === 'ask' || call.args[0] === b.item));
    if (block) return { item: block.item as string, kind: call.kind, toolItemId: tool.id };
  }
  return null;
}

// ─── Where the card goes ─────────────────────────────────────────────────────

const isUser = (it: ChatItem): boolean => it.kind === 'user';

/**
 * The cards of one rendered piece (foldSuper's KEPT output: an anchor folded into an event line
 * is not rendered, so its open question falls to the chat's tail). Each card goes after the LAST
 * item of the turn that asked (the last item before the next user turn, or the piece's end
 * while the turn still streams): under the super's prose, never between its tool rows.
 * One item asked twice (`queue ask` accepts an escalated item again): only the LATEST call is
 * live; earlier ones are history (`live: false`).
 */
export function placeQuestionCards(piece: readonly ChatItem[]): Map<string, Array<AskRef & { live: boolean }>> {
  const refs: Array<{ ref: AskRef; at: number }> = [];
  piece.forEach((it, i) => {
    if (it.kind !== 'tool') return;
    const ref = askRefOf(it);
    if (ref) refs.push({ ref, at: i });
  });
  const out = new Map<string, Array<AskRef & { live: boolean }>>();
  if (!refs.length) return out;
  const latest = new Map<string, string>();
  for (const { ref } of refs) latest.set(ref.item, ref.toolItemId);
  for (const { ref, at } of refs) {
    let end = at;
    while (end + 1 < piece.length && !isUser(piece[end + 1])) end += 1;
    const anchor = piece[end].id;
    const list = out.get(anchor) ?? [];
    list.push({ ...ref, live: latest.get(ref.item) === ref.toolItemId });
    out.set(anchor, list);
  }
  return out;
}

// ─── What the card says ───────────────────────────────────────────────────────

/** The questions the owner must answer that the super asked: its own `ask`, or a child's
 *  question it escalated. Permissions and AI Team approvals stay on the job bar. */
export function openOwnerQuestions(queue: readonly SuperQueueItem[]): SuperQueueItem[] {
  return queue
    .filter((q) => q.state === 'escalated' && (q.kind === 'ask' || q.kind === 'question'))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** open: answerable now. answered: the live record says it is no longer open. static: no live
 *  record in this window (taken back, not loaded yet), or an earlier call for an item asked
 *  again: the question's words only, it claims nothing. */
export type CardState = 'open' | 'answered' | 'static';

export function cardState(item: string, live: boolean, view: { open: readonly SuperQueueItem[] } | null): CardState {
  // An earlier call for an item asked again is history: the latest call's card is the live one.
  if (!view || !live) return 'static';
  return view.open.some((q) => q.id === item) ? 'open' : 'answered';
}

/** The latch key of a question: a re-sent request keeps its request id (the server re-sends the
 *  same one when an answer never landed), so the key holds across it. */
export function ownerAnswerKey(item: Pick<SuperQueueItem, 'id' | 'requestId'>): string {
  return `${item.id}:${item.requestId ?? ''}`;
}

/** The child's pending AskUserQuestion behind an escalated question, if this window holds it. */
export function childQuestionOf(item: SuperQueueItem, child: ChatSession | undefined): PendingQuestion | undefined {
  if (!child || item.kind === 'ask' || item.kind === 'permission') return undefined;
  return child.getModel().pending.find((p): p is PendingQuestion => p.kind === 'question' && p.requestId === item.requestId);
}

/**
 * Is the thing being answered still there? The ONE input every caller (the job bar, the card,
 * the tail) feeds the latch, so they never disagree on the same key. A permission or question:
 * the child still holds that request. An `ask`: the item is still open on the record (it leaves
 * when the owner's message reaches the super). Null = no child session in this window: do not
 * note at all (that card has no buttons).
 */
export function ownerPendingPresent(item: SuperQueueItem, child: ChatSession | undefined, open: readonly SuperQueueItem[]): boolean | null {
  if (item.kind === 'ask') return open.some((q) => q.id === item.id);
  if (!child || !item.requestId) return null;
  return child.getModel().pending.some((p) => p.requestId === item.requestId);
}

/** `scope` = the super session the item belongs to: every open project shares this window's
 *  module, and one project's trim must never drop another's latch. */
interface LatchEntry { item: string; scope: string; latch: AnswerLatch }
const latches = new Map<string, LatchEntry>();
let version = 0;
const listeners = new Set<() => void>();
const emit = () => { version += 1; for (const fn of [...listeners]) fn(); };

/**
 * Note whether the answered request is still there (`latchSeen`: it left = noted; the SAME
 * request back afterwards = the answer never landed, reopen). SILENT: it runs during render, and
 * notifying there is React's "update while rendering" error; each caller re-renders anyway on the
 * session or record change that moved it. Call it BEFORE reading `ownerAnswerLocked`.
 */
export function noteOwnerPending(key: string, present: boolean | null): void {
  if (present === null) return;
  const cur = latches.get(key);
  if (!cur) return;
  const next = latchSeen(cur.latch, key, present);
  if (next === cur.latch) return;
  if (next.key === null) latches.delete(key);
  else latches.set(key, { ...cur, latch: next });
}

/** Already answered from this window (card or bar), and not reopened. */
export function ownerAnswerLocked(key: string): boolean {
  return latches.has(key);
}

/** A click: true = send now (first click, a socket that can carry it); false = nothing to do. */
export function claimOwnerAnswer(key: string, item: string, scope: string, canSend: boolean): boolean {
  const cur = latches.get(key)?.latch ?? OPEN_LATCH;
  const r = latchClick(cur, key, canSend);
  if (!r.send) return false;
  latches.set(key, { item, scope, latch: r.latch });
  emit();
  return true;
}

/** The send wrote nothing after all: reopen. */
export function releaseOwnerAnswer(key: string): void {
  if (latches.delete(key)) emit();
}

/** Drop the latches of THIS super's items it no longer asks for (called from the publish, never
 *  from a render); another project's latches are not its to drop. */
export function trimOwnerAnswers(scope: string, openIds: ReadonlySet<string>): void {
  let changed = false;
  for (const [key, e] of latches) if (e.scope === scope && !openIds.has(e.item)) { latches.delete(key); changed = true; }
  if (changed) emit();
}

/** Re-render on a claim, a release or a trim anywhere (the card locks the bar and back). */
export function useOwnerAnswerVersion(): number {
  return useSyncExternalStore(subscribeOwnerAnswers, () => version, () => version);
}

export function subscribeOwnerAnswers(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Test-only. */
export function _resetOwnerAnswers(): void {
  latches.clear();
  version = 0;
}

// ─── The super's own `ask`, as AskUserQuestion ──────────────────────────────────

/** AskUserQuestion's input from the record: the `ask` spec, or (an older record) its text and
 *  options. A question with no options is answered in words (the card's text box). */
export function askSpecOf(item: Pick<SuperQueueItem, 'ask' | 'ownerText' | 'options'>): SuperAskSpec {
  if (item.ask && item.ask.questions.length) return item.ask;
  return { questions: [{ question: item.ownerText ?? '', options: (item.options ?? []).map((label) => ({ label })) }] };
}

/** The card's question list (chatProtocol's QuestionSpec), one per asked question. */
export function askQuestionsOf(spec: SuperAskSpec): QuestionSpec[] {
  return spec.questions.map((q) => ({
    question: q.question,
    ...(q.header ? { header: q.header } : {}),
    ...(q.description ? { description: q.description } : {}),
    ...(q.multiSelect ? { multiSelect: true } : {}),
    options: q.options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}), ...(o.preview ? { preview: o.preview } : {}) })),
    ...(q.options.length === 0 ? { kind: 'text' as const } : {}),
  }));
}

/** The super's own question as the pending AskUserQuestion the chat's card draws. */
export function askPendingOf(item: SuperQueueItem): PendingQuestion {
  const spec = askSpecOf(item);
  return {
    kind: 'question',
    requestId: item.id,
    toolName: 'AskUserQuestion',
    questions: askQuestionsOf(spec),
    ...(spec.title ? { title: spec.title } : {}),
    ...(spec.source ? { source: spec.source } : {}),
  };
}

/** The first line of every answer the owner sends the super from a question card. */
export const SUPER_ANSWER_PREFIX = '[super answer]';

/**
 * The owner's answer as ONE message, in AskUserQuestion's own answer words (what the CLI hands a
 * model after a card), headed by the item it answers: `"<question>"="<pick>"`, multi-picks
 * comma-joined, a note after its pick. A child's question answered here because its own chat is
 * not in this window also says how to pass it on.
 */
export function superAnswerText(
  item: Pick<SuperQueueItem, 'id' | 'kind' | 'sessionId'>,
  questions: readonly QuestionSpec[],
  picked: Record<string, string>,
  notes?: Record<string, string>,
): string {
  const pair = (q: QuestionSpec) => {
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

/** "Unclear, ask again": one message, the card's own words re-pointed at `super ask`. */
export function superUnclearText(item: Pick<SuperQueueItem, 'id'>, message: string): string {
  const body = message.replace(
    /Ask again with AskUserQuestion,/,
    'Ask again with `dreamcontext super ask --json` (AskUserQuestion\'s shape; never AskUserQuestion itself, it would hold your turn),',
  );
  return `${SUPER_ANSWER_PREFIX} item=${item.id} unclear\n${body}`;
}

/** An answer message read back for the transcript: the card's receipt in place of a bubble. */
export function parseSuperAnswer(text: string): { item: string; unclear: boolean; values: string[] } | null {
  if (typeof text !== 'string') return null;
  const m = /^\[super answer\] item=(\S+)( unclear)?\s*(?:\n|$)/.exec(text.trimStart());
  if (!m) return null;
  const values: string[] = [];
  const pair = /"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g;
  for (let p = pair.exec(text); p; p = pair.exec(text)) {
    try { values.push(JSON.parse(`"${p[2]}"`) as string); } catch { /* not ours: skip */ }
  }
  return { item: m[1], unclear: !!m[2], values };
}

/** Into the super chat: a running turn steers (never waits), an idle one gets a turn. False =
 *  nothing could be sent from here (no session, a closed socket). */
export function sendToSuper(s: Pick<ChatSession, 'status' | 'busy' | 'steer' | 'send'> | undefined, text: string): boolean {
  if (!s || s.status !== 'open') return false;
  if (s.busy) { if (!s.steer(text)) s.send(text); } else s.send(text);
  return true;
}
