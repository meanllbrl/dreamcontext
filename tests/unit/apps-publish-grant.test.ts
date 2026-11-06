import { describe, it, expect, beforeEach } from 'vitest';
import { PUBLISH_GRANT_TTL_MS, checkPublishGrant, mintPublishGrant, resetPublishGrants, takePublishGrant } from '../../src/lib/apps/share/publish-grant.js';

/**
 * The owner's Publish click opens one grant for one app for one hour (owner 2026-11-06,
 * yayinla-claude). Claude's push spends it; nothing else opens the push to an agent.
 */
describe('publish grant', () => {
  beforeEach(() => resetPublishGrants());

  it('is for that app of that project only', () => {
    const g = mintPublishGrant('/p/one', 'hava');
    expect(checkPublishGrant('/p/one', 'hava', g.id)).toBe(true);
    expect(checkPublishGrant('/p/one', 'sayac', g.id)).toBe(false);
    expect(checkPublishGrant('/p/two', 'hava', g.id)).toBe(false);
    expect(checkPublishGrant('/p/one', 'hava', g.id.slice(1))).toBe(false);
    expect(checkPublishGrant('/p/one', 'hava', undefined)).toBe(false);
    expect(checkPublishGrant('/p/one', 'hava', '')).toBe(false);
  });

  it('lasts one hour', () => {
    const g = mintPublishGrant('/p', 'hava', 1_000);
    expect(checkPublishGrant('/p', 'hava', g.id, 1_000 + PUBLISH_GRANT_TTL_MS - 1)).toBe(true);
    expect(checkPublishGrant('/p', 'hava', g.id, 1_000 + PUBLISH_GRANT_TTL_MS)).toBe(false);
    expect(takePublishGrant('/p', 'hava', g.id, 1_000 + PUBLISH_GRANT_TTL_MS + 5)).toBeNull();
  });

  it('a new click replaces the old grant', () => {
    const a = mintPublishGrant('/p', 'hava');
    const b = mintPublishGrant('/p', 'hava');
    expect(checkPublishGrant('/p', 'hava', a.id)).toBe(false);
    expect(checkPublishGrant('/p', 'hava', b.id)).toBe(true);
  });

  it('a sent publish spends it; a stopped one frees it for a retry', () => {
    const g = mintPublishGrant('/p', 'hava');
    const first = takePublishGrant('/p', 'hava', g.id)!;
    expect(first).toBeTypeOf('function');
    // Two pushes never ride one click.
    expect(takePublishGrant('/p', 'hava', g.id)).toBeNull();
    first(false);
    const second = takePublishGrant('/p', 'hava', g.id)!;
    expect(second).toBeTypeOf('function');
    second(true);
    expect(checkPublishGrant('/p', 'hava', g.id)).toBe(false);
    expect(takePublishGrant('/p', 'hava', g.id)).toBeNull();
  });
});
