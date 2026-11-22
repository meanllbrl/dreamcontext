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
const spawned: Array<{ args: unknown[]; session: { claudeId: string; scratchId?: string; dispose: ReturnType<typeof vi.fn>; busy: boolean; asking: boolean; emit: () => void } }> = [];
vi.mock('../../dashboard/src/components/sleepy/chatSession.js', () => ({
  createChatSession: (...args: unknown[]) => {
    const listeners = new Set<() => void>();
    const session = {
      claudeId: args[3] as string,
      dispose: vi.fn(),
      busy: false,
      asking: false,
      subscribe: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
      /** Test hook: the session says it changed (busy, asking). */
      emit: () => { for (const cb of [...listeners]) cb(); },
    };
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
  cardHasConversation, cardConversationKey, homeCardId, adoptHomeConversation,
  sweepHomeSessions, cardScratchId, adoptBoardCards, boardCardsAdopted, cardConversationId,
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
    expect(s.scratchId).toBe(boardAgentScratchId('acme', 'q3-plan', 'card-1'));
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

describe("a board's home conversations (the agent panel and the home agent's card)", () => {
  const board = { vault: 'acme', board: 'q3-plan' };
  const home = (agent: string) => ({ ...board, elementId: homeCardId(agent) });
  const openHome = (agent: string) => openCardSession({ ...home(agent), agent, model: '', effort: '' });

  beforeEach(() => {
    dropBoardAgentScratch();
    spawned.length = 0;
    store.clear();
  });

  it('are one per agent: two home agents on one board never share a session', () => {
    const a = openHome('growth-helper');
    const b = openHome('ops-desk');
    expect(a.claudeId).not.toBe(b.claudeId);
    expect(spawned[1].args[13]).toEqual({ agent: 'ops-desk', board: 'q3-plan' });
    expect(peekCardSession(home('growth-helper'))).toBe(a);
  });

  it('survive the page leaving with keepHome; every other card still ends', () => {
    const h = openHome('growth-helper');
    const card = openCardSession({ ...board, elementId: 'card-1', agent: 'other', model: '', effort: '' });
    const hb = boardAgentScratchId('acme', 'q3-plan', homeCardId('growth-helper'));
    const cb = boardAgentScratchId('acme', 'q3-plan', 'card-1');
    __resetScratchForTests();
    addAttachments(hb, [{ id: nextAttachmentId(), kind: 'ref', name: 'n', path: 'dcref:wb/q3-plan/n1' }]);
    addAttachments(cb, [{ id: nextAttachmentId(), kind: 'ref', name: 'n', path: 'dcref:wb/q3-plan/n2' }]);

    dropBoardAgentScratch({ keepHome: true });
    expect(h.dispose).not.toHaveBeenCalled();
    expect(peekCardSession(home('growth-helper'))).toBe(h);
    expect(readScratch(hb).attachments).toHaveLength(1);
    expect(card.dispose).toHaveBeenCalledTimes(1);
    expect(peekCardSession({ ...board, elementId: 'card-1' })).toBeNull();
    expect(readScratch(cb).attachments).toHaveLength(0);

    // Back on the page: the same live session, no new spawn.
    expect(openHome('growth-helper')).toBe(h);
    expect(spawned).toHaveLength(2);

    dropBoardAgentScratch();
    expect(h.dispose).toHaveBeenCalledTimes(1);
  });

  it('a project closing ends its own home sessions only', () => {
    const mine = openHome('growth-helper');
    const theirs = openCardSession({ vault: 'globex', board: 'q3-plan', elementId: homeCardId('growth-helper'), agent: 'growth-helper', model: '', effort: '' });
    dropBoardAgentScratch({ vault: 'acme' });
    expect(mine.dispose).toHaveBeenCalledTimes(1);
    expect(peekCardSession(home('growth-helper'))).toBeNull();
    expect(theirs.dispose).not.toHaveBeenCalled();
    // Leaving one project's page keeps the other project's cards too.
    const card = openCardSession({ vault: 'globex', board: 'q3-plan', elementId: 'card-1', agent: 'x', model: '', effort: '' });
    dropBoardAgentScratch({ vault: 'acme', keepHome: true });
    expect(card.dispose).not.toHaveBeenCalled();
  });

  it('the sweep keeps the wanted ones, ends idle others, and ends a busy one once it goes idle', async () => {
    const wanted = (b: string, agent: string) => b === 'q3-plan' && agent === 'growth-helper';
    const keep = openHome('growth-helper');
    const idle = openCardSession({ ...board, board: 'growth', elementId: homeCardId('scout'), agent: 'scout', model: '', effort: '' });
    const busy = openCardSession({ ...board, board: 'old', elementId: homeCardId('busy'), agent: 'busy', model: '', effort: '' }) as unknown as typeof spawned[number]['session'];
    busy.busy = true;
    const notHome = openCardSession({ ...board, elementId: 'card-1', agent: 'x', model: '', effort: '' });
    const heard: string[] = [];
    subscribeCardSession({ ...board, board: 'growth', elementId: homeCardId('scout') }, () => heard.push('scout'));

    sweepHomeSessions('acme', wanted);
    expect(keep.dispose).not.toHaveBeenCalled();
    expect(idle.dispose).toHaveBeenCalledTimes(1);
    expect(heard).toEqual(['scout']);
    expect(busy.dispose).not.toHaveBeenCalled();
    expect(notHome.dispose).not.toHaveBeenCalled();

    // No second sweep: the busy one ends by itself once its turn is over.
    busy.emit();
    await Promise.resolve();
    expect(busy.dispose).not.toHaveBeenCalled();
    busy.busy = false;
    busy.emit();
    await Promise.resolve();
    expect(busy.dispose).toHaveBeenCalledTimes(1);
    // Another project's sweep touches nothing here.
    sweepHomeSessions('globex', () => false);
    expect(keep.dispose).not.toHaveBeenCalled();
  });

  it('a busy one a newer sweep wants again is no longer ended', async () => {
    const s = openCardSession({ ...board, board: 'growth', elementId: homeCardId('scout'), agent: 'scout', model: '', effort: '' }) as unknown as typeof spawned[number]['session'];
    s.asking = true;
    sweepHomeSessions('acme', () => false);
    sweepHomeSessions('acme', (b) => b === 'growth');
    s.asking = false;
    s.emit();
    await Promise.resolve();
    expect(s.dispose).not.toHaveBeenCalled();
  });

  it('an ended conversation that a card still listens to is heard reopening (never a stuck Loading)', () => {
    const spec = { ...board, board: 'growth', elementId: homeCardId('scout') };
    let heard = 0;
    subscribeCardSession(spec, () => { heard += 1; });
    openCardSession({ ...spec, agent: 'scout', model: '', effort: '' });
    sweepHomeSessions('acme', () => false);
    expect(peekCardSession(spec)).toBeNull();
    const before = heard;
    const again = openCardSession({ ...spec, agent: 'scout', model: '', effort: '' });
    expect(heard).toBeGreaterThan(before);
    expect(peekCardSession(spec)).toBe(again);
  });

  it('the sweep also releases an unwanted home draft that never had a session', () => {
    __resetScratchForTests();
    const id = boardAgentScratchId('acme', 'old', homeCardId('ghost'));
    addAttachments(id, [{ id: nextAttachmentId(), kind: 'ref', name: 'n', path: 'dcref:wb/old/n1' }]);
    const keptId = boardAgentScratchId('acme', 'q3-plan', homeCardId('growth-helper'));
    addAttachments(keptId, [{ id: nextAttachmentId(), kind: 'ref', name: 'n', path: 'dcref:wb/q3-plan/n1' }]);
    sweepHomeSessions('acme', (b, agent) => b === 'q3-plan' && agent === 'growth-helper');
    expect(readScratch(id).attachments).toHaveLength(0);
    expect(readScratch(keptId).attachments).toHaveLength(1);
  });

  it("an element dropped for an agent goes to that agent's board conversation, the panel's composer", () => {
    expect(cardScratchId('acme', 'q3-plan', 'growth-helper')).toBe(boardAgentScratchId('acme', 'q3-plan', homeCardId('growth-helper')));
    // Another agent, another project's board of the same name: other buckets.
    expect(cardScratchId('acme', 'q3-plan', 'ops-desk')).not.toBe(cardScratchId('acme', 'q3-plan', 'growth-helper'));
    expect(cardScratchId('globex', 'q3-plan', 'growth-helper')).not.toBe(cardScratchId('acme', 'q3-plan', 'growth-helper'));
    // The bucket is the one the panel's session composes in.
    const s = openHome('growth-helper');
    expect(s.scratchId).toBe(cardScratchId('acme', 'q3-plan', 'growth-helper'));
  });

  it('the card reads the conversation it would continue, without opening one', () => {
    expect(cardConversationId(home('growth-helper'))).toBeNull();
    const s = openHome('growth-helper');
    expect(cardConversationId(home('growth-helper'))).toBe(s.claudeId);
    expect(spawned).toHaveLength(1);
  });

  it('a busy one that went idle is not ended if a sweep wanted it back before the tick', async () => {
    const s = openCardSession({ ...board, board: 'growth', elementId: homeCardId('scout'), agent: 'scout', model: '', effort: '' }) as unknown as typeof spawned[number]['session'];
    s.busy = true;
    let want = false;
    sweepHomeSessions('acme', () => want);
    s.busy = false;
    s.emit();
    want = true; // the owner opened that board again within the same tick
    await Promise.resolve();
    expect(s.dispose).not.toHaveBeenCalled();
  });

  it("a vault name holding | keeps its buckets apart from another project's", () => {
    expect(cardScratchId('a|b', 'c', 'growth-helper')).not.toBe(cardScratchId('a', 'b|c', 'growth-helper'));
  });

  it("the board's file hands its cards' older conversations to the home keys before the panel opens", () => {
    store.set(cardConversationKey({ ...board, elementId: 'card-1' }), 'old-conv');
    expect(boardCardsAdopted('acme', 'q3-plan')).toBe(false);
    adoptBoardCards('acme', 'q3-plan', [{ elementId: 'card-1', agent: 'growth-helper' }]);
    expect(boardCardsAdopted('acme', 'q3-plan')).toBe(true);
    expect(store.get(cardConversationKey(home('growth-helper')))).toBe('old-conv');
    // The panel then resumes it rather than starting afresh.
    const s = openHome('growth-helper');
    expect(s.claudeId).toBe('old-conv');
    expect(spawned[0].args[4]).toBe(true);
    // Another project's same-named board is not read yet; the page's drop forgets this one.
    expect(boardCardsAdopted('globex', 'q3-plan')).toBe(false);
    dropBoardAgentScratch({ vault: 'acme', keepHome: true });
    expect(boardCardsAdopted('acme', 'q3-plan')).toBe(false);
  });

  it("a card's older own conversation is adopted once, never over an existing home one", () => {
    const card = { ...board, elementId: 'card-1' };
    store.set(cardConversationKey(card), 'old-conv');
    adoptHomeConversation(card, 'growth-helper');
    expect(store.get(cardConversationKey(home('growth-helper')))).toBe('old-conv');

    store.set(cardConversationKey({ ...board, elementId: 'card-2' }), 'other-conv');
    adoptHomeConversation({ ...board, elementId: 'card-2' }, 'growth-helper');
    expect(store.get(cardConversationKey(home('growth-helper')))).toBe('old-conv');

    // The home card itself adopts nothing; another agent's home is its own.
    adoptHomeConversation(home('growth-helper'), 'ops-desk');
    expect(store.get(cardConversationKey(home('ops-desk')))).toBeUndefined();
  });
});

describe('per-card composer buckets', () => {
  beforeEach(() => {
    __resetScratchForTests();
    dropBoardAgentScratch();
  });

  const chip = (path: string) => ({ id: nextAttachmentId(), kind: 'ref' as const, name: 'Note · Plan', path });

  it('are named wb-agent:<vault>:<board>:<element id>, one per card and per project', () => {
    expect(boardAgentScratchId('acme', 'q3-plan', 'card-1')).toBe('wb-agent:acme:q3-plan:card-1');
    expect(boardAgentScratchId('acme', 'q3-plan', 'card-2')).not.toBe(boardAgentScratchId('acme', 'q3-plan', 'card-1'));
    expect(boardAgentScratchId('globex', 'q3-plan', 'card-1')).not.toBe(boardAgentScratchId('acme', 'q3-plan', 'card-1'));
    expect(boardAgentScratchId('my:proj', 'q3-plan', 'card-1')).toBe('wb-agent:my%3Aproj:q3-plan:card-1');
  });

  it("a project's drop releases its buckets that never had a session, and only its own", () => {
    const mine = boardAgentScratchId('acme', 'q3-plan', 'card-1');
    const home = boardAgentScratchId('acme', 'q3-plan', homeCardId('growth-helper'));
    const theirs = boardAgentScratchId('globex', 'q3-plan', 'card-1');
    for (const id of [mine, home, theirs]) addAttachments(id, [chip('dcref:wb/q3-plan/n1')]);

    dropBoardAgentScratch({ vault: 'acme', keepHome: true });
    expect(readScratch(mine).attachments).toHaveLength(0);
    expect(readScratch(home).attachments).toHaveLength(1);
    expect(readScratch(theirs).attachments).toHaveLength(1);

    dropBoardAgentScratch({ vault: 'acme' });
    expect(readScratch(home).attachments).toHaveLength(0);
    expect(readScratch(theirs).attachments).toHaveLength(1);
  });

  it("a card whose element id holds a colon is still its project's: that project's drop takes it", () => {
    const odd = boardAgentScratchId('acme', 'q3-plan', 'x:y');
    addAttachments(odd, [chip('dcref:wb/q3-plan/n1')]);
    dropBoardAgentScratch({ vault: 'globex' });
    expect(readScratch(odd).attachments).toHaveLength(1);
    dropBoardAgentScratch({ vault: 'acme' });
    expect(readScratch(odd).attachments).toHaveLength(0);
  });

  it('dropBoardAgentScratch releases every card bucket and nothing else', () => {
    const a = boardAgentScratchId('acme', 'q3-plan', 'card-1');
    const b = boardAgentScratchId('globex', 'growth', 'card-9');
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
