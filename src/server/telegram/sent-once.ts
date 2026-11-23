/**
 * One file reaches a Telegram chat at most once per Super turn (owner 2026-11-17: "Aynı dakikada
 * aynı pdf iki kere gelmiş").
 *
 * Why: a card can leave by two doors in one turn. An ask's `--show` card goes right before its
 * question (rich-asks.ts sendShowCards) and the same card, open on the stage, goes again in the
 * turn-end presentation (present.ts). A page card is printed to PDF afresh each time, so the bytes
 * differ (the PDF's creation date): the key is the card (id + ref + item index) and what the item
 * was made from (the printed page, else the bytes), so a re-print matches and an edit does not.
 *
 * A turn: from the chat leaving `idle` to the next time it does. A new turn forgets what went, so
 * the owner asking for the same file again later gets it. The turn-end presentation runs after the
 * chat is idle, so it passes the turn it belongs to (`turnOf` read at that moment).
 */
import { createHash } from 'node:crypto';
import { onChatChange } from '../../lib/assistant/chat-registry.js';
import type { CardOut } from './cards.js';
import type { MediaItem } from './pictures.js';

const turns = new Map<string, number>();
/** `${chat}\0${sessionId}` → item key → the turn it went in. */
const sent = new Map<string, Map<string, number>>();
let wired = false;

function wire(): void {
  if (wired) return;
  wired = true;
  onChatChange(({ entry, from }) => {
    if (entry.status === 'gone') { forgetSession(entry.sessionId); return; }
    if (from === 'idle' && entry.status !== 'idle') newTurn(entry.sessionId);
  });
}

/** The session's current turn number. */
export function turnOf(sessionId: string): number { wire(); return turns.get(sessionId) ?? 0; }

/** A new turn began: what went before may go again. */
export function newTurn(sessionId: string): void {
  const t = (turns.get(sessionId) ?? 0) + 1;
  turns.set(sessionId, t);
  // Keep the previous turn's entries: its presentation may still be settling.
  for (const [k, m] of sent) if (k.endsWith(`\0${sessionId}`)) for (const [ik, it] of m) if (it < t - 1) m.delete(ik);
}

export function forgetSession(sessionId: string): void {
  turns.delete(sessionId);
  for (const k of [...sent.keys()]) if (k.endsWith(`\0${sessionId}`)) sent.delete(k);
  for (const l of ledgers) l.forget(sessionId);
}

/** A card's item: the same card, the same place in it, the same content. Content is the item's
 *  `source` when its bytes vary per print (a page PDF), else its bytes: a card edited after the
 *  owner answered goes again, a mere re-print does not. */
export function cardItemKey(cardId: string, ref: string, m: MediaItem, index: number): string {
  const digest = createHash('sha256').update(m.source ?? m.file.data).digest('hex');
  return `card\0${cardId}\0${ref}\0${index}\0${m.kind}\0${digest}`;
}

/** Claims, for this turn, the keyed items not yet claimed: the claim is taken HERE, before any
 *  upload, so two doors racing (an ask uploading while the presentation checks) cannot both pass.
 *  A send that then fails gives its items back with `release`. */
export function claimThisTurn<T>(chat: string, sessionId: string, items: readonly T[], keyOf: (t: T) => string, turn = turnOf(sessionId)): T[] {
  const key = `${chat}\0${sessionId}`;
  const m = sent.get(key) ?? new Map<string, number>();
  const fresh: T[] = [];
  for (const it of items) {
    const k = keyOf(it);
    if (m.get(k) === turn) continue;
    m.set(k, turn);
    fresh.push(it);
  }
  sent.set(key, m);
  return fresh;
}

/** Gives back claims whose send failed (or never happened), so the other door may still send. */
export function release<T>(chat: string, sessionId: string, items: readonly T[], keyOf: (t: T) => string, turn = turnOf(sessionId)): void {
  const m = sent.get(`${chat}\0${sessionId}`);
  if (!m) return;
  for (const it of items) { const k = keyOf(it); if (m.get(k) === turn) m.delete(k); }
}

/** A presentation's card outputs, claiming their files for this turn: a file this turn already
 *  claimed is left out, a media card whose every item was is left out whole. `claimed` lists what
 *  the caller must `release` if it does not reach the chat. */
export function freshCardOuts(chat: string, sessionId: string, list: readonly { card: { id: string; ref: string }; out: CardOut }[], turn = turnOf(sessionId)): { outs: CardOut[]; claimed: MediaItem[]; keyOf: (m: MediaItem) => string } {
  const keys = new Map<MediaItem, string>();
  const keyOf = (m: MediaItem) => keys.get(m)!;
  const outs: CardOut[] = [];
  const claimed: MediaItem[] = [];
  for (const { card, out } of list) {
    if (out.kind !== 'media') { outs.push(out); continue; }
    out.items.forEach((m, i) => keys.set(m, cardItemKey(card.id, card.ref, m, i)));
    const fresh = claimThisTurn(chat, sessionId, out.items, keyOf, turn);
    claimed.push(...fresh);
    if (fresh.length) outs.push({ ...out, items: fresh });
  }
  return { outs, claimed, keyOf };
}

