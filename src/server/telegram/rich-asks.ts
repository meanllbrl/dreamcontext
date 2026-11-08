/**
 * Asks keep their full richness on Telegram (plan M3, P3, P4, N3, T5).
 *
 * One ask = up to 4 questions, one message each, answered together:
 *  - option buttons; a multiSelect toggles (✓) and the message's buttons are re-drawn by the hub
 *    (the record is re-issued per tap, same binding); a single-select marks its pick the same way;
 *  - **Not ekle** under each question: the owner's next text is that question's note;
 *  - under the last question **Gönder** (single use) and **Belirsiz, tekrar sor**;
 *  - option previews (markup) as ONE album of pictures built by the server just before the
 *    buttons, and the `--show` / plan-approval cards with the question, when pictures are allowed
 *    (a live Telegram turn or streaming, no secret pending; N3); otherwise nothing extra.
 * The answer goes the way each kind already goes: the Super's own ask → `superAnswerText` (or
 * `superUnclearText`) as an owner turn under a fresh Telegram ref; a child's escalated question
 * → `answerChildQuestion` (`cleanPhoneAnswer` inside); the Super chat's own AskUserQuestion →
 * `hub_command answer_pending` with the P3 tagged union. Picks are built by
 * `buildQuestionPicks` (option order, multiSelect joined with ", ").
 */
import { randomBytes } from 'node:crypto';
import { getChat } from '../../lib/assistant/chat-registry.js';
import { answerChildQuestion, superAnswerText, superUnclearText, unclearMessage } from '../../lib/super/answer.js';
import { readSuperState } from '../../lib/super/store.js';
import type { SuperQueueItem } from '../../lib/super/types.js';
import { buildQuestionPicks, type AnswerPending } from '../../lib/telegram/contract.js';
import { escapeHtml, redactSecrets } from '../../lib/telegram/format.js';
import { dreamHtmlPage } from '../../lib/telegram/render.js';
import { cleanTitle } from '../../lib/telegram/urls.js';
import { sendHubCommand, superTokenOfSession, tokenOfSession } from '../../lib/window-control.js';
import { cardOut } from './cards.js';
import { pngFile, sendAlbum, sendMedia, type MediaItem, type Snapshotter } from './pictures.js';
import { secretPending } from './present.js';
import { LINES, type ActiveBinding, type TelegramHub } from './hub.js';

type Obj = Record<string, unknown>;

export interface RichQuestion { question: string; header?: string; multiSelect?: boolean; options: { label: string; preview?: string }[] }

/** Where the answer goes. */
export type RichTarget =
  | { kind: 'super-ask'; item: Pick<SuperQueueItem, 'id' | 'kind' | 'sessionId'> }
  | { kind: 'child-question'; item: string; requestId: string }
  | { kind: 'pending'; sessionId: string; requestId: string };

interface RichAsk {
  id: string;
  key: string;
  target: RichTarget;
  questions: RichQuestion[];
  picks: Set<string>[];
  notes: string[];
  /** message id per question, and its HTML text. */
  messages: { messageId: number; html: string }[];
  noteFor: number | null;
  done: boolean;
}

export const MAX_QUESTIONS = 4;
export const MAX_OPTIONS = 8;

/** Can this ask go to Telegram as buttons? (Every question has 1-8 options, at most 4 questions.) */
export function richAskFits(questions: readonly RichQuestion[]): boolean {
  return questions.length >= 1 && questions.length <= MAX_QUESTIONS && questions.every((q) => q.options.length >= 1 && q.options.length <= MAX_OPTIONS);
}

export interface RichAsksDeps { snapshot: Snapshotter }

