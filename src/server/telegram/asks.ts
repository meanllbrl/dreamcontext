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
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getChat, onChatChange, onRequestAnswered, pendingRequest, type ChatEntry } from '../../lib/assistant/chat-registry.js';
import { announces, noteTelegramSend, offerOwnerItemsToTelegram, setOwnerQuestionSinks } from '../../lib/super/owner-question.js';
import { readSuperState } from '../../lib/super/store.js';
import { answerChildPermission, answerChildQuestion, superAnswerText } from '../../lib/super/answer.js';
import { askSpecFromLegacy, type SuperAskSpec, type SuperQueueItem } from '../../lib/super/types.js';
import { buildQuestionPicks, type ButtonRecord } from '../../lib/telegram/contract.js';
import { formatAskCardMessages, formatAskQuestionHtml, type AskCardQuestion } from '../../lib/telegram/ask-format.js';
import { escapeHtml, redactSecrets } from '../../lib/telegram/format.js';
import { LINES, type ActiveBinding, type TelegramHub } from './hub.js';
import { richQuestionsOf, type RichAsks } from './rich-asks.js';
import { wireTelegramAppRequests } from './app-requests.js';

/** W5 rich asks (multi-select, several questions, previews): set by `wireTelegramW5`. */
let rich: RichAsks | null = null;
export function setRichAsks(r: RichAsks | null): void { rich = r; }

type Obj = Record<string, unknown>;

/** Items taken for Telegram (per process): one send at a time per item; a failed one is let go. */
const sentItems = new Set<string>();

/** What an item's Telegram copy is: its messages, so an answer elsewhere can close them. */
interface Copy { ab: ActiveBinding; sessionId?: string; requestId?: string; askId?: string; messages: { messageId: number; html: string; question?: string }[] }
const copies = new Map<string, Copy>();
const COPIES_CAP = 200;

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
  try {
    const dir = join(hub.home, '.dreamcontext', 'logs');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, 'telegram-asks.log');
    try { if (statSync(file).size > 512 * 1024) renameSync(file, `${file}.1`); } catch { /* none yet */ }
    const what = 'skipped' in outcome ? 'skipped (answered before it went)' : outcome.ok ? 'sent' : `FAILED ${outcome.why}`;
    appendFileSync(file, `${new Date().toISOString()} ${item.id} ${item.kind} ${what}\n`, { mode: 0o600 });
  } catch { /* the log never breaks a send */ }
}

function failure(err: unknown): string {
  return redactSecrets(String((err as Error)?.message ?? err ?? 'unknown')).replace(/\s+/g, ' ').slice(0, 200);
}

