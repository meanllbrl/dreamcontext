/**
 * K8 (plan super-v3, D7): a Super question about what the presentation window shows is asked under
 * its page, not as a crowded card in the chat (owner 2026-11-20: "o sağdaki raporda mı sorsa
 * bunları"); exactly one full card per question, the chat keeps one row. Fictional fixtures.
 */
import { describe, it, expect } from 'vitest';
import { askHome, decisionChoices, dockedAskOf } from '../../dashboard/src/components/sleepy/super/superQuestions.js';
import { DOCK, PRESENT_WIN, STAGE, planStage, type StageItem } from '../../dashboard/src/components/sleepy/super/superLayout.js';
import type { SuperQueueItem } from '../../dashboard/src/lib/superTypes.js';

const ask = (id: string, over: Partial<SuperQueueItem> = {}): SuperQueueItem => ({
  id, kind: 'ask', state: 'escalated', sessionId: 'super-1', createdAt: 1, ownerText: 'Ship the pricing page?', options: ['Ship it', 'Wait'], ...over,
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

describe('decisionChoices: what the strip can ask with one tap (approved frame D)', () => {
  const spec = (questions: unknown[]) => ({ ask: { questions } }) as unknown as SuperQueueItem;
  it('one question, one pick, 1-4 choices: its words and its chips', () => {
    expect(decisionChoices(spec([{ question: 'Yearly price?', options: [{ label: '990' }, { label: '1,190' }, { label: '790' }] }])))
      .toEqual({ question: 'Yearly price?', choices: ['990', '1,190', '790'] });
  });
  it('several questions, a multi-pick, a free text, five choices or a preview: the chat\'s full card', () => {
    const o = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `o${i}` }));
    expect(decisionChoices(spec([{ question: 'a', options: o(2) }, { question: 'b', options: o(2) }]))).toBeNull();
    expect(decisionChoices(spec([{ question: 'a', options: o(2), multiSelect: true }]))).toBeNull();
    expect(decisionChoices(spec([{ question: 'a', options: [] }]))).toBeNull();
    expect(decisionChoices(spec([{ question: 'a', options: o(5) }]))).toBeNull();
    expect(decisionChoices(spec([{ question: 'a', options: [{ label: 'x', preview: '<b>x</b>' }] }]))).toBeNull();
    // Two chips with one label could not tell the answers apart: the chat's full card asks it.
    expect(decisionChoices(spec([{ question: 'a', options: [{ label: 'Ship' }, { label: 'Ship ' }] }]))).toBeNull();
  });
  it('a question the strip cannot carry is never docked: the chat asks it whole', () => {
    const rich = ask('q-rich', { read: ['web-plan'], ask: { questions: [{ question: 'a', options: [], multiSelect: false }] } } as Partial<SuperQueueItem>);
    expect(dockedAskOf([rich], { cards: ['web-plan'] })).toBeNull();
  });
});

describe('planStage: the dock under the window\'s page', () => {
  const stage = { width: 1440, height: 820 };
  const page = { id: 'web-plan', shape: 'tall', place: 'float', kind: 'web' } as StageItem;
  const view = { mode: 'present' as const, cards: ['web-plan'], layout: 'spotlight' as const };
  it('approved frame D: a thin strip in the window\'s foot, the page takes the window\'s height above it', () => {
    const plain = planStage([page], view, stage);
    const docked = planStage([page], view, stage, { askDock: true });
    const win = docked.presentWindow!;
    const dock = docked.askDock!;
    expect(plain.askDock).toBeUndefined();
    // Inset 16 px from the window's sides and 14 px from its foot, 96 px tall: a strip, never a card.
    expect(dock.x).toBe(win.x + PRESENT_WIN.ASK_INSET_X);
    expect(dock.width).toBe(win.width - 2 * PRESENT_WIN.ASK_INSET_X);
    expect(dock.y + dock.height).toBe(win.y + win.height - PRESENT_WIN.ASK_INSET_B);
    expect(dock.height).toBe(PRESENT_WIN.ASK_H);
    expect(dock.height).toBeLessThan(0.15 * win.height);
    const r = docked.cards['web-plan'].rect;
    expect(r.y + r.height).toBeLessThanOrEqual(dock.y + 0.5);
    // The page keeps most of the window: at least 80% of the body it has without a question.
    expect(r.height).toBeGreaterThanOrEqual(0.8 * plain.cards['web-plan'].rect.height);
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

describe('the window reaches down to the Dock (K8 frame D, Super 2026-11-20)', () => {
  it('under a Dock no band is reserved: window and chat run from one margin under the top to one margin above the Dock', () => {
    const jobs = Array.from({ length: 3 }, (_, i) => ({ id: `c${i}`, kind: 'chat', ref: `s${i}`, shape: 'portrait', place: 'float', live: true }) as unknown as StageItem);
    const agenda = { id: 'ag', kind: 'agenda', ref: 'agenda', shape: 'square', place: 'float' } as StageItem;
    const page = { id: 'web-plan', shape: 'tall', place: 'float', kind: 'web' } as StageItem;
    for (const stage of [{ width: 1440, height: 836 }, { width: 1180, height: 736 }]) {
      const plan = planStage([agenda, ...jobs, page], { mode: 'present', cards: ['web-plan'], layout: 'spotlight' }, stage,
        { askDock: true, dock: { prev: false, needs: new Set(), focus: null, today: null, agenda: 'ag', pool: 0, cap: null } });
      const win = plan.presentWindow!;
      const dockTop = plan.jobDock!.rect.y;
      expect(dockTop - (win.y + win.height)).toBe(STAGE.MARGIN);
      expect(plan.centre.y + plan.centre.height).toBe(win.y + win.height);
      // The window holds the stage's height less the top band, the margin and the Dock.
      expect(win.height).toBe(stage.height - win.y - STAGE.MARGIN - plan.jobDock!.rect.height - DOCK.INSET);
      // No top band either: the window starts one margin under the stage's top, its controls ride in its title row.
      expect(win.y).toBe(STAGE.MARGIN);
      expect(plan.controlsInTitle).toBe(true);
      const c = plan.controls!;
      expect(c.y).toBeGreaterThanOrEqual(win.y);
      expect(c.y + c.height).toBeLessThanOrEqual(win.y + PRESENT_WIN.TITLE_H);
      expect(c.x + c.width).toBeLessThanOrEqual(win.x + win.width);
    }
  });
  it('a band that holds something stays clear: terminal pills under the window, a job item over it', () => {
    const jobs = Array.from({ length: 3 }, (_, i) => ({ id: `c${i}`, kind: 'chat', ref: `s${i}`, shape: 'portrait', place: 'float', live: true }) as unknown as StageItem);
    const page = { id: 'web-plan', shape: 'tall', place: 'float', kind: 'web' } as StageItem;
    const dock = { prev: false, needs: new Set<string>(), focus: null, today: null, agenda: null, pool: 0, cap: null };
    const view = { mode: 'present' as const, cards: ['web-plan'], layout: 'spotlight' as const };
    const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    const term = planStage([...jobs, page], view, { width: 1440, height: 836 }, { terminals: 2, dock });
    expect(overlaps(term.dock!, term.presentWindow!)).toBe(false);
    expect(overlaps(term.dock!, term.centre)).toBe(false);
    const queued = planStage([...jobs, page], view, { width: 1440, height: 836 }, { queueUp: true, queueHeight: 56, dock });
    expect(queued.controlsInTitle).toBeUndefined();
    expect(overlaps(queued.queue!, queued.presentWindow!)).toBe(false);
    expect(overlaps(queued.queue!, queued.centre)).toBe(false);
  });
});
