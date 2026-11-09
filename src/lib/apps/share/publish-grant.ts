/**
 * The one-time publish grant of the owner's Share click (owner 2026-11-06, yayinla-claude): a thin
 * face on the app grant store (`app-grant.ts`, app-onay-karti plan r3 D2). The click opens ONE
 * unbound grant for that app, for an hour, carrying the visibility he clicked: Share private,
 * "Share publicly" public. Going public is for good, so Claude can never turn a private click into
 * it. `dreamcontext apps publish <slug> --go --grant <id>` spends it; without a live grant an
 * agent's push is refused (`owner_page_only`). The grant never lowers the gate.
 *
 * Memory only: a restart of the app drops every grant (the owner clicks again).
 */

import { APP_GRANT_TTL_MS, checkAppGrant, mintAppGrant, resetAppGrants, takeAppGrant, type GrantVisibility } from './app-grant.js';

export const PUBLISH_GRANT_TTL_MS = APP_GRANT_TTL_MS;
export type { GrantVisibility };
export type GrantRefusal = 'unknown' | 'expired' | 'running' | 'used';

/** A new grant for this app; an earlier one is replaced, unless a publish is running on it (null). */
export function mintPublishGrant(projectRoot: string, slug: string, visibility: GrantVisibility = 'private', now = Date.now()): { id: string; expiresAt: number; visibility: GrantVisibility } | null {
  return mintAppGrant({ projectRoot, key: slug, action: 'publish', plan: null, visibility, now });
}

/** True when `id` is this app's live publish grant. Constant time on the id. */
export function checkPublishGrant(projectRoot: string, slug: string, id: unknown, now = Date.now()): boolean {
  return checkAppGrant(projectRoot, slug, 'publish', id, now);
}

/**
 * Hold this app's live Share grant for one publish (see `takeAppGrant`). A grant from a request
 * card is not this function's: the publish route spends those through `takeAppGrant`.
 */
export function takePublishGrant(projectRoot: string, slug: string, id: unknown, now = Date.now()):
  { ok: true; visibility: GrantVisibility; done: (sent: boolean, fullName?: string | null) => void } | { ok: false; why: GrantRefusal; fullName?: string | null; at?: string } {
  const t = takeAppGrant({ projectRoot, key: slug, action: 'publish', id, now });
  if (!t.ok) return t.why === 'replaced' ? { ok: false, why: 'unknown' } : { ok: false, why: t.why, ...(t.fullName !== undefined ? { fullName: t.fullName } : {}), ...(t.at ? { at: t.at } : {}) };
  return { ok: true, visibility: t.visibility, done: t.done };
}

/** Tests only. */
export function resetPublishGrants(): void { resetAppGrants(); }
