/**
 * The Super's questions to the owner, on its Telegram bot (plan "Answering", A4, M2, M6; P3).
 *
 *  - Every open item he answers (the Super's own ask, a child's escalated or direct question, an
 *    AI Team approval, a job that needs him), head of his bar or not, goes once through the
 *    `telegram` sink while he is away (`owner-question.ts` offers them; owner 2026-11-09: a
 *    question behind another reached Telegram only on his next message). At the Mac: nothing
 *    (`at_mac`), and the turn-away flush offers them then.
 *  - Each send re-reads the record first: an item answered meanwhile is not sent. Its outcome is
 *    reported back (`noteTelegramSend`), so `super ask` says what LANDED, and written to
 *    `~/.dreamcontext/logs/telegram-asks.log`; a refused send is offered again later.
 *  - One clean message per question: the card's title once, the job's name, the question, its
 *    description, its option notes; an option's drawing as a picture (rich-asks.ts).
 *  - Answered anywhere else (the Mac card, the Super's `answer`, another device), its Telegram
 *    copy is edited to "✓ Cevaplandı: <seçim>" and its buttons go.
 *  - A child's PERMISSION (never offered by the sink): when a child of a bound Super starts
 *    asking one and its queue item is open, "İzin ver (bir kez)" / "Reddet".
 *
 * Answers:
 *  - the Super's own ask → owner text `superAnswerText(...)` injected under a fresh Telegram ref;
 *  - a child question → `answerChildQuestion` (the window's `super answer` verb);
 *  - a child permission → `answerChildPermission` (the window's `super allow`, `by: 'owner'`).
 * Each through a single-use, message-bound button record (hub.sendButtons).
 *
 * A CHILD's owner card (sahip-karti-yerinde K7: an `owner` item, or its `member` mirror, that
 * carries a card handle) is one message: the job, the card's command or title (escaped, secrets
 * redacted), the kind's one sentence, and "Mac'e dönünce hatırlat" (marks the item; his next
 * words on the Mac raise ONE desktop notification naming the marked cards) and "Gerek yok"
 * (closes the item). A run card it can show whole also gets its folder and ▶ Çalıştır
 * (run-kart-telefon), pressed in runs.ts `pressChildRun`. Never a field.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { buildAppLink } from '../../lib/app-link.js';
import type { CardSpec } from '../../lib/cards/public.js';
import { onOwnerAtMac, postOwnerCardRemind } from '../../lib/telegram/back-at-mac.js';
import { closeOwnerItemForCard, dropOwnerReceipts, ownerCardLookup } from '../owner-receipts.js';
import { join } from 'node:path';
import { getChat, onChatChange, onRequestAnswered, pendingRequest, type ChatEntry } from '../../lib/assistant/chat-registry.js';
import { announces, noteTelegramSend, offerOwnerItemsToTelegram, setOwnerQuestionSinks } from '../../lib/super/owner-question.js';
import { readSuperState, superIdOfMember, updateSuperState } from '../../lib/super/store.js';
import { answerChildQuestion, answerOwnerItem, memberMirrorTarget, superAnswerText, shownKeyOf } from '../../lib/super/answer.js';
import { answerMemberPick, pickLine, sizeLine } from './member-picks.js';
import { memberTitle, itemCall } from '../../lib/super/inbox.js';
import { askSpecFromLegacy, OWNER_CARD_TELEGRAM_LINE, OWNER_CARD_TELEGRAM_RUN_MAC_LINE, type GrantOffer, type GrantSize, type RefusalFact, type SuperAskSpec, type SuperQueueItem } from '../../lib/super/types.js';
import {
  buildQuestionPicks, OWNER_CARD_NOT_NEEDED_DONE, OWNER_CARD_NOT_NEEDED_LABEL, OWNER_CARD_REMIND_DONE, OWNER_CARD_REMIND_LABEL, OWNER_CARD_RUN_LABEL,
  OWNER_CARD_REMIND_TITLE, type ButtonRecord,
} from '../../lib/telegram/contract.js';
import { formatAskCardMessages, formatAskQuestionHtml, withDrawingNotes, type AskCardQuestion, type DrawnOption } from '../../lib/telegram/ask-format.js';
import { escapeHtml, redactSecrets } from '../../lib/telegram/format.js';
import { cardAbout, closedCardHtml } from '../../lib/telegram/system-lines.js';
import { agendaItemBlock } from '../../lib/telegram/headers.js';
import { LINES, NOT_SHOWN_WHOLE_LINE, editFailureOf, shownWhole, visibleCommand, type ActiveBinding, type EditFailure, type SuperTurnSpan, type TelegramHub } from './hub.js';
import { richQuestionsOf, type RichAsks, type RichQuestion, type RichTarget } from './rich-asks.js';
import { wireTelegramAppRequests } from './app-requests.js';
import { appendAskLog } from './ask-log.js';
import { readCopies, writeCopies, type StoredButtons, type StoredCopy, type StoredRich } from './copies-store.js';
import { childRunOffer, RUN_LINES } from './runs.js';

/** W5 rich asks (multi-select, several questions, previews): set by `wireTelegramW5`. */
let rich: RichAsks | null = null;
export function setRichAsks(r: RichAsks | null): void { rich = r; }

type Obj = Record<string, unknown>;

/** Items taken for Telegram (per process): one send at a time per item; a failed one is let go. */
const sentItems = new Set<string>();

/** What an item's Telegram copy is: its messages, so an answer elsewhere can close them. */
/** `again`: this copy is a card sent again below a turn that buried it (resurfaceBuried): its
 *  question and buttons only, the full card and its drawings sit above it, once. */
interface Copy { ab: ActiveBinding; sessionId?: string; requestId?: string; askId?: string; kind?: SuperQueueItem['kind']; messages: CopyMessage[]; turn?: true; sentAt?: number; again?: true; rich?: StoredRich }
/** One message of a copy; `buttons` binds its buttons again after a restart (copies-store.ts). */
interface CopyMessage { messageId: number; html: string; question?: string; buttons?: StoredButtons }

/** A member's item or a refused call goes one at a time (K5): the next after his answer. */
function oneAtATime(item: SuperQueueItem): boolean {
  return item.kind === 'member' || (item.kind === 'owner' && item.wait?.kind === 'refusal');
}
/** Is one such card of this project still open on Telegram (another than `id`)? */
function turnOpen(projectName: string, id: string): boolean {
  for (const [cid, c] of copies) if (cid !== id && c.turn && c.ab.projectName === projectName) return true;
  return false;
}
const copies = new Map<string, Copy>();
const COPIES_CAP = 200;
/** The kind of each item being sent, so its copy knows whether a reply to it answers it. */
const kindOf = new Map<string, SuperQueueItem['kind']>();

/**
 * The open question a Telegram reply answers: a reply to a message of a question card's copy
 * (the Super's own ask, or a child's question) on this bot. Its header (`[About agenda line
 * item=<id> section=waiting]`) is what closes it, exactly like the Mac's "write about this" on
 * its row (owner 2026-11-11: only a tap or an answer written about the card closes it).
 */
export function cardReplyItem(ab: Pick<ActiveBinding, 'key'>, replyToMessageId: number): string | null {
  if (!Number.isSafeInteger(replyToMessageId) || replyToMessageId <= 0) return null;
  for (const [id, c] of copies) {
    if (c.ab.key !== ab.key || (c.kind !== 'ask' && c.kind !== 'question')) continue;
    if (c.messages.some((m) => m.messageId === replyToMessageId)) return id;
  }
  return null;
}

type SendOutcome = { ok: true } | { ok: false; why: string; retryAfterS?: number } | { skipped: true };

/** The one card a W2 message can carry as buttons: one question, single-select, 1-8 options. */
function simpleCard(spec: SuperAskSpec | null | undefined): { question: string; labels: string[]; card: AskCardQuestion } | null {
  const qs = spec?.questions ?? [];
  if (qs.length !== 1 || qs[0].multiSelect || !qs[0].options?.length || qs[0].options.length > 8) return null;
  // Option previews are pictures (W5 M3): the rich path sends them before the buttons.
  if (rich && qs[0].options.some((o) => typeof (o as { preview?: unknown }).preview === 'string' && (o as { preview: string }).preview.trim())) return null;
  return { question: qs[0].question, labels: qs[0].options.map((o) => o.label), card: qs[0] };
}

