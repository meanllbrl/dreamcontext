import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatItem, ChatSession, ChatToolItem, PendingQuestion } from '../../dashboard/src/components/sleepy/chatSession.js';
import type { SuperQueueItem } from '../../dashboard/src/lib/superTypes.js';
import {
  _resetOwnerAnswers, answerLabelOf, askAnswerText, askRefOf, cardState, claimOwnerAnswer, clickedOwnerAnswer, jsonBlocks,
  noteOwnerPending, openOwnerQuestions, ownerAnswerKey, ownerAnswerLocked, ownerOptionsOf, ownerPendingPresent,
  placeQuestionCards, recordOwnerAnswer, releaseOwnerAnswer, sendOwnerAnswer, subscribeOwnerAnswers, trimOwnerAnswers,
} from '../../dashboard/src/components/sleepy/super/superQuestions.js';

// Fictional project and words (synthetic-fixtures pattern).
const pretty = (o: unknown) => JSON.stringify(o, null, 2);
let seq = 0;
function bash(command: string, result: unknown, status: ChatToolItem['status'] = 'done'): ChatToolItem {
  seq += 1;
  return { kind: 'tool', id: `t${seq}`, toolUseId: `tu${seq}`, name: 'Bash', input: { command }, status, startedAt: seq, result };
}
const text = (id: string, t = 'words'): ChatItem => ({ kind: 'text', id, index: 0, text: t, done: true, ts: 0 });
const user = (id: string, t: string, superEvent?: string): ChatItem => ({ kind: 'user', id, text: t, ts: 0, ...(superEvent ? { superEvent } : {}) });

const askItem = (over: Partial<SuperQueueItem> = {}): SuperQueueItem => ({
  id: 'q-ask-1', sessionId: 'super-0001', kind: 'ask', state: 'escalated', ownerText: 'Ship the login fix now?', createdAt: 1, options: ['Ship it', 'Wait'], ...over,
});
const questionItem = (over: Partial<SuperQueueItem> = {}): SuperQueueItem => ({
  id: 'q-child-1', sessionId: 'child-0001', kind: 'question', state: 'escalated', requestId: 'req-1', ownerText: 'The login button: blue or green?', createdAt: 2, ...over,
});

interface FakeSession extends ChatSession { sent: string[]; steered: string[]; answered: unknown[]; pendingList: PendingQuestion[] }
function fakeSession(over: Partial<{ status: string; busy: boolean; steerOk: boolean; pending: PendingQuestion[] }> = {}): FakeSession {
  const s = {
    status: over.status ?? 'open',
    busy: over.busy ?? false,
    sent: [] as string[], steered: [] as string[], answered: [] as unknown[],
    pendingList: over.pending ?? [],
    send(t: string) { s.sent.push(t); },
    steer(t: string) { if (over.steerOk === false) return false; s.steered.push(t); return true; },
    answerQuestion(requestId: string, _q: unknown, picked: Record<string, string>) { s.answered.push({ requestId, picked }); },
    getModel() { return { pending: s.pendingList }; },
  };
  return s as unknown as FakeSession;
}
const childQuestion = (requestId = 'req-1', multiSelect = false): PendingQuestion => ({
  kind: 'question', requestId, toolName: 'AskUserQuestion',
  questions: [{ question: 'Which colour?', header: 'Colour', multiSelect, options: [{ label: 'Blue', description: '' }, { label: 'Green', description: '' }] }],
} as unknown as PendingQuestion);

beforeEach(() => { _resetOwnerAnswers(); seq = 0; });

describe('askRefOf: the call that asked, read from the transcript', () => {
  it('super ask with quoted text and --options, accepted by the server', () => {
    const t = bash(`dreamcontext super ask "Ship the login fix now?" --options "Ship it|Wait"`, pretty({ item: 'q-ask-1', asked: true, shown: true }));
    expect(askRefOf(t)).toEqual({ item: 'q-ask-1', kind: 'ask', text: 'Ship the login fix now?', options: ['Ship it', 'Wait'], toolItemId: t.id });
  });

  it('super queue ask names the escalated item; npx and a chained line are read too', () => {
    const t = bash(`cd /tmp/acme-app && npx dreamcontext super queue ask q-child-1 'The login button: blue or green?' 2>&1`, [{ type: 'text', text: pretty({ item: 'q-child-1', escalated: true }) }]);
    expect(askRefOf(t)).toMatchObject({ item: 'q-child-1', kind: 'question', text: 'The login button: blue or green?', options: [] });
  });

  it('several JSON blocks: the one carrying the acceptance wins', () => {
    const t = bash(`dreamcontext super state >/dev/null; dreamcontext super ask "Rename the app?"`, `note: ok\n${pretty({ queue: [] })}\n${pretty({ item: 'q-ask-9', asked: true })}`);
    expect(askRefOf(t)).toMatchObject({ item: 'q-ask-9', kind: 'ask', text: 'Rename the app?', options: [] });
  });

  it('a refused call (stderr, exit 1), a running call, another command: no card', () => {
    expect(askRefOf(bash(`dreamcontext super ask "Again?"`, pretty({ error: 'ask_open', message: 'you already have a question open' }), 'error'))).toBeNull();
    expect(askRefOf(bash(`dreamcontext super ask "Again?"`, pretty({ error: 'ask_open' })))).toBeNull();
    expect(askRefOf(bash(`dreamcontext super ask "Soon?"`, undefined, 'running'))).toBeNull();
    expect(askRefOf(bash(`dreamcontext super delegate "do it"`, pretty({ item: 'x', asked: true })))).toBeNull();
    expect(askRefOf(bash(`echo 'dreamcontext super ask "fake"'`, pretty({ item: 'x', asked: true })))).toBeNull();
  });

  it('jsonBlocks skips braces inside strings and broken blocks', () => {
    expect(jsonBlocks(`{ "a": "}{" } {bad} {"b": 2}`)).toEqual([{ a: '}{' }, { b: 2 }]);
  });
});

