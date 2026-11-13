import type { SuperQueueItem } from '../../../lib/superTypes';
import type { ChatItem } from '../chatSession';

/**
 * WHERE AN OWNER CARD IS DRAWN in the Super chat: the one rule (owner 2026-11-13, third stuck-card
 * report in a day: "bu tip takılı kalmalar çok can sıkıyor").
 *
 * The chat's TAIL (the strip under the last message) is for what waits on the owner NOW. A card
 * whose wait ended (he ran it, saved it, sent it, said Not needed, the child ended, it closed
 * across a restart) is history: it leaves the tail and is drawn in the transcript where it was
 * posted, under the last message that came before it, and it stays there while the chat moves
 * on. One card record is drawn once, however many items name it.
 *
 * The owner-card slot (run, secret, checklist, mcp) was the kind that broke this: a closed item
 * with a result line stayed in the tail, so a finished run card sat under every new message
 * (13 Nov, two identical "Ran on this Mac" cards at the bottom). The other kinds of the tail
 * (the CLI's pending permission, question and plan, a refused call, the Super's own question, an
 * AI Team member's wait) already leave it when they close; `tailHolds` is their shared test, and
 * a member's mirror that carries a card follows the owner-card rule (`ownerCardItemsOf`).
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
 * The slot's card items split by the one rule: `tail` waits on the owner, `settled` is history.
 * One card record named by several items (a re-posted card, a successor's item) is drawn once:
 * the open item when one is open (it is the one he can act on), else the newest.
 */
export function placeOwnerCards(items: readonly SuperQueueItem[]): { tail: SuperQueueItem[]; settled: SuperQueueItem[] } {
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
  return { tail: kept.filter(tailHolds), settled: kept.filter((q) => !tailHolds(q)) };
}

/** Every owner card the Super chat may draw: its children's (`cards`) and the AI Team members'
 *  mirrors that carry a card (`members`), all under the one rule above. */
export function ownerCardItemsOf(view: { cards?: readonly SuperQueueItem[]; members?: readonly SuperQueueItem[] } | null | undefined): SuperQueueItem[] {
  return [...(view?.cards ?? []), ...(view?.members ?? []).filter((q) => !!q.card)];
}

/** When a transcript item happened (ms). */
export function itemTime(it: ChatItem): number {
  return it.kind === 'tool' ? it.startedAt : it.ts;
}

/**
 * Where each settled card goes: after the LAST drawn transcript item from before it was posted
 * (`drawn`: every item the chat draws, in reading order). A card posted before the first drawn
 * item (behind "Show earlier messages") has no place on screen and is not drawn: never in the
 * tail. Returns anchor item id -> the cards under it, oldest first.
 */
export function anchorSettledCards(drawn: readonly ChatItem[], settled: readonly SuperQueueItem[]): Map<string, SuperQueueItem[]> {
  const out = new Map<string, SuperQueueItem[]>();
  if (!settled.length || !drawn.length) return out;
  for (const q of settled) {
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
