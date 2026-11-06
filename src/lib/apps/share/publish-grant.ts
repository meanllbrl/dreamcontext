/**
 * The one-time publish grant (owner 2026-11-06, yayinla-claude). The owner's Publish click on the
 * app's own page hands the publish to Claude; that click is the owner's decision, so it opens ONE
 * grant on this server, for that app only, for an hour. `dreamcontext apps publish <slug> --go
 * --grant <id>` spends it. Without a live grant for that app, an agent's push is refused as before
 * (`owner_page_only`). The grant never lowers the gate: `publishApp` runs it the same way.
 *
 * Held in memory only: a restart of the app drops every grant (the owner clicks Publish again),
 * and no file an agent can write can make one.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

export const PUBLISH_GRANT_TTL_MS = 60 * 60 * 1000;

interface Grant { id: string; expiresAt: number; busy?: boolean }

const grants = new Map<string, Grant>();

const keyOf = (projectRoot: string, slug: string) => `${projectRoot}\0${slug}`;

/** A new grant for this app; any earlier one for it is replaced. */
export function mintPublishGrant(projectRoot: string, slug: string, now = Date.now()): Grant {
  for (const [k, g] of grants) if (g.expiresAt <= now) grants.delete(k);
  const g = { id: randomBytes(18).toString('base64url'), expiresAt: now + PUBLISH_GRANT_TTL_MS };
  grants.set(keyOf(projectRoot, slug), g);
  return { id: g.id, expiresAt: g.expiresAt };
}

/** True when `id` is this app's live grant. Constant time on the id. */
export function checkPublishGrant(projectRoot: string, slug: string, id: unknown, now = Date.now()): boolean {
  if (typeof id !== 'string' || !id) return false;
  const g = grants.get(keyOf(projectRoot, slug));
  if (!g) return false;
  if (g.expiresAt <= now) { grants.delete(keyOf(projectRoot, slug)); return false; }
  const a = Buffer.from(id, 'utf-8');
  const b = Buffer.from(g.id, 'utf-8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Hold this app's live grant for one publish: null when `id` is not it, or a publish on it is
 * already running (two pushes never ride one click). `done(true)` spends it; `done(false)` (the
 * gate stopped it, the push failed) frees it again, so Claude can fix the app and retry within
 * the hour.
 */
export function takePublishGrant(projectRoot: string, slug: string, id: unknown, now = Date.now()): ((sent: boolean) => void) | null {
  if (!checkPublishGrant(projectRoot, slug, id, now)) return null;
  const k = keyOf(projectRoot, slug);
  const g = grants.get(k)!;
  if (g.busy) return null;
  g.busy = true;
  return (sent: boolean) => {
    if (grants.get(k) !== g) return;
    if (sent) grants.delete(k); else g.busy = false;
  };
}

/** Tests only. */
export function resetPublishGrants(): void { grants.clear(); }