/** One queue item to its bot, once at a time. True = taken (the outcome is reported later). */
function offerItem(hub: TelegramHub, ab: ActiveBinding, sessionId: string, item: SuperQueueItem): boolean {
  if (sentItems.has(item.id)) return true;
  sentItems.add(item.id);
  // The Super's own ask that LANDS is its turn speaking (no "göndermeden bitti" after it); sent
  // in line with its texts. A child's item or an approval is not the Super's turn speaking.
  hub.queueSend(sessionId, async () => {
    let outcome: SendOutcome;
    try { outcome = await sendItem(hub, ab, sessionId, item); } catch (err) {
      const retry = (err as { retryAfter?: unknown })?.retryAfter;
      outcome = { ok: false, why: failure(err), ...(typeof retry === 'number' && retry > 0 ? { retryAfterS: retry } : {}) };
    }
    // Not sent (refused, or closed before it went): let go, so a later offer is a real send.
    if ('skipped' in outcome || !outcome.ok) sentItems.delete(item.id);
    logSend(hub, item, outcome);
    noteTelegramSend(item.id, outcome);
    // Answered while it was going: close it at once.
    if ('ok' in outcome && outcome.ok && !(await stillOpen(ab, item))) await closeCopy(hub, item.id, null);
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
  if (now.kind === 'question') {
    const pq = pendingRequest(getChat(now.sessionId), now.requestId);
    return !!pq && !pq.isPermission;
  }
  return true;
}

function remember(itemId: string, copy: Copy): void {
  copies.delete(itemId);
  copies.set(itemId, copy);
  while (copies.size > COPIES_CAP) copies.delete(copies.keys().next().value as string);
}

/** Answered elsewhere: each message of its copy says so, with the pick when known, buttons gone. */
async function closeCopy(hub: TelegramHub, itemId: string, answers: Record<string, string> | null): Promise<void> {
  const c = copies.get(itemId);
  if (!c) return;
  copies.delete(itemId);
  if (c.askId) rich?.close(c.askId);
  const all = answers ? Object.values(answers).join(' · ') : '';
  for (const m of c.messages) {
    if (!m.messageId) continue;
    const pick = answers && m.question ? answers[m.question] ?? '' : c.messages.length === 1 ? all : '';
    await hub.closeAnswered(c.ab, m.messageId, `${m.html}\n\n<b>✓ Cevaplandı${pick ? `: ${escapeHtml(redactSecrets(pick).slice(0, 300))}` : ''}</b>`);
  }
}

export function wireTelegramAsks(hub: TelegramHub): () => void {
  setOwnerQuestionSinks({
    // At the Mac (`hub.ownerAway()` false) the Mac card is the only one: `at_mac`, nothing taken,
    // so the turn-away flush below sends it once he is away.
    telegram: ({ vault, sessionId, item }) => {
      const ab = hub.superBindingOfVault(vault);
      if (!ab) return 'no_bot';
      if (!hub.ownerAway()) return 'at_mac';
      return offerItem(hub, ab, sessionId, item);
    },
    telegramClosed: ({ id }) => { void closeCopy(hub, id, null).catch(() => {}); },
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
    if (!ab.contextRoot || !hub.ownerAway()) return;
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
  const prev = hub.extraButton;
  hub.extraButton = async (ab, rec, idx) => (rec.kind === 'question' && rec.data?.queue === true) || (rec.kind === 'permission' && rec.data?.queue === true)
    ? onQueueButton(hub, ab, rec, idx)
    : prev ? prev(ab, rec, idx) : LINES.stale;
  // An agent's app request card (app-onay-karti C6): its own away rule and button kind.
  const offApps = wireTelegramAppRequests(hub);
  return () => {
    offApps(); off(); offAnswered(); hub.awayFlushers.delete(flush);
    setOwnerQuestionSinks({ telegram: () => false, telegramClosed: () => {} });
    hub.extraButton = prev;
  };
}

/** One message with buttons; its message id kept for the copy. */
async function buttons(hub: TelegramHub, ab: ActiveBinding, html: string, labels: string[], rec: Parameters<TelegramHub['sendButtons']>[3], data: Obj): Promise<{ messageId: number; html: string }> {
  const id = await hub.sendButtons(ab, html, labels.map((l) => [l.slice(0, 60)]), rec, data);
  return { messageId: hub.buttonMessageId(id) ?? 0, html };
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

/**
 * Sends one queue item, if it is still open. Throws (or answers `ok: false`) when Telegram did
 * not take it; `skipped` when it closed before it went (owner 2026-11-09: a card arrived a minute
 * after the Super had answered it).
 */
async function sendItem(hub: TelegramHub, ab: ActiveBinding, superSession: string, item: SuperQueueItem): Promise<SendOutcome> {
  if (!(await stillOpen(ab, item))) return { skipped: true };
  if (item.kind === 'ask') {
    const spec = item.ask ?? askSpecFromLegacy(item.ownerText ?? '', item.options ?? []);
    const card = simpleCard(spec);
    if (card) {
      const m = await buttons(hub, ab, formatAskQuestionHtml(card.card, { title: spec.title }), card.labels,
        { kind: 'question', requestId: item.id, sessionId: superSession, singleUse: true },
        { queue: true, item: item.id, itemKind: 'ask', session: superSession, question: card.question, labels: card.labels, questions: spec.questions });
      remember(item.id, { ab, messages: [{ ...m, question: card.question }] });
      return { ok: true };
    }
    const r = rich ? await rich.send(ab, { kind: 'super-ask', item }, richQuestionsOf(spec.questions), { title: spec.title, sessionId: superSession, itemId: item.id }) : false;
    if (r) {
      remember(item.id, { ab, askId: r.askId, messages: r.messages.map((m, i) => ({ ...m, question: spec.questions[i]?.question })) });
      return { ok: true };
    }
    const htmls = spec.questions.length
      ? formatAskCardMessages(spec.questions, { title: spec.title, footer: escapeHtml(LINES.waitingOnMac) })
      : [escapeHtml(`❓ ${redactSecrets(item.ownerText ?? 'Bir sorum var')}\n${LINES.waitingOnMac}`)];
    remember(item.id, { ab, messages: (await plain(hub, ab, htmls)).map((m, i) => ({ ...m, question: spec.questions[i]?.question })) });
    return { ok: true };
  }
  if (item.kind === 'question') {
    const pq = pendingRequest(getChat(item.sessionId), item.requestId);
    const qs = pq && !pq.isPermission ? pq.questions ?? [] : [];
    if (!qs.length || !item.requestId) return { skipped: true };
    // Who asks: the job's name, once (never `ownerText`, which already joins every question).
    const s = ab.contextRoot ? await readSuperState(ab.contextRoot).catch(() => null) : null;
    const job = s?.children?.[item.sessionId]?.brief?.trim();
    const lead = job ? `${job.slice(0, 80)} soruyor` : undefined;
    const base = { ab, sessionId: item.sessionId, requestId: item.requestId };
    const card = simpleCard({ questions: qs as SuperAskSpec['questions'] });
    if (card) {
      const m = await buttons(hub, ab, formatAskQuestionHtml(card.card, { title: pq?.title, lead }), card.labels,
        { kind: 'question', requestId: item.requestId, sessionId: item.sessionId, singleUse: true },
        { queue: true, item: item.id, itemKind: 'question', question: card.question, labels: card.labels, questions: qs });
      remember(item.id, { ...base, messages: [{ ...m, question: card.question }] });
      return { ok: true };
    }
    const r = rich ? await rich.send(ab, { kind: 'child-question', item: item.id, requestId: item.requestId }, richQuestionsOf(qs), { title: pq?.title, lead, sessionId: superSession, itemId: item.id }) : false;
    if (r) {
      remember(item.id, { ...base, askId: r.askId, messages: r.messages.map((m, i) => ({ ...m, question: qs[i]?.question })) });
      return { ok: true };
    }
    const htmls = formatAskCardMessages(qs, { title: pq?.title, lead, footer: escapeHtml(LINES.waitingOnMac) });
    remember(item.id, { ...base, messages: (await plain(hub, ab, htmls)).map((m, i) => ({ ...m, question: qs[i]?.question })) });
    return { ok: true };
  }
  // Approvals (G1) and jobs that need him: shown, answered on the Mac in W2.
  const line = item.kind === 'approval' ? `✋ Onay bekliyor: ${item.member ?? 'ekip üyesi'}` : `✋ ${item.ownerText ?? 'Bir iş seni bekliyor'}`;
  remember(item.id, { ab, messages: await plain(hub, ab, [escapeHtml(`${redactSecrets(line)}\n${LINES.waitingOnMac}`)]) });
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
    const job = s.children[entry.sessionId]?.brief ? `${escapeHtml(s.children[entry.sessionId].brief.slice(0, 60))} · ` : '';
    const body = `🔐 ${job}İzin istiyor: <b>${escapeHtml(pq.toolName)}</b>\n<pre>${escapeHtml(redactSecrets(pq.text).slice(0, 1500))}</pre>`;
    await hub.sendButtons(ab, body, [['İzin ver (bir kez)', 'Reddet']],
      { kind: 'permission', requestId: pq.requestId, sessionId: entry.sessionId, singleUse: true },
      { queue: true, item: item.id });
    return;
  }
}

async function onQueueButton(hub: TelegramHub, ab: ActiveBinding, rec: ButtonRecord & { data?: Obj }, idx: number): Promise<string | null> {
  const d = rec.data ?? {};
  const root = ab.contextRoot;
  if (!root) return LINES.stale;
  if (rec.kind === 'permission') {
    const r = await answerChildPermission(root, 'main', { item: String(d.item), requestId: String(rec.requestId), choice: idx === 0 ? 'allow' : 'deny' });
    if (!r.ok) return r.error === 'no_window' ? LINES.waitingOnMac : LINES.stale;
    return idx === 0 ? '✓ İzin verildi (bir kez)' : '✗ Reddedildi';
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

/** Test seam. */
export function _resetTelegramAsks(): void { sentItems.clear(); copies.clear(); }
