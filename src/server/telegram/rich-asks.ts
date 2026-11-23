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
import { noteUndelivered } from '../../lib/super/undelivered.js';
import { randomBytes } from 'node:crypto';
import { getChat } from '../../lib/assistant/chat-registry.js';
import { answerChildQuestion, superAnswerText, superUnclearText, superAlreadyText, unclearMessage, ALREADY_ANSWERED_MESSAGE } from '../../lib/super/answer.js';
import { readSuperState } from '../../lib/super/store.js';
import type { SuperQueueItem } from '../../lib/super/types.js';
import { buildQuestionPicks, type AnswerPending } from '../../lib/telegram/contract.js';
import { drawingCaption, drawingKey, drawingTag, formatAskQuestionHtml, withDrawingNotes } from '../../lib/telegram/ask-format.js';
import { appendAskLog } from './ask-log.js';
import { escapeHtml, redactSecrets } from '../../lib/telegram/format.js';
import { dreamHtmlPage, fitDrawing } from '../../lib/telegram/render.js';
import { cleanTitle } from '../../lib/telegram/urls.js';
import { sendHubCommand, superTokenOfSession, tokenOfSession } from '../../lib/window-control.js';
import { NOT_SENT, cardOut, fileMedia, notSentLine, pageWithOwnAssets, readProjectFile } from './cards.js';
import { loneMedia } from '../../lib/telegram/preview-media.js';
import { REFUSAL_WHY } from '../../lib/telegram/files.js';
import { answerMemberPick } from './member-picks.js';
import type { PreviewShooter } from './page-shot.js';
import { caption as pictureCaption, fitsTelegram, pngFile, sendMedia, sendPictures, sendWhole, type MediaItem, type Snapshotter } from './pictures.js';
import { cleanOwnerText } from '../../lib/telegram/inbound.js';
import type { NextTextCapture } from './capture.js';
import { secretPending } from './present.js';
import { cardItemKey, claimThisTurn, release, turnOf } from './sent-once.js';
import { superMediaRoots } from './media-roots.js';
import { LINES, type ActiveBinding, type TelegramHub } from './hub.js';

type Obj = Record<string, unknown>;

export interface RichQuestion { question: string; header?: string; description?: string; multiSelect?: boolean; options: { label: string; description?: string; preview?: string }[] }

/** Where the answer goes. */
export type RichTarget =
  | { kind: 'super-ask'; item: Pick<SuperQueueItem, 'id' | 'kind' | 'sessionId'> }
  | { kind: 'child-question'; item: string; requestId: string }
  | { kind: 'pending'; sessionId: string; requestId: string }
  /** An AI Team member's item mirrored into main's queue (owner 2026-11-10): `mirror` is its id there. */
  | { kind: 'member'; mirror: string };

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

