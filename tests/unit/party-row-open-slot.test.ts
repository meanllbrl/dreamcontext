import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * A party row's "open →" replaces its status mark on hover. It used to be absolutely placed
 * over a 16px mark slot, so the ~50px label landed on the row's meta ("5 tools"). The fix puts
 * both in one grid cell sized to the wider of the two. The rendered overlap itself is measured
 * by scripts/verify/chat-quest.mjs; this pins the structure that makes it impossible.
 */
const CSS = readFileSync('dashboard/src/components/sleepy/chat/cards.css', 'utf-8');
const TSX = readFileSync('dashboard/src/components/sleepy/chat/SubAgentCard.tsx', 'utf-8');

const rule = (selector: string): string => {
  const at = CSS.indexOf(`\n${selector} {`);
  expect(at, `${selector} rule`).toBeGreaterThan(-1);
  return CSS.slice(at, CSS.indexOf('}', at));
};

describe('party row: "open →" shares the status mark slot', () => {
  it('is laid out in flow, not absolutely over the meta', () => {
    expect(rule('.chat-subagents-row-open')).not.toMatch(/position:\s*absolute/);
  });

  it('sits in one grid cell with the mark', () => {
    expect(rule('.chat-subagents-row-end')).toMatch(/display:\s*grid/);
    expect(CSS).toMatch(/\.chat-subagents-row-end > \* \{ grid-area: 1 \/ 1; \}/);
    const end = TSX.indexOf('className="chat-subagents-row-end"');
    expect(end).toBeGreaterThan(-1);
    const mark = TSX.indexOf('className="chat-subagents-row-mark"', end);
    const open = TSX.indexOf('className="chat-subagents-row-open"', end);
    const close = TSX.indexOf('</span>\n              </span>', open);
    expect(mark).toBeGreaterThan(end);
    expect(open).toBeGreaterThan(mark);
    expect(close).toBeGreaterThan(open);
  });
});
