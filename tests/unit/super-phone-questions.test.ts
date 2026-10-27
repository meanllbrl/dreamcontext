// Owner 2026-10-24 (0.34.5): a child's 4-question AskUserQuestion card that the Super escalated
// with `super queue ask` reached the hands-free phone as a push and prose, never as a card: the
// phone's mirror of the super chat had no super record, no child socket, and every /api/super
// route is laptop-only. The fix carries the child's own card to the phone and its answer back.
import { describe, it, expect, beforeEach } from 'vitest';
import { getChat, readPendingQuestion, registerChat, registryQuestions, MAX_QUESTION_BYTES } from '../../src/lib/assistant/chat-registry.js';
import { cleanPhoneAnswer, phoneAnswerOpen, phoneSuperQuestions } from '../../src/server/routes/super-phone-questions.js';
import { ROUTE_POLICY } from '../../src/lib/handsfree/mac/route-policy.js';
import type { SuperQueueItem } from '../../src/lib/super/types.js';
import { ownerAnswerPicks } from '../../dashboard/src/components/sleepy/super/superHandover.js';
import { phoneQuestionItems, retryableAnswerError } from '../../dashboard/src/components/sleepy/super/usePhoneSuperQuestions.js';

const FOUR = [
  { question: 'Which layout?', header: 'Layout', options: [{ label: 'Grid', description: 'cards in rows' }, { label: 'List', preview: '<div>list</div>' }] },
  { question: 'Which  colour?', header: 'Colour', multiSelect: true, options: [{ label: 'Red' }, { label: 'Blue' }, { label: 'Green' }] },
  { question: 'Ship today?', options: [{ label: 'Yes' }, { label: 'No' }] },
  { question: 'Who reviews?', options: [{ label: 'Me' }, { label: 'The team' }] },
];
const askFrame = (requestId: string, questions: unknown[] = FOUR) => ({
  type: 'control_request', request_id: requestId,
  request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions } },
});

describe('the registry keeps a child\'s whole AskUserQuestion, verbatim', () => {
  it('four questions, multiSelect, descriptions and previews, texts untouched (an answer is keyed by them)', () => {
    const q = readPendingQuestion(askFrame('r1'))!;
    expect(q.questions).toHaveLength(4);
    expect(q.questions![1]).toEqual({ question: 'Which  colour?', header: 'Colour', multiSelect: true, options: [{ label: 'Red' }, { label: 'Blue' }, { label: 'Green' }] });
    expect(q.questions![0].options[0]).toEqual({ label: 'Grid', description: 'cards in rows' });
    expect(q.questions![0].options[1].preview).toBe('<div>list</div>');
    // The glance fields stay as they were.
    expect(q.options).toEqual(['Grid', 'List']);
  });

  it('never cut: over the cap, or an unrecognised shape, keeps no list at all', () => {
    const big = [{ question: 'Big?', options: [{ label: 'x', preview: 'p'.repeat(MAX_QUESTION_BYTES) }] }];
    expect(registryQuestions(big)).toBeUndefined();
    expect(registryQuestions([{ question: 'No label', options: [{ description: 'd' }] }])).toBeUndefined();
    expect(readPendingQuestion({ type: 'control_request', request_id: 'p', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } })!.questions).toBeUndefined();
  });

  it('a registry snapshot is a copy (a reader cannot change the live entry)', () => {
    const h = registerChat({ sessionId: 'child-copy', conversationId: 'child-copy', vault: 'v', mode: 'basic' });
    h.userSent('go');
    h.observe(askFrame('r-copy'));
    const snap = getChat('child-copy')!;
    snap.pendingQuestion!.questions![0].options[0].label = 'changed';
    snap.pendingQuestion!.questions!.pop();
    expect(getChat('child-copy')!.pendingQuestion!.questions).toHaveLength(4);
    expect(getChat('child-copy')!.pendingQuestion!.questions![0].options[0].label).toBe('Grid');
    h.exited();
  });
});

