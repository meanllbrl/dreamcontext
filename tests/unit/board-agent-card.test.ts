/**
 * The board's agent card: its status word and S line (`agentCardModel`), the card's own chat
 * session (`boardAgentScratch.openCardSession`: a conversation of the board's, never the
 * automation's thread, remembered per card on this machine), and the per-card composer buckets
 * that die with the board page.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { agentCardState, lastSaid, oneLine } from '../../dashboard/src/components/whiteboard/agentCardModel.js';
import {
  __resetScratchForTests, addAttachments, nextAttachmentId, readScratch,
} from '../../dashboard/src/components/sleepy/chat/composerScratch.js';

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

/** Every createChatSession call, with the fake session it returned. */
const spawned: Array<{ args: unknown[]; session: { claudeId: string; scratchId?: string; dispose: ReturnType<typeof vi.fn> } }> = [];
vi.mock('../../dashboard/src/components/sleepy/chatSession.js', () => ({
  createChatSession: (...args: unknown[]) => {
    const session = { claudeId: args[3] as string, dispose: vi.fn() };
    spawned.push({ args, session });
    return session;
  },
}));

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
});

const {
  boardAgentScratchId, dropBoardAgentScratch, openCardSession, peekCardSession, subscribeCardSession,
  cardHasConversation, cardConversationKey,
} = await import('../../dashboard/src/components/whiteboard/boardAgentScratch.js');

describe('agentCardState', () => {
  it('not approved outranks everything; needs-you outranks working; else idle', () => {
    expect(agentCardState({ approved: false, busy: true, asking: true })).toEqual({ kind: 'unapproved' });
    expect(agentCardState({ approved: true, busy: true, asking: true })).toEqual({ kind: 'needs-you' });
    expect(agentCardState({ approved: true, busy: true, asking: false })).toEqual({ kind: 'working' });
    expect(agentCardState({ approved: true, busy: false, asking: false })).toEqual({ kind: 'idle' });
  });
});