/** How an ask's previews reach the project's files (`previewFiles`). */
interface PreviewFiles {
  media(src: string, title: string): Promise<{ ok: true; item: MediaItem } | { ok: false; why: string }>;
  inline(html: string): Promise<string>;
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
    if (qi === a.questions.length - 1) rows.push(['Gönder', 'Belirsiz, tekrar sor'], ['Zaten cevapladım']);
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
    const keys = new Map<MediaItem, string>();
    const keyOf = (m: MediaItem) => keys.get(m)!;
    const turn = turnOf(sessionId);
    let roots: string[] | undefined;
    // Pictures claimed but not yet sent are given back if a card fails midway.
    try {
    for (const id of show?.cards ?? []) {
      const c = s!.containers.find((k) => k.id === id);
      if (!c || items.length >= 10) continue;
      const out = await cardOut({ contextRoot: ab.contextRoot, sessionId, pictures: true, snapshot: deps.snapshot, mediaRoots: roots ??= await superMediaRoots(ab.contextRoot) }, c);
      if (out.kind === 'media') {
        out.items.forEach((m, i) => keys.set(m, cardItemKey(c.id, c.ref, m, i)));
        // A file this turn already sent (the same card on the stage, another ask) goes once
        // (sent-once.ts): claimed now, before any upload; a failed or skipped one is given back.
        const fresh = claimThisTurn(ab.key, sessionId, out.items, keyOf, turn);
        const pics = fresh.filter((m) => m.kind !== 'document');
        const take = pics.slice(0, 10 - items.length);
        items.push(...take);
        release(ab.key, sessionId, pics.slice(take.length), keyOf, turn);
        // A page printed to PDF (or a PDF card) goes as its document; a refused send is its line.
        for (const d of fresh.filter((m) => m.kind === 'document')) {
          if (await sendMedia(ab, d, pictureCaption(d.title))) continue;
          release(ab.key, sessionId, [d], keyOf, turn);
          await hub.reply(ab, notSentLine('', cleanTitle(d.title, 80), NOT_SENT.refused));
        }
      } else await hub.reply(ab, out.line);
    }
    } catch (err) { release(ab.key, sessionId, items, keyOf, turn); throw err; }
    if (!items.length) return;
    const { unsent } = await sendPictures(ab, items, true).catch((err) => { release(ab.key, sessionId, items, keyOf, turn); throw err; });
    release(ab.key, sessionId, unsent, keyOf, turn);
    if (unsent.length) await hub.notice(ab, 'file', `Bu önizlemeler Telegram'a gitmedi, Mac'te: ${unsent.map((m) => cleanTitle(m.title, 40)).join('; ')}`);
  }

  /** One question's option drawings, right above its message, in option order: each its own
   *  message, seen whole (pictures.ts sendWhole), captioned "A · label" as the question's line
   *  names it (owner 2026-11-11: two drawings in one album with stage pictures, no way to tell
   *  which option is which). Adds the `qi:oi` keys (ask-format.ts drawingKey) that reached
   *  Telegram to `drawn`; `budget` caps the drawings of the whole ask (10, as one album held). */
  async function sendDrawings(ab: ActiveBinding, sessionId: string, q: RichQuestion, qi: number, drawn: Set<string>, budget: { left: number }, misses: string[], tries: { headless: boolean }, files: PreviewFiles): Promise<void> {
    for (const [oi, o] of q.options.entries()) {
      if (!o.preview?.trim()) continue;
      const key = drawingKey(qi, oi);
      if (budget.left <= 0) { misses.push(`${o.label}: over 10 pictures`); continue; }
      let it: MediaItem;
      const lone = loneMedia(o.preview);
      if (lone) {
        // A preview that is only one project picture or clip goes as that file, the way the
        // card draws it natively (owner 2026-11-17: drawn as a page it was a broken image).
        const got = await files.media(lone.src, o.label);
        if (!got.ok) { misses.push(`${o.label}: ${got.why}`); continue; }
        budget.left--;
        it = got.item;
      } else {
        const png = await drawPreview(sessionId, await files.inline(o.preview), tries);
        if (!png) { misses.push(`${o.label}: not drawn`); continue; }
        budget.left--;
        it = { kind: 'photo', file: pngFile(`${drawingTag(oi)}-${o.label}`, png), title: o.label };
      }
      if (!fitsTelegram(it)) { misses.push(`${o.label}: too large for Telegram, not sent`); continue; }
      const cap = pictureCaption(drawingCaption(oi, o.label));
      const ok = it.kind === 'photo' ? await sendWhole(ab, it, cap) : !!(await sendMedia(ab, it, cap));
      if (ok) drawn.add(key);
      else misses.push(`${o.label}: Telegram refused the picture`);
    }
  }

  /** The project files an ask's previews name, read through H (cards.ts `readProjectFile`: inside
   *  the project or a media root, no symlink, no secret class): a lone file as its own media item,
   *  and every project picture inside a preview's markup written in as a `data:` URL, the way the
   *  chat card inlines them (the drawing's page loads nothing else; an unread one stays as written). */
  function previewFiles(ab: ActiveBinding): PreviewFiles {
    let roots: Promise<string[]> | undefined;
    const ctx = async () => ab.contextRoot ? { contextRoot: ab.contextRoot, mediaRoots: await (roots ??= superMediaRoots(ab.contextRoot).catch(() => [])) } : null;
    return {
      async media(src, title) {
        const c = await ctx();
        if (!c) return { ok: false, why: 'no project to read it from' };
        const f = readProjectFile(c, src);
        if (!f.ok) return { ok: false, why: REFUSAL_WHY[f.reason] ?? f.reason };
        const item = fileMedia(f.file, f.ext, title);
        return item ? { ok: true, item } : { ok: false, why: 'not a picture or clip' };
      },
      async inline(html) {
        const c = await ctx();
        return c ? pageWithOwnAssets(c, html, 'preview.html') : html;
      },
    };
  }

  /** A question with drawings: one log line saying how many went and why the others did not
   *  (the message itself already says "Çizimi Mac'te" on each option that did not go). Counted
   *  by `qi:oi`, the key the notes use. */
  function logPictures(id: string, questions: readonly RichQuestion[], drawn: ReadonlySet<string>, misses: readonly string[], sessionId: string, secret: boolean): void {
    const wanted = questions.reduce((n, q) => n + q.options.filter((o) => o.preview?.trim()).length, 0);
    if (!wanted) return;
    const why = drawn.size < wanted && misses.length ? ` (${misses.join('; ')})` : '';
    appendAskLog(hub.home, `${id} pictures ${drawn.size}/${wanted}${drawn.size < wanted ? ' NOT ALL SENT' : ''}${why}`);
    // The asker hears it too (undelivered.ts): its card is on his phone without these drawings.
    if (drawn.size < wanted && !secret) noteUndelivered(sessionId, 'picture', `${wanted - drawn.size} of the ${wanted} drawings of your question card did not reach his phone${why}; they are on the Mac only.`);
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
    const logId = opts.itemId ?? (target.kind === 'super-ask' ? target.item.id : target.kind === 'member' ? target.mirror : target.requestId);
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
    const files = previewFiles(ab);
    try {
      for (let i = 0; i < questions.length; i++) {
        // Its drawings always (they are part of the question), never while a secret is pending.
        if (!secret) await sendDrawings(ab, opts.sessionId, questions[i], i, drawn, budget, misses, tries, files).catch(fail);
        await sendQuestion(ab, a, i, i === 0 ? head : {}, drawn);
      }
    } finally {
      logPictures(logId, questions, drawn, secret ? ['a secret is pending: no picture leaves'] : misses, opts.sessionId, secret);
    }
    return { askId: a.id, messages: a.messages.slice() };
  }

  /** Answered elsewhere: the ask's buttons answer nothing more. */
  function close(askId: string): void {
    const a = asks.get(askId);
    if (a) { a.done = true; asks.delete(askId); }
  }

  async function submit(ab: ActiveBinding, a: RichAsk, mode: 'answer' | 'unclear' | 'already'): Promise<string | null> {
    const already = mode === 'already';
    const unclear = mode !== 'answer';
    const selections = Object.fromEntries(a.questions.map((q, i) => [q.question, [...a.picks[i]]]));
    const picked = buildQuestionPicks(a.questions, selections);
    // Every note goes, picked or not, as the Mac's buildQuestionAnswer carries them.
    const notes = Object.fromEntries(a.questions.map((q, i) => [q.question, a.notes[i]]).filter(([, n]) => !!n));
    if (!unclear && !Object.keys(picked).length) return 'Önce bir seçenek seç.';
    const typed = a.notes.filter(Boolean);
    const t = a.target;
    if (t.kind === 'member') {
      return answerMemberPick(hub, ab, t.mirror, unclear
        ? { kind: 'question', questions: a.questions, picked: {}, unclear: typed.join(' / '), ...(already ? { already: true as const } : {}) }
        : { kind: 'question', questions: a.questions, picked, ...(Object.keys(notes).length ? { notes } : {}) });
    }
    if (t.kind === 'super-ask') {
      if (!ab.contextRoot) return LINES.stale;
      const s = await readSuperState(ab.contextRoot);
      const item = s.queue.find((q) => q.id === t.item.id && q.state !== 'done');
      if (!item || !s.enabled || !s.session) return LINES.stale;
      const text = already ? superAlreadyText(item) : unclear ? superUnclearText(item, unclearMessage(typed)) : superAnswerText(item, a.questions, picked, notes);
      const ok = await hub.injectText(ab, hub.syntheticUpdateId(), text, s.session);
      return ok ? (already ? '↺ Zaten cevaplandı' : unclear ? '↺ Tekrar sorulacak' : '✓ Gönderildi') : null;
    }
    if (t.kind === 'child-question') {
      if (!ab.contextRoot) return LINES.stale;
      const r = await answerChildQuestion(ab.contextRoot, 'main', unclear
        ? { item: t.item, requestId: t.requestId, unclear: already ? ALREADY_ANSWERED_MESSAGE : typed.join(' / ') }
        : { item: t.item, requestId: t.requestId, picked, notes });
      if (!r.ok) return r.error === 'no_window' ? LINES.waitingOnMac : LINES.stale;
      return already ? '↺ Zaten cevaplandı' : unclear ? '↺ Tekrar sorulacak' : '✓ Gönderildi';
    }
    const token = superTokenOfSession(t.sessionId) ?? tokenOfSession(t.sessionId);
    if (!token) return LINES.waitingOnMac;
    const args: AnswerPending = unclear
      ? { kind: 'unclear', requestId: t.requestId, unclear: typed.join(' / '), ...(already ? { already: true as const } : {}) }
      : { kind: 'question', requestId: t.requestId, picked, ...(Object.keys(notes).length ? { notes } : {}) };
    const r = await sendHubCommand(token, 'answer_pending', args as unknown as Obj);
    if (!r.ok) return r.error === 'no_window' ? LINES.waitingOnMac : LINES.stale;
    return already ? '↺ Zaten cevaplandı' : unclear ? '↺ Tekrar sorulacak' : '✓ Gönderildi';
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
    if (!isLast || (idx !== n + 1 && idx !== n + 2 && idx !== n + 3)) return LINES.stale;
    a.done = true;
    const out = (await submit(ab, a, idx === n + 3 ? 'already' : idx === n + 2 ? 'unclear' : 'answer').catch(() => null)) ?? 'Gönderilemedi, tekrar dene.';
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
    const id = t.kind === 'super-ask' ? t.item.id : t.kind === 'member' ? t.mirror : t.item;
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