const item = (over: Partial<SuperQueueItem>): SuperQueueItem => ({ id: 'q1', sessionId: 'child', kind: 'question', state: 'escalated', createdAt: 1, requestId: 'r1', ownerText: 'The child asks about the layout', ...over });

describe('GET /api/agent/super-questions: what the phone draws', () => {
  const state = (queue: SuperQueueItem[], enabled = true) => ({ enabled, session: 'super-1', queue, children: {} } as never);

  it('a child question escalated with queue ask carries the child\'s full card, the super\'s words as its strip', () => {
    const qs = registryQuestions(FOUR)!;
    const out = phoneSuperQuestions(state([item({})]), () => qs);
    expect(out.session).toBe('super-1');
    expect(out.questions).toHaveLength(1);
    expect(out.questions[0]).toMatchObject({ id: 'q1', kind: 'question', requestId: 'r1', sessionId: 'child' });
    expect(out.questions[0].card!.title).toBe('The child asks about the layout');
    expect(out.questions[0].card!.questions.map((q) => q.options.length)).toEqual([2, 3, 2, 2]);
    expect(out.questions[0].card!.questions[1].multiSelect).toBe(true);
  });

  it('the super\'s own ask carries its spec; a legacy ask its text and options', () => {
    const spec = { title: 'Pick', questions: [{ question: 'A or B?', options: [{ label: 'A' }, { label: 'B' }] }] };
    const out = phoneSuperQuestions(state([
      item({ id: 'a1', kind: 'ask', requestId: undefined, ask: spec, createdAt: 2 }),
      item({ id: 'a2', kind: 'ask', requestId: undefined, ownerText: 'Go?', options: ['yes', 'no'], createdAt: 3 }),
    ]), () => null);
    expect(out.questions.map((q) => q.card)).toEqual([spec, { questions: [{ question: 'Go?', options: [{ label: 'yes' }, { label: 'no' }] }] }]);
  });

  it('a child no longer asking it is not drawn; one too large to carry is words only; not escalated or not handed over: nothing', () => {
    expect(phoneSuperQuestions(state([item({})]), () => 'gone').questions).toEqual([]);
    expect(phoneSuperQuestions(state([item({})]), () => null).questions[0].card).toBeNull();
    expect(phoneSuperQuestions(state([item({ state: 'pending' }), item({ id: 'p', kind: 'permission' })]), () => []).questions).toEqual([]);
    expect(phoneSuperQuestions(state([item({})], false), () => []).session).toBeNull();
  });

  it('a child\'s own question (direct) is drawn AND answerable from birth, before the Super saw it (owner 2026-10-27)', () => {
    const direct = item({ state: 'pending', direct: true });
    expect(phoneSuperQuestions(state([direct]), () => registryQuestions(FOUR)!).questions.map((q) => q.id)).toEqual(['q1']);
    expect(phoneAnswerOpen(direct, 'r1')).toBe(true);
    expect(phoneAnswerOpen(item({ state: 'delivered', direct: true }), 'r1')).toBe(true);
    expect(phoneAnswerOpen(item({}), 'r1')).toBe(true);
    // Answered (done), another request, a legacy pending item, a permission: nothing to answer.
    expect(phoneAnswerOpen(item({ state: 'done', direct: true }), 'r1')).toBe(false);
    expect(phoneAnswerOpen(direct, 'r2')).toBe(false);
    expect(phoneAnswerOpen(item({ state: 'pending' }), 'r1')).toBe(false);
    expect(phoneAnswerOpen(item({ kind: 'permission', state: 'pending' }), 'r1')).toBe(false);
  });

  it('the phone may call both routes (the phone listener\'s default-deny policy)', () => {
    expect(ROUTE_POLICY['GET /api/agent/super-questions'].allow).toBe(true);
    expect(ROUTE_POLICY['POST /api/agent/super-answer'].allow).toBe(true);
    // The super's own routes stay laptop-only.
    expect(ROUTE_POLICY['POST /api/super/v/:verb'].allow).toBe(false);
  });
});

