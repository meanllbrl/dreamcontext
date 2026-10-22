import { buildAppLink } from '../app-link.js';
import type { SuperQueueItem, SuperState } from './types.js';

/**
 * A question the Super Agent puts to the owner REACHES him (Tilki, 2026-10-21: three `super
 * queue ask`s in one morning sat as a line in the job bar while the agent told him "I asked
 * you"). The job bar draws the question and rings once, but only while the Super stage is
 * mounted, and the turn that escalated is no notch row or banner of its own. So the announcement
 * lives HERE, on the server, at the queue head's edge, whatever page the window shows:
 *
 *   banner — a routable macOS banner to the Super Agent's stage while he is not looking at this
 *            project (another app, another project); the job bar then rings without a banner
 *   phone  — a hands-free `question` push to the super chat while Mac mode exposes the project
 *   notch  — the glance already lists the head (`superGlanceRows`); a notch that polled it
 *            lately shows the row within its 3 s tick
 *   screen — he is looking at this project's window right now (the bar, the notch peek)
 *
 * Every head the owner must answer but a permission (a child's own request, drawn and rung by
 * the window from that request): an escalated child question, the agent's own `ask`, an AI Team
 * approval. ONCE per item per process; a head already open when the server boots is seeded
 * silently. What reached him is kept per item, so `super queue ask` / `super ask` can tell the
 * agent the truth (`reached`, `via`, `note`) instead of "escalated: true".
 *
 * The sinks are injected at boot (src/server/index.ts, the hands-free route), so this module
 * imports neither the notch inbox nor the push notifier.
 */

export type OwnerChannel = 'screen' | 'notch' | 'banner' | 'phone';

export interface OwnerQuestionReach {
  /** At the head of his bar now. False = waiting behind `ahead` items he must answer first. */
  shown: boolean;
  ahead: number;
  /** What carried it to him. */
  via: OwnerChannel[];
  /** Shown, and at least one channel carried it. */
  reached: boolean;
  /** For the agent: what that means and what to do. */
  note: string;
}

export interface OwnerQuestionPush {
  vault: string;
  /** The super session (registry id and Claude id). */
  sessionId: string;
  key: string;
  title: string;
  body: string;
}

export interface OwnerQuestionSinks {
  /** Which project, and which chat in it, the owner is looking at (notch-inbox presence). */
  presence: () => { vault: string | null; session: string | null };
  /** Post a routable banner; true when one was posted. */
  banner: (title: string, body: string, link: string | null) => boolean;
  /** Push to the hands-free phones; how many devices it goes to (0 = Mac mode off). */
  push: (q: OwnerQuestionPush) => number;
}

const NONE: OwnerQuestionSinks = {
  presence: () => ({ vault: null, session: null }),
  banner: () => false,
  push: () => 0,
};
let sinks: OwnerQuestionSinks = NONE;

export function setOwnerQuestionSinks(next: Partial<OwnerQuestionSinks>): void {
  sinks = { ...sinks, ...next };
}

/** A notch that read the glance this recently lists the head within its next tick. */
export const NOTCH_LIVE_MS = 10_000;
let notchPolledAt = 0;
export function noteNotchPoll(now = Date.now()): void {
  notchPolledAt = now;
}

const BODY_CHARS = 180;
const ANNOUNCED_CAP = 500;
/** Item id → what reached him. Insertion-ordered, the oldest dropped first. */
const announced = new Map<string, OwnerQuestionReach>();

function remember(id: string, reach: OwnerQuestionReach): void {
  announced.delete(id);
  announced.set(id, reach);
  while (announced.size > ANNOUNCED_CAP) announced.delete(announced.keys().next().value as string);
}

/** Does the owner answer this item (not a permission: the window rings that one)? */
function announces(item: SuperQueueItem | null): item is SuperQueueItem {
  return !!item && item.state === 'escalated' && (item.kind === 'question' || item.kind === 'ask' || item.kind === 'approval');
}

function clip(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > BODY_CHARS ? `${flat.slice(0, BODY_CHARS - 1).trimEnd()}…` : flat;
}

function bodyOf(item: SuperQueueItem): string {
  if (item.kind === 'approval') return `An AI Team member needs your approval${item.member ? `: ${item.member}` : ''}.`;
  return clip(item.ownerText ?? '') || 'A question is waiting for your answer.';
}

