/**
 * The one-time publish grant (owner 2026-11-06, yayinla-claude). The owner's click on the app's
 * own page hands the publish to Claude; that click is the owner's decision, so it opens ONE grant
 * on this server, for that app only, for an hour. `dreamcontext apps publish <slug> --go --grant
 * <id>` spends it. Without a live grant for that app, an agent's push is refused as before
 * (`owner_page_only`). The grant never lowers the gate: `publishApp` runs it the same way.
 *
 * The grant carries the visibility the owner clicked: Share opens a private one, "Share publicly"
 * a public one. Going public is for good, so Claude can never turn a private click into it.
 *
 * Held in memory only: a restart of the app drops every grant (the owner clicks again), and no
 * file an agent can write can make one.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

export const PUBLISH_GRANT_TTL_MS = 60 * 60 * 1000;

export type GrantVisibility = 'private' | 'public';

interface Grant { id: string; expiresAt: number; visibility: GrantVisibility; busy?: boolean }

const grants = new Map<string, Grant>();
/** Spent grants, kept for their hour: a retry of a publish that went out is told so, never sent for a new click. */
const spent = new Map<string, { id: string; until: number; fullName: string | null; at: string }>();

const keyOf = (projectRoot: string, slug: string) => `${projectRoot}\0${slug}`;

/** A new grant for this app; an earlier one is replaced, unless a publish is running on it (null). */
export function mintPublishGrant(projectRoot: string, slug: string, visibility: GrantVisibility = 'private', now = Date.now()): { id: string; expiresAt: number; visibility: GrantVisibility } | null {
  for (const [k, g] of grants) if (g.expiresAt <= now && !g.busy) grants.delete(k);
  if (grants.get(keyOf(projectRoot, slug))?.busy) return null;
  const g: Grant = { id: randomBytes(18).toString('base64url'), expiresAt: now + PUBLISH_GRANT_TTL_MS, visibility };
  grants.set(keyOf(projectRoot, slug), g);
  return { id: g.id, expiresAt: g.expiresAt, visibility };
}

function sameId(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf-8');
  const y = Buffer.from(b, 'utf-8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** True when `id` is this app's live grant. Constant time on the id. */
export function checkPublishGrant(projectRoot: string, slug: string, id: unknown, now = Date.now()): boolean {
  if (typeof id !== 'string' || !id) return false;
  const g = grants.get(keyOf(projectRoot, slug));
  if (!g || !sameId(id, g.id)) return false;
  return g.expiresAt > now;
}

export type GrantRefusal = 'unknown' | 'expired' | 'running' | 'used';

/**
 * Hold this app's live grant for one publish. Refused: `used` (it already published: never ask for
 * a new one), `unknown` (made up, replaced by a newer click, or the app restarted), `expired`, `running` (a publish on it is
 * still going: two pushes never ride one click). `done(true)` spends it, called the moment the push
 * went out; `done(false)` (the gate stopped it, the push failed) frees it for a retry within the hour.
 */
export function takePublishGrant(projectRoot: string, slug: string, id: unknown, now = Date.now()):
  { ok: true; visibility: GrantVisibility; done: (sent: boolean, fullName?: string | null) => void } | { ok: false; why: GrantRefusal; fullName?: string | null; at?: string } {
  const k = keyOf(projectRoot, slug);
  const g = grants.get(k);
  if (typeof id === 'string' && id && (!g || !sameId(id, g.id))) {
    const s = spent.get(k);
    if (s && s.until > now && sameId(id, s.id)) return { ok: false, why: 'used', fullName: s.fullName, at: s.at };
  }
  if (typeof id !== 'string' || !id || !g || !sameId(id, g.id)) return { ok: false, why: 'unknown' };
  if (g.busy) return { ok: false, why: 'running' };
  if (g.expiresAt <= now) { grants.delete(k); return { ok: false, why: 'expired' }; }
  g.busy = true;
  return {
    ok: true,
    visibility: g.visibility,
    done: (sent: boolean, fullName: string | null = null) => {
      if (grants.get(k) !== g) return;
      if (sent) { grants.delete(k); spent.set(k, { id: g.id, until: g.expiresAt + PUBLISH_GRANT_TTL_MS, fullName, at: new Date(now).toISOString() }); } else g.busy = false;
    },
  };
}

/** Tests only. */
export function resetPublishGrants(): void { grants.clear(); spent.clear(); }
