/**
 * Unit tests for `revealPath` — the chat surface's single door to `POST /api/agent/reveal`.
 *
 * The load-bearing behavior is that it REPORTS. Four call sites draw an "Open ↗" / "Reveal
 * in Finder" button on top of this, and every one of them used to `.catch(() => {})` the
 * route's refusal — so a click on a file the route would never open did nothing at all, with
 * no way to tell "opened behind the window" from "this was never reachable" (owner report
 * 07-28: an answer wrote `![…](../../tmp/…/automations-light.png)`, a relative path that
 * escapes the project root, and the card's only affordance was a silent no-op).
 *
 * `fetch` is stubbed, so no server and no OS opener are involved.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { revealPath } from '../../dashboard/src/components/sleepy/chat/chatEntities.js';

const realFetch = globalThis.fetch;

/** A stubbed `fetch` answering one status + JSON body, recording what it was called with. */
function stubFetch(status: number, body: Record<string, unknown>): { calls: Array<[string, RequestInit]> } {
  const calls: Array<[string, RequestInit]> = [];
  globalThis.fetch = vi.fn(async (url: unknown, init: unknown) => {
    calls.push([String(url), (init ?? {}) as RequestInit]);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
  return { calls };
}

afterEach(() => { globalThis.fetch = realFetch; });

describe('revealPath', () => {
  it('resolves null when the OS took the path — nothing for the caller to say', async () => {
    stubFetch(200, { opened: true });
    await expect(revealPath('_dream_context/tmp/shot.png')).resolves.toBeNull();
  });

  it('POSTs the path verbatim to the reveal route, letting the route decide by default', async () => {
    const { calls } = stubFetch(200, { opened: true });
    await revealPath('_dream_context/tmp/shot.png');
    const [url, init] = calls[0];
    expect(url).toContain('/api/agent/reveal');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ path: '_dream_context/tmp/shot.png', mode: 'auto' });
  });

  // "Open on computer" and "Reveal in Finder" are two buttons because they are two things a
  // person wants; without the mode both would hit the same heuristic and a picture could
  // never be SHOWN in the file manager, only opened.
  it('asks for the file manager outright when told to', async () => {
    const { calls } = stubFetch(200, { opened: true, mode: 'reveal' });
    await expect(revealPath('_dream_context/tmp/shot.png', 'reveal')).resolves.toBeNull();
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ path: '_dream_context/tmp/shot.png', mode: 'reveal' });
  });

  // The route downgrades an executable to a reveal whatever the caller asked for. That IS the
  // click working — the file manager comes forward with the file selected — so it must not be
  // reported as a failure, or `handleAction`'s reveal case would open a panel on top of it.
  it('treats the executable downgrade as success, not something to report', async () => {
    stubFetch(200, { opened: true, mode: 'reveal' });
    await expect(revealPath('/tmp/install.sh')).resolves.toBeNull();
  });

  // The words are the UI's, not the route's. "Path escapes the project root" is a correct
  // answer to the wrong audience — nobody reading a chat bubble asked about project roots —
  // and matching on the English of `message` would be a UI that breaks when a route rewords
  // itself, so the `error` slug is what these map from.
  it('says a missing file is missing, in words meant for a person', async () => {
    stubFetch(404, { error: 'not_found', message: 'Not found: /tmp/gone.png' });
    const said = await revealPath('/tmp/gone.png');
    expect(said).toBe('this file isn’t there any more');
    expect(said).not.toContain('/tmp/gone.png');
  });

  it('says the desktop gate plainly instead of looking like a no-op in the browser', async () => {
    stubFetch(403, { error: 'desktop_only', message: 'Available only in the desktop app.' });
    await expect(revealPath('/tmp/shot.png')).resolves.toBe('only available in the desktop app');
  });

  it('still says SOMETHING when the request never lands (server down, offline)', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error(''); }) as unknown as typeof fetch;
    await expect(revealPath('/tmp/shot.png')).resolves.toBe('couldn’t open this one');
  });

  it('never leaks a raw route message, whatever the failure was', async () => {
    stubFetch(500, { error: 'open_failed', message: 'The system opener could not be started.' });
    await expect(revealPath('/tmp/shot.png')).resolves.toBe('couldn’t open this one');
  });

  // A rejection here would take down whatever drew the button; the contract is that it
  // ALWAYS resolves, and the string is the thing to show.
  it('never rejects, whatever the route did', async () => {
    for (const status of [200, 400, 403, 404, 500]) {
      stubFetch(status, { message: 'nope' });
      await expect(revealPath('/tmp/x.png')).resolves.not.toThrow();
    }
  });

  // The everyday outcome after the resolver fix: the reference the owner reported now names
  // a real file, the route opens it, and there is nothing to say.
  it('says nothing at all for the reference from the 07-28 report', async () => {
    stubFetch(200, { opened: true });
    await expect(revealPath('../../tmp/dc-verify-auto/automations-light.png')).resolves.toBeNull();
  });
});
