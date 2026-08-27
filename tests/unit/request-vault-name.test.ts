/**
 * Unit tests for `requestedVaultName` — which vault a request is ASKING for, before the
 * registry is consulted.
 *
 * This exists because of a whole class of request that cannot send a header: a subresource
 * the BROWSER fetches. `<img src>`, `<video src>` and `<audio src>` carry no custom headers,
 * so in launcher mode (nothing pinned server-side) every inline picture and every clip in
 * Chat answered 400 `no_vault` — the file was right there, the request just had no way to
 * say which project it belonged to (owner report 07-25: "inline göstermesi gerekiyordu,
 * göstermedi"). A `?vault=` query param on GET closes that gap.
 *
 * The GET-only restriction is the security half and is pinned here: a query param rides
 * along on any cross-site navigation or form post, so a mutating request must never be able
 * to pick its own vault that way.
 */
import { describe, it, expect } from 'vitest';
import { requestedVaultName } from '../../src/server/index.js';

/** The three fields the function reads, nothing more — it is typed structurally so this
 *  needs no real IncomingMessage. */
function req(
  over: { headers?: Record<string, string | string[] | undefined>; method?: string; url?: string } = {},
) {
  return { headers: {}, method: 'GET', url: '/api/agent/file?path=x&raw=1', ...over } as any;
}

describe('requestedVaultName', () => {
  it('reads the header when one is present', () => {
    expect(requestedVaultName(req({ headers: { 'x-dreamcontext-vault': 'acme-design' } })))
      .toBe('acme-design');
  });

  it('falls back to ?vault= on a GET — the media-element channel', () => {
    expect(requestedVaultName(req({
      url: '/api/agent/file?path=_dream_context%2Fexport%2Freel-sfx.mp4&raw=1&vault=acme-design',
    }))).toBe('acme-design');
  });

  it('prefers the header over the query when both are sent', () => {
    expect(requestedVaultName(req({
      headers: { 'x-dreamcontext-vault': 'from-header' },
      url: '/api/agent/file?path=x&vault=from-query',
    }))).toBe('from-header');
  });

  it('IGNORES ?vault= on a mutating request — a query param rides along on cross-site posts', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
      expect(requestedVaultName(req({ method, url: '/api/agent/reveal?vault=acme-design' })))
        .toBeNull();
    }
  });

  it('still honours the HEADER on a mutating request — that channel was never the risk', () => {
    expect(requestedVaultName(req({
      method: 'POST', headers: { 'x-dreamcontext-vault': 'dreamcontext' }, url: '/api/agent/reveal',
    }))).toBe('dreamcontext');
  });

  it('answers null when neither channel names a vault', () => {
    expect(requestedVaultName(req())).toBeNull();
    expect(requestedVaultName(req({ url: '/api/agent/file?path=x&vault=' }))).toBeNull();
    expect(requestedVaultName(req({ headers: { 'x-dreamcontext-vault': '' } }))).toBeNull();
  });

  it('treats a repeated (array) header as absent rather than guessing which one is meant', () => {
    expect(requestedVaultName(req({ headers: { 'x-dreamcontext-vault': ['a', 'b'] } }))).toBeNull();
  });

  it('survives a malformed url without throwing', () => {
    expect(requestedVaultName(req({ url: '' }))).toBeNull();
    expect(requestedVaultName(req({ url: '%' }))).toBeNull();
  });

  it('does not resolve the name — a path-shaped value is returned verbatim for the strict '
    + 'resolver to reject, never treated as a location', () => {
    expect(requestedVaultName(req({ url: '/api/agent/file?vault=../../etc' }))).toBe('../../etc');
  });
});