export function wireRichAsks(hub: TelegramHub, deps: RichAsksDeps) {
  const asks = new Map<string, RichAsk>();

  function keyboard(a: RichAsk, qi: number): string[][] {
    const q = a.questions[qi];
    const rows = q.options.map((o) => [`${a.picks[qi].has(o.label) ? '✓ ' : ''}${o.label}`.slice(0, 60)]);
    rows.push([a.notes[qi] ? '✎ Notu değiştir' : 'Not ekle']);
    if (qi === a.questions.length - 1) rows.push(['Gönder', 'Belirsiz, tekrar sor']);
    return rows;
  }

  async function sendQuestion(ab: ActiveBinding, a: RichAsk, qi: number, title: string): Promise<void> {
    const q = a.questions[qi];
    const n = a.questions.length > 1 ? ` (${qi + 1}/${a.questions.length})` : '';
    const html = `❓ ${title}${escapeHtml(redactSecrets(q.question))}${n}${q.multiSelect ? '\n<i>Birden fazla seçebilirsin.</i>' : ''}`;
    await hub.sendButtons(ab, html, keyboard(a, qi), { kind: 'confirm', singleUse: false }, { rich: a.id, q: qi });
    a.messages[qi] = { messageId: 0, html };
  }

  /** Previews (option markup → pictures) and the ask's `--show` cards, before the buttons. */
  async function sendPictures(ab: ActiveBinding, sessionId: string, questions: readonly RichQuestion[], itemId: string | null): Promise<void> {
    const items: MediaItem[] = [];
    for (const q of questions) {
      for (const o of q.options) {
        if (!o.preview || items.length >= 10) continue;
        const plan = dreamHtmlPage(o.preview);
        const pngs = plan.ok ? await deps.snapshot(sessionId, plan.page, plan.width) : null;
        if (pngs?.[0]) items.push({ kind: 'photo', file: pngFile(o.label, pngs[0]), title: o.label });
      }
    }
    if (itemId && ab.contextRoot) {
      const s = await readSuperState(ab.contextRoot).catch(() => null);
      const show = s?.askShows?.find((x) => x.item === itemId);
      for (const id of show?.cards ?? []) {
        const c = s!.containers.find((k) => k.id === id);
        if (!c || items.length >= 10) continue;
        const out = await cardOut({ contextRoot: ab.contextRoot, sessionId, pictures: true, snapshot: deps.snapshot }, c);
        if (out.kind === 'media') items.push(...out.items.filter((m) => m.kind !== 'document').slice(0, 10 - items.length));
        else await hub.reply(ab, out.line);
      }
    }
    const caption = escapeHtml(items.map((m) => cleanTitle(m.title, 40)).join(' · '));
    if (items.length === 1) await sendMedia(ab, items[0], caption);
    else if (items.length > 1 && !(await sendAlbum(ab, items, caption))) await sendMedia(ab, items[0], caption);
  }

  /** Sends a rich ask. False = it does not fit (the caller says "Mac'te seni bekliyor"). */
  async function send(ab: ActiveBinding, target: RichTarget, questions: RichQuestion[], opts: { title?: string; sessionId: string; itemId?: string }): Promise<boolean> {
    if (!richAskFits(questions)) return false;
    const pictures = !!(hub.telegramTurnOf(opts.sessionId) || hub.deps.handsfree?.streamsTo(ab.scope, ab.target)) && !secretPending(opts.sessionId);
    if (pictures) await sendPictures(ab, opts.sessionId, questions, opts.itemId ?? null).catch(() => {});
    const a: RichAsk = {
      id: randomBytes(6).toString('hex'), key: ab.key, target, questions,
      picks: questions.map(() => new Set<string>()), notes: questions.map(() => ''), messages: [], noteFor: null, done: false,
    };
    asks.set(a.id, a);
    if (asks.size > 200) asks.delete(asks.keys().next().value as string);
    const title = opts.title ? `${escapeHtml(redactSecrets(cleanTitle(opts.title, 120)))}\n` : '';
    for (let i = 0; i < questions.length; i++) await sendQuestion(ab, a, i, i === 0 ? title : '');
    return true;
  }

  async function submit(ab: ActiveBinding, a: RichAsk, unclear: boolean): Promise<string | null> {
    const selections = Object.fromEntries(a.questions.map((q, i) => [q.question, [...a.picks[i]]]));
    const picked = buildQuestionPicks(a.questions, selections);
    const notes = Object.fromEntries(a.questions.map((q, i) => [q.question, a.notes[i]]).filter(([q, n]) => n && (unclear || picked[q as string])));
    if (!unclear && !Object.keys(picked).length) return 'Önce bir seçenek seç.';
    const typed = a.notes.filter(Boolean);
    const t = a.target;
    if (t.kind === 'super-ask') {
      if (!ab.contextRoot) return LINES.stale;
      const s = await readSuperState(ab.contextRoot);
      const item = s.queue.find((q) => q.id === t.item.id && q.state !== 'done');
      if (!item || !s.enabled || !s.session) return LINES.stale;
      const text = unclear ? superUnclearText(item, unclearMessage(typed)) : superAnswerText(item, a.questions, picked, notes);
      const ok = await hub.injectText(ab, hub.syntheticUpdateId(), text, s.session);
      return ok ? (unclear ? '↺ Tekrar sorulacak' : '✓ Gönderildi') : null;
    }
    if (t.kind === 'child-question') {
      if (!ab.contextRoot) return LINES.stale;
      const r = await answerChildQuestion(ab.contextRoot, 'main', unclear
        ? { item: t.item, requestId: t.requestId, unclear: typed.join(' / ') }
        : { item: t.item, requestId: t.requestId, picked, notes });
      if (!r.ok) return r.error === 'no_window' ? LINES.waitingOnMac : LINES.stale;
      return unclear ? '↺ Tekrar sorulacak' : '✓ Gönderildi';
    }
    const token = superTokenOfSession(t.sessionId) ?? tokenOfSession(t.sessionId);
    if (!token) return LINES.waitingOnMac;
    const args: AnswerPending = unclear
      ? { kind: 'unclear', requestId: t.requestId, unclear: typed.join(' / ') }
      : { kind: 'question', requestId: t.requestId, picked, ...(Object.keys(notes).length ? { notes } : {}) };
    const r = await sendHubCommand(token, 'answer_pending', args as unknown as Obj);
    if (!r.ok) return r.error === 'no_window' ? LINES.waitingOnMac : LINES.stale;
    return unclear ? '↺ Tekrar sorulacak' : '✓ Gönderildi';
  }

  /** A tap on a rich ask's message. */
  async function onButton(ab: ActiveBinding, data: Obj, idx: number, messageId: number): Promise<string | null> {
    const a = asks.get(String(data.rich));
    const qi = Number(data.q);
    if (!a || a.done || a.key !== ab.key || !Number.isInteger(qi) || !a.questions[qi]) return LINES.stale;
    const q = a.questions[qi];
    const n = q.options.length;
    if (idx < n) {
      const label = q.options[idx].label;
      const set = a.picks[qi];
      if (q.multiSelect) { if (set.has(label)) set.delete(label); else set.add(label); } else { set.clear(); set.add(label); }
      await redraw(ab, a, qi, messageId);
      return `✓ ${cleanTitle(label, 40)}`;
    }
    if (idx === n) {
      a.noteFor = qi;
      await hub.reply(ab, 'Notunu yaz; sonraki mesajın bu sorunun notu olacak.');
      return 'Not ekle';
    }
    const isLast = qi === a.questions.length - 1;
    if (!isLast || (idx !== n + 1 && idx !== n + 2)) return LINES.stale;
    a.done = true;
    const out = await submit(ab, a, idx === n + 2).catch(() => LINES.stale);
    if (out === 'Önce bir seçenek seç.') a.done = false;
    else asks.delete(a.id);
    return out;
  }

  /** Re-draws a question's buttons after a toggle: a fresh record on the same message (P4). */
  async function redraw(ab: ActiveBinding, a: RichAsk, qi: number, messageId: number): Promise<void> {
    await hub.reissueButtons(ab, messageId, keyboard(a, qi), { kind: 'confirm', singleUse: false }, { rich: a.id, q: qi });
  }

  /** The owner's next text after "Not ekle": that question's note, never a turn. */
  function takeNote(ab: ActiveBinding, text: string): boolean {
    for (const a of asks.values()) {
      if (a.key !== ab.key || a.noteFor === null || a.done) continue;
      a.notes[a.noteFor] = text.slice(0, 2000);
      a.noteFor = null;
      return true;
    }
    return false;
  }

  return { send, onButton, takeNote, _asks: asks };
}

export type RichAsks = ReturnType<typeof wireRichAsks>;

/** Registry questions → rich questions (labels kept exactly). */
export function richQuestionsOf(raw: readonly { question: string; header?: string; multiSelect?: boolean; options?: readonly { label: string; preview?: string }[] }[] | undefined): RichQuestion[] {
  return (raw ?? []).map((q) => ({ question: q.question, header: q.header, multiSelect: !!q.multiSelect, options: (q.options ?? []).map((o) => ({ label: o.label, preview: o.preview })) }));
}

/** Is the Super chat itself asking this request right now? */
export function pendingStillOpen(sessionId: string, requestId: string): boolean {
  const e = getChat(sessionId);
  return [e?.pendingQuestion, ...(e?.earlierPending ?? [])].some((p) => p?.requestId === requestId);
}
