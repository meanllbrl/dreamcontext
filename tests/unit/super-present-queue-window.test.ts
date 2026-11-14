/**
 * The presentation queue, window half (task super-sahnesinde-sunum-sirasi, W2): the client mirror
 * of the counter, the top band's queue control (D7, D10), the queue gesture as a patch (local and
 * remote), the card -> answer map the chat scrolls by (AC3), and the side menu's waiting count (AC5).
 */
import { describe, it, expect } from 'vitest';
import * as server from '../../src/lib/super/types.js';
import * as client from '../../dashboard/src/lib/superTypes.js';
import { STAGE, applyLayoutPatch, patchEchoed, planStage } from '../../dashboard/src/components/sleepy/super/superLayout.js';
import { remoteLayoutPatch, remoteStageState } from '../../dashboard/src/components/sleepy/super/remoteStage.js';
import { answerForCards, turnCardsByAnswer, type TurnItem } from '../../dashboard/src/lib/turnCards.js';
import { superRowMarks } from '../../dashboard/src/components/sleepy/super/sessionHome.js';
import { rosterSummary } from '../../src/server/routes/agent-sessions.js';
import { onQueueJump, sendQueueJump } from '../../dashboard/src/components/sleepy/super/queueJump.js';

const card = (id: string): client.SuperContainer => ({ id, kind: 'insight', ref: `ref-${id}`, shape: 'square', place: 'float' });
const item = (id: string, cards: string[], extra: Partial<client.PresentItem> = {}): client.PresentItem => ({ id, cards, at: 1, ...extra });
const queue = (items: client.PresentItem[], showing?: string, seen = 0): client.PresentQueue => ({ items, seen, seq: items.length + seen, ...(showing ? { showing } : {}) });

describe('the counter, on both sides', () => {
  it('reads the same as the server when the view shows the head', () => {
    const q = queue([item('pq1', ['a']), item('pq2', ['b']), item('pq3', ['c'])], 'pq1');
    const view: client.SuperView = { mode: 'present', cards: ['a'] };
    expect(client.queueCounter(q, view)).toEqual(server.queueCounter(q as server.PresentQueue));
    expect(client.queueCounter(q, view)).toEqual({ at: 1, of: 3, waiting: 2, showing: true });
  });

  it('a view that lags the gesture (another presentation still drawn) is not the head shown', () => {
    const q = queue([item('pq2', ['b']), item('pq3', ['c'])], 'pq2', 1);
    expect(client.queueCounter(q, { mode: 'present', cards: ['a'] })).toEqual({ at: 2, of: 3, waiting: 2, showing: false });
    expect(client.queueCounter(q, { mode: 'float' }).showing).toBe(false);
  });

  it('a pushed queue survives the reader; a malformed item is dropped', () => {
    const v = client.readSuperStateView({
      ...server.emptySuperState(), vault: 'acme-app', session: 's1',
      presentQueue: { items: [{ id: 'pq1', cards: ['a'], at: 1 }, { id: 'bad', cards: ['b'], at: 1 }, { id: 'pq3', cards: [], at: 1 }], seen: 0, seq: 3, showing: 'pq1' },
    });
    expect(v?.presentQueue).toEqual({ items: [{ id: 'pq1', cards: ['a'], at: 1 }], seen: 0, seq: 3, showing: 'pq1' });
    expect(client.readSuperStateView({ ...server.emptySuperState(), vault: 'acme-app', session: 's1' })?.presentQueue).toBeUndefined();
  });
});

describe('the top band (D7, D10)', () => {
  const items = [card('a'), card('b'), card('c')];
  const present: client.SuperView = { mode: 'present', cards: ['a', 'b'] };

  it('step: left of the layout buttons, which keep their place', () => {
    const before = planStage(items, present, { width: 1384, height: 814 }, { layoutChoices: 3 });
    const p = planStage(items, present, { width: 1384, height: 814 }, { layoutChoices: 3, queueBand: 'step' });
    expect(p.controls).toEqual(before.controls);
    expect(p.queueBand?.kind).toBe('step');
    expect(p.queueBand?.short).toBe(false);
    expect(p.queueBand!.rect.width).toBe(STAGE.QUEUE_STEP_W);
    expect(p.queueBand!.rect.x + p.queueBand!.rect.width).toBeLessThanOrEqual(p.controls!.x);
    expect(p.queueBand!.rect.y).toBe(p.controls!.y);
  });

  it('a narrow band shortens the queue control, never the layout buttons or the exit', () => {
    const before = planStage(items, present, { width: 1000, height: 700 }, { layoutChoices: 3 });
    const p = planStage(items, present, { width: 1000, height: 700 }, { layoutChoices: 3, queueBand: 'step' });
    expect(p.controls).toEqual(before.controls);
    expect(p.queueBand?.short).toBe(true);
    expect(p.queueBand!.rect.width).toBe(STAGE.QUEUE_STEP_SHORT_W);
  });

  it('wait: at the band\'s right end off a presentation; step needs a presentation, wait refuses one', () => {
    const w = planStage(items, { mode: 'float' }, { width: 1384, height: 814 }, { queueBand: 'wait' });
    expect(w.queueBand?.kind).toBe('wait');
    expect(w.controls).toBeUndefined();
    expect(planStage(items, { mode: 'float' }, { width: 1384, height: 814 }, { queueBand: 'step' }).queueBand).toBeUndefined();
    expect(planStage(items, present, { width: 1384, height: 814 }, { layoutChoices: 3, queueBand: 'wait' }).queueBand).toBeUndefined();
  });
});