/** One line per send to `~/.dreamcontext/logs/telegram-asks.log` (the server's stdout is
 *  /dev/null in the app: without this a lost question leaves no trace). Rotated at 512 KB. */
function logSend(hub: TelegramHub, item: SuperQueueItem, outcome: SendOutcome): void {
  const what = 'skipped' in outcome ? 'skipped (answered before it went)' : outcome.ok ? 'sent' : `FAILED ${outcome.why}`;
  appendAskLog(hub.home, `${item.id} ${item.kind} ${what}`);
}

/** Questions sent as text with no picture: each option's drawing says it is on the Mac, and the
 *  log says the pictures did not go (never a silent loss). */
function macDrawn<Q extends AskCardQuestion>(hub: TelegramHub, id: string, qs: readonly Q[]): Q[] {
  const wanted = qs.reduce((n, q) => n + ((q.options ?? []) as readonly DrawnOption[]).filter((o) => o.preview?.trim()).length, 0);
  if (wanted) appendAskLog(hub.home, `${id} pictures 0/${wanted} NOT ALL SENT (sent as text: this card has no picture path)`);
  return qs.map((q, i) => (q.options ? withDrawingNotes({ ...q, options: q.options }, i, new Set<string>()) : q));
}

function failure(err: unknown): string {
  return redactSecrets(String((err as Error)?.message ?? err ?? 'unknown')).replace(/\s+/g, ' ').slice(0, 200);
}

/** One queue item to its bot, once at a time. True = taken (the outcome is reported later). */
function offerItem(hub: TelegramHub, ab: ActiveBinding, sessionId: string, item: SuperQueueItem): boolean {
  if (sentItems.has(item.id)) return true;
  sentItems.add(item.id);
  // A text after the Super's own question card that re-says its answer is not sent (sent-once.ts).
  if (item.kind === 'ask' || item.superAsked === true) hub.noteQuestionCard(sessionId);
  // The Super's own ask that LANDS is its turn speaking (no "göndermeden bitti" after it); sent
  // in line with its texts. A child's item or an approval is not the Super's turn speaking.
  // Marked before it is queued: the turn's texts queued after it know a card came first.
  const own = item.kind === 'ask' ? hub.ownAskOffered(sessionId, item.createdAt) : null;
  hub.queueSend(sessionId, async () => {
    // The running turn's own card: a short line it held just before (hub.ts `tails`) goes first.
    if (own?.inTurn) await hub.flushTail(sessionId);
    let outcome: SendOutcome;
    try { outcome = (await adoptCopy(hub, ab, item)) ?? await sendItem(hub, ab, sessionId, item); } catch (err) {
      const retry = (err as { retryAfter?: unknown })?.retryAfter;
      outcome = { ok: false, why: failure(err), ...(typeof retry === 'number' && retry > 0 ? { retryAfterS: retry } : {}) };
    }
    // Not sent (refused, or closed before it went): let go, so a later offer is a real send.
    if ('skipped' in outcome || !outcome.ok) sentItems.delete(item.id);
    logSend(hub, item, outcome);
    noteTelegramSend(item.id, outcome);
    // Answered while it was going: close it at once.
    if ('ok' in outcome && outcome.ok && !(await stillOpen(ab, item))) await closeCopy(hub, item.id, null);
    if (own && 'ok' in outcome && outcome.ok) own.landed = true;
    return item.kind === 'ask' && 'ok' in outcome && outcome.ok;
  });
  return true;
}

/** Is this item still the owner's to answer (its record open; a child's question still asked)? */
async function stillOpen(ab: ActiveBinding, item: SuperQueueItem): Promise<boolean> {
  if (!ab.contextRoot) return false;
  const s = await readSuperState(ab.contextRoot).catch(() => null);
  const now = s?.queue.find((q) => q.id === item.id);
  if (!s?.enabled || !now || !announces(now)) return false;
  // A routine is open until its fact leaves the disk (its `shown` marker only stops a second ring).
  if (now.kind === 'routine') return now.state !== 'done';
  if (now.kind === 'question') {
    const pq = pendingRequest(getChat(now.sessionId), now.requestId);
    return !!pq && !pq.isPermission;
  }
  return true;
}

function remember(itemId: string, copy: Copy, item?: SuperQueueItem): void {
  copies.delete(itemId);
  copy.kind ??= kindOf.get(itemId);
  copy.sentAt ??= Date.now();
  copies.set(itemId, item && oneAtATime(item) ? { ...copy, turn: true } : copy);
  while (copies.size > COPIES_CAP) copies.delete(copies.keys().next().value as string);
  save(copy.ab.contextRoot);
}

// ─── Copies kept across a restart (copies-store.ts) ───────────────────────────────────────────
// Every change to `copies` is written to the project's `state/.super/telegram-copies.json`. After
// a start, what the file holds waits in `kept` until its item is offered again: then its copy is
// taken back (buttons bound again on the same messages) and nothing is sent; an item that closed
// meanwhile has its copy closed. One live copy of a card, restart or not.

/** Read back from disk after a start, not yet taken back: per project root, by item id. */
const kept = new Map<string, Map<string, StoredCopy>>();
function keptOf(root: string): Map<string, StoredCopy> {
  let m = kept.get(root);
  if (!m) { m = new Map(Object.entries(readCopies(root))); kept.set(root, m); }
  return m;
}

function stored(c: Copy): StoredCopy {
  return {
    key: c.ab.key, botId: c.ab.binding.botId, chatId: c.ab.binding.chatId, sentAt: c.sentAt ?? Date.now(),
    ...(c.kind ? { kind: c.kind } : {}), ...(c.sessionId ? { sessionId: c.sessionId } : {}), ...(c.requestId ? { requestId: c.requestId } : {}),
    ...(c.turn ? { turn: true as const } : {}), ...(c.again ? { again: true as const } : {}), ...(c.rich ? { rich: c.rich } : {}),
    messages: c.messages.filter((m) => m.messageId > 0).map((m) => ({ messageId: m.messageId, html: m.html, ...(m.question ? { question: m.question } : {}), ...(m.buttons ? { buttons: m.buttons } : {}) })),
  };
}

/** This project's copies to disk: the live ones and those still waiting to be taken back. */
function save(root: string | null | undefined): void {
  if (!root) return;
  const out: Record<string, StoredCopy> = Object.fromEntries(keptOf(root));
  for (const [id, c] of copies) if (c.ab.contextRoot === root && c.messages.some((m) => m.messageId > 0)) out[id] = stored(c);
  writeCopies(root, out);
}

/** A rich ask's copy, as it is kept (the target reduced to the ids its answer uses). */
function richOf(target: RichTarget, questions: readonly RichQuestion[]): StoredRich {
  const t = target.kind === 'super-ask' ? { kind: 'super-ask', item: { id: target.item.id, kind: target.item.kind, sessionId: target.item.sessionId } } : { ...target };
  return { target: t, questions: questions.map((q) => ({ ...q })) as unknown as Record<string, unknown>[] };
}

/** Each message of a kept copy becomes its one line (`line` of its text, telegram-sade), its
 *  buttons gone (records die with the edit).
 *  Null once every message is closed or gone; else the passing failure that stopped it (the
 *  copy stays kept and is tried again: never a second copy beside a live one). */
async function closeKept(hub: TelegramHub, ab: ActiveBinding, s: StoredCopy, line: (html: string) => string): Promise<Extract<EditFailure, { gone: false }> | null> {
  for (const m of s.messages) {
    const r = await hub.closeEdit(ab, m.messageId, line(m.html)).catch((err) => editFailureOf(err));
    if (r !== true && !r.gone) return r;
  }
  return null;
}

