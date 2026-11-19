/**
 * Which entries of the Super chat belong to one agenda row's thread (task ajanda-gunluk, plan
 * ajanda-filtre C2). Pure: the conversation, the row's key and the asks in; a set of entry ids
 * and a card predicate out. The filtered chat (ChatPane) draws only these.
 *
 * Membership is by EXPLICIT links only (D5), never by words or a time window:
 *  M1. an owner message whose About header (any part) names the key (`note=`, `item=`, `owed=`,
 *      or a closed line's `[About a closed agenda line note=<id>]`);
 *  M2. the owner messages the key's `refs` and `sent` pairs resolve to: each pair takes ONE
 *      distinct message with that ref whose time lies in [at - 60 s, at + STEER_MAX] (a steer
 *      is replayed with the time it was folded in; 60 s a remote clock's skew), the nearest to
 *      its own arrival first, so an earlier identical "ok" never takes a later pair's place. A
 *      message with no time (`ts: 0`, a replay) matches by order only when the line holds as
 *      many of that ref's pairs as there are such messages; otherwise none (a wrong message is
 *      worse than a missing one). A pair no message fits was linked after the fact (`--origin`
 *      or `super note link` in a later turn, stamped when linked): it takes the newest message
 *      with that ref that arrived before it. A `sent` pair was stamped by this window's own clock: 5 s;
 *  M3. an event turn naming the key's job, with the Super's text and step rows of that turn;
 *  M4. the Super group whose tool row asked the key's item;
 *  M5. every Super group (`replyGroups` over the FULL conversation) answering an M1/M2 message.
 * A key whose `child` is the Super's own session names no job (no M3, no card by session): no
 * path ever widens a thread to everything the Super did.
 */
import type { ChatItem, ChatUserItem } from '../chatSession';
import { isOwnerMessage, ownerPartRefsOf, ownerRefOf, replyGroups, type ReplyGroup } from '../chat/replyLinks';
import { aboutHeads, type PadRef } from '../../../lib/superTypes';
import { superBatchOf, type ThreadKey } from './superHandover';
import type { AskRef } from './superQuestions';

/** How long after his message arrived its transcript row may carry (a steer folds in late). */
export const STEER_MAX_MS = 15 * 60_000;
/** A remote clock's skew: a row may read a little before the arrival the server stamped. */
export const CLOCK_SKEW_MS = 60_000;
/** A send from the filter is stamped by the same clock as its row: only a moment's slack. */
export const SENT_SKEW_MS = 5_000;

/** A card a layer may draw, as the predicate reads it. */
export interface ThreadCard { item: string; sessionId?: string; toolItemId?: string }

export interface LineThread {
  /** The entry ids drawn while filtered. */
  entries: Set<string>;
  /** Whether a card (question or owner card) belongs to the thread. */
  card: (c: ThreadCard) => boolean;
  /** Owner messages plus the Super's text groups in the thread ("N mesaj"). */
  count: number;
  /** Nothing to show: no entry and none of the known cards passes (D5's empty state). */
  empty: boolean;
}

const CLOSED_LINE_RE = /^\[About a closed agenda line note=([A-Za-z0-9_-]{1,40})\]/;

/** Every About head a message opens a part with, the closed-line header included. */
function aboutTargets(text: string): Array<{ kind: string; id: string }> {
  const out: Array<{ kind: string; id: string }> = aboutHeads(text).map((h) => ({ kind: h.kind, id: h.id }));
  const starts = [0];
  for (let i = text.indexOf('\n\n'); i >= 0; i = text.indexOf('\n\n', i + 1)) starts.push(i + 2);
  for (const at of starts) {
    const m = CLOSED_LINE_RE.exec(text.slice(at));
    if (m) out.push({ kind: 'note', id: m[1] });
  }
  return out;
}

function namesKey(it: ChatUserItem, key: ThreadKey): boolean {
  return aboutTargets(it.text).some((h) => (h.kind === 'note' && h.id === key.note)
    || (h.kind === 'item' && h.id === key.item) || (h.kind === 'owed' && h.id === key.owed));
}