function noteFor(item: SuperQueueItem, shown: boolean, ahead: number, via: OwnerChannel[], reached: boolean): string {
  if (!shown) {
    return `Not shown yet: it is a card in your chat, but in his bar it waits behind ${ahead} item(s) he must answer first, and it is announced when it comes up. He has not seen it: do not tell him you asked.`;
  }
  const answer = item.kind === 'question'
    ? 'His pick goes to the child directly, or he writes to you.'
    : 'His answer is his next message to you.';
  if (!reached) {
    return `NOT seen: he is not on your stage and no banner or phone push could reach him${via.includes('notch') ? ' (only the notch lists it)' : ''}. It waits as a card in your chat and at the head of his bar; do not tell him you asked. Write him the question in this turn too: your reply reaches him when he is back. ${answer}`;
  }
  return `Reached him (${via.join(', ')}): it waits as a card in your chat and at the head of his bar, with its buttons. Write him the question in this turn too, then end your turn; never wait for it. ${answer}`;
}

/** How many owner items come before a question at the head: every open permission, then the
 *  older questions (`superQueueHead`'s order). */
function aheadOf(state: Pick<SuperState, 'queue'>, item: SuperQueueItem): number {
  return state.queue.filter((q) => q.id !== item.id
    && ((q.kind === 'permission' && q.state !== 'done') || (announces(q) && q.createdAt < item.createdAt))).length;
}

/**
 * A write left `head` at the head of a handed-over vault's queue: announce it, once. Called from
 * every record write (`afterSuperWrite`); `vaultOf` is read only past the cheap guards.
 */
export function announceOwnerHead(vaultOf: () => string, state: Pick<SuperState, 'enabled' | 'session' | 'queue'>, head: SuperQueueItem | null): void {
  if (!state.enabled || !state.session || !announces(head) || announced.has(head.id)) return;
  const session = state.session;
  const vault = vaultOf();
  const via: OwnerChannel[] = [];
  let looking: { vault: string | null; session: string | null } = { vault: null, session: null };
  try { looking = sinks.presence(); } catch { /* nobody known to be looking */ }
  // In this project's window: no banner over it (the attention rule). On screen only when that
  // window shows the Super Agent itself (its stage); another page of the project is not.
  const here = looking.vault === vault;
  if (here && looking.session === session) via.push('screen');
  if (Date.now() - notchPolledAt <= NOTCH_LIVE_MS) via.push('notch');
  const title = `Super Agent asks · ${vault}`;
  const body = bodyOf(head);
  if (!here) {
    let link: string | null = null;
    try { link = buildAppLink({ kind: 'session', vault, claudeId: session }); } catch { link = null; }
    try { if (sinks.banner(title, body, link)) via.push('banner'); } catch { /* the other channels still stand */ }
  }
  try { if (sinks.push({ vault, sessionId: session, key: `super-ask:${head.id}`, title, body }) > 0) via.push('phone'); } catch { /* idem */ }
  // A notch that polls is listed but proves nothing alone: it polls while he is away too.
  const reached = via.some((v) => v !== 'notch');
  remember(head.id, { shown: true, ahead: 0, via, reached, note: noteFor(head, true, 0, via, reached) });
}

/** The queue items whose banner the server posted: the window's job bar posts none of its own
 *  for those, and posts its own for every other (a Mac without the notifier bundle). */
export function serverBannered(queue: readonly SuperQueueItem[]): string[] {
  return queue.filter((q) => announced.get(q.id)?.via.includes('banner')).map((q) => q.id);
}

/** At boot: the head already open is not news. */
export function seedOwnerHead(head: SuperQueueItem | null): void {
  if (announces(head) && !announced.has(head.id)) {
    remember(head.id, { shown: true, ahead: 0, via: [], reached: false, note: 'It was already open when the app started.' });
  }
}

/** What reached the owner of `itemId` (after the write that put it on the queue). */
export function ownerQuestionReach(state: Pick<SuperState, 'queue'>, itemId: string): OwnerQuestionReach {
  const item = state.queue.find((q) => q.id === itemId);
  const known = announced.get(itemId);
  if (known) return known;
  if (!item) return { shown: false, ahead: 0, via: [], reached: false, note: 'That item is no longer on the queue.' };
  const ahead = aheadOf(state, item);
  return { shown: ahead === 0, ahead, via: [], reached: false, note: noteFor(item, ahead === 0, ahead, [], false) };
}

/** Test-only. */
export function _resetOwnerQuestions(): void {
  announced.clear();
  notchPolledAt = 0;
  sinks = NONE;
}