/** A kept copy whose card closed while nobody held it: the one closed line, its subject kept. */
const keptClosedLine = (html: string): string => closedCopyLine(null, cardAbout(html));

/** Is this item still the owner's to answer, as its Telegram copy sees it? A child's permission
 *  is his while it is not done, not handed to the Super, and the child still asks it (the bar's
 *  rule); every other kind as {@link stillOpen}. */
async function copyOpen(ab: ActiveBinding, item: SuperQueueItem): Promise<boolean> {
  if (item.kind !== 'permission' || item.own === true) return stillOpen(ab, item);
  if (item.state === 'done' || item.toSuper) return false;
  return !!pendingRequest(getChat(item.sessionId), item.requestId)?.isPermission;
}

/**
 * The copy this item had before a restart, taken back: its buttons bound again on the same
 * messages, nothing sent. Null = nothing kept for this bot and chat, or the old copy is gone
 * (Telegram no longer has a message of it): the caller sends the card as new, and what is left
 * of the old copy has lost its buttons and points down. A PASSING failure (a flood limit, a
 * timeout) is `ok: false`: the copy stays kept and the offer tries again; no second copy.
 * The kept entry leaves the disk only once it is taken back, closed, or replaced.
 */
async function adoptCopy(hub: TelegramHub, ab: ActiveBinding, item: SuperQueueItem): Promise<SendOutcome | null> {
  const root = ab.contextRoot;
  if (!root) return null;
  const k = keptOf(root);
  const s = k.get(item.id);
  if (!s || s.key !== ab.key || s.botId !== ab.binding.botId || s.chatId !== ab.binding.chatId) return null;
  const drop = (): void => { if (k.get(item.id) === s) k.delete(item.id); save(root); };
  const later = (f: Extract<EditFailure, { gone: false }>): SendOutcome => {
    appendAskLog(hub.home, `${item.id} ${item.kind} kept copy not taken back yet (${f.why}): tried again, nothing sent`);
    return { ok: false, why: `its earlier copy could not be taken back yet: ${f.why}`, ...(f.retryAfterS ? { retryAfterS: f.retryAfterS } : {}) };
  };
  // Gone: what is left of the old copy points down, then the card goes as new.
  const replace = async (): Promise<SendOutcome | null> => {
    const f = await closeKept(hub, ab, s, () => MOVED_COPY_LINE);
    if (f) return later(f);
    drop();
    appendAskLog(hub.home, `${item.id} ${item.kind} kept copy is gone from the chat: sent as new`);
    return null;
  };
  if (!(await copyOpen(ab, item))) {
    const f = await closeKept(hub, ab, s, keptClosedLine);
    if (f) return later(f);
    drop();
    return { skipped: true };
  }
  let askId: string | undefined;
  if (s.rich) {
    const r = rich ? await rich.adopt(ab, s.rich.target as unknown as RichTarget, s.rich.questions as unknown as RichQuestion[], s.messages).catch((err) => editFailureOf(err)) : { gone: true as const };
    if (typeof r !== 'string') return r.gone === false ? later(r) : replace();
    askId = r;
  } else {
    for (const m of s.messages) {
      if (!m.buttons) continue;
      const r = await hub.rebindButtons(ab, m.messageId, m.html, m.buttons.rows, m.buttons.rec, m.buttons.data).catch((err) => editFailureOf(err));
      if (r !== true) return r.gone === false ? later(r) : replace();
    }
  }
  if (k.get(item.id) === s) k.delete(item.id);
  kindOf.set(item.id, item.kind);
  remember(item.id, {
    ab, messages: s.messages, sentAt: s.sentAt, ...(askId ? { askId } : {}), ...(s.rich ? { rich: s.rich } : {}),
    ...(s.sessionId ? { sessionId: s.sessionId } : {}), ...(s.requestId ? { requestId: s.requestId } : {}),
    ...(s.again ? { again: true as const } : {}), ...(s.turn ? { turn: true as const } : {}),
  });
  appendAskLog(hub.home, `${item.id} ${item.kind} kept after a restart (its copy taken back, not sent again)`);
  return { ok: true };
}

/** After a start: every kept copy of this bot whose item closed while the server was down says
 *  so and loses its buttons (no offer will ever come for it). One that could not be edited yet
 *  stays kept for the next pass. */
async function closeKeptClosed(hub: TelegramHub, ab: ActiveBinding): Promise<void> {
  const root = ab.contextRoot;
  if (!root) return;
  const k = keptOf(root);
  const mine = [...k].filter(([, s]) => s.key === ab.key && s.botId === ab.binding.botId && s.chatId === ab.binding.chatId);
  if (!mine.length) return;
  const st = await readSuperState(root).catch(() => null);
  if (!st) return;
  for (const [id, s] of mine) {
    const item = st.queue.find((q) => q.id === id);
    if (item && (await copyOpen(ab, item))) continue;
    if (await closeKept(hub, ab, s, keptClosedLine)) continue;
    if (k.get(id) === s) k.delete(id);
  }
  save(root);
}


/** The line a closed copy ends with: "✓ Cevaplandı" only with the pick it was answered with.
 *  A close that carries no answer (the record closed it: a message of his taken as the answer,
 *  a new session, a hand-over) says only that the card closed, never that he answered it
 *  (owner 2026-11-10: a card stamped "Cevaplandı" while the Super still waited on him). */
export function closedCopyLine(pick: string | null, about = ''): string {
  // ONE line once closed (telegram-sade, Doc C3): the question goes, the answer and its subject stay.
  return pick ? closedCardHtml(`✓ Cevaplandı: ${pick.replace(/\s+/g, ' ')}`, about) : closedCardHtml('Bu kart kapandı', about);
}

/** Closed elsewhere: each message of its copy says how, buttons gone. */
async function closeCopy(hub: TelegramHub, itemId: string, answers: Record<string, string> | null): Promise<void> {
  const c = copies.get(itemId);
  if (!c) return;
  copies.delete(itemId);
  save(c.ab.contextRoot);
  if (c.askId) rich?.close(c.askId);
  const all = answers ? Object.values(answers).filter(Boolean).join(' · ') : '';
  for (const m of c.messages) {
    if (!m.messageId) continue;
    // A permission tapped on Telegram already says what he chose (the hub's edit): kept.
    if (c.kind === 'permission' && m.buttons && !hub.buttonsLive(c.ab, m.messageId)) continue;
    // One message holds the whole card (a rich ask, telegram-sade): its line carries every answer.
    const pick = c.messages.length === 1 ? all : answers && m.question ? answers[m.question] ?? '' : '';
    await hub.closeAnswered(c.ab, m.messageId, closedCopyLine(pick || null, cardAbout(m.html)));
  }
}

/** What an old copy of a card becomes when Telegram will not delete it (older than 48 h). */
export const MOVED_COPY_LINE = '<i>↓ Aşağıda yeniden soruldu.</i>';

/**
 * A question card buried under later messages comes back to the bottom (owner 2026-11-16: "bana
 * sorduğun soru kartı benim ekranıma gelmiyor"; the card landed at 23:33, the Super's next turn
 * put its texts and a voice under it at 23:42 and said "a card is open" while none was in view).
 * At the end of a Super turn OTHER than the one that sent it, an open question card (the Super's
 * own ask, a child's question) with anything this bot posted below it is sent again; only once
 * the new one landed does the old copy lose its buttons and say where it went. Its own turn's
 * line after it ("a question waits") does not count: that turn speaks about the card in view.
 */
