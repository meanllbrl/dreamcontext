/**
 * Asks keep their full richness on Telegram (plan M3, P3, P4, N3, T5).
 *
 * One ask = up to 4 questions, one message each, answered together:
 *  - option buttons; a multiSelect toggles (✓) and the message's buttons are re-drawn by the hub
 *    (the record is re-issued per tap, same binding); a single-select marks its pick the same way;
 *  - **Not ekle** under each question: the owner's next text is that question's note;
 *  - under the last question **Gönder** (single use) and **Belirsiz, tekrar sor**;
 *  - the `--show` / plan-approval cards first, as their own group, when pictures are allowed
 *    (a live Telegram turn or streaming, no secret pending; N3); then each question's option
 *    previews (markup), drawn by the server, each its OWN message right above its question,
 *    captioned "A · label" as the question's line names it (never in an album with anything).
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
import { drawingCaption, drawingKey, drawingTag, formatAskQuestionHtml, withDrawingNotes } from '../../lib/telegram/ask-format.js';
import { appendAskLog } from './ask-log.js';
import { escapeHtml, redactSecrets } from '../../lib/telegram/format.js';
import { dreamHtmlPage, fitDrawing } from '../../lib/telegram/render.js';
import { cleanTitle } from '../../lib/telegram/urls.js';
import { sendHubCommand, superTokenOfSession, tokenOfSession } from '../../lib/window-control.js';
import { NOT_SENT, cardOut, notSentLine } from './cards.js';
import type { PreviewShooter } from './page-shot.js';
import { caption as pictureCaption, fitsTelegram, pngFile, sendMedia, sendPictures, sendWhole, type MediaItem, type Snapshotter } from './pictures.js';
import { cleanOwnerText } from '../../lib/telegram/inbound.js';
import type { NextTextCapture } from './capture.js';
import { secretPending } from './present.js';
import { LINES, type ActiveBinding, type TelegramHub } from './hub.js';

type Obj = Record<string, unknown>;

export interface RichQuestion { question: string; header?: string; description?: string; multiSelect?: boolean; options: { label: string; description?: string; preview?: string }[] }

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
  done: boolean;
}

export const MAX_QUESTIONS = 4;
/** A "Not ekle" capture lives this long. */
/** A note as one line of the owner's own words: headers neutralised, sentinels out, no newline. */
export function noteText(text: string): string {
  return cleanOwnerText(text).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
}
export const MAX_OPTIONS = 8;

/** Can this ask go to Telegram as buttons? (Every question has 1-8 options, at most 4 questions.) */
export function richAskFits(questions: readonly RichQuestion[]): boolean {
  return questions.length >= 1 && questions.length <= MAX_QUESTIONS && questions.every((q) => q.options.length >= 1 && q.options.length <= MAX_OPTIONS);
}

export interface RichAsksDeps {
  snapshot: Snapshotter;
  /** Headless renderer for an option's drawing when the window cannot draw it (`page-shot.ts`). */
  shoot?: PreviewShooter;
  /** The bot's one next-text capture (shared with /gundem's Yaz, capture.ts). */
  capture: NextTextCapture;
}

export interface SentRichAsk { askId: string; messages: { messageId: number; html: string }[] }

/** Shared with every text sender (ask-format.ts): an option's drawing says where it is. */
export { withDrawingNotes };

