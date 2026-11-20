/**
 * K8 (plan super-v3, D7): a Super question about what the presentation window shows is asked under
 * its page, not as a crowded card in the chat (owner 2026-11-20: "o sağdaki raporda mı sorsa
 * bunları"); exactly one full card per question, the chat keeps one row. Fictional fixtures.
 */
import { describe, it, expect } from 'vitest';
import { askHome, dockedAskOf } from '../../dashboard/src/components/sleepy/super/superQuestions.js';
import { PRESENT_WIN, STAGE, planStage, type StageItem } from '../../dashboard/src/components/sleepy/super/superLayout.js';
import type { SuperQueueItem } from '../../dashboard/src/lib/superTypes.js';

const ask = (id: string, over: Partial<SuperQueueItem> = {}): SuperQueueItem => ({
  id, kind: 'ask', state: 'escalated', sessionId: 'super-1', createdAt: 1, ownerText: 'Ship the pricing page?', ...over,
} as SuperQueueItem);

describe('askHome', () => {
  it('a Super ask whose read card is in the window is homed in the report', () => {
    expect(askHome(ask('q1', { read: ['web-plan'] }), { cards: ['web-plan'] })).toBe('report');
  });
  it('a question the window was opened for (--show) is homed there', () => {
    expect(askHome(ask('q1'), { cards: ['image-a'], ask: 'q1' })).toBe('report');
  });
  it('a read card not in the window, no window, or a child\'s question stays in the chat', () => {
    expect(askHome(ask('q1', { read: ['web-plan'] }), { cards: ['web-other'] })).toBe('chat');
    expect(askHome(ask('q1', { read: ['web-plan'] }), null)).toBe('chat');
    expect(askHome(ask('q1', { kind: 'question', read: ['web-plan'] }), { cards: ['web-plan'] })).toBe('chat');
  });
});

describe('dockedAskOf: one docked question at a time', () => {
  it('the oldest open ask about the window is docked; answered ones and others are not', () => {
    const queue = [
      ask('q-new', { read: ['web-plan'], createdAt: 30 }),
      ask('q-old', { read: ['web-plan'], createdAt: 10 }),
      ask('q-done', { read: ['web-plan'], createdAt: 5, state: 'done' }),
      ask('q-else', { read: ['web-other'], createdAt: 1 }),
    ];
    expect(dockedAskOf(queue, { cards: ['web-plan'] })).toBe('q-old');
    expect(dockedAskOf(queue, null)).toBeNull();
    expect(dockedAskOf(queue, { cards: ['web-none'] })).toBeNull();
  });
});

describe('planStage: the dock under the window\'s page', () => {
  const stage = { width: 1440, height: 820 };
  const page = { id: 'web-plan', shape: 'tall', place: 'float', kind: 'web' } as StageItem;
  const view = { mode: 'present' as const, cards: ['web-plan'], layout: 'spotlight' as const };
  it('the page gives its foot to the dock; the dock spans the window under it', () => {
    const plain = planStage([page], view, stage);
    const docked = planStage([page], view, stage, { askDock: true });
    const win = docked.presentWindow!;
    const dock = docked.askDock!;
    expect(plain.askDock).toBeUndefined();
    expect(dock.x).toBe(win.x);
    expect(dock.width).toBe(win.width);
    expect(dock.y + dock.height).toBe(win.y + win.height);
    expect(dock.height).toBeLessThanOrEqual(PRESENT_WIN.ASK_MAX_H);
    const r = docked.cards['web-plan'].rect;
    expect(r.y + r.height).toBeLessThanOrEqual(dock.y - STAGE.GAP + 0.5);
    expect(win.width).toBeGreaterThanOrEqual(PRESENT_WIN.ASK_MIN_W);
    expect(docked.centre.width).toBeGreaterThanOrEqual(PRESENT_WIN.CHAT_MIN);
  });
  it('a filmstrip has no window, so no dock: the chat keeps the full card', () => {
    const shots = ['image-a', 'image-b'].map((id) => ({ id, shape: 'tall', place: 'float', kind: 'image', aspect: 0.46 }) as StageItem);
    const strip = planStage(shots, { mode: 'present', cards: ['image-a', 'image-b'], layout: 'filmstrip' }, stage, { askDock: true });
    expect(strip.presentWindow).toBeUndefined();
    expect(strip.askDock).toBeUndefined();
  });
});

describe('a presented member is not docked (Ü2)', () => {
  it('the member tab stays in the window while the jobs go to the Dock', () => {
    const jobs = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, kind: 'chat', ref: `s${i}`, shape: 'portrait', place: 'float', live: true }) as unknown as StageItem);
    const team = { id: 't0', kind: 'team', ref: 'team-sage', shape: 'square', place: 'float' } as StageItem;
    const plan = planStage([...jobs, team], { mode: 'present', cards: ['t0'], layout: 'spotlight' }, { width: 1440, height: 820 },
      { dock: { prev: false, needs: new Set(), focus: null, today: null, agenda: null, pool: 0, cap: null } });
    expect(plan.cards.t0.where).toBe('present');
    expect(plan.cards.t0.inWindow).toBe(true);
    expect(plan.cards.c0.where).toBe('dock');
  });
});