async function resurfaceBuried(hub: TelegramHub, ab: ActiveBinding, superSession: string, turn: SuperTurnSpan): Promise<void> {
  if (turn.before < 0 || !hub.ownerAway()) return;
  // Only what THIS turn posted buries a card: never another card's resend, never a turn that
  // wrote nothing (review r1: two open cards took turns being resent on every quiet turn).
  const last = ab.transport.lastSentMessageId(ab.binding.chatId);
  if (last <= turn.before) return;
  for (const [id, c] of [...copies]) {
    if (c.ab.key !== ab.key || (c.kind !== 'ask' && c.kind !== 'question')) continue;
    if ((c.sentAt ?? Infinity) >= turn.startedAt) continue;
    const top = Math.max(0, ...c.messages.map((m) => m.messageId));
    if (!top || top >= last) continue;
    const s = ab.contextRoot ? await readSuperState(ab.contextRoot).catch(() => null) : null;
    const item = s?.queue.find((q) => q.id === id);
    if (!item) continue;
    // Which of its messages carry buttons now: one tapped while it goes again keeps his answer.
    const live = new Set(c.messages.filter((m) => m.messageId && hub.buttonsLive(c.ab, m.messageId)).map((m) => m.messageId));
    let outcome: SendOutcome;
    try { outcome = await sendItem(hub, ab, superSession, item, true); } catch (err) { outcome = { ok: false, why: failure(err) }; }
    // Not sent again (refused, or closed meanwhile): the old copy stays as it is.
    if (!('ok' in outcome) || !outcome.ok) {
      if ('ok' in outcome) appendAskLog(hub.home, `${id} ${item.kind} resend below FAILED ${outcome.why}`);
      continue;
    }
    // Answered while it went again (a tap on the old card, the Mac): the new copy closes, if it
    // is still the one kept, and the old one keeps what the answer wrote on it.
    if (!(await stillOpen(ab, item))) {
      if (copies.get(id) !== c) await closeCopy(hub, id, null);
      appendAskLog(hub.home, `${id} ${item.kind} answered while it was resent below`);
      continue;
    }
    const now = copies.get(id);
    if (now && now !== c) now.again = true;
    if (c.askId) rich?.close(c.askId);
    // One live copy at any time, and what it showed goes once (owner 2026-11-22: the same two
    // drawings and the stage PDF came again with every later turn). The resend below carries only
    // the question and its buttons. The FIRST copy keeps its body and its drawings above it, loses
    // its buttons and points down, unless the resend says all it said (a bare card): then it is
    // deleted (telegram-sade, Doc C3). An earlier resend says nothing the first does not: it
    // leaves the chat. Only a message Telegram will not delete becomes the one line.
    const whole = !c.again && !(now && now !== c && sameText(c, now));
    for (const m of c.messages) {
      if (!m.messageId || (live.has(m.messageId) && !hub.buttonsLive(c.ab, m.messageId))) continue;
      if (whole) { await hub.closeAnswered(c.ab, m.messageId, `${m.html}\n\n${MOVED_COPY_LINE}`).catch(() => false); continue; }
      if (await hub.deleteMessage(c.ab, m.messageId)) continue;
      await hub.closeAnswered(c.ab, m.messageId, MOVED_COPY_LINE).catch(() => false);
    }
    appendAskLog(hub.home, `${id} ${item.kind} resent below (later messages buried it)`);
  }
}

/** Does the copy sent again below say every word the old one said (no body, note or drawing lost)? */
function sameText(old: Copy, again: Copy): boolean {
  return old.messages.length === again.messages.length && old.messages.every((m, i) => m.html === again.messages[i].html);
}

/**
 * A member's item from the owner's OWN conversation with that member (`ownerTalk` on its mirror,
 * owner 2026-11-15): it goes on the member's own bot, under its name, when that bot is bound to
 * this project; else on the Super bot as before. Its answer reads main's record through the
 * binding's project root, so only a project-bound member bot carries it.
 */
export function ownerTalkBinding(hub: Pick<TelegramHub, 'bindingOfSuper'>, vault: string, item: SuperQueueItem): ActiveBinding | null {
  if (item.kind !== 'member' || item.ownerTalk !== true || !item.member) return null;
  const ab = hub.bindingOfSuper(vault, superIdOfMember(item.member));
  return ab && !ab.disabled && ab.target !== 'super' && ab.contextRoot ? ab : null;
}

export function wireTelegramAsks(hub: TelegramHub): () => void {
  setOwnerQuestionSinks({
    // At the Mac (`hub.ownerAway()` false) the Mac card is the only one: `at_mac`, nothing taken,
    // so the turn-away flush below sends it once he is away.
    telegram: ({ vault, sessionId, item }) => {
      // Owner 2026-11-15: a child's question never goes to Telegram by itself. The Super reads it
      // (`event=question`), answers it, or asks in its own words (`super ask`, `queue ask`): only
      // those reach here (`superAsked`).
      if (item.kind === 'question' && item.superAsked !== true) return false;
      // The same for a member Super's child question mirrored into main's queue (owner decision
      // 2026-11-15), even inside his own talk with that member: the member's Super asks with its
      // own `super ask`, which is a member `ask`.
      if (item.kind === 'member' && item.of === 'question') return false;
      const ab = ownerTalkBinding(hub, vault, item) ?? hub.superBindingOfVault(vault);
      if (!ab) return 'no_bot';
      if (!hub.ownerAway()) return 'at_mac';
      // One at a time: not taken now, offered again by the write his answer makes.
      if (oneAtATime(item) && turnOpen(ab.projectName, item.id)) return false;
      return offerItem(hub, ab, sessionId, item);
    },
    // Closed: its copy says so, and the item is no longer counted as carried, so the same item
    // reopened later (a member's mirror, K8) is offered again.
    telegramClosed: ({ id }) => { sentItems.delete(id); void closeCopy(hub, id, null).catch(() => {}); },
  });
  const off = onChatChange((c) => { void onChildAsking(hub, c.entry).catch(() => {}); });
  // A child's question answered through its window (Mac card, `super answer`, a tap): its pick.
  const offAnswered = onRequestAnswered((a) => {
    for (const [id, c] of copies) {
      if (c.sessionId === a.sessionId && c.requestId === a.requestId) { void closeCopy(hub, id, a.answers).catch(() => {}); break; }
    }
  });
  // He turned away: every question still open on this Super goes (oldest first), each once; and
  // every child permission still open.
  const flush = async (ab: ActiveBinding): Promise<void> => {
    // A copy kept from before a restart whose item closed meanwhile: closed now, on any bot.
    await closeKeptClosed(hub, ab).catch(() => {});
    // The main Super's queue, on the main Super's bot only (a member's bot never carries it, B2).
    if (ab.target !== 'super' || !ab.contextRoot || !hub.ownerAway()) return;
    const s = await readSuperState(ab.contextRoot);
    if (!s.enabled || !s.session) return;
    offerOwnerItemsToTelegram(ab.projectName, s);
    for (const q of [...s.queue].sort((a, b) => a.createdAt - b.createdAt)) {
      if (q.kind !== 'permission') continue;
      const child = q.state !== 'done' ? getChat(q.sessionId) : null;
      if (child) await onChildAsking(hub, child).catch(() => {});
    }
  };
  hub.awayFlushers.add(flush);
  const resurface = (ab: ActiveBinding, sessionId: string, turn: SuperTurnSpan): Promise<void> => resurfaceBuried(hub, ab, sessionId, turn);
  hub.turnEnders.add(resurface);
  const prev = hub.extraButton;
  hub.extraButton = async (ab, rec, idx) => rec.kind === 'owner-card'
    ? onOwnerCardButton(ab, rec, idx)
    : (rec.kind === 'question' && rec.data?.queue === true) || (rec.kind === 'permission' && rec.data?.queue === true)
      ? onQueueButton(hub, ab, rec, idx)
      : prev ? prev(ab, rec, idx) : LINES.stale;
  // A reply to a question card's message is written about that question: its header goes first.
  const prevPrefix = hub.turnPrefix;
  hub.turnPrefix = (ab, msg) => {
    const pre = prevPrefix ? prevPrefix(ab, msg) : '';
    const reply = msg.reply_to_message as Obj | undefined;
    const item = ab.target === 'super' ? cardReplyItem(ab, Number(reply?.message_id)) : null;
    const head = item ? agendaItemBlock(item, 'waiting') : '';
    return [head, pre].filter(Boolean).join('\n\n');
  };
  // An agent's app request card (app-onay-karti C6): its own away rule and button kind.
  const offApps = wireTelegramAppRequests(hub);
  // "Mac'e dönünce hatırlat" (K7): his next words on the Mac name every marked card, once.
  const offRemind = onOwnerAtMac(() => { void remindMarkedCards(hub).catch(() => {}); });
  return () => {
    offRemind(); offApps(); off(); offAnswered(); hub.awayFlushers.delete(flush); hub.turnEnders.delete(resurface);
    setOwnerQuestionSinks({ telegram: () => false, telegramClosed: () => {} });
    hub.extraButton = prev;
    hub.turnPrefix = prevPrefix;
  };
}