describe('the S line', () => {
  it('is the newest user or agent text, skipping tools, thinking and empty text', () => {
    expect(lastSaid([])).toBeNull();
    expect(lastSaid([
      { kind: 'user', text: 'What is on the board?' },
      { kind: 'text', text: 'Three notes and a funnel.' },
      { kind: 'tool' },
      { kind: 'thinking', text: 'hmm' },
      { kind: 'text', text: '   ' },
    ])).toEqual({ who: 'agent', text: 'Three notes and a funnel.' });
    expect(lastSaid([{ kind: 'text', text: 'Hi' }, { kind: 'user', text: 'Hello' }])).toEqual({ who: 'you', text: 'Hello' });
  });

  it('drops a dragged element token, and a message that is only a token is skipped', () => {
    expect(lastSaid([
      { kind: 'text', text: 'Earlier answer' },
      { kind: 'user', text: 'dcref:wb/q3-plan/n1' },
    ])).toEqual({ who: 'agent', text: 'Earlier answer' });
    expect(lastSaid([{ kind: 'user', text: 'Explain this dcref:wb/q3-plan/n1' }])).toEqual({ who: 'you', text: 'Explain this' });
  });

  it('flattens and caps one line', () => {
    expect(oneLine('a\n\n b   c')).toBe('a b c');
    expect(oneLine('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe("the card's own session", () => {
  const card = { vault: 'acme', board: 'q3-plan', elementId: 'card-1' };
  const open = (how?: 'continue' | 'new' | 'resume') =>
    openCardSession({ ...card, agent: 'growth-helper', model: 'sonnet', effort: 'medium' }, how);

  beforeEach(() => {
    dropBoardAgentScratch();
    spawned.length = 0;
    store.clear();
  });

  it('first open starts a conversation as the card: card param, basic mode, remembered id, card bucket', () => {
    expect(peekCardSession(card)).toBeNull();
    expect(cardHasConversation(card)).toBe(false);
    const s = open();
    expect(spawned).toHaveLength(1);
    const args = spawned[0].args;
    expect(args[0]).toBe('acme');
    expect(args[1]).toBe(false); // never bypass from the card; the server decides the envelope
    expect(args[4]).toBe(false); // a new conversation, not a resume
    expect(args[10]).toBe('basic');
    expect(args[13]).toEqual({ agent: 'growth-helper', board: 'q3-plan' });
    expect(store.get(cardConversationKey(card))).toBe(s.claudeId);
    expect(s.scratchId).toBe(boardAgentScratchId('q3-plan', 'card-1'));
    expect(peekCardSession(card)).toBe(s);
    expect(cardHasConversation(card)).toBe(true);
  });

  it('continue keeps the live session; after the page drops it, the remembered one is resumed', () => {
    const s = open();
    expect(open()).toBe(s);
    expect(spawned).toHaveLength(1);

    dropBoardAgentScratch();
    expect(s.dispose).toHaveBeenCalledTimes(1);
    expect(peekCardSession(card)).toBeNull();

    const again = open();
    expect(again.claudeId).toBe(s.claudeId);
    expect(spawned[1].args[4]).toBe(true); // resume
  });

  it('new conversation ends the live one and starts a fresh, remembered id', () => {
    const s = open();
    const fresh = open('new');
    expect(s.dispose).toHaveBeenCalledTimes(1);
    expect(fresh.claudeId).not.toBe(s.claudeId);
    expect(spawned[1].args[4]).toBe(false);
    expect(store.get(cardConversationKey(card))).toBe(fresh.claudeId);
  });

  it('resume respawns the same conversation', () => {
    const s = open();
    const back = open('resume');
    expect(s.dispose).toHaveBeenCalledTimes(1);
    expect(back.claudeId).toBe(s.claudeId);
    expect(spawned[1].args[4]).toBe(true);
  });

  it('two cards are two conversations; listeners hear their own card only', () => {
    const other = { ...card, elementId: 'card-2' };
    const heard: string[] = [];
    subscribeCardSession(card, () => heard.push('one'));
    subscribeCardSession(other, () => heard.push('two'));
    const a = open();
    const b = openCardSession({ ...other, agent: 'growth-helper', model: '', effort: '' });
    expect(a.claudeId).not.toBe(b.claudeId);
    expect(heard).toEqual(['one', 'two']);
  });
});

describe('per-card composer buckets', () => {
  beforeEach(() => {
    __resetScratchForTests();
    dropBoardAgentScratch();
  });

  const chip = (path: string) => ({ id: nextAttachmentId(), kind: 'ref' as const, name: 'Note · Plan', path });

  it('are named wb-agent:<board>:<element id>, one per card', () => {
    expect(boardAgentScratchId('q3-plan', 'card-1')).toBe('wb-agent:q3-plan:card-1');
    expect(boardAgentScratchId('q3-plan', 'card-2')).not.toBe(boardAgentScratchId('q3-plan', 'card-1'));
  });

  it('dropBoardAgentScratch releases every card bucket and nothing else', () => {
    const a = boardAgentScratchId('q3-plan', 'card-1');
    const b = boardAgentScratchId('growth', 'card-9');
    addAttachments(a, [chip('dcref:wb/q3-plan/n1')]);
    addAttachments(b, [chip('dcref:wb/growth/n2')]);
    addAttachments('agents-channel', [chip('dcref:wb/q3-plan/n3')]);
    expect(readScratch(a).attachments).toHaveLength(1);

    dropBoardAgentScratch();
    expect(readScratch(a).attachments).toHaveLength(0);
    expect(readScratch(b).attachments).toHaveLength(0);
    expect(readScratch('agents-channel').attachments).toHaveLength(1);
    // Idempotent.
    expect(() => dropBoardAgentScratch()).not.toThrow();
  });
});