/** M2: each pair to ONE distinct owner message (see the module note). */
function resolvePairs(owners: readonly ChatUserItem[], pairs: readonly PadRef[], taken: Set<string>, skew = CLOCK_SKEW_MS, late = true): string[] {
  const out: string[] = [];
  const byRef = new Map<string, PadRef[]>();
  for (const p of pairs) {
    const list = byRef.get(p.ref) ?? [];
    list.push(p);
    byRef.set(p.ref, list);
  }
  for (const [ref, list] of byRef) {
    const sorted = [...list].sort((a, b) => a.at - b.at);
    const cands = owners.filter((o) => !taken.has(o.id) && (ownerRefOf(o) === ref || ownerPartRefsOf(o).includes(ref)));
    // Timed: every fitting (pair, message), nearest first; each side is used once.
    const fits: Array<{ k: number; id: string; d: number }> = [];
    sorted.forEach((pair, k) => {
      for (const o of cands) if (o.ts && o.ts >= pair.at - skew && o.ts <= pair.at + STEER_MAX_MS) fits.push({ k, id: o.id, d: Math.abs(o.ts - pair.at) });
    });
    fits.sort((a, b) => a.d - b.d || a.k - b.k);
    const done = new Set<number>();
    for (const f of fits) {
      if (done.has(f.k) || taken.has(f.id)) continue;
      done.add(f.k);
      taken.add(f.id);
      out.push(f.id);
    }
    // Linked late: a pair stamped when the link was MADE (`--origin` or `note link` outside his
    // turn, his arrival no longer known) lies after its message. A link never precedes its
    // message, so the newest one with that ref that arrived before the pair is the one meant.
    if (late) sorted.forEach((pair, k) => {
      if (done.has(k)) return;
      let best: ChatUserItem | undefined;
      for (const o of cands) if (o.ts && !taken.has(o.id) && o.ts < pair.at - skew && (!best || o.ts > (best.ts ?? 0))) best = o;
      if (!best) return;
      done.add(k);
      taken.add(best.id);
      out.push(best.id);
    });
    // Untimed (a replay): by order, only when the counts say which is which.
    const left = sorted.filter((_, k) => !done.has(k));
    const untimed = cands.filter((o) => !o.ts && !taken.has(o.id));
    if (left.length && left.length === untimed.length) {
      for (const o of untimed) { taken.add(o.id); out.push(o.id); }
    }
  }
  return out;
}

/**
 * The thread of `key` in `entries` (the FULL conversation: history + live items). `cards`: the
 * cards the layers may draw, so `empty` knows whether one would show.
 */
export function lineThread(
  entries: readonly ChatItem[],
  key: ThreadKey,
  asks: readonly AskRef[],
  superSession: string | null | undefined,
  opts: { cards?: readonly ThreadCard[]; groups?: ReadonlyMap<string, ReplyGroup> } = {},
): LineThread {
  const child = key.child && key.child !== superSession ? key.child : undefined;
  const groups = opts.groups ?? replyGroups(entries);
  const owners = entries.filter(isOwnerMessage);
  const ownerIds = new Set<string>();

  // M1: his messages about this row.
  for (const o of owners) if (namesKey(o, key)) ownerIds.add(o.id);
  // M2: the messages its refs (and the sends made from the filter) resolve to.
  const taken = new Set<string>();
  for (const id of resolvePairs(owners, key.refs, taken)) ownerIds.add(id);
  if (key.sent.length) for (const id of resolvePairs(owners, key.sent, taken, SENT_SKEW_MS, false)) ownerIds.add(id);

  const out = new Set<string>(ownerIds);
  const groupMembers = new Map<string, string[]>();
  for (const [id, g] of groups) {
    const list = groupMembers.get(g.groupId) ?? [];
    list.push(id);
    groupMembers.set(g.groupId, list);
  }
  const textGroups = new Set<string>();
  const addGroup = (gid: string) => {
    for (const id of groupMembers.get(gid) ?? []) out.add(id);
  };

  // M5: the Super's answers to them, each with its step rows.
  for (const [, g] of groups) {
    if (g.targets.some((t) => ownerIds.has(t)) || (g.sections ?? []).some((s) => s.targets.some((t) => ownerIds.has(t)))) addGroup(g.groupId);
  }
  // M4: the turn group whose tool row asked this row's item.
  if (key.item) {
    for (const a of asks) {
      if (a.item !== key.item) continue;
      out.add(a.toolItemId);
      const g = groups.get(a.toolItemId);
      if (g) addGroup(g.groupId);
    }
  }
  // M3: an event turn about this job, with what the Super did in it.
  if (child) {
    let inTurn = false;
    for (const e of entries) {
      if (e.kind === 'user') {
        const text = e.text;
        inTurn = !isOwnerMessage(e) && !!superBatchOf(text)?.items.some((x) => x.child === child);
        if (inTurn) out.add(e.id);
        continue;
      }
      if (inTurn && (e.kind === 'text' || e.kind === 'tool' || e.kind === 'thinking')) out.add(e.id);
    }
  }

  // "N mesaj": his messages + the Super's text groups (cards and step rows are not counted).
  for (const e of entries) {
    if (!out.has(e.id) || e.kind !== 'text' || !e.text.trim()) continue;
    textGroups.add(groups.get(e.id)?.groupId ?? e.id);
  }
  const card = (c: ThreadCard): boolean => (key.item !== undefined && c.item === key.item)
    || (child !== undefined && c.sessionId === child)
    || (c.toolItemId !== undefined && out.has(c.toolItemId));
  const known: ThreadCard[] = [...(opts.cards ?? []), ...asks.map((a) => ({ item: a.item, toolItemId: a.toolItemId }))];
  return {
    entries: out,
    card,
    count: ownerIds.size + textGroups.size,
    empty: out.size === 0 && !known.some(card),
  };
}