/** One message with buttons; its message id kept for the copy. */
async function buttons(hub: TelegramHub, ab: ActiveBinding, html: string, labels: string[], rec: Parameters<TelegramHub['sendButtons']>[3], data: Obj): Promise<CopyMessage> {
  return buttons2(hub, ab, html, labels.map((l) => [l]), rec, data);
}

/** Plain messages (answered on the Mac): every one must land, else it is a failure. */
async function plain(hub: TelegramHub, ab: ActiveBinding, htmls: string[]): Promise<{ messageId: number; html: string }[]> {
  const out: { messageId: number; html: string }[] = [];
  for (const html of htmls) {
    const sent = await hub.send(ab, html);
    out.push({ messageId: Number(sent?.message_id) || 0, html });
  }
  return out;
}

/** A card sent again below carries what answers it and nothing else: each question, its header
 *  and its option labels. The description, the option notes and the drawings went with its first
 *  copy (owner 2026-11-19: the same card came back five times, each time with its two pictures
 *  and its whole body). */
export function againQuestions<Q extends { question: string; header?: string; multiSelect?: boolean; options?: readonly { label: string }[] }>(qs: readonly Q[]): Q[] {
  return qs.map((q) => ({
    question: q.question, ...(q.header ? { header: q.header } : {}), ...(q.multiSelect ? { multiSelect: true } : {}),
    ...(q.options ? { options: q.options.map((o) => ({ label: o.label })) } : {}),
  }) as unknown as Q);
}

/**
 * Sends one queue item, if it is still open. Throws (or answers `ok: false`) when Telegram did
 * not take it; `skipped` when it closed before it went (owner 2026-11-09: a card arrived a minute
 * after the Super had answered it).
 */
async function sendItem(hub: TelegramHub, ab: ActiveBinding, superSession: string, item: SuperQueueItem, again = false): Promise<SendOutcome> {
  if (!(await stillOpen(ab, item))) return { skipped: true };
  kindOf.set(item.id, item.kind);
  if (kindOf.size > COPIES_CAP) kindOf.delete(kindOf.keys().next().value as string);
  if (item.kind === 'ask') {
    const asked = item.ask ?? askSpecFromLegacy(item.ownerText ?? '', item.options ?? []);
    const spec = again ? { ...asked, questions: againQuestions(asked.questions) } : asked;
    const card = simpleCard(spec);
    if (card) {
      const m = await buttons(hub, ab, formatAskQuestionHtml(macDrawn(hub, item.id, [card.card])[0], { title: spec.title }), card.labels,
        { kind: 'question', requestId: item.id, sessionId: superSession, singleUse: true },
        { queue: true, item: item.id, itemKind: 'ask', session: superSession, question: card.question, labels: card.labels, questions: spec.questions });
      remember(item.id, { ab, messages: [{ ...m, question: card.question }] });
      return { ok: true };
    }
    const target: RichTarget = { kind: 'super-ask', item };
    const rqs = richQuestionsOf(spec.questions);
    const r = rich ? await rich.send(ab, target, rqs, { title: spec.title, sessionId: superSession, itemId: item.id, again }) : false;
    if (r) {
      remember(item.id, { ab, askId: r.askId, rich: richOf(target, rqs), messages: r.messages.map((m, i) => ({ ...m, question: spec.questions[i]?.question })) });
      return { ok: true };
    }
    const htmls = spec.questions.length
      ? formatAskCardMessages(macDrawn(hub, item.id, spec.questions), { title: spec.title, footer: escapeHtml(LINES.waitingOnMac) })
      : [escapeHtml(`❓ ${redactSecrets(item.ownerText ?? 'Bir sorum var')}\n${LINES.waitingOnMac}`)];
    remember(item.id, { ab, messages: (await plain(hub, ab, htmls)).map((m, i) => ({ ...m, question: spec.questions[i]?.question })) });
    return { ok: true };
  }
  if (item.kind === 'question') {
    const pq = pendingRequest(getChat(item.sessionId), item.requestId);
    const asked = pq && !pq.isPermission ? pq.questions ?? [] : [];
    const qs = again ? againQuestions(asked) : asked;
    if (!qs.length || !item.requestId) return { skipped: true };
    // Who asks: the job's name, once (never `ownerText`, which already joins every question).
    const s = ab.contextRoot ? await readSuperState(ab.contextRoot).catch(() => null) : null;
    const job = s?.children?.[item.sessionId]?.brief?.trim();
    const lead = job ? `${job.slice(0, 80)} soruyor` : undefined;
    const base = { ab, sessionId: item.sessionId, requestId: item.requestId };
    const card = simpleCard({ questions: qs as SuperAskSpec['questions'] });
    if (card) {
      const m = await buttons(hub, ab, formatAskQuestionHtml(macDrawn(hub, item.id, [card.card])[0], { title: pq?.title, lead }), card.labels,
        { kind: 'question', requestId: item.requestId, sessionId: item.sessionId, singleUse: true },
        { queue: true, item: item.id, itemKind: 'question', question: card.question, labels: card.labels, questions: qs });
      remember(item.id, { ...base, messages: [{ ...m, question: card.question }] });
      return { ok: true };
    }
    const target: RichTarget = { kind: 'child-question', item: item.id, requestId: item.requestId };
    const rqs = richQuestionsOf(qs);
    const r = rich ? await rich.send(ab, target, rqs, { title: pq?.title, lead, sessionId: superSession, itemId: item.id, again }) : false;
    if (r) {
      remember(item.id, { ...base, askId: r.askId, rich: richOf(target, rqs), messages: r.messages.map((m, i) => ({ ...m, question: qs[i]?.question })) });
      return { ok: true };
    }
    const htmls = formatAskCardMessages(macDrawn(hub, item.id, qs), { title: pq?.title, lead, footer: escapeHtml(LINES.waitingOnMac) });
    remember(item.id, { ...base, messages: (await plain(hub, ab, htmls)).map((m, i) => ({ ...m, question: qs[i]?.question })) });
    return { ok: true };
  }
  // A child's owner card (K7): a Mac step, said plainly, with Remind and Not needed.
  if (item.kind === 'owner' && item.card) return sendOwnerCard(hub, ab, item, null);
  if (item.kind === 'member') return sendMemberItem(hub, ab, superSession, item);
  // A refused call (K2): the whole command and the sizes he may give it, or the Mac line.
  if (item.kind === 'owner' && item.wait?.kind === 'refusal' && item.wait.refusal) {
    return sendAllowCard(hub, ab, item, { refusal: item.wait.refusal, offer: item.offer, who: null, record: 'main', kind: 'refusal' });
  }
  // A routine stopped on him (K7): its own title and line; approval and review need the change in view.
  if (item.kind === 'routine') {
    remember(item.id, { ab, messages: await plain(hub, ab, [escapeHtml(`⏰ ${redactSecrets(item.ownerText ?? 'Bir rutin seni bekliyor')}\nMac'te, Agents sayfasında karar verirsin.`)]) });
    return { ok: true };
  }
  // Approvals (G1) and jobs that need him: shown, answered on the Mac in W2.
  const line = item.kind === 'approval' ? `✋ Onay bekliyor: ${item.member ?? 'ekip üyesi'}` : `✋ ${item.ownerText ?? 'Bir iş seni bekliyor'}`;
  remember(item.id, { ab, messages: await plain(hub, ab, [escapeHtml(`${redactSecrets(line)}\n${LINES.waitingOnMac}`)]) });
  return { ok: true };
}

