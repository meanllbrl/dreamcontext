/**
 * The window never draws a live job's card in Others while there is any other way (task
 * super-canli-kart-sahnede, owner 2026-10-23: "running jobs' cards keep not being floating on the
 * stage"). The record says float; the stage used to DRAW it in Others when:
 *  - a side was too full (a live chat gave way like any finished one);
 *  - side by side or a presentation was on (every card not shown went to Others);
 *  - a narrow stage put every card in Others (now: live jobs lead the stack).
 * Invariants, not pixels.
 */
import { describe, it, expect } from 'vitest';
import { NARROW_STAGE_PX, STAGE, childIsLive, planStage, stageItems, type StagePlan } from '../../dashboard/src/components/sleepy/super/superLayout.js';
import type { SuperContainer, SuperState, SuperView } from '../../dashboard/src/lib/superTypes.js';

const chat = (id: string, extra: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id: `chat-${id}`, kind: 'chat', ref: id, shape: 'tall', place: 'float', ...extra });
const pic = (id: string, extra: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id: `image-${id}`, kind: 'image', ref: `docs/${id}.png`, shape: 'square', place: 'float', ...extra });
const STAGE_1440 = { width: 1384, height: 814 };
const liveOf = (ids: readonly string[]) => (c: SuperContainer) => ids.includes(c.ref);
const where = (p: StagePlan, id: string) => p.cards[id]?.where;
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('childIsLive (the window\'s copy of the server rule)', () => {
  it('a live row, an open question or a working session is live; done, gone, ended are not', () => {
    const s = {
      children: {
        w: { sessionId: 'w', brief: '', adopted: false, startedAt: 1, row: 'waiting' },
        q: { sessionId: 'q', brief: '', adopted: false, startedAt: 1, row: 'done' },
        b: { sessionId: 'b', brief: '', adopted: false, startedAt: 1, row: 'done' },
        d: { sessionId: 'd', brief: '', adopted: false, startedAt: 1, row: 'done' },
        g: { sessionId: 'g', brief: '', adopted: false, startedAt: 1, row: 'gone' },
        e: { sessionId: 'e', brief: '', adopted: false, startedAt: 1, row: 'working', endedAt: 3 },
      },
      queue: [{ id: 'q-1', sessionId: 'q', kind: 'question', state: 'escalated', createdAt: 1 }],
    } as unknown as SuperState;
    expect(childIsLive(s, 'w', null)).toBe(true);
    expect(childIsLive(s, 'q', null)).toBe(true);
    expect(childIsLive(s, 'b', 'working')).toBe(true);
    expect(childIsLive(s, 'd', 'ready')).toBe(false);
    expect(childIsLive(s, 'g', null)).toBe(false);
    expect(childIsLive(s, 'e', 'working')).toBe(false);
  });
});

describe('float: a too-full side gives up everything else before a live job', () => {
  it('on a crowded stage every live chat is drawn floating; pictures and finished chats go to Others first', () => {
    // 30 items: far more than the 1440 stage holds. The live jobs come LAST in the record (the
    // ones a side used to drop first).
    const finished = Array.from({ length: 12 }, (_, i) => chat(`f${i}`));
    const pics = Array.from({ length: 12 }, (_, i) => pic(`p${i}`));
    const live = Array.from({ length: 6 }, (_, i) => chat(`l${i}`));
    const items = stageItems([...finished, ...pics, ...live], [], { mode: 'float' }, liveOf(live.map((c) => c.ref)));
    const p = planStage(items, { mode: 'float' }, STAGE_1440);
    expect(p.others.length).toBeGreaterThan(0);
    for (const c of live) expect(where(p, c.id)).toBe('float');
    // Others leads with nothing live (none is there) and holds the pictures before any chat.
    expect(p.others.some((id) => id.startsWith('image-'))).toBe(true);
  });

  it('sized cards too: a large picture shrinks and goes before a live job does', () => {
    const items = stageItems(
      [...Array.from({ length: 10 }, (_, i) => pic(`p${i}`, { size: 'large' })), chat('l1'), chat('l2')],
      [], { mode: 'float' }, liveOf(['l1', 'l2']),
    );
    const p = planStage(items, { mode: 'float' }, STAGE_1440);
    expect(where(p, 'chat-l1')).toBe('float');
    expect(where(p, 'chat-l2')).toBe('float');
  });

  it('a group holding a live job is kept like a live job', () => {
    const items = stageItems(
      [...Array.from({ length: 20 }, (_, i) => pic(`p${i}`)), chat('l1'), pic('x')],
      [{ id: 'grp-live', name: 'Live', cards: ['chat-l1', 'image-x'], place: 'float' }],
      { mode: 'float' }, liveOf(['l1']),
    );
    expect(items.find((i) => i.id === 'grp-live')?.live).toBe(true);
    expect(where(planStage(items, { mode: 'float' }, STAGE_1440), 'grp-live')).toBe('float');
  });
});