export function wireRichAsks(hub: TelegramHub, deps: RichAsksDeps) {
  const asks = new Map<string, RichAsk>();

  function keyboard(a: RichAsk, qi: number): string[][] {
    const q = a.questions[qi];
    const rows = q.options.map((o) => [`${a.picks[qi].has(o.label) ? '✓ ' : ''}${o.label}`.slice(0, 60)]);
    rows.push([a.notes[qi] ? '✎ Notu değiştir' : 'Not ekle']);
    if (qi === a.questions.length - 1) rows.push(['Gönder', 'Belirsiz, tekrar sor']);
    return rows;
  }

  async function sendQuestion(ab: ActiveBinding, a: RichAsk, qi: number, head: { title?: string; lead?: string }, drawn: ReadonlySet<string>): Promise<void> {
    const q = a.questions[qi];
    const n = a.questions.length > 1 ? ` (${qi + 1}/${a.questions.length})` : '';
    const html = formatAskQuestionHtml(withDrawingNotes(q, qi, drawn), { ...head, suffix: n, footer: q.multiSelect ? '<i>Birden fazla seçebilirsin.</i>' : undefined });
    const rec = await hub.sendButtons(ab, html, keyboard(a, qi), { kind: 'confirm', singleUse: false }, { rich: a.id, q: qi });
    a.messages[qi] = { messageId: hub.buttonMessageId(rec) ?? 0, html };
  }

  /** One option's drawing as PNG (owner 2026-11-09: "çizim gözükmüyor"), fitted so nothing is
   *  lost off its right edge (render.ts fitDrawing). Headless Chromium first: it draws at a
   *  phone's width and widens when that would shrink content (page-shot.ts); once it gives
   *  nothing in an ask (`tries.headless`), the ask's other drawings skip it (no 40 s wait each).
   *  Else the Mac window's sealed renderer, at the chat's width. Null = it could not be drawn. */
  async function drawPreview(sessionId: string, preview: string, tries: { headless: boolean }): Promise<Buffer | null> {
    const fitted = fitDrawing(preview);
    const plan = dreamHtmlPage(fitted);
    if (!plan.ok) return null;
    if (deps.shoot && tries.headless) {
      const shot = await deps.shoot(fitted).catch(() => null);
      if (shot) return shot;
      tries.headless = false;
    }
    const pngs = await deps.snapshot(sessionId, plan.page, plan.width).catch(() => null);
    return pngs?.[0] ?? null;
  }

  /** The ask's `--show` cards (when pictures are allowed), BEFORE its drawings and never in one
   *  album with them: their own group, each picture with its own "N · name" caption and a
   *  numbered list (pictures.ts sendPictures). */
  async function sendShowCards(ab: ActiveBinding, sessionId: string, itemId: string): Promise<void> {
    if (!ab.contextRoot) return;
    const s = await readSuperState(ab.contextRoot).catch(() => null);
    const show = s?.askShows?.find((x) => x.item === itemId);
    const items: MediaItem[] = [];
    for (const id of show?.cards ?? []) {
      const c = s!.containers.find((k) => k.id === id);
      if (!c || items.length >= 10) continue;
      const out = await cardOut({ contextRoot: ab.contextRoot, sessionId, pictures: true, snapshot: deps.snapshot }, c);
      if (out.kind === 'media') {
        items.push(...out.items.filter((m) => m.kind !== 'document').slice(0, 10 - items.length));
        // A page printed to PDF (or a PDF card) goes as its document; a refused send is its line.
        for (const d of out.items.filter((m) => m.kind === 'document')) {
          if (!(await sendMedia(ab, d, pictureCaption(d.title)))) await hub.reply(ab, notSentLine('', cleanTitle(d.title, 80), NOT_SENT.refused));
        }
      } else await hub.reply(ab, out.line);
    }
    if (!items.length) return;
    const { unsent } = await sendPictures(ab, items, { heading: (n) => (n === 1 ? 'Soruyla ilgili resim:' : `Soruyla ilgili ${n} resim:`) });
    if (unsent.length) await hub.notice(ab, 'file', `Bu önizlemeler Telegram'a gitmedi, Mac'te: ${unsent.map((m) => cleanTitle(m.title, 40)).join('; ')}`);
  }

  /** One question's option drawings, right above its message, in option order: each its own
   *  message, seen whole (pictures.ts sendWhole), captioned "A · label" as the question's line
   *  names it (owner 2026-11-11: two drawings in one album with stage pictures, no way to tell
   *  which option is which). Adds the `qi:oi` keys (ask-format.ts drawingKey) that reached
   *  Telegram to `drawn`; `budget` caps the drawings of the whole ask (10, as one album held). */
  async function sendDrawings(ab: ActiveBinding, sessionId: string, q: RichQuestion, qi: number, drawn: Set<string>, budget: { left: number }, misses: string[], tries: { headless: boolean }): Promise<void> {
    for (const [oi, o] of q.options.entries()) {
      if (!o.preview?.trim()) continue;
      const key = drawingKey(qi, oi);
      if (budget.left <= 0) { misses.push(`${o.label}: over 10 pictures`); continue; }
      const png = await drawPreview(sessionId, o.preview, tries);
      if (!png) { misses.push(`${o.label}: not drawn`); continue; }
      budget.left--;
      const it: MediaItem = { kind: 'photo', file: pngFile(`${drawingTag(oi)}-${o.label}`, png), title: o.label };
      if (!fitsTelegram(it)) { misses.push(`${o.label}: too large for Telegram, not sent`); continue; }
      if (await sendWhole(ab, it, pictureCaption(drawingCaption(oi, o.label)))) drawn.add(key);
      else misses.push(`${o.label}: Telegram refused the picture`);
    }
  }

  /** A question with drawings: one log line saying how many went and why the others did not
   *  (the message itself already says "Çizimi Mac'te" on each option that did not go). Counted
   *  by `qi:oi`, the key the notes use. */
  function logPictures(id: string, questions: readonly RichQuestion[], drawn: ReadonlySet<string>, misses: readonly string[]): void {
    const wanted = questions.reduce((n, q) => n + q.options.filter((o) => o.preview?.trim()).length, 0);
    if (!wanted) return;
    const why = drawn.size < wanted && misses.length ? ` (${misses.join('; ')})` : '';
    appendAskLog(hub.home, `${id} pictures ${drawn.size}/${wanted}${drawn.size < wanted ? ' NOT ALL SENT' : ''}${why}`);
  }

  /** The drawings that reached Telegram for an ask (by its log id), kept so a text fallback after
   *  a failed send names them truthfully ("yukarıda", not "Mac'te"). */
  const drawnById = new Map<string, ReadonlySet<string>>();
  function drawnOf(id: string): ReadonlySet<string> | undefined { return drawnById.get(id); }

  /** Sends a rich ask: its messages (id + HTML, one per question), or false when it does not fit
   *  (the caller says "Mac'te seni bekliyor"). Throws when a question message did not go. */
  async function send(ab: ActiveBinding, target: RichTarget, questions: RichQuestion[], opts: { title?: string; lead?: string; sessionId: string; itemId?: string }): Promise<false | SentRichAsk> {
    if (!richAskFits(questions)) return false;
    // The ask's --show cards only in a live Telegram turn or streaming (N3); its option drawings
    // always (they are part of the question), never while a secret is pending.
    const secret = secretPending(opts.sessionId);
    const cards = !!(hub.telegramTurnOf(opts.sessionId) || hub.deps.handsfree?.streamsTo(ab.scope, ab.target)) && !secret;
    const misses: string[] = [];
    const fail = (err: unknown) => { misses.push(`pictures failed: ${redactSecrets(String((err as Error)?.message ?? err)).slice(0, 120)}`); };
    if (cards && opts.itemId) await sendShowCards(ab, opts.sessionId, opts.itemId).catch(fail);
    const logId = opts.itemId ?? (target.kind === 'super-ask' ? target.item.id : target.requestId);
    // Kept live: a text fallback after a question that did not go names what already went.
    const drawn = new Set<string>();
    drawnById.delete(logId);
    drawnById.set(logId, drawn);
    if (drawnById.size > 200) drawnById.delete(drawnById.keys().next().value as string);
    const a: RichAsk = {
      id: randomBytes(6).toString('hex'), key: ab.key, target, questions,
      picks: questions.map(() => new Set<string>()), notes: questions.map(() => ''), messages: [], done: false,
    };
    asks.set(a.id, a);
    if (asks.size > 200) asks.delete(asks.keys().next().value as string);
    const head = { title: opts.title ? cleanTitle(opts.title, 120) : undefined, lead: opts.lead };
    const budget = { left: 10 };
    const tries = { headless: true };
    try {
      for (let i = 0; i < questions.length; i++) {
        // Its drawings always (they are part of the question), never while a secret is pending.
        if (!secret) await sendDrawings(ab, opts.sessionId, questions[i], i, drawn, budget, misses, tries).catch(fail);
        await sendQuestion(ab, a, i, i === 0 ? head : {}, drawn);
      }
    } finally {
      logPictures(logId, questions, drawn, secret ? ['a secret is pending: no picture leaves'] : misses);
    }
    return { askId: a.id, messages: a.messages.slice() };
  }

  /** Answered elsewhere: the ask's buttons answer nothing more. */
  function close(askId: string): void {
    const a = asks.get(askId);
    if (a) { a.done = true; asks.delete(askId); }
  }

  async function submit(ab: ActiveBinding, a: RichAsk, unclear: boolean): Promise<string | null> {
    const selections = Object.fromEntries(a.questions.map((q, i) => [q.question, [...a.picks[i]]]));
    const picked = buildQuestionPicks(a.questions, selections);
    // Every note goes, picked or not, as the Mac's buildQuestionAnswer carries them.
    const notes = Object.fromEntries(a.questions.map((q, i) => [q.question, a.notes[i]]).filter(([, n]) => !!n));
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
      if (!q.multiSelect && set.has(label) && set.size === 1) return `✓ ${cleanTitle(label, 40)}`; // nothing to redraw
      if (q.multiSelect) { if (set.has(label)) set.delete(label); else set.add(label); } else { set.clear(); set.add(label); }
      await redraw(ab, a, qi, messageId);
      return `✓ ${cleanTitle(label, 40)}`;
    }
    if (idx === n) {
      deps.capture.set(ab.key, { kind: 'note', askId: a.id, qi, at: hub.now() });
      await hub.notice(ab, 'wait', 'Notunu yaz (5 dk): sonraki mesajın bu sorunun notu olacak.');
      return 'Not ekle';
    }
    const isLast = qi === a.questions.length - 1;
    if (!isLast || (idx !== n + 1 && idx !== n + 2)) return LINES.stale;
    a.done = true;
    const out = (await submit(ab, a, idx === n + 2).catch(() => null)) ?? 'Gönderilemedi, tekrar dene.';
    // Only a delivered answer (or an ask that no longer exists) ends it: a failed send can be
    // tapped again with the same picks.
    if (out === LINES.stale || (typeof out === 'string' && out.startsWith('✓')) || (typeof out === 'string' && out.startsWith('↺'))) asks.delete(a.id);
    else a.done = false;
    return out;
  }

  /** Re-draws a question's buttons after a toggle: a fresh record on the same message (P4). */
  async function redraw(ab: ActiveBinding, a: RichAsk, qi: number, messageId: number): Promise<void> {
    await hub.reissueButtons(ab, messageId, keyboard(a, qi), { kind: 'confirm', singleUse: false }, { rich: a.id, q: qi });
  }

  /** Is the request behind this ask still open where it lives? */
  async function stillOpen(ab: ActiveBinding, a: RichAsk): Promise<boolean> {
    const t = a.target;
    if (t.kind === 'pending') return pendingStillOpen(t.sessionId, t.requestId);
    if (!ab.contextRoot) return false;
    const s = await readSuperState(ab.contextRoot).catch(() => null);
    const id = t.kind === 'super-ask' ? t.item.id : t.item;
    return !!s?.queue.some((q) => q.id === id && q.state !== 'done');
  }

  /**
   * The owner's next text after "Not ekle": that question's note, never a turn, but only his own
   * typed words (a forwarded, quoted or reply-to-external message is someone else's text: it goes
   * the normal turn path, quoted), only within 5 minutes, only while the ask is still open. A
   * capture that no longer applies lets the text through as a turn.
   */
  async function takeNote(ab: ActiveBinding, msg: Obj): Promise<boolean> {
    // Only a NOTE capture is ours; a Yaz capture waits for the turn path.
    if (deps.capture.peek(ab.key)?.kind !== 'note') return false;
    const c = deps.capture.take(ab.key);
    if (!c || c.kind !== 'note') return false;
    const text = typeof msg.text === 'string' ? msg.text : '';
    if (msg.forward_origin || msg.forward_from || msg.quote || msg.external_reply || !text.trim()) return false;
    const a = asks.get(c.askId);
    if (!a || a.done || a.key !== ab.key || !a.questions[c.qi]) return false;
    // A capture on an ask answered elsewhere: the ask is gone, the text is a turn.
    if (!(await stillOpen(ab, a))) { asks.delete(a.id); return false; }
    a.notes[c.qi] = noteText(text);
    await hub.reply(ab, `✓ Not kaydedildi: «${cleanTitle(a.notes[c.qi], 80)}». Göndermek için Gönder.`);
    return true;
  }

  return { send, close, onButton, takeNote, drawnOf, _asks: asks };
}

export type RichAsks = ReturnType<typeof wireRichAsks>;

/** Registry questions → rich questions (labels kept exactly). */
export function richQuestionsOf(raw: readonly { question: string; header?: string; description?: string; multiSelect?: boolean; options?: readonly { label: string; description?: string; preview?: string }[] }[] | undefined): RichQuestion[] {
  return (raw ?? []).map((q) => ({
    question: q.question, header: q.header, ...(q.description ? { description: q.description } : {}), multiSelect: !!q.multiSelect,
    options: (q.options ?? []).map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}), preview: o.preview })),
  }));
}

/** Is the Super chat itself asking this request right now? */
export function pendingStillOpen(sessionId: string, requestId: string): boolean {
  const e = getChat(sessionId);
  return [e?.pendingQuestion, ...(e?.earlierPending ?? [])].some((p) => p?.requestId === requestId);
}
