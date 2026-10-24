import { activityOf, getChat } from '../assistant/chat-registry.js';
import { MAX_FLOAT, floatCount, type QueueKind, type SuperContainer, type SuperState } from './types.js';

/**
 * A live child is a floating card (task super-canli-kart-sahnede, owner 2026-10-23, said many
 * times: "running jobs' cards keep not being floating on the stage"). Only a finished or ended
 * job's card rests in Others.
 *
 * LIVE = a child of the record, not ended or succeeded, whose row works, asks, is stuck or waits
 * on the owner, or that has an open question or owner item, or whose process the registry says
 * is busy right now (a row that has not caught up yet: the subject is asked, not its record).
 *
 * The one exception is the OWNER's own hand: a live card he dragged to Others or grouped himself
 * (`heldAt`) stays there until the run he put away finishes; when the child runs again after
 * that, its card comes back.
 */

/** Whether a chat's process is doing something now (working, starting, asking, silent mid-turn).
 *  Injected by tests. */
export type BusyTest = (sessionId: string) => boolean;

export const chatIsBusy: BusyTest = (sid) => {
  const e = getChat(sid);
  if (!e) return false;
  const a = activityOf(e);
  return a === 'working' || a === 'starting' || a === 'asking' || a === 'stale';
};

const LIVE_ROWS = new Set(['working', 'asking', 'stuck', 'waiting']);
/** Queue items that say the child still needs someone: a question, a stuck turn, an owner step. */
const OPEN_KINDS = new Set<QueueKind>(['permission', 'question', 'stuck', 'owner']);

const own = <T>(o: Readonly<Record<string, T>>, k: string): T | undefined =>
  (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

/** Whether this child's job is live (see the module comment). Pure but for `busy`. */
export function childIsLive(s: Pick<SuperState, 'children' | 'queue'>, sid: string, busy: BusyTest = chatIsBusy): boolean {
  const ch = own(s.children, sid);
  if (!ch || ch.endedAt !== undefined || ch.succeededBy) return false;
  if (ch.row !== undefined && LIVE_ROWS.has(ch.row)) return true;
  if (s.queue.some((q) => q.sessionId === sid && q.state !== 'done' && OPEN_KINDS.has(q.kind))) return true;
  return busy(sid);
}

/** A live child's chat card. */
export function isLiveChatCard(s: Pick<SuperState, 'children' | 'queue'>, c: Pick<SuperContainer, 'kind' | 'ref'>, busy: BusyTest = chatIsBusy): boolean {
  return c.kind === 'chat' && childIsLive(s, c.ref, busy);
}

/** The owner put this live card away himself and that run has not finished since. */
export function ownerHolds(s: Pick<SuperState, 'children'>, c: Pick<SuperContainer, 'ref' | 'heldAt'>): boolean {
  if (c.heldAt === undefined) return false;
  const fin = own(s.children, c.ref)?.finishedAt;
  return !(fin !== undefined && fin > c.heldAt);
}

const shownIds = (s: Pick<SuperState, 'view'>): Set<string> =>
  new Set(s.view.mode === 'half' && s.view.card ? [s.view.card] : s.view.mode === 'present' ? s.view.cards ?? [] : []);

/**
 * Bring the stage back to `target` floating items by putting the oldest NON-live items in Others:
 * pictures, tasks, pages, finished chats, groups without a live card. Never a live chat, the
 * agenda, what the view shows, or what the owner placed or sized while anything else may go.
 * All live: nothing moves (the cap gives way to live jobs). Mutates; returns the ids moved.
 */
export function stackForLive(s: SuperState, target: number, busy: BusyTest = chatIsBusy): string[] {
  const moved: string[] = [];
  if (floatCount(s) <= target) return moved;
  const shown = shownIds(s);
  const grouped = new Set(s.groups.flatMap((g) => g.cards));
  const byId = new Map(s.containers.map((c) => [c.id, c] as const));
  type Item = { id: string; owner: boolean; at: number; put: () => void };
  const items: Item[] = [];
  s.containers.forEach((c, i) => {
    if (c.place !== 'float' || c.min || grouped.has(c.id) || shown.has(c.id) || c.kind === 'agenda') return;
    if (isLiveChatCard(s, c, busy)) return;
    items.push({ id: c.id, owner: !!c.pos || c.sizeBy === 'owner', at: i, put: () => { c.place = 'others'; } });
  });
  for (const g of s.groups) {
    if (g.place !== 'float') continue;
    const cards = g.cards.map((id) => byId.get(id)).filter((c): c is SuperContainer => !!c);
    if (cards.some((c) => shown.has(c.id) || c.kind === 'agenda' || isLiveChatCard(s, c, busy))) continue;
    const at = Math.min(...cards.map((c) => s.containers.indexOf(c)));
    items.push({ id: g.id, owner: !!g.pos, at, put: () => { g.place = 'others'; } });
  }
  // Oldest first; what the owner placed or sized only once nothing else is left.
  items.sort((a, b) => Number(a.owner) - Number(b.owner) || a.at - b.at);
  for (const it of items) {
    if (floatCount(s) <= target) break;
    it.put();
    moved.push(it.id);
  }
  return moved;
}

/** Float one live chat card now: back from Others; a grouped one floats with its whole group
 *  (a group is never broken up: who made it is not recorded, and it may be the owner's). */
function floatCard(s: SuperState, c: SuperContainer): boolean {
  const g = s.groups.find((x) => x.cards.includes(c.id));
  if (g) {
    if (g.place === 'float') return false;
    g.place = 'float';
    return true;
  }
  if (c.place === 'float') return false;
  c.place = 'float';
  return true;
}

/** A child that runs from now on (`ensureChatContainer(…, runs)`): its card floats (with its
 *  group), the owner's hold on an earlier run spent, and non-live items make room. Mutates. */
export function bringLiveCard(s: SuperState, c: SuperContainer, busy: BusyTest = chatIsBusy): void {
  const before = floatCount(s);
  delete c.heldAt;
  floatCard(s, c);
  stackForLive(s, Math.max(before, MAX_FLOAT), busy);
}

/**
 * The record's invariant, run on every write (inbox `writeSuper`): every live child's chat card
 * floats (a grouped one with its group), unless the owner holds it away; a spent hold is dropped. Room is made by
 * `stackForLive`, never past what floated before this pass (an owner who floated more than
 * MAX_FLOAT himself keeps them). Mutates; returns the cards it brought back and moved away.
 */
export function floatLiveChildren(s: SuperState, busy: BusyTest = chatIsBusy): { floated: string[]; stacked: string[] } {
  const floated: string[] = [];
  if (!s.enabled) return { floated, stacked: [] };
  const before = floatCount(s);
  for (const c of s.containers) {
    if (c.kind !== 'chat') continue;
    if (c.heldAt !== undefined && !ownerHolds(s, c)) delete c.heldAt;
    if (c.heldAt !== undefined || !childIsLive(s, c.ref, busy)) continue;
    if (floatCard(s, c)) floated.push(c.id);
  }
  if (!floated.length) return { floated, stacked: [] };
  const stacked = stackForLive(s, Math.max(before, MAX_FLOAT), busy);
  return { floated, stacked };
}
