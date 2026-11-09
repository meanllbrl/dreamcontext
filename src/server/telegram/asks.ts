/**
 * The Super's questions to the owner, on its Telegram bot (plan "Answering", A4, M2, M6; P3).
 *
 *  - Queue heads (`owner-question.ts` announces them: the Super's own `ask`, a child's escalated
 *    or direct question, an AI Team approval, a job that needs him): sent once per item, through
 *    the `telegram` sink, beside the banner and the phone push (duplicate pings are intended).
 *    A single-question, single-select card becomes buttons; anything richer (multi-select,
 *    several questions, previews) says "Mac'te seni bekliyor" in W2 (rich asks are W5).
 *  - A child's PERMISSION (never a queue head): when a child of a bound Super starts asking one
 *    and its queue item is open, "İzin ver (bir kez)" / "Reddet".
 *
 * Answers:
 *  - the Super's own ask → owner text `superAnswerText(...)` injected under a fresh Telegram ref;
 *  - a child question → `answerChildQuestion` (the window's `super answer` verb);
 *  - a child permission → `answerChildPermission` (the window's `super allow`, `by: 'owner'`).
 * Each through a single-use, message-bound button record (hub.sendButtons).
 */
import { getChat, onChatChange, type ChatEntry } from '../../lib/assistant/chat-registry.js';
import { announces, setOwnerQuestionSinks } from '../../lib/super/owner-question.js';
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

/** Items already sent to Telegram (per process): one message per item. */
const sentItems = new Set<string>();

/** The one card a W2 message can carry as buttons: one question, single-select, 1-8 options. */
function simpleCard(spec: SuperAskSpec | null | undefined): { question: string; labels: string[]; card: AskCardQuestion } | null {
  const qs = spec?.questions ?? [];
  if (qs.length !== 1 || qs[0].multiSelect || !qs[0].options?.length || qs[0].options.length > 8) return null;
  // Option previews are pictures (W5 M3): the rich path sends them before the buttons.
  if (rich && qs[0].options.some((o) => typeof (o as { preview?: unknown }).preview === 'string' && (o as { preview: string }).preview.trim())) return null;
  return { question: qs[0].question, labels: qs[0].options.map((o) => o.label), card: qs[0] };
}

/** One queue item to its bot, once. False when it did not go (nothing recorded as sent). */
function offerItem(hub: TelegramHub, ab: ActiveBinding, sessionId: string, item: SuperQueueItem): boolean {
  if (sentItems.has(item.id)) return true;
  sentItems.add(item.id);
  // The Super's own ask that LANDS is its turn speaking (no "göndermeden bitti" after it); sent
  // in line with its texts. A child's item or an approval is not the Super's turn speaking.
  hub.queueSend(sessionId, () => sendItem(hub, ab, sessionId, item).then(
    (landed) => item.kind === 'ask' && landed,
    () => { sentItems.delete(item.id); return false; },
  ));
  return true;
}

export function wireTelegramAsks(hub: TelegramHub): () => void {
  setOwnerQuestionSinks({
    // At the Mac (`hub.ownerAway()` false) the Mac card is the only one: false, nothing recorded,
    // so the turn-away flush below sends it once he is away.
    telegram: ({ vault, sessionId, item }) => {
      const ab = hub.superBindingOfVault(vault);
      if (!ab || !hub.ownerAway()) return false;
      return offerItem(hub, ab, sessionId, item);
    },
  });
  const off = onChatChange((c) => { void onChildAsking(hub, c.entry).catch(() => {}); });
  // He turned away: every question and child permission still open on this Super, oldest first.
  const flush = async (ab: ActiveBinding): Promise<void> => {
    if (!ab.contextRoot || !hub.ownerAway()) return;
    const s = await readSuperState(ab.contextRoot);
    if (!s.enabled || !s.session) return;
    const open = [...s.queue].sort((a, b) => a.createdAt - b.createdAt);
    for (const q of open) {
      if (q.kind === 'permission') {
        const child = q.state !== 'done' ? getChat(q.sessionId) : null;
        if (child) await onChildAsking(hub, child).catch(() => {});
        continue;
      }
      if (announces(q)) offerItem(hub, ab, s.session, q);
    }
  };
  hub.awayFlushers.add(flush);
  const prev = hub.extraButton;
  hub.extraButton = async (ab, rec, idx) => (rec.kind === 'question' && rec.data?.queue === true) || (rec.kind === 'permission' && rec.data?.queue === true)
    ? onQueueButton(hub, ab, rec, idx)
    : prev ? prev(ab, rec, idx) : LINES.stale;
  // An agent's app request card (app-onay-karti C6): its own away rule and button kind.
  const offApps = wireTelegramAppRequests(hub);
  return () => { offApps(); off(); hub.awayFlushers.delete(flush); setOwnerQuestionSinks({ telegram: () => false }); hub.extraButton = prev; };
}