describe('placeQuestionCards: under the turn that asked', () => {
  it('after the last item of the asking turn, before the next user turn', () => {
    const ask = bash(`dreamcontext super ask "Ship?" --options "Ship it|Wait"`, pretty({ item: 'q-ask-1', asked: true }));
    const piece = [user('u1', 'go'), text('a1'), ask, text('a2', 'Ship the login fix now?'), user('u2', 'later'), text('a3')];
    const placed = placeQuestionCards(piece);
    expect([...placed.keys()]).toEqual(['a2']);
    expect(placed.get('a2')?.[0]).toMatchObject({ item: 'q-ask-1', live: true });
  });

  it('a turn that ends on the call itself, or still streams: the piece\'s last item', () => {
    const ask = bash(`dreamcontext super ask "Ship?"`, pretty({ item: 'q-ask-1', asked: true }));
    expect([...placeQuestionCards([user('u1', 'go'), ask]).keys()]).toEqual([ask.id]);
    const later = text('a9');
    expect([...placeQuestionCards([user('u1', 'go'), ask, later]).keys()]).toEqual(['a9']);
  });

  it('one item escalated twice: only the latest call is live', () => {
    const one = bash(`dreamcontext super queue ask q-child-1 "Blue or green?"`, pretty({ item: 'q-child-1', escalated: true }));
    const two = bash(`dreamcontext super queue ask q-child-1 "Blue or green, again?"`, pretty({ item: 'q-child-1', escalated: true }));
    const placed = placeQuestionCards([user('u1', '[super events] x', 'b1'), one, text('a1'), user('u2', 'hm'), two]);
    const all = [...placed.values()].flat();
    expect(all.map((c) => [c.toolItemId, c.live])).toEqual([[one.id, false], [two.id, true]]);
  });

  it('a call folded away is not in the kept piece: nothing is placed (the tail draws it)', () => {
    expect(placeQuestionCards([user('u1', 'hi'), text('a1')]).size).toBe(0);
  });
});

describe('the card\'s state never guesses', () => {
  const view = { open: [askItem()] };
  it('open while the record has it; answered once it left; static with no record or for a superseded call', () => {
    expect(cardState('q-ask-1', true, view)).toBe('open');
    expect(cardState('q-ask-1', true, { open: [] })).toBe('answered');
    expect(cardState('q-ask-1', true, null)).toBe('static');
    expect(cardState('q-ask-1', false, view)).toBe('static');
  });

  it('openOwnerQuestions: escalated asks and child questions only, oldest first', () => {
    const queue: SuperQueueItem[] = [
      questionItem({ createdAt: 5 }), askItem({ createdAt: 3 }),
      { id: 'p1', sessionId: 'child-0001', kind: 'permission', state: 'pending', createdAt: 1 },
      questionItem({ id: 'q-done', state: 'done', createdAt: 2 }), questionItem({ id: 'q-pend', state: 'pending', createdAt: 2 }),
    ];
    expect(openOwnerQuestions(queue).map((q) => q.id)).toEqual(['q-ask-1', 'q-child-1']);
  });
});

