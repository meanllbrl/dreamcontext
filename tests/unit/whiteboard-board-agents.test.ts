/**
 * Round 2 (owner, 2026-10-06): the panel knows every agent on the board, the card is the agent's
 * face. The pure parts: which agents are on a board (agentPanelState.ts), what the panel shows
 * while open, the drop target, and the card's last lines (agentCardModel.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AutomationSummary } from '../../dashboard/src/hooks/useAutomations.js';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
});

const panel = await import('../../dashboard/src/components/whiteboard/agentPanelState.js');
const { lastLines, lineOpacity } = await import('../../dashboard/src/components/whiteboard/agentCardModel.js');

const agent = (slug: string, title: string, whiteboard: string | null = null) =>
  ({ slug, title, whiteboard, approved: true, hasPhoto: false }) as unknown as AutomationSummary;

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

  it('boardAgentsOf is the home agents plus every agent with a card, by title, each once', () => {
    const all = [agent('ops', 'Ops Desk', 'q3'), agent('copy', 'Copy Desk'), agent('scout', 'Scout', 'other'), agent('idle', 'Idle')];
    const cards = [{ elementId: 'a', agent: 'scout' }, { elementId: 'b', agent: 'copy' }, { elementId: 'c', agent: 'copy' }, { elementId: 'd', agent: 'gone' }];
    expect(panel.boardAgentsOf(all, 'q3', cards).map((a) => a.slug)).toEqual(['copy', 'ops', 'scout']);
    // No cards: only the home agents (what the panel knew before round 2).
    expect(panel.boardAgentsOf(all, 'q3', []).map((a) => a.slug)).toEqual(['ops']);
    expect(panel.boardAgentsOf(undefined, 'q3', cards)).toEqual([]);
  });

  it('setBoardCards is heard only when the list really changes, per project and board', () => {
    // The snapshot's identity is what useSyncExternalStore compares: unchanged, it stays.
    panel.setBoardCards('acme', 'q3', [{ elementId: 'a', agent: 'copy' }]);
    const first = panel.boardCardsOf('acme', 'q3');
    panel.setBoardCards('acme', 'q3', [{ elementId: 'a', agent: 'copy' }]);
    expect(panel.boardCardsOf('acme', 'q3')).toBe(first);
    panel.setBoardCards('acme', 'q3', [{ elementId: 'a', agent: 'ops' }]);
    expect(panel.boardCardsOf('acme', 'q3')).not.toBe(first);
    expect(panel.boardCardsOf('globex', 'q3')).toEqual([]);
    expect(panel.boardCardsOf(null, 'q3')).toEqual([]);
  });

  it('panelAgentSlug is null while the panel is closed, else the picked agent, else the first', () => {
    const all = [agent('ops', 'Ops Desk', 'q4'), agent('copy', 'Copy Desk')];
    panel.setBoardCards('acme', 'q4', [{ elementId: 'a', agent: 'copy' }]);
    panel.setAgentPanelOpen('acme', false);
    expect(panel.panelAgentSlug('acme', 'q4', all)).toBeNull();
    panel.setAgentPanelOpen('acme', true);
    expect(panel.panelAgentSlug('acme', 'q4', all)).toBe('copy');
    panel.setPanelAgent('acme', 'q4', 'ops');
    expect(panel.panelAgentSlug('acme', 'q4', all)).toBe('ops');
    // A click on a card (or a drop on it) opens the panel on that agent.
    panel.setAgentPanelOpen('acme', false);
    panel.showAgentInPanel('acme', 'q4', 'copy');
    expect(panel.panelAgentSlug('acme', 'q4', all)).toBe('copy');
    panel.setAgentPanelOpen('acme', false);
  });

  it('pointOverPanel is false with no panel registered', () => {
    expect(panel.pointOverPanel('acme', 10, 10)).toBe(false);
    expect(panel.panelLandingOf('acme')).toBeNull();
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
