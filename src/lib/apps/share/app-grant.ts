/**
 * One-time grants for app actions (app-onay-karti plan r3, C1). Two things open one:
 *
 *  - the owner's Share click on an app's own page (`plan === null`): a publish of that app, the
 *    visibility he clicked, nothing else bound (owner 2026-11-06, unchanged);
 *  - the owner's Onayla on an agent's request card (`decideAppRequest`, the ONLY other minting
 *    place): exactly the stored action plan the card showed, nothing the spender sends.
 *
 * One live grant per (project, app key, action); a newer one replaces the older (its id then
 * answers `replaced`). An hour to spend it. `done(true)` spends it (the id answers `used` for
 * another hour), `done(false)` frees it for a retry inside the same hour (the gate stopped it).
 * Memory only: a restart drops every grant, and no file an agent can write can make one.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { ActionPlan } from './app-request.js';

export const APP_GRANT_TTL_MS = 60 * 60 * 1000;

export type AppAction = 'publish' | 'update' | 'install' | 'logo';
export type GrantVisibility = 'private' | 'public';
export type AppGrantRefusal = 'unknown' | 'expired' | 'running' | 'used' | 'replaced';

interface Grant {
  id: string;
  expiresAt: number;
  plan: ActionPlan | null;
  visibility: GrantVisibility;
  requestId: string | null;
  busy?: boolean;
}

interface Gone { id: string; until: number; fullName: string | null; at: string }

const grants = new Map<string, Grant>();
/** Spent ids, kept for their hour: a retry of an action that ran is told so, never run again. */
const spent = new Map<string, Gone[]>();
/** Ids a newer grant on the same slot replaced: "the owner opened a newer one". */
const replaced = new Map<string, Gone[]>();
const spentListeners = new Set<(requestId: string) => void>();

const slotOf = (projectRoot: string, key: string, action: AppAction) => `${projectRoot}\0${key}\0${action}`;

function sameId(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf-8');
  const y = Buffer.from(b, 'utf-8');
  return x.length === y.length && timingSafeEqual(x, y);
}

function remember(map: Map<string, Gone[]>, slot: string, g: Gone, now: number): void {
  const list = (map.get(slot) ?? []).filter((x) => x.until > now);
  list.push(g);
  map.set(slot, list.slice(-8));
}

function sweep(now: number): void {
  for (const [k, g] of grants) if (g.expiresAt <= now && !g.busy) grants.delete(k);
  for (const map of [spent, replaced]) for (const [k, list] of map) { const live = list.filter((x) => x.until > now); if (live.length) map.set(k, live); else map.delete(k); }
}

/** A grant spent by a bound request: the request module marks its request used. */
export function onAppGrantSpent(fn: (requestId: string) => void): () => void {
  spentListeners.add(fn);
  return () => { spentListeners.delete(fn); };
}

export interface MintInput {
  projectRoot: string;
  key: string;
  action: AppAction;
  plan: ActionPlan | null;
  visibility?: GrantVisibility;
  requestId?: string | null;
  now?: number;
}

/** A new grant on this slot; an earlier one is replaced, unless an action on it is running (null). */
export function mintAppGrant(input: MintInput): { id: string; expiresAt: number; visibility: GrantVisibility } | null {
  const now = input.now ?? Date.now();
  sweep(now);
  const slot = slotOf(input.projectRoot, input.key, input.action);
  const old = grants.get(slot);
  if (old?.busy) return null;
  if (old) remember(replaced, slot, { id: old.id, until: old.expiresAt + APP_GRANT_TTL_MS, fullName: null, at: new Date(now).toISOString() }, now);
  const g: Grant = {
    id: randomBytes(18).toString('base64url'),
    expiresAt: now + APP_GRANT_TTL_MS,
    plan: input.plan,
    visibility: input.visibility ?? 'private',
    requestId: input.requestId ?? null,
  };
  grants.set(slot, g);
  return { id: g.id, expiresAt: g.expiresAt, visibility: g.visibility };
}

/** True when `id` is the live grant of this slot. Constant time on the id. */
export function checkAppGrant(projectRoot: string, key: string, action: AppAction, id: unknown, now = Date.now()): boolean {
  if (typeof id !== 'string' || !id) return false;
  const g = grants.get(slotOf(projectRoot, key, action));
  return !!g && sameId(id, g.id) && g.expiresAt > now;
}

export type TakeResult =
  | { ok: true; plan: ActionPlan | null; visibility: GrantVisibility; requestId: string | null; done: (sent: boolean, fullName?: string | null) => void }
  | { ok: false; why: AppGrantRefusal; fullName?: string | null; at?: string };

/**
 * Hold this slot's live grant for one action. Refused: `used` (it already ran: never ask again),
 * `replaced` (the owner opened a newer one), `unknown` (made up, for another app or action, or the
 * app restarted), `expired`, `running` (an action on it still runs: two never ride one grant).
 */
export function takeAppGrant(input: { projectRoot: string; key: string; action: AppAction; id: unknown; now?: number }): TakeResult {
  const now = input.now ?? Date.now();
  const slot = slotOf(input.projectRoot, input.key, input.action);
  const g = grants.get(slot);
  const id = input.id;
  if (typeof id !== 'string' || !id) return { ok: false, why: 'unknown' };
  if (!g || !sameId(id, g.id)) {
    const s = (spent.get(slot) ?? []).find((x) => x.until > now && sameId(id, x.id));
    if (s) return { ok: false, why: 'used', fullName: s.fullName, at: s.at };
    const r = (replaced.get(slot) ?? []).find((x) => x.until > now && sameId(id, x.id));
    if (r) return { ok: false, why: 'replaced' };
    return { ok: false, why: 'unknown' };
  }
  if (g.busy) return { ok: false, why: 'running' };
  if (g.expiresAt <= now) { grants.delete(slot); return { ok: false, why: 'expired' }; }
  g.busy = true;
  return {
    ok: true,
    plan: g.plan,
    visibility: g.visibility,
    requestId: g.requestId,
    done: (sent: boolean, fullName: string | null = null) => {
      if (grants.get(slot) !== g) return;
      if (!sent) { g.busy = false; return; }
      grants.delete(slot);
      remember(spent, slot, { id: g.id, until: g.expiresAt + APP_GRANT_TTL_MS, fullName, at: new Date(now).toISOString() }, now);
      if (g.requestId) for (const fn of [...spentListeners]) { try { fn(g.requestId); } catch { /* a listener's failure is its own */ } }
    },
  };
}

/** Tests only. */
export function resetAppGrants(): void { grants.clear(); spent.clear(); replaced.clear(); }