describe('answerLabelOf: the answer this question got, never another one\'s', () => {
  const ask1 = () => bash(`dreamcontext super ask "Ship?" --options "Ship it|Wait"`, pretty({ item: 'q-ask-1', asked: true }));
  it('the clicked label first', () => {
    const a = ask1();
    expect(answerLabelOf({ item: 'q-ask-1', kind: 'ask', toolItemId: a.id }, [a], 'Wait')).toEqual({ label: 'Wait' });
  });

  it('the first owner message after it, skipping event turns', () => {
    const a = ask1();
    const items = [a, text('t'), user('e', '[super events] child done', 'b2'), user('o', 'Answer to your question: Ship it')];
    expect(answerLabelOf({ item: 'q-ask-1', kind: 'ask', toolItemId: a.id }, items, undefined)).toEqual({ label: 'Ship it' });
  });

  it('free text closed it: Answered, and a later click on another ask is never borrowed', () => {
    const a = ask1();
    const b = bash(`dreamcontext super ask "Rename?" --options "Yes|No"`, pretty({ item: 'q-ask-2', asked: true }));
    const items = [a, user('o1', 'not now, later'), b, user('o2', 'Answer to your question: Yes')];
    expect(answerLabelOf({ item: 'q-ask-1', kind: 'ask', toolItemId: a.id }, items, undefined)).toBe('answered');
    expect(answerLabelOf({ item: 'q-ask-2', kind: 'ask', toolItemId: b.id }, items, undefined)).toEqual({ label: 'Yes' });
  });

  it('closed by a take-back, then another ask answered: the earlier one says closed, never takes that answer', () => {
    const a = ask1();
    const b = bash(`dreamcontext super ask "Rename?" --options "Yes|No"`, pretty({ item: 'q-ask-2', asked: true }));
    const items = [a, text('t1'), b, user('o2', 'Answer to your question: Yes')];
    // The server never holds two open asks: a second one before any owner message = the first closed unanswered.
    expect(answerLabelOf({ item: 'q-ask-1', kind: 'ask', toolItemId: a.id }, items, undefined)).toBe('closed');
    expect(answerLabelOf({ item: 'q-ask-2', kind: 'ask', toolItemId: b.id }, items, undefined)).toEqual({ label: 'Yes' });
  });

  it('no owner message at all after it: closed, not answered; a child question without a click: Answered', () => {
    const a = ask1();
    expect(answerLabelOf({ item: 'q-ask-1', kind: 'ask', toolItemId: a.id }, [a, text('t')], undefined)).toBe('closed');
    expect(answerLabelOf({ item: 'q-child-1', kind: 'question', toolItemId: 'x' }, [], undefined)).toBe('answered');
  });

  it('clicked labels outlive the latch', () => {
    recordOwnerAnswer('q-child-1', 'Blue');
    trimOwnerAnswers('super-0001', new Set());
    expect(clickedOwnerAnswer('q-child-1')).toBe('Blue');
  });
});

describe('one answer, two places: the card and the job bar share one latch', () => {
  it('a click in one place locks the other at once (subscribers hear it)', () => {
    const item = askItem();
    const key = ownerAnswerKey(item);
    let heard = 0;
    const off = subscribeOwnerAnswers(() => { heard += 1; });
    expect(claimOwnerAnswer(key, item.id, 'super-0001', true)).toBe(true);
    expect(heard).toBe(1);
    expect(ownerAnswerLocked(key)).toBe(true);
    // The bar's click on the same key: nothing to send.
    expect(claimOwnerAnswer(key, item.id, 'super-0001', true)).toBe(false);
    off();
  });

  it('a closed socket claims nothing; a send that wrote nothing releases', () => {
    const key = ownerAnswerKey(askItem());
    expect(claimOwnerAnswer(key, 'q-ask-1', 'super-0001', false)).toBe(false);
    expect(ownerAnswerLocked(key)).toBe(false);
    expect(claimOwnerAnswer(key, 'q-ask-1', 'super-0001', true)).toBe(true);
    releaseOwnerAnswer(key);
    expect(ownerAnswerLocked(key)).toBe(false);
  });

  it('an ask stays locked until it leaves the open set, whoever notes in whatever order', () => {
    const item = askItem();
    const key = ownerAnswerKey(item);
    claimOwnerAnswer(key, item.id, 'super-0001', true);
    const stillOpen = ownerPendingPresent(item, undefined, [item]);
    expect(stillOpen).toBe(true);
    for (let i = 0; i < 3; i += 1) {
      noteOwnerPending(key, stillOpen); // the card
      noteOwnerPending(key, ownerPendingPresent(item, undefined, [item])); // the bar: the same input
      expect(ownerAnswerLocked(key)).toBe(true);
    }
    noteOwnerPending(key, ownerPendingPresent(item, undefined, []));
    expect(ownerAnswerLocked(key)).toBe(true); // left the open set: noted, never reopened
  });

  it('a lost answer: the SAME request coming back after it left reopens both places', () => {
    const item = questionItem();
    const child = fakeSession({ pending: [childQuestion('req-1')] });
    const key = ownerAnswerKey(item);
    claimOwnerAnswer(key, item.id, 'super-0001', true);
    noteOwnerPending(key, ownerPendingPresent(item, child, [item]));
    expect(ownerAnswerLocked(key)).toBe(true);
    child.pendingList = []; // the answer took it off
    noteOwnerPending(key, ownerPendingPresent(item, child, [item]));
    expect(ownerAnswerLocked(key)).toBe(true);
    child.pendingList = [childQuestion('req-1')]; // re-sent: the answer never landed
    noteOwnerPending(key, ownerPendingPresent(item, child, [item]));
    expect(ownerAnswerLocked(key)).toBe(false);
  });

  it('noting is silent (it runs during render); no child session = not noted at all', () => {
    const item = questionItem();
    const key = ownerAnswerKey(item);
    claimOwnerAnswer(key, item.id, 'super-0001', true);
    let heard = 0;
    const off = subscribeOwnerAnswers(() => { heard += 1; });
    noteOwnerPending(key, false);
    noteOwnerPending(key, true);
    expect(heard).toBe(0);
    expect(ownerPendingPresent(item, undefined, [item])).toBeNull();
    off();
  });

  it('one project\'s trim never drops another project\'s latch (every project shares this window)', () => {
    const mine = askItem();
    const theirs = askItem({ id: 'q-ask-other', sessionId: 'super-0002' });
    claimOwnerAnswer(ownerAnswerKey(mine), mine.id, 'super-0001', true);
    claimOwnerAnswer(ownerAnswerKey(theirs), theirs.id, 'super-0002', true);
    trimOwnerAnswers('super-0001', new Set());
    expect(ownerAnswerLocked(ownerAnswerKey(mine))).toBe(false);
    expect(ownerAnswerLocked(ownerAnswerKey(theirs))).toBe(true);
  });

  it('latches of items no longer asked for are trimmed (from the publish)', () => {
    const a = askItem();
    const q = questionItem();
    claimOwnerAnswer(ownerAnswerKey(a), a.id, 'super-0001', true);
    claimOwnerAnswer(ownerAnswerKey(q), q.id, 'super-0001', true);
    trimOwnerAnswers('super-0001', new Set([q.id]));
    expect(ownerAnswerLocked(ownerAnswerKey(a))).toBe(false);
    expect(ownerAnswerLocked(ownerAnswerKey(q))).toBe(true);
  });
});

