/**
 * The presentation queue, window half (task super-sahnesinde-sunum-sirasi, W2): the client mirror
 * of the counter, the top band's queue control (D7, D10), the queue gesture as a patch (local and
 * remote), the card -> answer map the chat scrolls by (AC3), and the side menu's waiting count (AC5).
 */
import { describe, it, expect } from 'vitest';
import * as server from '../../src/lib/super/types.js';
import * as client from '../../dashboard/src/lib/superTypes.js';
import { STAGE, applyLayoutPatch, controlsWidth, patchEchoed, planStage, type Rect } from '../../dashboard/src/components/sleepy/super/superLayout.js';
import { remoteLayoutPatch, remoteStageState } from '../../dashboard/src/components/sleepy/super/remoteStage.js';
import { PRESENT_REPLY_KEYS as CLIENT_PRESENT_KEYS, answerForCards, turnCardsByAnswer, type TurnItem } from '../../dashboard/src/lib/turnCards.js';
import { PRESENT_REPLY_KEYS } from '../../src/server/routes/super.js';
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

  it('step: a presentation is framed, its tab strip left of the icons, which keep their place', () => {
    const before = planStage(items, present, { width: 1384, height: 814 }, { layoutChoices: 3 });
    const p = planStage(items, present, { width: 1384, height: 814 }, { layoutChoices: 3, queueBand: 'step' });
    expect(p.controls).toEqual(before.controls);
    // A queued presentation on screen is named by the frame's tabs, never a pill.
    expect(p.queueBand).toBeUndefined();
    expect(p.presentTabs!.x + p.presentTabs!.width).toBeLessThanOrEqual(p.controls!.x);
    expect(p.presentTabs!.y).toBe(p.controls!.y);
    expect(p.presentFrame!.x).toBeLessThanOrEqual(p.presentTabs!.x);
    expect(p.presentFrame!.y).toBe(p.presentTabs!.y + p.presentTabs!.height);
  });

  it('the icon box is exactly its icons', () => {
    expect(controlsWidth(1, false)).toBe(2 * STAGE.ICON_PAD + STAGE.ICON_BTN);
    expect(controlsWidth(2, true)).toBe(2 * STAGE.ICON_PAD + 5 * STAGE.ICON_BTN + 4 * STAGE.ICON_GAP + 1 + STAGE.ICON_GAP);
    const p = planStage(items, present, { width: 1384, height: 814 }, { layoutChoices: 3, groupExit: true });
    expect(p.controls!.width).toBe(controlsWidth(3, true));
  });

  it('wait: at the band\'s right end off a presentation; step needs a presentation, wait refuses one', () => {
    const w = planStage(items, { mode: 'float' }, { width: 1384, height: 814 }, { queueBand: 'wait' });
    expect(w.queueBand?.kind).toBe('wait');
    expect(w.controls).toBeUndefined();
    expect(planStage(items, { mode: 'float' }, { width: 1384, height: 814 }, { queueBand: 'step' }).queueBand).toBeUndefined();
    // The floating centre starts under the band, as it does under the job bar's pill: never under the pill.
    expect(w.centre.y).toBeGreaterThanOrEqual(w.queueBand!.rect.y + w.queueBand!.rect.height);
    expect(w.centre.y).toBe(planStage(items, { mode: 'float' }, { width: 1384, height: 814 }, { queueUp: true }).centre.y);
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
      bash('t4', 'dreamcontext super present c-logo', { view: { mode: 'present', cards: ['c-pay'] }, queued: { at: 2, of: 2, cards: ['c-logo'], note: 'In the presentation queue (2/2)' }, window: 'sent' }),
      { kind: 'text', id: 'a4', text: 'The logo waits in the queue.' },
    ];
    const by = turnCardsByAnswer(queuedTurn);
    expect(by.get('a4')?.ids).toEqual(['c-logo']);
    expect(answerForCards(by, ['c-logo'])).toBe('a4');
    expect(answerForCards(by, ['c-pay'])).toBe('a3');
  });

  it('the CLI\'s window mark on a present reply does not hide what it showed', () => {
    const by = turnCardsByAnswer([
      { kind: 'user', id: 'u1', text: 'show it' },
      bash('t1', 'dreamcontext super present c-pay', { view: { mode: 'present', cards: ['c-pay'] }, window: 'none', windowNote: 'No window holds the Super Agent' }),
      { kind: 'text', id: 'a1', text: 'On the stage.' },
    ]);
    expect(by.get('a1')?.ids).toEqual(['c-pay']);
  });

  it('the turn record reads every key a present reply may carry (mirrors the server)', () => {
    expect([...CLIENT_PRESENT_KEYS].sort()).toEqual([...PRESENT_REPLY_KEYS].sort());
  });

  it('a re-present that kept the owner\'s layout records its cards (kept + note)', () => {
    const by = turnCardsByAnswer([
      { kind: 'user', id: 'u1', text: 'again' },
      bash('t1', 'dreamcontext super present c-pay', { view: { mode: 'present', cards: ['c-pay'], layout: 'filmstrip' }, kept: 'owner_layout', note: 'Shown, in the layout the owner picked', window: 'sent' }),
      { kind: 'text', id: 'a1', text: 'In your layout.' },
    ]);
    expect(by.get('a1')?.ids).toEqual(['c-pay']);
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

describe('the top band never overlaps itself (field 2026-11-15: the Next pill over "Grid")', () => {
  const items = [card('a'), card('b'), card('c'), card('d')];
  const present: client.SuperView = { mode: 'present', cards: ['a', 'b', 'c', 'd'] };
  const clash = (p: Rect, q: Rect) => p.x < q.x + q.width && q.x < p.x + p.width;

  it.each([700, 820, 1024, 1280, 1440, 1650, 2000])('a stage %i px wide: the tab strip and the icons never intersect, both inside the stage', (width) => {
    for (const layoutChoices of [1, 2, 3]) for (const groupExit of [false, true]) {
      const p = planStage(items, present, { width, height: 800 }, { layoutChoices, queueBand: 'step', groupExit });
      const c = p.controls!;
      // A narrow stage draws its one row of tabs (the chat's and the cards') in the band instead.
      const strip = p.narrow ? p.tabs!.rect : p.presentTabs!;
      expect(clash(strip, c), `${width}/${layoutChoices}/${groupExit}`).toBe(false);
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x + c.width).toBeLessThanOrEqual(width);
      expect(c.width).toBe(controlsWidth(layoutChoices, groupExit));
      if (p.presentFrame) expect(p.presentFrame.x + p.presentFrame.width).toBeLessThanOrEqual(width);
    }
  });
});