/** Sends one queue item. For the Super's own ask: true only when a message of it LANDED on
 *  Telegram (a swallowed failure is nothing landed); every other kind answers false. */
async function sendItem(hub: TelegramHub, ab: ActiveBinding, superSession: string, item: SuperQueueItem): Promise<boolean> {
  if (item.kind === 'ask') {
    const spec = item.ask ?? askSpecFromLegacy(item.ownerText ?? '', item.options ?? []);
    const card = simpleCard(spec);
    if (card) {
      await hub.sendButtons(ab, formatAskQuestionHtml(card.card, { title: spec.title }), card.labels.map((l) => [l.slice(0, 60)]),
        { kind: 'question', requestId: item.id, sessionId: superSession, singleUse: true },
        { queue: true, item: item.id, itemKind: 'ask', session: superSession, question: card.question, labels: card.labels, questions: spec.questions });
      return true;
    }
    if (rich && await rich.send(ab, { kind: 'super-ask', item }, richQuestionsOf(spec.questions), { title: spec.title, sessionId: superSession, itemId: item.id }).catch(() => false)) return true;
    const landed = (html: string) => hub.send(ab, html).then(() => true, () => false);
    if (spec.questions.length) {
      let any = false;
      for (const html of formatAskCardMessages(spec.questions, { title: spec.title, footer: escapeHtml(LINES.waitingOnMac) })) any = (await landed(html)) || any;
      return any;
    }
    return landed(escapeHtml(`❓ ${redactSecrets(item.ownerText ?? 'Bir sorum var')}\n${LINES.waitingOnMac}`));
  }
  if (item.kind === 'question') {
    const pq = getChat(item.sessionId)?.pendingQuestion;
    const qs = pq && !pq.isPermission && pq.requestId === item.requestId ? pq.questions ?? [] : [];
    const card = simpleCard({ questions: qs as SuperAskSpec['questions'] });
    if (card && item.requestId) {
      await hub.sendButtons(ab, formatAskQuestionHtml(card.card, { title: pq?.title, lead: item.ownerText }), card.labels.map((l) => [l.slice(0, 60)]),
        { kind: 'question', requestId: item.requestId, sessionId: item.sessionId, singleUse: true },
        { queue: true, item: item.id, itemKind: 'question', question: card.question, labels: card.labels, questions: qs });
      return false;
    }
    if (rich && item.requestId && qs.length && await rich.send(ab, { kind: 'child-question', item: item.id, requestId: item.requestId }, richQuestionsOf(qs), { title: pq?.title ?? item.ownerText, lead: pq?.title ? item.ownerText : undefined, sessionId: superSession, itemId: item.id }).catch(() => false)) return false;
    if (qs.length) {
      for (const html of formatAskCardMessages(qs, { title: pq?.title, lead: item.ownerText, footer: escapeHtml(LINES.waitingOnMac) })) await hub.send(ab, html).catch(() => {});
      return false;
    }
    await hub.reply(ab, `❓ ${redactSecrets(item.ownerText ?? pq?.text ?? 'Bir iş soru soruyor')}\n${LINES.waitingOnMac}`);
    return false;
  }
  // Approvals (G1) and jobs that need him: shown, answered on the Mac in W2.
  const line = item.kind === 'approval' ? `✋ Onay bekliyor: ${item.member ?? 'ekip üyesi'}` : `✋ ${item.ownerText ?? 'Bir iş seni bekliyor'}`;
  await hub.reply(ab, `${redactSecrets(line)}\n${LINES.waitingOnMac}`);
  return false;
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
export function _resetTelegramAsks(): void { sentItems.clear(); }
