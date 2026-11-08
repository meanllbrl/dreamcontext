import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { memberOfSuperId, parseSuperKey, superKey } from './store.js';
import type { SuperId } from './types.js';

/**
 * `super delegate` calls in flight, per SUPER (its `superKey`; main's key is the vault root), from
 * the cap check until the window answers (plan-r10 1). Counted against that super's own cap and
 * summed per vault for the vault-wide ceiling; and read by the chat spawn: a lean child opened
 * while a member's delegate is in flight is that member's crew from its FIRST spawn, before its
 * record lands (security r8-2). In memory: a restart ends every call in flight anyway.
 */
const delegating = new Map<string, number>();

/** Add `delta` (+1 at the start, -1 when it settles) and return the count now; `0` only reads. */
export function noteDelegating(key: string, delta: number): number {
  const n = Math.max(0, (delegating.get(key) ?? 0) + delta);
  if (n > 0) delegating.set(key, n); else delegating.delete(key);
  return n;
}

/** Every super's calls in flight in one vault. */
export function vaultDelegating(root: string): number {
  const main = superKey(root);
  let n = 0;
  for (const [k, v] of delegating) if (k === main || k.startsWith(`${main}\u0000`)) n += v;
  return n;
}

/** The members of a vault with a delegate in flight right now, sorted (none: main's or nobody's). */
export function membersDelegating(root: string): string[] {
  const main = resolve(root);
  const out: string[] = [];
  for (const k of delegating.keys()) {
    const { root: r, superId } = parseSuperKey(k);
    const slug = memberOfSuperId(superId);
    if (slug && r === main) out.push(slug);
  }
  return out.sort();
}

/** Is the project's own Super (main) delegating in this vault right now? */
export function mainDelegating(root: string): boolean {
  return (delegating.get(superKey(root)) ?? 0) > 0;
}

// ─── Crew tickets (plan-r10 1, security r8-2; the lane R contract) ─────────────────

/**
 * A member Super's `delegate` frame carries a one-time `crewTicket` the server mints here, keyed to
 * that super and the delegate's job; the window passes it on the child's chat connection
 * (`?crewTicket=`) and the spawn consumes it once: the child is tied to EXACTLY its super from its
 * first spawn. Main's frames carry none. A forged, expired or replayed ticket ties nothing.
 */
export const CREW_TICKET_TTL_MS = 40_000;
const tickets = new Map<string, { root: string; superId: SuperId; job: string; at: number }>();

export function mintCrewTicket(root: string, superId: SuperId, job: string, now = Date.now()): string {
  for (const [t, v] of tickets) if (now - v.at > CREW_TICKET_TTL_MS) tickets.delete(t);
  const ticket = randomBytes(18).toString('hex');
  tickets.set(ticket, { root: resolve(root), superId, job, at: now });
  return ticket;
}

/** The member a ticket ties a child to (consumed: a second use ties nothing), or null. */
export function consumeCrewTicket(ticket: unknown, root: string, now = Date.now()): string | null {
  if (typeof ticket !== 'string' || !/^[0-9a-f]{36}$/.test(ticket)) return null;
  const v = tickets.get(ticket);
  if (!v) return null;
  tickets.delete(ticket);
  if (now - v.at > CREW_TICKET_TTL_MS || v.root !== resolve(root)) return null;
  return memberOfSuperId(v.superId);
}

/** Tests only. */
export function _resetDelegating(): void { delegating.clear(); tickets.clear(); }
