import { describe, it, expect, beforeEach } from 'vitest';
import { APP_GRANT_TTL_MS, checkAppGrant, mintAppGrant, onAppGrantSpent, resetAppGrants, takeAppGrant } from '../../src/lib/apps/share/app-grant.js';
import type { ActionPlan } from '../../src/lib/apps/share/app-request.js';

/**
 * One grant store for every app action (app-onay-karti C1): a slot is (project, app key, action).
 * The owner's Share click mints an unbound publish grant; his Onayla on a card mints one bound to
 * the card's plan. Neither reaches another app, another action or another project.
 */
const plan = (slug: string): ActionPlan => ({
  vault: 'v', projectRoot: '/p', key: slug, appName: 'X', title: 'Logoyu değiştir', lines: [],
  body: { action: 'logo', slug, sha256: 'a'.repeat(64), type: 'image/png' },
});

describe('app grant', () => {
  beforeEach(() => resetAppGrants());

  it('is for its project, app key and action only', () => {
    const g = mintAppGrant({ projectRoot: '/p', key: 'hava', action: 'logo', plan: plan('hava') })!;
    expect(checkAppGrant('/p', 'hava', 'logo', g.id)).toBe(true);
    for (const [root, key, action] of [['/p', 'sayac', 'logo'], ['/q', 'hava', 'logo'], ['/p', 'hava', 'publish'], ['/p', 'hava', 'update'], ['/p', 'hava', 'install']] as const) {
      expect(checkAppGrant(root, key, action, g.id)).toBe(false);
      expect(takeAppGrant({ projectRoot: root, key, action, id: g.id })).toEqual({ ok: false, why: 'unknown' });
    }
  });

  it('carries the plan it was minted for', () => {
    const g = mintAppGrant({ projectRoot: '/p', key: 'hava', action: 'logo', plan: plan('hava'), requestId: 'r1' })!;
    const t = takeAppGrant({ projectRoot: '/p', key: 'hava', action: 'logo', id: g.id });
    expect(t.ok && t.plan?.body.action).toBe('logo');
    expect(t.ok && t.requestId).toBe('r1');
  });

  it('an hour, then expired', () => {
    const g = mintAppGrant({ projectRoot: '/p', key: 'hava', action: 'update', plan: null, now: 1_000 })!;
    expect(checkAppGrant('/p', 'hava', 'update', g.id, 1_000 + APP_GRANT_TTL_MS - 1)).toBe(true);
    expect(takeAppGrant({ projectRoot: '/p', key: 'hava', action: 'update', id: g.id, now: 1_000 + APP_GRANT_TTL_MS + 1 })).toEqual({ ok: false, why: 'expired' });
  });

  it('a newer grant replaces the old (said so), never one that is running', () => {
    const a = mintAppGrant({ projectRoot: '/p', key: 'hava', action: 'logo', plan: plan('hava') })!;
    const b = mintAppGrant({ projectRoot: '/p', key: 'hava', action: 'logo', plan: plan('hava') })!;
    expect(takeAppGrant({ projectRoot: '/p', key: 'hava', action: 'logo', id: a.id })).toEqual({ ok: false, why: 'replaced' });
    const held = takeAppGrant({ projectRoot: '/p', key: 'hava', action: 'logo', id: b.id });
    expect(held.ok).toBe(true);
    expect(mintAppGrant({ projectRoot: '/p', key: 'hava', action: 'logo', plan: plan('hava') })).toBeNull();
    expect(takeAppGrant({ projectRoot: '/p', key: 'hava', action: 'logo', id: b.id })).toEqual({ ok: false, why: 'running' });
  });

  it('spent once: a retry is told it ran; a stop frees it; a bound spend tells the request', () => {
    const seen: string[] = [];
    const off = onAppGrantSpent((id) => seen.push(id));
    const g = mintAppGrant({ projectRoot: '/p', key: 'hava', action: 'logo', plan: plan('hava'), requestId: 'r9' })!;
    const first = takeAppGrant({ projectRoot: '/p', key: 'hava', action: 'logo', id: g.id });
    if (!first.ok) throw new Error('not taken');
    first.done(false);
    expect(seen).toEqual([]);
    const second = takeAppGrant({ projectRoot: '/p', key: 'hava', action: 'logo', id: g.id });
    if (!second.ok) throw new Error('not taken again');
    second.done(true);
    second.done(false);
    expect(seen).toEqual(['r9']);
    expect(takeAppGrant({ projectRoot: '/p', key: 'hava', action: 'logo', id: g.id })).toMatchObject({ ok: false, why: 'used' });
    off();
  });

  it('restart drops every grant (memory only)', () => {
    const g = mintAppGrant({ projectRoot: '/p', key: 'hava', action: 'publish', plan: null })!;
    resetAppGrants();
    expect(takeAppGrant({ projectRoot: '/p', key: 'hava', action: 'publish', id: g.id })).toEqual({ ok: false, why: 'unknown' });
  });
});