/**
 * An AI Team member waiting on him (a `member` mirror, owner 2026-11-10), as its own kind would
 * go: its own question or a job's question with their options as buttons, a job's permission with
 * "İzin ver (bir kez)" / "Reddet", anything else as a line answered on the Mac. Every message is
 * led by the member's name; every button answers the MEMBER's item (`onQueueButton`).
 */
async function sendMemberItem(hub: TelegramHub, ab: ActiveBinding, superSession: string, item: SuperQueueItem): Promise<SendOutcome> {
  const who = ab.contextRoot ? memberTitle(ab.contextRoot, item.member ?? '') : item.member ?? '';
  const lead = `${who.slice(0, 80) || 'Bir ekip üyesi'} soruyor`;
  const data = { queue: true, item: item.id, itemKind: 'member' };
  if (item.of === 'permission') {
    const pq = pendingRequest(getChat(item.sessionId), item.requestId);
    if (!pq?.isPermission || !item.requestId) return { skipped: true };
    const command = pq.fullText ?? pq.text;
    const { html, rows, choices } = permissionCard(`${escapeHtml(who.slice(0, 60))} · `, pq.toolName, command, item.offer?.sizes ?? ['once'], who, item.offer);
    const shownCall = itemCall(pq);
    const m = await buttons2(hub, ab, html, rows,
      { kind: 'permission', requestId: item.requestId, sessionId: item.sessionId, singleUse: true }, { ...data, choices, shown: shownKeyOf(shownCall.tool, shownCall.input) });
    remember(item.id, { ab, messages: [m] }, item);
    return { ok: true };
  }
  if (item.of === 'owner' && item.card) return sendOwnerCard(hub, ab, item, who);
  if (item.of === 'owner') {
    // The member's item behind it holds the refused call (its mirror carries only the line).
    const t = ab.contextRoot ? await memberMirrorTarget(ab.contextRoot, item.id) : null;
    const r = t?.item.kind === 'owner' && t.item.wait?.kind === 'refusal' ? t.item.wait.refusal : undefined;
    if (r) return sendAllowCard(hub, ab, item, { refusal: r, offer: item.offer, who, record: 'main', kind: 'refusal', data });
  }
  let questions: SuperAskSpec['questions'] = [];
  let title: string | undefined;
  if (item.of === 'ask') {
    const spec = item.ask ?? askSpecFromLegacy(item.ownerText ?? '', []);
    questions = spec.questions;
    title = spec.title;
  } else if (item.of === 'question') {
    const pq = pendingRequest(getChat(item.sessionId), item.requestId);
    if (!pq || pq.isPermission) return { skipped: true };
    questions = (pq.questions ?? []) as SuperAskSpec['questions'];
    title = pq.title;
  }
  if (questions.length) {
    const card = simpleCard({ questions });
    if (card) {
      const m = await buttons(hub, ab, formatAskQuestionHtml(card.card, { title, lead }), card.labels,
        { kind: 'question', requestId: item.id, sessionId: item.sessionId, singleUse: true },
        { ...data, question: card.question, labels: card.labels, questions });
      remember(item.id, { ab, messages: [{ ...m, question: card.question }] }, item);
      return { ok: true };
    }
    const target: RichTarget = { kind: 'member', mirror: item.id };
    const rqs = richQuestionsOf(questions);
    const r = rich ? await rich.send(ab, target, rqs, { title, lead, sessionId: superSession, itemId: item.id }) : false;
    if (r) {
      remember(item.id, { ab, askId: r.askId, rich: richOf(target, rqs), messages: r.messages.map((m, i) => ({ ...m, question: questions[i]?.question })) }, item);
      return { ok: true };
    }
    const htmls = formatAskCardMessages(questions, { title, lead, footer: escapeHtml(LINES.waitingOnMac) });
    remember(item.id, { ab, messages: (await plain(hub, ab, htmls)).map((m, i) => ({ ...m, question: questions[i]?.question })) }, item);
    return { ok: true };
  }
  const line = `✋ ${who || 'Bir ekip üyesi'} seni bekliyor${item.ownerText ? `: ${item.ownerText}` : ''}`;
  remember(item.id, { ab, messages: await plain(hub, ab, [escapeHtml(`${redactSecrets(line)}\n${LINES.waitingOnMac}`)]) }, item);
  return { ok: true };
}

// ─── The Allow card: once, this job, the member, deny or not needed (uye-bildirim K4) ─────────

/** Consent matches display: ONE rule for every card that offers an Allow (hub.ts), so a
 *  permission, a refusal and the Super's own prompt can never disagree on what he saw. */
export { shownWhole } from './hub.js';

/** A permission's card: Allow only when the command is shown whole (else Reddet and the Mac line),
 *  the command drawn with its hidden characters as visible escapes. */
function permissionCard(lead: string, tool: string, command: string, offered: readonly GrantSize[], who: string | null, offer: GrantOffer | undefined): { html: string; rows: string[][]; choices: string[] } {
  const whole = shownWhole(command);
  const sizes: GrantSize[] = whole ? [...offered] : [];
  const { rows, choices } = allowRows(sizes, who, 'deny');
  const html = `🔐 ${lead}İzin istiyor: <b>${escapeHtml(tool)}</b>\n<pre>${escapeHtml(visibleCommand(command))}</pre>${whole ? ruleLine(offer, sizes) : `\n${escapeHtml(NOT_SHOWN_WHOLE_LINE)}`}`;
  return { html, rows, choices };
}

/** Two rows of two: the sizes offered, then the closing choice. `choices` maps a tap's index. */
export function allowRows(sizes: readonly GrantSize[], who: string | null, last: 'deny' | 'not_needed'): { rows: string[][]; choices: string[] } {
  const label = (z: GrantSize) => (z === 'once' ? 'İzin ver (bir kez)' : z === 'job' ? 'Bu iş için hep' : `${(who || 'Üye').slice(0, 30)} için hep`);
  const flat = [...sizes.filter((z) => z !== 'member' || !!who).map((z) => ({ label: label(z), choice: z as string })), { label: last === 'deny' ? 'Reddet' : 'Gerek yok', choice: last }];
  const rows: string[][] = [];
  for (let i = 0; i < flat.length; i += 2) rows.push(flat.slice(i, i + 2).map((x) => x.label));
  return { rows, choices: flat.map((x) => x.choice) };
}

/** The rule an always choice writes, in the message itself (what a tap allows is what he read). */
function ruleLine(offer: GrantOffer | undefined, sizes: readonly GrantSize[], whyOnce = false): string {
  // A permission that can only be allowed once reads as it always did; a refused call says why.
  if (!offer || sizes.length < 2) return whyOnce && offer?.onceOnlyReason ? `\n<i>${escapeHtml(offer.onceOnlyReason)}</i>` : '';
  return `${offer.rule ? `\nKural: <code>${escapeHtml(visibleCommand(offer.rule).slice(0, 300))}</code>` : ''}${offer.notChecked ? `\n<i>${escapeHtml(offer.notChecked)}</i>` : ''}`;
}

async function buttons2(hub: TelegramHub, ab: ActiveBinding, html: string, rows: string[][], rec: Parameters<TelegramHub['sendButtons']>[3], data: Obj): Promise<CopyMessage> {
  const shown = rows.map((r) => r.map((l) => l.slice(0, 60)));
  const id = await hub.sendButtons(ab, html, shown, rec, data);
  // What binds the same buttons again on this message after a restart (adoptCopy).
  return { messageId: hub.buttonMessageId(id) ?? 0, html, buttons: { rows: shown, rec, data } };
}

/** A refused call as a card: its whole command and his choices, or "on the Mac" when the message
 *  cannot show it whole (too long, a secret in it, hidden characters): then no Allow at all. */
