import { describe, it, expect, beforeEach } from 'vitest';
import { PUBLISH_GRANT_TTL_MS, checkPublishGrant, mintPublishGrant, resetPublishGrants, takePublishGrant } from '../../src/lib/apps/share/publish-grant.js';

/**
 * The owner's click opens one grant for one app for one hour (owner 2026-11-06, yayinla-claude),
 * carrying the visibility he clicked. Claude's push spends it; nothing else opens the push to an agent.
 */
describe('publish grant', () => {
  beforeEach(() => resetPublishGrants());
  const take = (root: string, slug: string, id: unknown, now?: number) => takePublishGrant(root, slug, id, now);

  it('is for that app of that project only', () => {
    const g = mintPublishGrant('/p/one', 'hava')!;
    expect(checkPublishGrant('/p/one', 'hava', g.id)).toBe(true);
    expect(checkPublishGrant('/p/one', 'sayac', g.id)).toBe(false);
    expect(checkPublishGrant('/p/two', 'hava', g.id)).toBe(false);
    expect(checkPublishGrant('/p/one', 'hava', g.id.slice(1))).toBe(false);
    expect(take('/p/one', 'hava', undefined)).toEqual({ ok: false, why: 'unknown' });
    expect(take('/p/one', 'sayac', g.id)).toEqual({ ok: false, why: 'unknown' });
  });

  it('carries the visibility the owner clicked; private is the default', () => {
    expect(mintPublishGrant('/p', 'a')!.visibility).toBe('private');
    const pub = mintPublishGrant('/p', 'b', 'public')!;
    const t = take('/p', 'b', pub.id);
    expect(t.ok && t.visibility).toBe('public');
  });

  it('lasts one hour, and says so when it ran out', () => {
    const g = mintPublishGrant('/p', 'hava', 'private', 1_000)!;
    expect(checkPublishGrant('/p', 'hava', g.id, 1_000 + PUBLISH_GRANT_TTL_MS - 1)).toBe(true);
    expect(checkPublishGrant('/p', 'hava', g.id, 1_000 + PUBLISH_GRANT_TTL_MS)).toBe(false);
    expect(take('/p', 'hava', g.id, 1_000 + PUBLISH_GRANT_TTL_MS + 5)).toEqual({ ok: false, why: 'expired' });
  });

  it('a new click replaces the old grant, but never one a publish is running on', () => {
    const a = mintPublishGrant('/p', 'hava')!;
    const b = mintPublishGrant('/p', 'hava')!;
    expect(take('/p', 'hava', a.id)).toEqual({ ok: false, why: 'unknown' });
    const held = take('/p', 'hava', b.id);
    expect(held.ok).toBe(true);
    expect(mintPublishGrant('/p', 'hava')).toBeNull();
    expect(take('/p', 'hava', b.id)).toEqual({ ok: false, why: 'running' });
  });

  it('a sent publish spends it; a stopped one frees it for a retry', () => {
    const g = mintPublishGrant('/p', 'hava')!;
    const first = take('/p', 'hava', g.id);
    if (!first.ok) throw new Error('not taken');
    first.done(false);
    const second = take('/p', 'hava', g.id);
    if (!second.ok) throw new Error('not taken again');
    second.done(true);
    second.done(false); // a failure after the push never frees it again
    expect(checkPublishGrant('/p', 'hava', g.id)).toBe(false);
    expect(take('/p', 'hava', g.id)).toEqual({ ok: false, why: 'unknown' });
  });
});
