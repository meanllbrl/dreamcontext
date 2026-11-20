/** Telegram draws the `jobs` view from the bound Super's record its caller passes (plan super-v3 K7). */
import { describe, it, expect } from 'vitest';
import { viewLine } from '../../src/server/telegram/blocks.js';
import { hubDrawsFence } from '../../src/lib/telegram/format.js';

const now = Date.now();
const state = {
  children: {
    a: { sessionId: 'a', brief: 'Checkout <b>screen</b>', adopted: false, startedAt: now, row: 'working', rowAt: now },
    b: { sessionId: 'b', brief: 'Yearly plan price', adopted: false, startedAt: now, row: 'asking', rowAt: now - 1 },
  },
  queue: [{ id: 'q1', sessionId: 'b', kind: 'question', state: 'escalated', createdAt: now, ownerText: 'Which price?' }],
  team: [],
  containers: [],
} as never;

describe('the jobs line on Telegram', () => {
  it('the hub sends it as its own message', () => {
    expect(hubDrawsFence('dream-view', '{"type":"jobs"}')).toBe(true);
  });
  it('head and rows from the record, waiting first; nothing without a record', () => {
    const text = viewLine('{"type":"jobs"}', state)!;
    const lines = text.split('\n');
    expect(lines[0]).toBe('2 iş · 1 seni bekliyor · 1 sürüyor · 0 bitti');
    expect(lines[1]).toBe('✋ Yearly plan price: Which price?');
    expect(lines[2]).toBe('▸ Checkout <b>screen</b>');
    expect(viewLine('{"type":"jobs"}', null)).toBeNull();
  });
});