async function sendAllowCard(hub: TelegramHub, ab: ActiveBinding, item: SuperQueueItem, o: { refusal: RefusalFact; offer?: GrantOffer; who: string | null; record: string; kind: 'refusal'; data?: Obj }): Promise<SendOutcome> {
  const r = o.refusal;
  const lead = o.who ? `${escapeHtml(o.who.slice(0, 60))} · ` : '';
  const shown = r.whole && shownWhole(r.input);
  const head = `⛔ ${lead}Reddedildi: <b>${escapeHtml(r.tool)}</b>`;
  if (!shown) {
    const html = `${head}\n<pre>${escapeHtml(visibleCommand(r.input).slice(0, 300))}…</pre>\n${escapeHtml(NOT_SHOWN_WHOLE_LINE)}`;
    const m = await buttons2(hub, ab, html, [['Gerek yok']], { kind: 'permission', sessionId: item.sessionId, singleUse: true },
      { ...(o.data ?? {}), queue: true, item: item.id, itemKind: o.data ? 'member' : 'refusal', refusal: true, choices: ['not_needed'] });
    remember(item.id, { ab, messages: [m] }, item);
    return { ok: true };
  }
  const sizes = o.offer ? o.offer.sizes : (['once'] as GrantSize[]);
  // A built-in safety check no Allow can lift: the one choice that works, asking for a rewrite.
  const { rows, choices } = o.offer?.rewrite
    ? { rows: [['Yeniden yazsın', 'Gerek yok']], choices: ['rewrite', 'not_needed'] }
    : allowRows(sizes, o.who, 'not_needed');
  const why = r.reason ? `\n${escapeHtml(redactSecrets(r.reason).slice(0, 300))}` : '';
  const html = `${head}${why}\n<pre>${escapeHtml(visibleCommand(r.input))}</pre>${ruleLine(o.offer, sizes, true)}`;
  const m = await buttons2(hub, ab, html, rows, { kind: 'permission', sessionId: item.sessionId, singleUse: true },
    { ...(o.data ?? {}), queue: true, item: item.id, itemKind: o.data ? 'member' : 'refusal', refusal: true, choices, shown: shownKeyOf(r.tool, r.input) });
  remember(item.id, { ab, messages: [m] }, item);
  return { ok: true };
}

/** A child of a bound Super starts asking a permission: buttons, once per request (A4). */
async function onChildAsking(hub: TelegramHub, entry: ChatEntry): Promise<void> {
  const pq = entry.pendingQuestion;
  if (entry.status !== 'asking' || !pq?.isPermission) return;
  // At the Mac: the Mac card only, nothing claimed (the turn-away flush sends it).
  if (!hub.ownerAway()) return;
  // Claimed before any await: two `asking` emits for one request send one message.
  const claim = `req:${entry.sessionId}:${pq.requestId}`;
  if (sentItems.has(claim)) return;
  sentItems.add(claim);
  for (const ab of hub.active.values()) {
    if (ab.target !== 'super' || ab.disabled || !ab.contextRoot || entry.vault !== ab.projectName) continue;
    const s = await readSuperState(ab.contextRoot);
    if (!s.enabled || !s.session || !Object.prototype.hasOwnProperty.call(s.children, entry.sessionId)) continue;
    const item = s.queue.find((q) => q.kind === 'permission' && q.state !== 'done' && q.sessionId === entry.sessionId && q.requestId === pq.requestId);
    if (!item) { sentItems.delete(claim); return; }
    if (sentItems.has(item.id)) return;
    sentItems.add(item.id);
    // Its copy from before a restart: taken back, never sent a second time. Not taken back YET
    // (a passing failure): let go, so the next change or flush tries again; nothing is sent.
    const kept = await adoptCopy(hub, ab, item).catch(() => null);
    if (kept && !('skipped' in kept) && !kept.ok) { sentItems.delete(claim); sentItems.delete(item.id); return; }
    if (kept) return;
    const job = s.children[entry.sessionId]?.brief ? `${escapeHtml(s.children[entry.sessionId].brief.slice(0, 60))} · ` : '';
    const command = pq.fullText ?? pq.text;
    // Main's own crew has no member: "for this job" at most (`who` null drops the member size).
    const { html, rows, choices } = permissionCard(job, pq.toolName, command, item.offer?.sizes ?? ['once'], null, item.offer);
    const shownCall = itemCall(pq);
    const m = await buttons2(hub, ab, html, rows,
      { kind: 'permission', requestId: pq.requestId, sessionId: entry.sessionId, singleUse: true },
      { queue: true, item: item.id, choices, shown: shownKeyOf(shownCall.tool, shownCall.input) });
    kindOf.set(item.id, item.kind);
    remember(item.id, { ab, sessionId: entry.sessionId, requestId: pq.requestId, messages: [m] });
    return;
  }
}

async function onQueueButton(hub: TelegramHub, ab: ActiveBinding, rec: ButtonRecord & { data?: Obj }, idx: number): Promise<string | null> {
  const d = rec.data ?? {};
  const root = ab.contextRoot;
  if (!root) return LINES.stale;
  // A tap's choice: what the card listed at that index (two rows of two), else the old two buttons.
  const choices = Array.isArray(d.choices) ? (d.choices as string[]) : null;
  const choice = choices ? choices[idx] : idx === 0 ? 'once' : 'deny';
  const size = (choice === 'once' || choice === 'job' || choice === 'member' ? choice : undefined) as GrantSize | undefined;
  // What the card showed (its key, kept when it was sent): an Allow lands only on that call.
  const shownKey = typeof d.shown === 'string' ? { shownKey: d.shown } : {};
  if (d.itemKind === 'member') {
    if (rec.kind === 'permission' && d.refusal === true) return answerMemberPick(hub, ab, String(d.item), { kind: 'refusal', allow: !!size, ...(size ? { size } : {}), ...(choice === 'rewrite' ? { rewrite: true as const } : {}), ...shownKey });
    if (rec.kind === 'permission') return answerMemberPick(hub, ab, String(d.item), { kind: 'permission', allow: !!size, ...(size ? { size } : {}), ...shownKey });
    const labels = Array.isArray(d.labels) ? (d.labels as string[]) : [];
    const label = labels[idx];
    if (typeof label !== 'string') return LINES.stale;
    const question = String(d.question ?? '');
    const questions = Array.isArray(d.questions) ? (d.questions as { question: string }[]) : [{ question }];
    return answerMemberPick(hub, ab, String(d.item), { kind: 'question', questions, picked: { [question]: label } });
  }
  // A refused call of main's own crew (K2): Allow once / for this job, or not needed.
  if (rec.kind === 'permission' && d.itemKind === 'refusal') {
    const r = await answerOwnerItem(root, { record: 'main', item: String(d.item), via: 'telegram', answer: choice === 'rewrite' ? { kind: 'refusal', action: 'rewrite' } : { kind: 'refusal', action: size ? 'allow' : 'not_needed', ...(size ? { size } : {}) }, ...shownKey });
    return pickLine(r, sizeLine(size ?? 'not_needed'));
  }
  if (rec.kind === 'permission') {
    const r = await answerOwnerItem(root, { record: 'main', item: String(d.item), via: 'telegram', answer: { kind: 'permission', behavior: size ? 'allow' : 'deny', ...(size ? { size } : {}) }, ...shownKey });
    if (!r.ok && r.error === 'already_answered') return LINES.stale;
    return pickLine(r, sizeLine(size ?? 'deny'));
  }
  const labels = Array.isArray(d.labels) ? (d.labels as string[]) : [];
  const label = labels[idx];
  if (typeof label !== 'string') return LINES.stale;
  const question = String(d.question ?? '');
  if (d.itemKind === 'question') {
    const picked = buildQuestionPicks([{ question, options: labels.map((l) => ({ label: l })) }], { [question]: [label] });
    const r = await answerChildQuestion(root, 'main', { item: String(d.item), requestId: String(rec.requestId), picked });
    if (!r.ok) return r.error === 'no_window' ? LINES.waitingOnMac : LINES.stale;
    return `✓ ${label}`;
  }
  // The Super's own ask: still open? Then its answer is an owner turn under a Telegram ref.
  const s = await readSuperState(root);
  const item = s.queue.find((q) => q.id === d.item && q.kind === 'ask' && q.state !== 'done');
  if (!item || !s.enabled || !s.session) return LINES.stale;
  const questions = Array.isArray(d.questions) ? (d.questions as { question: string }[]) : [{ question }];
  const text = superAnswerText(item, questions, { [question]: label });
  const ok = await hub.injectText(ab, hub.syntheticUpdateId(), text, s.session);
  return ok ? `✓ ${label}` : null;
}

