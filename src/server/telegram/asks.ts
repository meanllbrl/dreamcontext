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
import { answerChildQuestion, answerOwnerItem, memberMirrorTarget, superAnswerText } from '../../lib/super/answer.js';
import { answerMemberPick, pickLine, sizeLine } from './member-picks.js';
import { memberTitle } from '../../lib/super/inbox.js';
import { askSpecFromLegacy, type GrantOffer, type GrantSize, type RefusalFact, type SuperAskSpec, type SuperQueueItem } from '../../lib/super/types.js';
import { buildQuestionPicks, type ButtonRecord } from '../../lib/telegram/contract.js';
import { formatAskCardMessages, formatAskQuestionHtml, type AskCardQuestion } from '../../lib/telegram/ask-format.js';
import { escapeHtml, redactSecrets } from '../../lib/telegram/format.js';
import { LINES, NOT_SHOWN_WHOLE_LINE, shownWhole, visibleCommand, type ActiveBinding, type TelegramHub } from './hub.js';
import { richQuestionsOf, type RichAsks } from './rich-asks.js';
import { wireTelegramAppRequests } from './app-requests.js';

/** W5 rich asks (multi-select, several questions, previews): set by `wireTelegramW5`. */
let rich: RichAsks | null = null;
export function setRichAsks(r: RichAsks | null): void { rich = r; }

type Obj = Record<string, unknown>;

/** Items taken for Telegram (per process): one send at a time per item; a failed one is let go. */
const sentItems = new Set<string>();

/** What an item's Telegram copy is: its messages, so an answer elsewhere can close them. */
interface Copy { ab: ActiveBinding; sessionId?: string; requestId?: string; askId?: string; messages: { messageId: number; html: string; question?: string }[]; turn?: true }

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
  copies.set(itemId, item && oneAtATime(item) ? { ...copy, turn: true } : copy);
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
    const m = await buttons2(hub, ab, html, rows,
      { kind: 'permission', requestId: item.requestId, sessionId: item.sessionId, singleUse: true }, { ...data, choices });
    remember(item.id, { ab, messages: [m] }, item);
    return { ok: true };
  }
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
    const r = rich ? await rich.send(ab, { kind: 'member', mirror: item.id }, richQuestionsOf(questions), { title, lead, sessionId: superSession, itemId: item.id }) : false;
    if (r) {
      remember(item.id, { ab, askId: r.askId, messages: r.messages.map((m, i) => ({ ...m, question: questions[i]?.question })) }, item);
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

async function buttons2(hub: TelegramHub, ab: ActiveBinding, html: string, rows: string[][], rec: Parameters<TelegramHub['sendButtons']>[3], data: Obj): Promise<{ messageId: number; html: string }> {
  const id = await hub.sendButtons(ab, html, rows.map((r) => r.map((l) => l.slice(0, 60))), rec, data);
  return { messageId: hub.buttonMessageId(id) ?? 0, html };
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
  const { rows, choices } = allowRows(sizes, o.who, 'not_needed');
  const why = r.reason ? `\n${escapeHtml(redactSecrets(r.reason).slice(0, 300))}` : '';
  const html = `${head}${why}\n<pre>${escapeHtml(visibleCommand(r.input))}</pre>${ruleLine(o.offer, sizes, true)}`;
  const m = await buttons2(hub, ab, html, rows, { kind: 'permission', sessionId: item.sessionId, singleUse: true },
    { ...(o.data ?? {}), queue: true, item: item.id, itemKind: o.data ? 'member' : 'refusal', refusal: true, choices });
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
    const job = s.children[entry.sessionId]?.brief ? `${escapeHtml(s.children[entry.sessionId].brief.slice(0, 60))} · ` : '';
    const command = pq.fullText ?? pq.text;
    // Main's own crew has no member: "for this job" at most (`who` null drops the member size).
    const { html, rows, choices } = permissionCard(job, pq.toolName, command, item.offer?.sizes ?? ['once'], null, item.offer);
    await hub.sendButtons(ab, html, rows,
      { kind: 'permission', requestId: pq.requestId, sessionId: entry.sessionId, singleUse: true },
      { queue: true, item: item.id, choices });
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
  if (d.itemKind === 'member') {
    if (rec.kind === 'permission' && d.refusal === true) return answerMemberPick(hub, ab, String(d.item), { kind: 'refusal', allow: !!size, ...(size ? { size } : {}) });
    if (rec.kind === 'permission') return answerMemberPick(hub, ab, String(d.item), { kind: 'permission', allow: !!size, ...(size ? { size } : {}) });
    const labels = Array.isArray(d.labels) ? (d.labels as string[]) : [];
    const label = labels[idx];
    if (typeof label !== 'string') return LINES.stale;
    const question = String(d.question ?? '');
    const questions = Array.isArray(d.questions) ? (d.questions as { question: string }[]) : [{ question }];
    return answerMemberPick(hub, ab, String(d.item), { kind: 'question', questions, picked: { [question]: label } });
  }
  // A refused call of main's own crew (K2): Allow once / for this job, or not needed.
  if (rec.kind === 'permission' && d.itemKind === 'refusal') {
    const r = await answerOwnerItem(root, { record: 'main', item: String(d.item), via: 'telegram', answer: { kind: 'refusal', action: size ? 'allow' : 'not_needed', ...(size ? { size } : {}) } });
    return pickLine(r, sizeLine(size ?? 'not_needed'));
  }
  if (rec.kind === 'permission') {
    const r = await answerOwnerItem(root, { record: 'main', item: String(d.item), via: 'telegram', answer: { kind: 'permission', behavior: size ? 'allow' : 'deny', ...(size ? { size } : {}) } });
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

/** Test seam. */
export function _resetTelegramAsks(): void { sentItems.clear(); copies.clear(); }
