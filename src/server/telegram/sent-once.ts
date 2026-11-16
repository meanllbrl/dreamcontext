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