// ─── A child's owner card (sahip-karti-yerinde K7, D3) ─────────────────────────────────────

/** The card's own line as Telegram draws it: the command (hidden characters as visible escapes,
 *  secrets redacted) or the title, escaped. */
export function ownerCardLineHtml(spec: CardSpec): string {
  switch (spec.type) {
    case 'run': return `<pre>${escapeHtml(visibleCommand(spec.command))}</pre>`;
    case 'secret': return escapeHtml(redactSecrets(`🔑 ${spec.title} → ${spec.file}`));
    case 'checklist': return escapeHtml(redactSecrets(`📋 ${spec.title}`));
    case 'mcp': return escapeHtml(redactSecrets(`🔌 ${spec.servers.join(', ')}`));
    default: { const never: never = spec; void never; return ''; }
  }
}

/** The card's name in the reminder (plain text, one line). */
function ownerCardName(spec: CardSpec): string {
  switch (spec.type) {
    case 'run': return redactSecrets(spec.command).replace(/\s+/g, ' ').slice(0, 80);
    case 'secret': case 'checklist': return redactSecrets(spec.title).slice(0, 80);
    case 'mcp': return redactSecrets(spec.servers.join(', ')).slice(0, 80);
    default: { const never: never = spec; void never; return ''; }
  }
}

/** One message per child card: the job, the card's line, the kind's sentence, Remind and Not
 *  needed; a run card it can show whole adds its folder and ▶ Çalıştır first (run-kart-telefon). */
async function sendOwnerCard(hub: TelegramHub, ab: ActiveBinding, item: SuperQueueItem, who: string | null): Promise<SendOutcome> {
  const h = item.card;
  if (!h) return { skipped: true };
  let job = who ?? '';
  if (!job && ab.contextRoot) {
    const s = await readSuperState(ab.contextRoot).catch(() => null);
    job = s?.children?.[h.childId]?.brief?.trim() ?? '';
  }
  const lead = `✋ ${escapeHtml(redactSecrets(job.slice(0, 80) || 'Bir iş'))} seni bekliyor`;
  // A run card: ▶ Çalıştır when it can be shown whole, as written, in a proven folder (the button
  // keeps that folder and the command's hash: the press runs exactly them or nothing).
  const got = h.spec.type === 'run'
    ? await childRunOffer(ab, h, item.id).catch(() => ({ none: 'unavailable' as const }))
    : null;
  const offer = got && !('none' in got) ? got : null;
  const none = got && 'none' in got ? got.none : null;
  // Each card without Run says its own reason: a command it cannot show, a folder not proven, else the Mac.
  const line = h.spec.type !== 'run' ? OWNER_CARD_TELEGRAM_LINE[h.spec.type]
    : offer ? OWNER_CARD_TELEGRAM_LINE.run
      : none === 'not_showable' ? OWNER_CARD_TELEGRAM_RUN_MAC_LINE : none === 'no_folder' ? RUN_LINES.noFolder : RUN_LINES.childMacOnly;
  const html = [lead, ownerCardLineHtml(h.spec), ...(offer ? [`Klasör: <code>${escapeHtml(offer.folder)}</code>`] : []), escapeHtml(line)].join('\n');
  const rows = offer
    ? [[OWNER_CARD_RUN_LABEL], [OWNER_CARD_REMIND_LABEL], [OWNER_CARD_NOT_NEEDED_LABEL]]
    : [[OWNER_CARD_REMIND_LABEL], [OWNER_CARD_NOT_NEEDED_LABEL]];
  const data: Obj = offer
    ? { item: item.id, choices: ['run', 'remind', 'not_needed'], cmdHash: offer.cmdHash, root: offer.root }
    : { item: item.id, choices: ['remind', 'not_needed'] };
  const m = await buttons2(hub, ab, html, rows,
    { kind: 'owner-card', sessionId: h.postingSession, cardRef: h.cardRef, singleUse: true }, data);
  remember(item.id, { ab, messages: [m] }, item);
  return { ok: true };
}

/** The open item a child-card button names: still open, still that very card. */
function openCardItem(queue: readonly SuperQueueItem[], itemId: string, rec: ButtonRecord): SuperQueueItem | undefined {
  return queue.find((q) => q.id === itemId && q.state !== 'done' && !!q.card && q.card.cardRef === rec.cardRef && q.card.postingSession === rec.sessionId);
}

/** A tap on a child card's message (authorised and single use: the hub checked the binding, the
 *  chat, the message and its text). Remind marks the item; Not needed closes it. Its ▶ Çalıştır
 *  is runs.ts's (`pressChildRun`, ahead of this handler): reaching here, it runs nothing. A
 *  message from before `choices` reads its two buttons by index. */
async function onOwnerCardButton(ab: ActiveBinding, rec: ButtonRecord & { data?: Obj }, idx: number): Promise<string | null> {
  const root = ab.contextRoot;
  if (ab.target !== 'super' || ab.disabled || !root) return LINES.stale;
  const itemId = String(rec.data?.item ?? '');
  const choices = Array.isArray(rec.data?.choices) ? rec.data.choices as string[] : ['remind', 'not_needed'];
  const choice = choices[idx];
  const s = await readSuperState(root).catch(() => null);
  if (!s?.enabled || !openCardItem(s.queue, itemId, rec)) return LINES.stale;
  if (choice === 'remind') {
    const got = { marked: false };
    await updateSuperState(root, (draft) => {
      const q = openCardItem(draft.queue, itemId, rec);
      if (q) { q.remindAt = Date.now(); got.marked = true; }
    });
    return got.marked ? OWNER_CARD_REMIND_DONE : LINES.stale;
  }
  if (choice === 'not_needed') {
    const l = ownerCardLookup(rec.sessionId ?? '', rec.cardRef ?? '');
    if (!l || !(await closeOwnerItemForCard(l, 'not_needed'))) return LINES.stale;
    dropOwnerReceipts(l.target, { cardRef: l.handle.cardRef });
    return OWNER_CARD_NOT_NEEDED_DONE;
  }
  return LINES.stale;
}

/**
 * He is back at the Mac: ONE desktop notification naming every card he asked to be reminded of
 * (every bound Super), through the owner-question banner path; the marks clear. Clicking it opens
 * the Super's stage, where the slot draws the card.
 */
export async function remindMarkedCards(hub: TelegramHub): Promise<number> {
  const names: string[] = [];
  let link: string | null = null;
  for (const ab of [...hub.active.values()]) {
    if (ab.target !== 'super' || ab.disabled || !ab.contextRoot) continue;
    const s = await readSuperState(ab.contextRoot).catch(() => null);
    if (!s?.queue.some((q) => q.remindAt && q.card)) continue;
    const got = { session: null as string | null };
    await updateSuperState(ab.contextRoot, (draft) => {
      got.session = draft.session ?? null;
      for (const q of draft.queue) {
        if (!q.remindAt) continue;
        if (q.card && q.state !== 'done') names.push(`${ownerCardName(q.card.spec)}`);
        delete q.remindAt;
      }
    });
    if (!link && got.session) { try { link = buildAppLink({ kind: 'session', vault: ab.projectName, claudeId: got.session }); } catch { link = null; } }
  }
  if (!names.length) return 0;
  postOwnerCardRemind(OWNER_CARD_REMIND_TITLE, names.join(' · ').slice(0, 300), link);
  return names.length;
}

/** Test seam. */
export function _resetTelegramAsks(): void { sentItems.clear(); copies.clear(); kindOf.clear(); kept.clear(); }
