/**
 * A picture question presents its pictures by itself and puts them back after the answer (task
 * a-picture-question…, D2). `super ask` / `super queue ask` record which cards a question shows
 * (`SuperState.askShows`); this settles those entries on EVERY record write (`writeSuper`), so
 * every way a question closes (the owner's click or typed answer, `queue done`, `super answer`,
 * a child answering itself, the stale sweep, a hand-over or fresh session) and every way one
 * reaches the head (a permission ahead clears, a first question closes, a restart) is caught:
 *
 * - a closed question: the stage floats if it still shows that question, and the pictures it
 *   opened go to Others (a group of them as its group tile), unless the owner placed or sized
 *   them, or the view still shows them;
 * - the head question: its cards are presented (`view.ask` = the item), unless the owner set
 *   the view himself (`skipped: owner_layout`, never later).
 *
 * Pure: never imports inbox.js (inbox imports this).
 */
import {
  ASK_SHOW_RECENT_MS, MAX_ASK_SHOWS, MAX_FILMSTRIP, leaveGroups, presentCards, sameCardSet,
  type AskShow, type SuperQueueItem, type SuperState,
} from './types.js';
import type { ImageChain } from './image-group.js';

/** A question still open with the owner (or waiting to reach him). */
function isOpen(q: SuperQueueItem | undefined): boolean {
  return !!q && q.state === 'escalated' && (q.kind === 'ask' || q.kind === 'question');
}

/** The owner arranged the stage himself, for other cards than these. */
function ownerArranged(s: SuperState, cards: readonly string[]): boolean {
  const v = s.view;
  if (v.mode === 'present' && sameCardSet(v.cards ?? [], cards)) return false;
  return v.by === 'owner' || (v.mode === 'present' && v.layoutBy === 'owner');
}

/** What the view shows right now. */
function shownNow(s: SuperState): Set<string> {
  const v = s.view;
  return new Set(v.mode === 'half' && v.card ? [v.card] : v.mode === 'present' ? v.cards ?? [] : []);
}

/** A closed question's pictures to Others (D2a). */
function putBack(s: SuperState, e: AskShow): void {
  if (s.view.mode === 'present' && s.view.ask === e.item) s.view = { mode: 'float' };
  const shown = shownNow(s);
  // Its cards now and what it opened before a repeat ask replaced them (D2).
  const moving = new Set([...new Set([...e.cards, ...e.opened])].filter((id) => {
    const k = s.containers.find((c) => c.id === id);
    if (!k || k.kind !== 'image' || k.by === 'auto') return false;
    if (!(e.opened.includes(id) || k.forChild !== undefined || e.via === 'recent')) return false;
    return !shown.has(id) && !k.pos && k.sizeBy !== 'owner';
  }));
  if (!moving.size) return;
  const solo: string[] = [];
  const handled = new Set<string>();
  for (const g of s.groups) {
    const mine = g.cards.filter((id) => moving.has(id));
    if (!mine.length) continue;
    mine.forEach((id) => handled.add(id));
    // A group the owner placed is his: none of its cards move.
    if (g.pos) continue;
    if (g.cards.every((id) => moving.has(id))) { g.place = 'others'; continue; }
    solo.push(...mine);
  }
  if (solo.length) leaveGroups(s, solo);
  for (const id of [...moving].filter((x) => !handled.has(x)).concat(solo)) {
    const k = s.containers.find((c) => c.id === id);
    if (k) k.place = 'others';
  }
}

/** Settle every picture question against the record (D2 a-c). Mutates `s`. */
export function settleAskShows(s: SuperState, head: SuperQueueItem | null): void {
  if (!s.askShows?.length) return;
  let entries = [...s.askShows];
  // a. Closed questions.
  for (const e of [...entries]) {
    if (isOpen(s.queue.find((q) => q.id === e.item))) continue;
    putBack(s, e);
    entries = entries.filter((x) => x !== e);
  }
  // b. The head question, once.
  const e = head ? entries.find((x) => x.item === head.id) : undefined;
  if (e && !e.presented && !e.skipped) {
    const cards = e.cards.filter((id) => s.containers.some((c) => c.id === id)).slice(0, MAX_FILMSTRIP);
    if (!cards.length) entries = entries.filter((x) => x !== e);
    else if (ownerArranged(s, cards)) entries = entries.map((x) => (x === e ? { ...x, skipped: 'owner_layout' as const } : x));
    else {
      presentCards(s, cards, undefined, e.item);
      entries = entries.map((x) => (x === e ? { ...x, cards, presented: true as const } : x));
    }
  }
  // c. A few at most: the oldest goes.
  entries = entries.slice(-MAX_ASK_SHOWS);
  if (entries.length) s.askShows = entries; else delete s.askShows;
}

/** What `show.state` says about a question right after its write. */
export function askShowState(s: SuperState, item: string): 'presented' | 'waiting' | 'skipped' | 'none' {
  const e = s.askShows?.find((x) => x.item === item);
  if (!e) return 'none';
  if (e.skipped) return 'skipped';
  return e.presented ? 'presented' : 'waiting';
}

/**
 * The recent pictures a question falls back on (D1.3): for a child's question, the pictures shown
 * for that child within ASK_SHOW_RECENT_MS; for the super's own, its last picture set (the image
 * chain: its group's pictures, or the lone one) within the same window. At most MAX_FILMSTRIP.
 */
export function recentAskCards(s: SuperState, from: { child: string } | { chain: ImageChain | undefined }, now: number): string[] {
  const images = s.containers.filter((c) => c.kind === 'image');
  if ('child' in from) {
    return images.filter((c) => c.forChild === from.child && (c.forAt ?? 0) >= now - ASK_SHOW_RECENT_MS).map((c) => c.id).slice(0, MAX_FILMSTRIP);
  }
  const chain = from.chain;
  if (!chain || now - chain.at > ASK_SHOW_RECENT_MS) return [];
  const g = chain.group ? s.groups.find((x) => x.id === chain.group) : undefined;
  const ids = g ? g.cards : [chain.card];
  return ids.filter((id) => images.some((c) => c.id === id)).slice(0, MAX_FILMSTRIP);
}

/**
 * Record a question's cards (the routes, inside the same write as the queue item). A repeat
 * `queue ask` of the same item replaces its cards and keeps what it opened before (D2), and is
 * presented again.
 */
export function recordAskShow(s: SuperState, item: string, cards: readonly string[], opened: readonly string[], via: AskShow['via']): void {
  const prev = s.askShows?.find((x) => x.item === item);
  const rest = (s.askShows ?? []).filter((x) => x.item !== item);
  const entry: AskShow = { item, cards: [...cards], opened: [...new Set([...(prev?.opened ?? []), ...opened])], via };
  s.askShows = [...rest, entry].slice(-MAX_ASK_SHOWS);
}
