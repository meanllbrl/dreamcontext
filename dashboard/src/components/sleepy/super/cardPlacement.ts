import type { SuperQueueItem } from '../../../lib/superTypes';
import type { ChatItem } from '../chatSession';

/**
 * WHERE AN OWNER CARD IS DRAWN in the Super chat: the one rule.
 *
 * A card a child (or an AI Team member's child) left for the owner is a MESSAGE of the chat: it
 * is drawn in the transcript where it arrived, under the last drawn message that came before it
 * was posted, and it scrolls with the conversation like any message, waiting or settled. Whatever
 * he writes after it, and the Super's answers, come BELOW it (owner 2026-11-14, a tall secret card
 * pinned over the chat: "şu kartlar da kaymıyor altta kalıyor"). The job bar on top is the "it
 * waits on you" signal, and its verbs bring the card into view.
 *
 * The same rule places the Super's own open question whose asking call is not drawn and a member's
 * wait with no card (`placedByTime`, owner 2026-11-15): asked before his next message, drawn above it.
 *
 * The chat's TAIL (the strip under the last message) holds an owner card only as a fallback: one
 * that still waits on him (`tailHolds`) but has no place on screen (posted before the first drawn
 * message, behind "Show earlier messages", or before any message at all), so a wait is never lost.
 * A settled card with no place is not drawn. One card record is drawn once, however many items
 * name it (13 Nov: two identical "Ran on this Mac" cards).
 *
 * History: the tail used to hold every open owner card (owner cards W2, 0.41.20), so a card sat
 * under every new message until it was acted on; settled cards left it first (13 Nov), and now
 * waiting ones do too. The other kinds of the tail (the CLI's pending permission, question and
 * plan, a refused call, the Super's own question, a member's wait without a card) leave it when
 * they close; `tailHolds` is their shared test.
 */

/**
 * A tail item is drawn only while it still waits on the OWNER: open, and (an owner card) his
 * action has no result yet. A card he already ran, saved or sent whose result is on its way
 * (`delivery`: sent, waking, held for a full crew, a closed window, the phone) waits on nothing
 * he can do: it is history, even before the record closes the item.
 */
export function tailHolds(item: Pick<SuperQueueItem, 'state'> & { delivery?: SuperQueueItem['delivery'] }): boolean {
  // A run he pressed and that still goes (`running`, run-bildirim-hemen) stays where he pressed it,
  // its terminal live (a login or a y/n may still want his keys); it is no longer HIS to do
  // (needsOwner says so), and it settles in its place at the exit, when the server's result line
  // replaces `running` (the server never leaves `running` behind a run that ended).
  if (item.delivery === 'running') return true;
  return item.state !== 'done' && !item.delivery;
}

/** The record a card item stands for: one card, drawn once. */
function cardKeyOf(q: SuperQueueItem): string {
  return q.card ? `${q.card.postingSession}\n${q.card.cardRef}` : `item\n${q.id}`;
}

/**
 * The slot's card items, each card once (`all`, every one drawn in its place), split by whether it
 * waits on the owner (`tail`: kept at the chat's end when it has no place) or is history (`settled`).
 * One card record named by several items (a re-posted card, a successor's item) is drawn once:
 * the open item when one is open (it is the one he can act on), else the newest.
 */
export function placeOwnerCards(items: readonly SuperQueueItem[]): { all: SuperQueueItem[]; tail: SuperQueueItem[]; settled: SuperQueueItem[] } {
  const best = new Map<string, SuperQueueItem>();
  for (const q of items) {
    const k = cardKeyOf(q);
    const cur = best.get(k);
    if (!cur) { best.set(k, q); continue; }
    const qOpen = tailHolds(q);
    const curOpen = tailHolds(cur);
    if ((qOpen && !curOpen) || (qOpen === curOpen && q.createdAt >= cur.createdAt)) best.set(k, q);
  }
  const kept = [...best.values()].sort((a, b) => a.createdAt - b.createdAt);
  return { all: kept, tail: kept.filter(tailHolds), settled: kept.filter((q) => !tailHolds(q)) };
}

/** Every owner card the Super chat may draw: its children's (`cards`) and the AI Team members'
 *  mirrors that carry a card (`members`), all under the one rule above. */
export function ownerCardItemsOf(view: { cards?: readonly SuperQueueItem[]; members?: readonly SuperQueueItem[] } | null | undefined): SuperQueueItem[] {
  return [...(view?.cards ?? []), ...(view?.members ?? []).filter((q) => !!q.card)];
}

/** What the Super chat places by time (`anchorOwnerCards`), and which of those are the Super's own
 *  questions and which a member's wait with no card (each kind draws its own component). */
export interface PlacedByTime {
  items: SuperQueueItem[];
  questions: ReadonlySet<string>;
  members: ReadonlySet<string>;
}

export const NOTHING_TIMED: PlacedByTime = { items: [], questions: new Set(), members: new Set() };

/**
 * Everything the Super chat asks the owner that is drawn in the transcript by WHEN it was asked:
 * every owner card (`ownerCards`, from `placeOwnerCards(...).all`), each open question of the
 * Super whose asking call has no live card drawn (`callAnchored`: its call folded into an event
 * line, compacted away, or asked in a way the transcript cannot read), and each member's wait
 * with no card. Before 2026-11-15 those questions and waits went straight to the tail, so a
 * question asked before the owner's next message was drawn UNDER it (owner: "Sorunun altına
 * geçmeliydi"). Only one with no place on screen falls back to the tail now (`SuperQuestionTail`).
 */
export function placedByTime(
  view: { open?: readonly SuperQueueItem[]; members?: readonly SuperQueueItem[] } | null | undefined,
  ownerCards: readonly SuperQueueItem[],
  callAnchored: ReadonlySet<string>,
): PlacedByTime {
  const open = (view?.open ?? []).filter((q) => !callAnchored.has(q.id));
  const members = (view?.members ?? []).filter((q) => !q.card);
  return {
    items: [...ownerCards, ...open, ...members],
    questions: new Set(open.map((q) => q.id)),
    members: new Set(members.map((q) => q.id)),
  };
}

/** When a transcript item happened (ms). */
export function itemTime(it: ChatItem): number {
  return it.kind === 'tool' ? it.startedAt : it.ts;
}

/**
 * Where each card goes: after the LAST drawn transcript item from before it was posted (`drawn`:
 * every item the chat draws, in reading order). A card posted before the first drawn item (behind
 * "Show earlier messages") has no place on screen: it is left out of the map (a waiting one falls
 * back to the tail, a settled one is not drawn). Returns anchor item id -> the cards under it,
 * oldest first.
 */
export function anchorOwnerCards(drawn: readonly ChatItem[], cards: readonly SuperQueueItem[]): Map<string, SuperQueueItem[]> {
  const out = new Map<string, SuperQueueItem[]>();
  if (!cards.length || !drawn.length) return out;
  for (const q of cards) {
    let anchor: string | null = null;
    // An undated row (0: no time, never the epoch) places nothing.
    for (const it of drawn) { const at = itemTime(it); if (at > 0 && at <= q.createdAt) anchor = it.id; }
    if (!anchor) continue;
    const list = out.get(anchor) ?? [];
    list.push(q);
    out.set(anchor, list);
  }
  return out;
}