// ─── Text: one answer reaches the chat once per turn (owner 2026-11-17, "aynı mesajı iki kere
// attın bak yine bunu fixle"). The Super wrote its answer under a `re:` mark, ran `super ask`, then
// wrote the same answer again in other words as the turn's last text: text, card, text. Only that
// shape is caught: a text written AFTER a question card of this turn that says largely what a text
// written BEFORE the card said is not sent. Not byte equality: a re-worded repeat is caught by
// word-set overlap (Jaccard, `SAME_TEXT`). Never a repeat: two texts answering different `re:`
// refs, texts with no card between them (two job reports of one template), and a text that adds
// a number, a `#ref` or a code span the earlier one did not have (a correction, another job).

/** Jaccard over word sets at or above which a text counts as a repeat. The re-worded repeat of
 *  2026-11-17 measured 0.77; a different short reply in the same turn 0.04. */
export const SAME_TEXT = 0.6;
/** Below this many distinct words a text is a repeat only when its words are identical. */
export const SAME_TEXT_MIN_WORDS = 8;

/** The words of a text: lowercased (Turkish casing), letters and digits only, two chars or more. */
export function textWords(text: string): Set<string> {
  return new Set(text.toLocaleLowerCase('tr').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2));
}

/** Is `b` largely what `a` already said? */
export function sameText(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (!a.size || !b.size) return false;
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  if (Math.min(a.size, b.size) < SAME_TEXT_MIN_WORDS) return both === a.size && both === b.size;
  return both / (a.size + b.size - both) >= SAME_TEXT;
}

/** What tells one report from another of the same shape: numbers, `#refs`, code spans. */
export function textMarks(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/`[^`\n]+`|#[\p{L}\p{N}_-]+|[\p{L}\p{N}]*\d[\p{L}\p{N}]*/gu)) out.add(m[0].toLocaleLowerCase('tr'));
  return out;
}

interface SentText { words: Set<string>; marks: Set<string>; refs: string[]; turn: number; cards: number }

/** Every live ledger: a chat that is gone takes its texts with it (`forgetSession`). */
const ledgers = new Set<TextLedger>();

/** The texts one hub sent, per chat and Super session, with the turn each went in and how many
 *  question cards of that turn were queued before it. A hub owns one (a fresh hub, a fresh
 *  ledger); entries older than the previous turn are pruned on every claim, a session that is
 *  gone is dropped whole. */
export class TextLedger {
  /** `${chat}\0${sessionId}` → the texts claimed. */
  private readonly sent = new Map<string, SentText[]>();
  /** sessionId → the question cards queued in its turn. */
  private readonly cards = new Map<string, { turn: number; n: number }>();
  constructor() { wire(); ledgers.add(this); }

  /** A question card of the Super (`super ask`, `queue ask`) was queued for its chat now. */
  noteCard(sessionId: string, turn = turnOf(sessionId)): void {
    const c = this.cards.get(sessionId);
    this.cards.set(sessionId, { turn, n: c?.turn === turn ? c.n + 1 : 1 });
  }

  /** How many question cards this turn queued so far (read as a text is written). */
  cardsOf(sessionId: string, turn = turnOf(sessionId)): number {
    const c = this.cards.get(sessionId);
    return c?.turn === turn ? c.n : 0;
  }

  /** Claims this text, unless it is the repeat above. Returns the claim (to `release` if the send
   *  fails) or null for a repeat. `cards` = `cardsOf` when the text was written. */
  claim(chat: string, sessionId: string, text: string, refs: readonly string[], turn: number, cards: number): object | null {
    const key = `${chat}\0${sessionId}`;
    const list = (this.sent.get(key) ?? []).filter((t) => t.turn >= turn - 1);
    const words = textWords(text);
    const marks = textMarks(text);
    const otherAnswer = (t: SentText) => t.refs.length > 0 && refs.length > 0 && !t.refs.some((r) => refs.includes(r));
    const addsMarks = (t: SentText) => [...marks].some((m) => !t.marks.has(m));
    if (list.some((t) => t.turn === turn && t.cards < cards && !otherAnswer(t) && !addsMarks(t) && sameText(t.words, words))) {
      this.sent.set(key, list);
      return null;
    }
    const claim: SentText = { words, marks, refs: [...refs], turn, cards };
    list.push(claim);
    this.sent.set(key, list);
    return claim;
  }

  /** A claimed text that did not reach the chat: a later one saying the same may still go. */
  release(chat: string, sessionId: string, claim: object | null): void {
    if (!claim) return;
    const list = this.sent.get(`${chat}\0${sessionId}`);
    const i = list?.indexOf(claim as SentText) ?? -1;
    if (list && i >= 0) list.splice(i, 1);
  }

  forget(sessionId: string): void {
    this.cards.delete(sessionId);
    for (const k of [...this.sent.keys()]) if (k.endsWith(`\0${sessionId}`)) this.sent.delete(k);
  }
}
