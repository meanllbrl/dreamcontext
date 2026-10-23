import { getChat } from '../assistant/chat-registry.js';
import { MAX_CONTAINERS, MAX_FLOAT, floatCount, type SuperContainer, type SuperState } from './types.js';

/**
 * Room in the card record (task super-kart-kaydi-…, owner 2026-10-23: "I don't see the new job
 * on the stage"). The record holds at most MAX_CONTAINERS cards; at that cap a new child's card
 * used to be skipped with no word (`delegate` answered `container: null`), so running children
 * had no card and nobody noticed. Now a new card first RETIRES the oldest finished cards, and
 * a card that still cannot be opened is said out loud (`card: 'not_opened'`).
 *
 * Retiring removes the card only: the child's transcript stays, `super resume` / `super open
 * chat` bring it back. Oldest = first in the record.
 *   1. Cards resting in Others: a finished child's chat, a read-only view, an automatic card of
 *      a child that no longer runs, a team job that ended.
 *   2. Then floating chat cards of children that are ended or gone.
 * Never retired: a live child's card, a child with an open queue item, a finished result the
 * owner has not seen, a stuck child, the card the half/present view shows, a grouped card, a
 * card the owner sized or placed, or a card being opened right now.
 */

/** Whether a chat runs (its registry entry is not gone). Injected by tests. */
export type LiveTest = (sessionId: string) => boolean;

export const chatIsLive: LiveTest = (sid) => {
  const e = getChat(sid);
  return !!e && e.status !== 'gone';
};

/** A child's job is over and its card can go: ended, gone or done with the result seen, and
 *  nothing about it still open in the queue. A child the record no longer holds is over too. */
function childFinished(s: SuperState, sid: string, live: LiveTest): boolean {
  if (live(sid)) return false;
  if (s.queue.some((q) => q.sessionId === sid && q.state !== 'done')) return false;
  const ch = Object.prototype.hasOwnProperty.call(s.children, sid) ? s.children[sid] : undefined;
  if (!ch) return true;
  if (ch.endedAt !== undefined) return true;
  if (ch.row !== 'done' && ch.row !== 'gone') return false;
  // An unseen result stays: the agenda still shows it as new.
  return ch.finishedAt === undefined || (ch.seenAt !== undefined && ch.seenAt >= ch.finishedAt);
}

function retirable(s: SuperState, c: SuperContainer, live: LiveTest): boolean {
  if (c.kind === 'chat') return childFinished(s, c.ref, live);
  // Everything else rests in Others to go: a read-only view, or a card that belongs to something.
  if (c.place !== 'others') return false;
  if (c.of && !childFinished(s, c.of, live)) return false;
  if (c.kind === 'browser' && !childFinished(s, c.ref, live)) return false;
  if (c.kind === 'team') {
    const job = s.team.find((j) => j.id === c.ref);
    return !job || job.endedAt !== undefined || job.outcome !== undefined;
  }
  return true;
}

/** The cards that may go to make room, in the order they go. */
export function retirableCards(s: SuperState, keep: readonly string[] = [], live: LiveTest = chatIsLive): string[] {
  const grouped = new Set(s.groups.flatMap((g) => g.cards));
  const shown = new Set(s.view.mode === 'half' ? [s.view.card ?? ''] : s.view.mode === 'present' ? s.view.cards ?? [] : []);
  const kept = new Set(keep);
  const ok = s.containers.filter((c) => !kept.has(c.id) && !grouped.has(c.id) && !shown.has(c.id)
    && c.sizeBy !== 'owner' && !c.pos && retirable(s, c, live));
  return [...ok.filter((c) => c.place === 'others'), ...ok.filter((c) => c.place === 'float' && c.kind === 'chat')].map((c) => c.id);
}

/** Whether `n` new cards fit once every retirable card is counted out. Pure. */
export function roomPossible(s: SuperState, n: number, keep: readonly string[] = [], live: LiveTest = chatIsLive): boolean {
  if (s.containers.length + n <= MAX_CONTAINERS) return true;
  return s.containers.length - retirableCards(s, keep, live).length + n <= MAX_CONTAINERS;
}

/**
 * Retire the oldest retirable cards until `n` new ones fit (nothing when they already do).
 * Mutates `s` inside a locked write; returns what it retired. The store settles groups and the
 * view after the write, as it does for `super close`.
 */
export function makeRoom(s: SuperState, n: number, keep: readonly string[] = [], live: LiveTest = chatIsLive): string[] {
  const over = s.containers.length + n - MAX_CONTAINERS;
  if (over <= 0) return [];
  const gone = new Set(retirableCards(s, keep, live).slice(0, over));
  if (!gone.size) return [];
  s.containers = s.containers.filter((c) => !gone.has(c.id));
  console.info(`[super] retired ${gone.size} finished card${gone.size === 1 ? '' : 's'} to make room in the card record`);
  return [...gone];
}

/** How full each limit is: the stage counts top-level floating items, the record every card. */
export function cardCounts(s: Pick<SuperState, 'containers' | 'groups'>): { floating: number; maxFloating: number; total: number; maxTotal: number } {
  return { floating: floatCount(s), maxFloating: MAX_FLOAT, total: s.containers.length, maxTotal: MAX_CONTAINERS };
}

export const RECORD_FULL_MESSAGE = `the card record holds ${MAX_CONTAINERS} cards (Others included) and none could be retired: `
  + 'each belongs to a live child, an open question, an unseen result or the shown view, or the owner sized, placed or grouped it';

/** What a verb that opens a child's card answers about it: opened, or said out loud. */
export function cardOutcome(container: string | null, child: string, s: Pick<SuperState, 'containers' | 'groups'>):
  { card: 'opened'; container: string } | { card: 'not_opened'; container: null; cardError: Record<string, unknown> } {
  if (container) return { card: 'opened', container };
  return {
    card: 'not_opened', container: null,
    cardError: {
      reason: 'record_full', limit: 'record', ...cardCounts(s),
      message: `the child runs, but the owner cannot see it: ${RECORD_FULL_MESSAGE}`,
      todo: `\`super close\` a card he no longer needs (\`super state\` lists them), then \`dreamcontext super open chat ${child}\`. Do not delegate it again: it already runs`,
    },
  };
}

/** `super state`: a running child with no card, as a warning the super sees on its next look. */
export function noCardWarnings(s: Pick<SuperState, 'children' | 'containers'>, running: (sid: string) => boolean):
  Array<{ kind: 'no-card'; child: string; message: string }> {
  const carded = new Set(s.containers.filter((c) => c.kind === 'chat').map((c) => c.ref));
  return Object.entries(s.children)
    .filter(([sid, ch]) => ch.endedAt === undefined && !ch.succeededBy && !carded.has(sid) && running(sid))
    .map(([sid]) => ({
      kind: 'no-card' as const, child: sid,
      message: `${sid} runs with no card, so the owner cannot see it: \`dreamcontext super open chat ${sid}\``,
    }));
}
