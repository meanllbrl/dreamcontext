/**
 * Gate G1's desktop ws proof (sahip-karti-yerinde K4): the OWNER presses a card, never the Super.
 *
 * Every card-mode upgrade of `/api/agent/terminal` (start, attach, rerun) carries a ticket from
 * `POST /api/agent/card-ticket`, which itself requires `fromOwnerPage` (own Origin,
 * `Sec-Fetch-Site: same-origin`, the shell's owner key). A no-Origin loopback client (the Super's
 * own Bash with a node `ws`) has no owner key, so it can mint none.
 *
 * A ticket is:
 *  - 128 bits of randomness, base64url; held in this process's memory only, by its sha256;
 *  - single use: SPENT at the first lookup, before any check passes and before anything starts,
 *    attaches or replays, whatever the outcome;
 *  - alive 30 s;
 *  - bound to (project, posting session, cardRef, action) and to the command the surface DREW
 *    (`shown`): a ticket for another card, another action, another project or a command that is
 *    not exactly the record's spec is refused.
 *
 * No CLI verb, `super` verb, `window` verb or window command handler mints one (asserted by test
 * in lane B). The upgrade's query string is never logged.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { CARD_TICKET_TTL_MS, type CardTicketAction, type CardTicketRefusal } from '../lib/super/types.js';

export { CARD_TICKET_TTL_MS };
export type { CardTicketAction, CardTicketRefusal };

/** What a ticket is bound to at mint. `project` is the record's project root (or vault name: the
 *  caller picks one and uses the same at consume); `shown` the command the surface drew. */
export interface CardTicketBinding {
  project: string;
  postingSession: string;
  cardRef: string;
  action: CardTicketAction;
  shown: string;
}

/** What the upgrade checks a ticket against: the record as it is NOW. `action` may list several
 *  (an upgrade that would attach to a run the same ticket's card has going). */
export interface CardTicketExpect {
  project: string;
  postingSession: string;
  cardRef: string;
  action: CardTicketAction | readonly CardTicketAction[];
  /** The record's spec command at the upgrade. */
  command: string;
}

export type CardTicketResult = { ok: true; binding: CardTicketBinding } | { ok: false; why: CardTicketRefusal };

interface Held { hash: Buffer; binding: CardTicketBinding; expiresAt: number }

const TICKET_RE = /^[A-Za-z0-9_-]{22}$/;
const MAX_LIVE = 256;
const live = new Map<string, Held>();
/** Spent or expired tickets, remembered for one TTL so a reuse reads `spent`, not `unknown`. */
const spent = new Map<string, number>();

const hashOf = (ticket: string): Buffer => createHash('sha256').update(ticket, 'utf-8').digest();

function prune(now: number): void {
  for (const [k, h] of live) if (h.expiresAt <= now) { live.delete(k); spent.set(k, now + CARD_TICKET_TTL_MS); }
  for (const [k, until] of spent) if (until <= now) spent.delete(k);
  while (live.size >= MAX_LIVE) {
    const oldest = live.keys().next().value as string;
    live.delete(oldest);
    spent.set(oldest, now + CARD_TICKET_TTL_MS);
  }
}

/** Mint one ticket for an owner-proven press (the caller has checked `fromOwnerPage` and that
 *  `shown` is exactly the record's command). */
export function mintCardTicket(binding: CardTicketBinding, now: number = Date.now()): { ticket: string; expiresAt: number } {
  prune(now);
  const ticket = randomBytes(16).toString('base64url');
  const hash = hashOf(ticket);
  const expiresAt = now + CARD_TICKET_TTL_MS;
  live.set(hash.toString('hex'), { hash, binding: { ...binding }, expiresAt });
  return { ticket, expiresAt };
}

const eq = (a: string, b: string): boolean => {
  const x = Buffer.from(a, 'utf-8');
  const y = Buffer.from(b, 'utf-8');
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Spend a ticket and check it against the record now. The ticket is gone from the moment it is
 * looked up, whether it then passes or not: call this BEFORE anything starts, attaches or replays.
 */
export function consumeCardTicket(ticket: string | null | undefined, expect: CardTicketExpect, now: number = Date.now()): CardTicketResult {
  if (!ticket || typeof ticket !== 'string' || !TICKET_RE.test(ticket)) return { ok: false, why: 'missing' };
  const hash = hashOf(ticket);
  const key = hash.toString('hex');
  const held = live.get(key);
  if (!held) {
    const wasSpent = spent.has(key) && (spent.get(key) ?? 0) > now;
    return { ok: false, why: wasSpent ? 'spent' : 'unknown' };
  }
  // Spent first: no path below can leave it usable.
  live.delete(key);
  spent.set(key, now + CARD_TICKET_TTL_MS);
  if (held.hash.length !== hash.length || !timingSafeEqual(held.hash, hash)) return { ok: false, why: 'unknown' };
  if (held.expiresAt <= now) return { ok: false, why: 'expired' };
  const b = held.binding;
  if (!eq(b.project, expect.project)) return { ok: false, why: 'wrong_project' };
  if (!eq(b.postingSession.toLowerCase(), expect.postingSession.toLowerCase()) || !eq(b.cardRef, expect.cardRef)) return { ok: false, why: 'wrong_card' };
  const actions: readonly CardTicketAction[] = typeof expect.action === 'string' ? [expect.action] : expect.action;
  if (!actions.includes(b.action)) return { ok: false, why: 'wrong_action' };
  if (!eq(b.shown, expect.command)) return { ok: false, why: 'shown_mismatch' };
  return { ok: true, binding: { ...b } };
}

/** Strip a ticket (and the whole query) from a URL before any log line prints it. */
export function redactTicketUrl(url: string | undefined): string {
  if (!url) return '';
  const q = url.indexOf('?');
  return q < 0 ? url : `${url.slice(0, q)}?…`;
}

/** Tests only. */
export function _resetCardTicketsForTests(): void {
  live.clear();
  spent.clear();
}
