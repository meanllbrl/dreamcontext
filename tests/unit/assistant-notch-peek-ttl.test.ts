/**
 * The notch's peeks fold by themselves, each kind after its own time (owner, 2026-10-17). Only
 * a prompt in the chat the owner is FOCUSED on drops no peek; while he is in the app any other
 * prompt or finish is a glance (owner, 2026-10-18). Every turn of a chat is its own finish.
 */
import { describe, it, expect } from 'vitest';
import { PEEK_TTL_MS, noticeKey, offScreenAsks, peekTtlMs } from '../../dashboard/src/components/assistant/notchModel';

describe('peek TTLs (notchModel.ts)', () => {
  it('gives every peek that drops by itself a clock, prompts included', () => {
    expect(peekTtlMs({ kind: 'permission' })).toBe(PEEK_TTL_MS.permission);
    expect(peekTtlMs({ kind: 'question' })).toBe(PEEK_TTL_MS.question);
    expect(peekTtlMs({ kind: 'finished' })).toBe(PEEK_TTL_MS.handoff);
    expect(peekTtlMs({ kind: 'notice', notice: { kind: 'finished' } })).toBe(PEEK_TTL_MS.finished);
    expect(peekTtlMs({ kind: 'notice', notice: { kind: 'account' } })).toBe(PEEK_TTL_MS.account);
    expect(peekTtlMs({ kind: 'post' })).toBe(PEEK_TTL_MS.post);
    expect(peekTtlMs({ kind: 'started' })).toBe(PEEK_TTL_MS.started);
  });

  it('leaves the owner-driven and self-timed peeks without one', () => {
    expect(peekTtlMs({ kind: 'summary' })).toBeNull();
    expect(peekTtlMs({ kind: 'progress' })).toBeNull();
  });

  it('makes a prompt or a chat\'s finish a 5 s glance while the owner is in the app', () => {
    expect(PEEK_TTL_MS.inApp).toBe(5_000);
    expect(peekTtlMs({ kind: 'question' }, true)).toBe(PEEK_TTL_MS.inApp);
    expect(peekTtlMs({ kind: 'permission' }, true)).toBe(PEEK_TTL_MS.inApp);
    expect(peekTtlMs({ kind: 'notice', notice: { kind: 'finished' } }, true)).toBe(PEEK_TTL_MS.inApp);
    // Not on his screen even in the app: an account, a post, a start keep their own time.
    expect(peekTtlMs({ kind: 'notice', notice: { kind: 'account' } }, true)).toBe(PEEK_TTL_MS.account);
    expect(peekTtlMs({ kind: 'post' }, true)).toBe(PEEK_TTL_MS.post);
    expect(peekTtlMs({ kind: 'started' }, true)).toBe(PEEK_TTL_MS.started);
  });

  it('keeps a permission down longest and a start shortest', () => {
    const all = Object.values(PEEK_TTL_MS);
    expect(PEEK_TTL_MS.permission).toBe(Math.max(...all));
    expect(PEEK_TTL_MS.started).toBe(Math.min(...all));
  });
});

describe('prompts on screen (notchModel.ts)', () => {
  const ask = { id: 'a1', kind: 'question' as const, tool: '', text: 'Which one?' };
  const chats = [
    { sessionId: 's1', vault: 'acme', ask },
    { sessionId: 's2', vault: 'globex', ask },
    { sessionId: 's3', vault: 'initech', ask: null },
    { sessionId: 's4', vault: 'acme', ask },
  ];

  it('drops only the chat the owner is focused on, and every chat with no prompt', () => {
    // s4 is in the project in front too, but not the focused chat: it still peeks.
    expect(offScreenAsks(chats, 's1').map((c) => c.sessionId)).toEqual(['s2', 's4']);
  });

  it('keeps every prompt when no chat has his focus (another app, or the chat surface closed)', () => {
    expect(offScreenAsks(chats, null).map((c) => c.sessionId)).toEqual(['s1', 's2', 's4']);
  });
});

describe('each turn of a chat is its own finish (notchModel.ts noticeKey)', () => {
  const fin = (at: number) => ({ id: 'fin:s1', kind: 'finished' as const, at });

  it('keys a finish by its id AND its time, so a second turn is announced again', () => {
    expect(noticeKey(fin(1000))).not.toBe(noticeKey(fin(2000)));
    expect(noticeKey(fin(1000))).toBe(noticeKey(fin(1000)));
  });

  it('keys an account notice by its id alone: a merged limit + switch is one announcement', () => {
    expect(noticeKey({ id: 'acct:a:1', kind: 'account', at: 1000 })).toBe(noticeKey({ id: 'acct:a:1', kind: 'account', at: 5000 }));
  });
});
