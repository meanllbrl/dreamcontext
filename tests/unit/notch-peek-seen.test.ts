/**
 * Owner, 2026-11-13: "seen yerine çarpıya da basıldığında seen olarak algılanmalı ki tekrar
 * tekrar aynı bildirim çıkmasın".
 *
 * Root cause: the peek's × only folded the peek and hid its row in the notch's memory for 30 s;
 * nothing was written. The post stayed unread (its thread watermark never moved) and the notice
 * stayed in the server's inbox, so the row came back on the next poll after the 30 s, and after
 * every reload or restart. Now × runs `markPeekSeen`, the same write as "Seen" / "Dismiss".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { markPeekSeen } = await import('../../dashboard/src/components/assistant/NotchPeek');

describe('× on a peek = seen (markPeekSeen)', () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      return new Response('{"ok":true}', { status: 200 });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('a post advances its thread\'s read watermark, exactly like "Seen"', () => {
    markPeekSeen({ kind: 'post', post: { key: 'acme::digest::r1', vault: 'acme', slug: 'digest', title: 'Digest', hasPhoto: false, runId: 'r1', at: '', status: 'ok', textFrom: 'error', text: 'x', needsYou: false, newestId: 'e9' } });
    expect(calls).toEqual([{ url: '/api/assistant/inbox/seen', body: { vault: 'acme', slug: 'digest', upToId: 'e9' } }]);
  });

  it('a notice leaves the server\'s inbox, exactly like "Dismiss"', () => {
    markPeekSeen({ kind: 'notice', notice: { id: 'fin:s-1', kind: 'finished', at: 1, sessionId: 's-1', vault: 'acme', mode: 'develop', title: '', lastText: '' } });
    expect(calls).toEqual([{ url: '/api/assistant/inbox/dismiss', body: { id: 'fin:s-1' } }]);
  });

  it('a closed hand-off is cleared; a waiting prompt writes nothing (it stays under "Now")', () => {
    const handoff = { sessionId: 's-2', vault: 'acme', activity: 'gone' as const, startedAt: 0, endedAt: 1, brief: '', lastText: '', ask: null };
    markPeekSeen({ kind: 'finished', handoff });
    expect(calls.map((c) => c.url)).toEqual(['/api/assistant/delegations/dismiss']);
    calls.length = 0;
    markPeekSeen({ kind: 'question', chat: { sessionId: 's-3', vault: 'acme', ask: { id: 'q', kind: 'question', tool: '', text: '?' } } });
    expect(calls).toEqual([]);
  });
});
