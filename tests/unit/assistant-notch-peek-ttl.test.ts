/**
 * The notch's peeks fold by themselves, each kind after its own time, and a prompt asked in
 * the project the owner is looking at drops no peek (owner, 2026-10-17).
 */
import { describe, it, expect } from 'vitest';
import { PEEK_TTL_MS, offScreenAsks, peekTtlMs } from '../../dashboard/src/components/assistant/notchModel';

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
  ];

  it('drops the project in front of the owner and every chat with no prompt', () => {
    expect(offScreenAsks(chats, 'acme').map((c) => c.sessionId)).toEqual(['s2']);
  });

  it('keeps every prompt when the owner is in another app', () => {
    expect(offScreenAsks(chats, null).map((c) => c.sessionId)).toEqual(['s1', 's2']);
  });
});
