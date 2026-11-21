import { describe, expect, it } from 'vitest';
import { WINDOW_GONE_MS, mintWindowToken, sendSuperCommand, windowGone } from '../../src/lib/window-control.js';

/**
 * AC14 (owner 2026-11-21: after a relaunch one job had two sessions): a send that found no open
 * socket is not a closed window. The server starts a child itself only when the window has been
 * away past WINDOW_GONE_MS, or no window ever held the Super (a server start).
 */
describe('windowGone', () => {
  const mint = (away?: () => number) => mintWindowToken({ send: () => false, ...(away ? { windowAway: away } : {}) });

  it('a window that just dropped (reload, reconnect, relaunch restoring tabs) is not gone', async () => {
    const t = mint(() => 3_000);
    // The send finds no socket: the route reads no_window / sent:false ...
    const r = await sendSuperCommand(t.token, 'resume', { child: 'x' });
    expect(r).toMatchObject({ ok: false, error: 'no_window', sent: false });
    // ... and yet the window is coming back: the server must not start a twin.
    expect(windowGone(t.token)).toBe(false);
    t.release();
  });

  it('away past the limit, or never held by a window, is gone', () => {
    const long = mint(() => WINDOW_GONE_MS);
    const never = mint(() => Infinity);
    expect(windowGone(long.token)).toBe(true);
    expect(windowGone(never.token)).toBe(true);
    long.release(); never.release();
  });

  it('a holder that says nothing, a held socket and an unknown token are not gone', () => {
    const quiet = mint();
    const held = mint(() => 0);
    expect(windowGone(quiet.token)).toBe(false);
    expect(windowGone(held.token)).toBe(false);
    expect(windowGone('f'.repeat(48))).toBe(false);
    quiet.release(); held.release();
  });
});