describe('the answer: every question, several picks, notes, checked against the child\'s own card', () => {
  const qs = registryQuestions(FOUR)!;
  it('server: keys must be the child\'s exact question texts', () => {
    expect(cleanPhoneAnswer(qs, { 'Which layout?': 'Grid', 'Which  colour?': 'Red, Blue', 'Ship today?': 'No', 'Who reviews?': 'Someone else' }))
      .toEqual({ 'Which layout?': 'Grid', 'Which  colour?': 'Red, Blue', 'Ship today?': 'No', 'Who reviews?': 'Someone else' });
    expect(cleanPhoneAnswer(qs, { 'Which colour?': 'Red' })).toBeNull();
    expect(cleanPhoneAnswer(qs, { 'Which layout?': '  ' })).toBeNull();
    expect(cleanPhoneAnswer(qs, ['Grid'])).toBeNull();
    expect(cleanPhoneAnswer(qs, undefined)).toEqual({});
  });

  it('window: the owner\'s picks and notes pass whole; an unknown question or no pick is refused', () => {
    expect(ownerAnswerPicks(qs, { 'Which layout?': 'List', 'Which  colour?': 'Green, Red' }, { 'Which layout?': 'but compact' }))
      .toEqual({ ok: true, picked: { 'Which layout?': 'List', 'Which  colour?': 'Green, Red' }, notes: { 'Which layout?': 'but compact' } });
    expect(ownerAnswerPicks(qs, { Other: 'x' }, undefined)).toEqual({ ok: false, error: 'unknown_choice' });
    expect(ownerAnswerPicks(qs, {}, undefined)).toEqual({ ok: false, error: 'empty_answer' });
  });
});

describe('the phone\'s view of the wire', () => {
  let wire: Parameters<typeof phoneQuestionItems>[0];
  beforeEach(() => {
    wire = {
      session: 'super-1',
      questions: [
        { id: 'q1', kind: 'question', sessionId: 'child', requestId: 'r1', ownerText: 'Layout?', createdAt: 1, card: { questions: registryQuestions(FOUR)! } },
        { id: 'a1', kind: 'ask', sessionId: 'super-1', createdAt: 2, card: { questions: [{ question: 'Go?', options: [] }] } },
      ],
    };
  });
  it('queue items the cards read (an ask carries its spec) and each child question\'s card', () => {
    const v = phoneQuestionItems(wire);
    expect(v.open.map((q) => [q.id, q.kind, q.state, q.requestId])).toEqual([['q1', 'question', 'escalated', 'r1'], ['a1', 'ask', 'escalated', undefined]]);
    expect(v.open[1].ask).toEqual({ questions: [{ question: 'Go?', options: [] }] });
    expect(v.cards.get('q1')!.questions).toHaveLength(4);
  });
  it('the key changes when the same item is asked again under a new request', () => {
    const before = phoneQuestionItems(wire).key;
    wire.questions[0].requestId = 'r2';
    expect(phoneQuestionItems(wire).key).not.toBe(before);
  });
});

describe('a refused answer: the card comes back with its picks unless the question is gone', () => {
  it('stale (answered elsewhere, taken back) is not drawn again; anything else is', () => {
    for (const e of ['stale_request', 'no_such_question', 'not_handed_over', 'not_a_child']) expect(retryableAnswerError(e)).toBe(false);
    for (const e of ['no_window', 'not_connected', 'timeout', 'invalid_args', 'network', undefined]) expect(retryableAnswerError(e)).toBe(true);
  });
  it('window: invalid notes say so', () => {
    expect(ownerAnswerPicks(registryQuestions(FOUR)!, { 'Which layout?': 'Grid' }, { Nope: 'x' })).toEqual({ ok: false, error: 'invalid_notes' });
  });
});
