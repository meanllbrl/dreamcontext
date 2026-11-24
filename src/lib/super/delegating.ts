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
const tickets = new Map<string, { root: string; superId: SuperId; job: string; until: number }>();

/** `ttlMs`: how long the window may still open the child (a delegate's late wait, field
 *  2026-11-15); never shorter than {@link CREW_TICKET_TTL_MS}. */
export function mintCrewTicket(root: string, superId: SuperId, job: string, now = Date.now(), ttlMs = CREW_TICKET_TTL_MS): string {
  for (const [t, v] of tickets) if (now > v.until) tickets.delete(t);
  const ticket = randomBytes(18).toString('hex');
  tickets.set(ticket, { root: resolve(root), superId, job, until: now + Math.max(CREW_TICKET_TTL_MS, ttlMs) });
  return ticket;
}

/** The member a ticket ties a child to (consumed: a second use ties nothing), or null. */
export function consumeCrewTicket(ticket: unknown, root: string, now = Date.now()): string | null {
  if (typeof ticket !== 'string' || !/^[0-9a-f]{36}$/.test(ticket)) return null;
  const v = tickets.get(ticket);
  if (!v) return null;
  tickets.delete(ticket);
  if (now > v.until || v.root !== resolve(root)) return null;
  return memberOfSuperId(v.superId);
}

// ─── The first read (plan ilk-acilis C15, C15a) ───────────────────────────────────

/**
 * A first read's start rides the main Super's `delegate` frame with a one-time ticket in the same
 * `crewTicket` field (the window binds it to the child like a member's), kept in ITS OWN store: a
 * child connection that presents it is the first-read child and spawns `auto` with no MCP,
 * whatever the URL says. A forged or replayed ticket finds nothing here and can only narrow.
 */
const firstReadTickets = new Map<string, { root: string; until: number }>();

export function mintFirstReadTicket(root: string, now = Date.now(), ttlMs = CREW_TICKET_TTL_MS): string {
  for (const [t, v] of firstReadTickets) if (now > v.until) firstReadTickets.delete(t);
  const ticket = randomBytes(18).toString('hex');
  firstReadTickets.set(ticket, { root: resolve(root), until: now + Math.max(CREW_TICKET_TTL_MS, ttlMs) });
  return ticket;
}

/** True once for a valid first-read ticket of this vault (consumed: a second use is false). */
export function consumeFirstReadTicket(ticket: unknown, root: string, now = Date.now()): boolean {
  if (typeof ticket !== 'string' || !/^[0-9a-f]{36}$/.test(ticket)) return false;
  const v = firstReadTickets.get(ticket);
  if (!v) return false;
  firstReadTickets.delete(ticket);
  return now <= v.until && v.root === resolve(root);
}

/** The per-vault first-read lock (C15 step 2): held from the start call until the claim is
 *  written, the start failed, or `until` passes. Read by the chat spawn to fail closed. */
const firstReadLocks = new Map<string, number>();

/** Take the lock for `ms`; false when it is already held (a read is in flight). */
export function takeFirstReadLock(root: string, ms: number, now = Date.now()): boolean {
  const k = resolve(root);
  const until = firstReadLocks.get(k);
  if (until !== undefined && now <= until) return false;
  firstReadLocks.set(k, now + ms);
  return true;
}

export function releaseFirstReadLock(root: string): void {
  firstReadLocks.delete(resolve(root));
}

export function firstReadLockHeld(root: string, now = Date.now()): boolean {
  const until = firstReadLocks.get(resolve(root));
  if (until === undefined) return false;
  if (now > until) { firstReadLocks.delete(resolve(root)); return false; }
  return true;
}

/** Tests only. */
export function _resetDelegating(): void { delegating.clear(); tickets.clear(); firstReadTickets.clear(); firstReadLocks.clear(); }