describe('the gesture as a patch', () => {
  const st = { containers: [card('a'), card('b')], groups: [], view: { mode: 'present', cards: ['a'] } as client.SuperView };

  it('a queue step draws nothing ahead of the server and is never laid over a push', () => {
    const patch = { queue: { op: 'next' as const, item: 'pq1' } };
    expect(applyLayoutPatch(st, patch)).toBe(st);
    expect(patchEchoed(st, patch)).toBe(true);
  });

  it('a remote screen sends it (seen there is seen here, AC7)', () => {
    expect(remoteLayoutPatch({ queue: { op: 'resume', item: 'pq4' } })).toEqual({ queue: { op: 'resume', item: 'pq4' } });
  });

  it('a remote screen reads the queue its view carries (no `at`, no `seq` on the wire)', () => {
    const st = remoteStageState({
      vault: 'acme-app', session: 's1', enabled: true, containers: [card('a'), card('b')], groups: [], view: { mode: 'present', cards: ['a'] },
      children: {}, pad: [], waiting: [], ownerBatches: [], names: {}, head: null,
      presentQueue: { items: [{ id: 'pq1', cards: ['a'] }, { id: 'pq2', cards: ['b'], ask: 'q-logo' }], seen: 0, showing: 'pq1' },
    });
    expect(st?.presentQueue?.items.map((i) => i.id)).toEqual(['pq1', 'pq2']);
    expect(st?.presentQueue?.items[1].ask).toBe('q-logo');
    expect(client.queueCounter(st!.presentQueue, st!.view)).toEqual({ at: 1, of: 2, waiting: 1, showing: true });
  });
});

describe('the chat follows the step (AC3)', () => {
  const bash = (id: string, command: string, out: unknown): TurnItem => ({ kind: 'tool', id, name: 'Bash', input: { command }, status: 'done', result: JSON.stringify(out, null, 2) });
  const items: TurnItem[] = [
    { kind: 'user', id: 'u1', text: 'three jobs' },
    bash('t1', 'dreamcontext super present c-pay', { view: { mode: 'present', cards: ['c-pay'] } }),
    { kind: 'text', id: 'a1', text: 'Checkout is done.' },
    { kind: 'user', id: 'u2', text: 'and pricing?' },
    bash('t2', 'dreamcontext super present c-price', { view: { mode: 'present', cards: ['c-price'] } }),
    { kind: 'text', id: 'a2', text: 'Pricing is ready.' },
    { kind: 'user', id: 'u3', text: 'checkout again' },
    bash('t3', 'dreamcontext super present c-pay', { view: { mode: 'present', cards: ['c-pay'] } }),
    { kind: 'text', id: 'a3', text: 'Checkout, second look.' },
  ];

  it('a present that joined the queue is recorded by the cards that wait, not the view on screen', () => {
    const queuedTurn: TurnItem[] = [
      ...items,
      { kind: 'user', id: 'u4', text: 'the logo too' },
      // The view is still checkout (on screen); the logo waits (W1's reply shape).
      bash('t4', 'dreamcontext super present c-logo', { view: { mode: 'present', cards: ['c-pay'] }, queued: { at: 2, of: 2, cards: ['c-logo'], note: 'In the presentation queue (2/2)' } }),
      { kind: 'text', id: 'a4', text: 'The logo waits in the queue.' },
    ];
    const by = turnCardsByAnswer(queuedTurn);
    expect(by.get('a4')?.ids).toEqual(['c-logo']);
    expect(answerForCards(by, ['c-logo'])).toBe('a4');
    expect(answerForCards(by, ['c-pay'])).toBe('a3');
  });

  it('lands on the newest answer that showed the cards', () => {
    const by = turnCardsByAnswer(items);
    expect(answerForCards(by, ['c-price'])).toBe('a2');
    expect(answerForCards(by, ['c-pay'])).toBe('a3');
  });

  it('cards no answer showed (cut from history): nothing to scroll to', () => {
    expect(answerForCards(turnCardsByAnswer(items), ['c-gone'])).toBeNull();
    expect(answerForCards(turnCardsByAnswer(items), [])).toBeNull();
  });

  it('the jump reaches only its own Super chat', () => {
    const got: string[][] = [];
    const off = onQueueJump('sess-main', (c) => got.push([...c]));
    sendQueueJump('sess-member', ['x']);
    sendQueueJump('sess-main', ['c-pay']);
    off();
    sendQueueJump('sess-main', ['late']);
    expect(got).toEqual([['c-pay']]);
  });
});

describe('the side menu says how many wait (AC5)', () => {
  const q = queue([item('pq1', ['a']), item('pq2', ['b']), item('pq3', ['c'])], 'pq1');

  it('the window counts the ones not on screen; none waiting adds no field', () => {
    expect(superRowMarks({ children: {}, queue: [], presentQueue: q })).toEqual({ working: 0, asking: false, waiting: 2 });
    expect(superRowMarks({ children: {}, queue: [] })).toEqual({ working: 0, asking: false });
  });

  it('a folded project\'s summary carries the same count', () => {
    const sum = rosterSummary({ sessions: [], windows: [] }, { enabled: true, session: 's1', presentQueue: q as server.PresentQueue });
    expect(sum.superWaiting).toBe(2);
    expect(rosterSummary({ sessions: [], windows: [] }, { enabled: true, session: 's1' }).superWaiting).toBe(0);
  });
});
