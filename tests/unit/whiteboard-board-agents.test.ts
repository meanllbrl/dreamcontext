/**
 * The agent card is the agent's face on a board. The pure parts: which agent cards a board holds
 * (agentCards.ts) and the card's last lines (agentCardModel.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
});

const panel = await import('../../dashboard/src/components/whiteboard/agentCards.js');
const { lastLines, lineOpacity } = await import('../../dashboard/src/components/whiteboard/agentCardModel.js');


const card = (id: string, ref: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'embeddable', isDeleted: false, customData: { dc: { v: 1, kind: 'agent', ref, size: 'l' } }, ...extra,
});

beforeEach(() => store.clear());

describe('the agents on a board', () => {
  it('agentCardsOf reads live agent cards in scene order, skipping deleted, other kinds and bad refs', () => {
    const els = [
      card('c1', 'copy-desk'),
      card('c2', 'ops-desk', { isDeleted: true }),
      { id: 'n1', type: 'embeddable', customData: { dc: { v: 1, kind: 'note', ref: 'x' } } },
      card('c3', 'Not A Slug!'),
      card('c4', 'scout'),
      null,
    ];
    expect(panel.agentCardsOf(els)).toEqual([{ elementId: 'c1', agent: 'copy-desk' }, { elementId: 'c4', agent: 'scout' }]);
    expect(panel.agentCardsOf(undefined)).toEqual([]);
  });
});

describe("the card's last lines", () => {
  it('are the last said things, oldest first, never tools, thinking or a bare dragged token', () => {
    const items = [
      { kind: 'user', text: 'one' },
      { kind: 'text', text: 'two' },
      { kind: 'tool' },
      { kind: 'thinking', text: 'hidden' },
      { kind: 'user', text: 'dcref:wb/q3/abc' },
      { kind: 'user', text: 'look at dcref:wb/q3/abc please' },
      { kind: 'text', text: 'three' },
    ];
    expect(lastLines(items, 6)).toEqual([
      { who: 'you', text: 'one' },
      { who: 'agent', text: 'two' },
      { who: 'you', text: 'look at  please' },
      { who: 'agent', text: 'three' },
    ]);
    expect(lastLines(items, 2).map((l) => l.text)).toEqual(['look at  please', 'three']);
    expect(lastLines([], 6)).toEqual([]);
  });

  it('fade with age: the newest full, never below a third', () => {
    expect(lineOpacity(5, 6)).toBe(1);
    expect(lineOpacity(4, 6)).toBeLessThan(1);
    expect(lineOpacity(0, 6)).toBeGreaterThanOrEqual(0.35);
    expect(lineOpacity(0, 40)).toBe(0.35);
  });
});
