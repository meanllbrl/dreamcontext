import { useSyncExternalStore } from 'react';
import type { SuperQueueItem } from '../../../lib/superTypes';
import type { ChatItem, ChatSession, ChatToolItem, PendingQuestion } from '../chatSession';
import { splitShellSegments, tokenizeShell } from '../chat/dreamCommand';
import { toolResultText } from '../chat/chatEntities';
import { OPEN_LATCH, latchClick, latchSeen, superAnswerPicks, superEventOf, type AnswerLatch } from './superHandover';

/**
 * The Super Agent's question to the owner, IN the super chat (owner 2026-10-21 18:17: "soruyu hep
 * chatta sorsun"). Before this the options were buttons on the job bar only; the chat showed the
 * question as prose and a "Super ask" tool row. Now the question is a card under the turn that
 * asked it, its options buttons, answered exactly where the job bar answers: the super's own
 * `super ask` -> "Answer to your question: <label>" into the super chat; a child's question it
 * escalated with `super queue ask` -> the CHILD (`answerQuestion`). The bar row stays.
 *
 * Nothing here waits on anything: `super ask` returned at once and the super's turn ended (the
 * reason it is not AskUserQuestion, which held the super's turn for 82 minutes in the field).
 *
 * Pure parts (parse, placement, states, labels) are tested in tests/unit/super-question-card; the
 * latch store below is the ONE answer per question shared by the card and the job bar.
 */

// ─── The anchor: the call that asked ──────────────────────────────────────────

/** A question the transcript shows the super agent asking. */
export interface AskRef {
  /** The queue item id the server answered with. */
  item: string;
  kind: 'ask' | 'question';
  /** The words it asked in, read from the command (the live item's text wins while open). */
  text: string;
  /** An `ask`'s options as written (`--options a|b`); a child question's come from the child. */
  options: string[];
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
    if (!block) continue;
    const args = call.args;
    if (call.kind === 'question') {
      return { item: block.item as string, kind: 'question', text: args.slice(1).find((a) => !a.startsWith('--')) ?? '', options: [], toolItemId: tool.id };
    }
    let text = '';
    let options: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i];
      if (a === '--options') { options = (args[i + 1] ?? '').split('|').map((x) => x.trim()).filter(Boolean); i += 1; continue; }
      if (a.startsWith('--options=')) { options = a.slice('--options='.length).split('|').map((x) => x.trim()).filter(Boolean); continue; }
      if (!text && !a.startsWith('--')) text = a;
    }
    return { item: block.item as string, kind: 'ask', text, options, toolItemId: tool.id };
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

/**
 * What an answered card shows. The label clicked in this window first. Else, for an `ask`: the
 * server closes it on the owner's NEXT message, whatever it says (inbox.ts closeOpenAsks), so the
 * answer is exactly the first owner-written item after the anchor (super event turns skipped),
 * never one further on. Another `ask` asked before any owner message means this one was closed
 * unanswered (a take-back; the server never holds two open asks): `closed`, and it never borrows
 * the later ask's answer. `closed` too = no owner message at all after it.
 */
export function answerLabelOf(
  ref: Pick<AskRef, 'item' | 'kind' | 'toolItemId'>,
  items: readonly ChatItem[],
  clicked: string | undefined,
): { label: string } | 'answered' | 'closed' {
  if (clicked) return { label: clicked };
  if (ref.kind !== 'ask') return 'answered';
  const from = items.findIndex((it) => it.id === ref.toolItemId);
  if (from < 0) return 'answered';
  for (let i = from + 1; i < items.length; i += 1) {
    const it = items[i];
    if (it.kind === 'tool') {
      const other = askRefOf(it);
      // The server holds one open ask at a time (`ask_open`): another one asked before any
      // owner message means this one closed WITHOUT an answer (a take-back closes asks).
      if (other && other.kind === 'ask' && other.item !== ref.item) return 'closed';
      continue;
    }
    if (it.kind !== 'user' || it.superEvent || superEventOf(it.text)) continue;
    const m = /^Answer to your question: (.+)$/s.exec(it.text.trim());
    return m ? { label: m[1].trim() } : 'answered';
  }
  return 'closed';
}

// ─── One answer, two places (the card and the job bar) ──────────────────────────

/** The answer an `ask` option sends, exactly as drawn and framed (plan r4 D7). */
export function askAnswerText(label: string): string {
  return `Answer to your question: ${label}`;
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
/** Clicked labels by item id: kept past the latch (an answered card still shows its answer). */
const clickedLabels = new Map<string, string>();
const CLICKED_CAP = 200;
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

export function recordOwnerAnswer(item: string, label: string): void {
  clickedLabels.delete(item);
  clickedLabels.set(item, label);
  while (clickedLabels.size > CLICKED_CAP) clickedLabels.delete(clickedLabels.keys().next().value as string);
}

export function clickedOwnerAnswer(item: string): string | undefined {
  return clickedLabels.get(item);
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
  clickedLabels.clear();
  version = 0;
}

/**
 * Send the owner's pick where it belongs. An `ask`: the framed label into the super chat (a
 * running turn steers). A question: the child's own AskUserQuestion, answered as its card would.
 * False = nothing could be sent from here (no session, a closed socket, the child's request not
 * in this window, a pick it would refuse).
 */
export function sendOwnerAnswer(
  item: SuperQueueItem,
  label: string,
  at: { superSession: ChatSession | undefined; child: ChatSession | undefined },
): boolean {
  if (item.kind === 'ask') {
    const s = at.superSession;
    if (!s || s.status !== 'open') return false;
    const text = askAnswerText(label);
    if (s.busy) { if (!s.steer(text)) s.send(text); } else s.send(text);
    return true;
  }
  const child = at.child;
  const question = childQuestionOf(item, child);
  if (!child || child.status !== 'open' || !question) return false;
  const picks = superAnswerPicks(question.questions, [label]);
  if (!picks.ok) return false;
  child.answerQuestion(question.requestId, question.questions, picks.picked, picks.notes);
  return true;
}

/** The option labels a card or the bar can offer for an item: an `ask`'s own, or the child's
 *  single-choice single question's first four (anything richer is answered in words). */
export function ownerOptionsOf(item: SuperQueueItem, child: ChatSession | undefined): string[] {
  if (item.kind === 'ask') return item.options ?? [];
  const q = childQuestionOf(item, child);
  const one = q && q.questions.length === 1 && !q.questions[0].multiSelect ? q.questions[0] : null;
  return one ? one.options.slice(0, 4).map((o) => o.label) : [];
}