describe('side by side and present: live jobs stay beside the page', () => {
  const record = [chat('l1'), chat('l2'), chat('done'), pic('p1'), pic('page')];
  const live = liveOf(['l1', 'l2']);
  for (const view of [{ mode: 'half', card: 'image-page' }, { mode: 'present', cards: ['image-page', 'image-p1'] }] as SuperView[]) {
    it(`${view.mode}: live chats are tiles in a left column, the rest in Others, nothing overlaps`, () => {
      const p = planStage(stageItems(record, [], view, live), view, STAGE_1440);
      expect(where(p, 'chat-l1')).toBe('float');
      expect(where(p, 'chat-l2')).toBe('float');
      expect(where(p, 'chat-done')).toBe('others');
      const rail = [p.cards['chat-l1'].rect, p.cards['chat-l2'].rect];
      for (const r of rail) {
        expect(r.width).toBe(STAGE.TILE);
        expect(r.x + r.width).toBeLessThanOrEqual(p.centre.x);
        expect(overlaps(r, p.centre)).toBe(false);
        for (const id of view.mode === 'half' ? [view.card!] : view.cards!) expect(overlaps(r, p.cards[id].rect)).toBe(false);
      }
      expect(overlaps(rail[0], rail[1])).toBe(false);
    });
  }

  it('present on a smaller stage: the centre and the presented cards keep PRESENT_MIN, the rail gives way', () => {
    const view: SuperView = { mode: 'present', cards: ['image-a', 'image-b', 'image-c', 'image-d'] };
    const live = Array.from({ length: 5 }, (_, i) => chat(`l${i}`));
    const record = [...live, pic('a'), pic('b'), pic('c'), pic('d')];
    for (const width of [1040, 1100, 1240]) {
      const p = planStage(stageItems(record, [], view, liveOf(live.map((c) => c.ref))), view, { width, height: 700 });
      expect(p.centre.width).toBeGreaterThanOrEqual(STAGE.PRESENT_MIN);
      const shown = view.cards!.map((id) => p.cards[id].rect);
      const region = Math.max(...shown.map((r) => r.x + r.width)) - Math.min(...shown.map((r) => r.x));
      expect(region).toBeGreaterThanOrEqual(STAGE.PRESENT_MIN - 1);
      for (const r of shown) expect(r.width).toBeGreaterThanOrEqual((STAGE.PRESENT_MIN - STAGE.GAP) / 2 - 1);
      // Whatever the rail cannot hold leads Others.
      const railed = live.filter((c) => where(p, c.id) === 'float').length;
      expect(p.others.slice(0, live.length - railed).every((id) => id.startsWith('chat-l'))).toBe(true);
    }
  });

  it('a live card the owner put away himself (in Others) is not pulled onto the rail', () => {
    const view: SuperView = { mode: 'half', card: 'image-page' };
    const p = planStage(stageItems([chat('l1', { place: 'others' }), pic('page')], [], view, liveOf(['l1'])), view, STAGE_1440);
    expect(where(p, 'chat-l1')).toBe('others');
  });

  it('no live job: the half page is exactly as before (centre and page share the content)', () => {
    const view: SuperView = { mode: 'half', card: 'image-page' };
    const p = planStage(stageItems([chat('done'), pic('page')], [], view), view, STAGE_1440);
    expect(p.centre.x).toBe(STAGE.MARGIN);
    expect(where(p, 'chat-done')).toBe('others');
  });
});

describe('narrow: every card is in Others, live jobs first', () => {
  it('the Others stack leads with the live jobs, then record order', () => {
    const p = planStage(stageItems([pic('a'), chat('done'), chat('l1'), pic('b')], [], { mode: 'float' }, liveOf(['l1'])),
      { mode: 'float' }, { width: NARROW_STAGE_PX - 100, height: 800 });
    expect(p.others).toEqual(['chat-l1', 'image-a', 'chat-done', 'image-b']);
  });
});