describe('sendOwnerAnswer: the pick goes where it belongs', () => {
  it('an ask: the framed label into the super chat; a running turn steers', () => {
    const sup = fakeSession();
    expect(sendOwnerAnswer(askItem(), 'Ship it', { superSession: sup, child: undefined })).toBe(true);
    expect(sup.sent).toEqual([askAnswerText('Ship it')]);
    expect(askAnswerText('Ship it')).toBe('Answer to your question: Ship it');
    const busy = fakeSession({ busy: true });
    sendOwnerAnswer(askItem(), 'Wait', { superSession: busy, child: undefined });
    expect(busy.steered).toEqual(['Answer to your question: Wait']);
    const noSteer = fakeSession({ busy: true, steerOk: false });
    sendOwnerAnswer(askItem(), 'Wait', { superSession: noSteer, child: undefined });
    expect(noSteer.sent).toEqual(['Answer to your question: Wait']);
  });

  it('a child question: the CHILD answers, never the super', () => {
    const sup = fakeSession();
    const child = fakeSession({ pending: [childQuestion('req-1')] });
    expect(sendOwnerAnswer(questionItem(), 'Blue', { superSession: sup, child })).toBe(true);
    expect(child.answered).toEqual([{ requestId: 'req-1', picked: { 'Which colour?': 'Blue' } }]);
    expect(sup.sent).toEqual([]);
  });

  it('nothing can be sent: no session, a closed socket, the request not here, an unknown pick', () => {
    expect(sendOwnerAnswer(askItem(), 'Ship it', { superSession: undefined, child: undefined })).toBe(false);
    expect(sendOwnerAnswer(askItem(), 'Ship it', { superSession: fakeSession({ status: 'closed' }), child: undefined })).toBe(false);
    expect(sendOwnerAnswer(questionItem(), 'Blue', { superSession: undefined, child: fakeSession() })).toBe(false);
    expect(sendOwnerAnswer(questionItem(), 'Red', { superSession: undefined, child: fakeSession({ pending: [childQuestion()] }) })).toBe(false);
  });

  it('options: an ask\'s own; a child\'s single-choice single question; nothing richer', () => {
    expect(ownerOptionsOf(askItem(), undefined)).toEqual(['Ship it', 'Wait']);
    expect(ownerOptionsOf(questionItem(), fakeSession({ pending: [childQuestion()] }))).toEqual(['Blue', 'Green']);
    expect(ownerOptionsOf(questionItem(), fakeSession({ pending: [childQuestion('req-1', true)] }))).toEqual([]);
    expect(ownerOptionsOf(questionItem(), undefined)).toEqual([]);
  });
});
