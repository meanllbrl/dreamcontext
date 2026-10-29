/**
 * Room to grow (owner 2026-10-29 on 0.36.1, "alan var mı?"): he drags the corner of a card in the
 * empty column beside the centre chat to make it 2x2 and the outline says "No room: the centre
 * chat needs its width", though the column is free.
 *
 *  - the check asks the plan with the card grown WHERE IT IS (its inner top corner held, the spot
 *    the write records), not at its old pos fraction, which for a bigger card is another spot;
 *  - a card the owner placed stands at his spot, not in its side's column: a side too tall for the
 *    column no longer shrinks it (it is set aside from the column at the size he chose);
 *  - a size that truly cannot be drawn (the centre would lose its floor) is still refused.
 */
import { describe, it, expect } from 'vitest';
import {
  STAGE, anchoredPos, fitsNow, planStage, stageItems, type Rect, type StagePlan,
} from '../../dashboard/src/components/sleepy/super/superLayout.js';
import type { ContainerSize, SuperContainer } from '../../dashboard/src/lib/superTypes.js';

const FLOAT = { mode: 'float' as const };
const EPS = 1e-6;
/** The stage a 1440x900 window leaves; the owner's screenshot (an 1800x1169 window). */
const S1440 = { width: 1384, height: 814 };
const OWNER = { width: 1744, height: 1083 };

const c = (id: string, kind: string, extra: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id, kind, ref: `r-${id}`, shape: 'square', place: 'float', ...extra } as SuperContainer);
const overlaps = (a: Rect, b: Rect, gap = 0) =>
  a.x < b.x + b.width + gap - EPS && b.x < a.x + a.width + gap - EPS && a.y < b.y + b.height + gap - EPS && b.y < a.y + a.height + gap - EPS;

function expectSound(p: StagePlan, label: string) {
  const fl = Object.values(p.cards).filter((k) => k.where === 'float');
  for (const k of fl) {
    expect(overlaps(k.rect, p.centre), `${label}: ${k.id} over the centre`).toBe(false);
    expect(k.rect.x >= -EPS && k.rect.y >= -EPS && k.rect.x + k.rect.width <= p.width + EPS && k.rect.y + k.rect.height <= p.height + EPS, `${label}: ${k.id} off the stage`).toBe(true);
    for (const d of fl) if (k.id < d.id) expect(overlaps(k.rect, d.rect, STAGE.GAP - 1), `${label}: ${k.id} overlaps ${d.id}`).toBe(false);
  }
}

/** The corner gesture end to end: the check, then the write it makes, then the stage drawn. */
function grow(cs: SuperContainer[], stage: { width: number; height: number }, id: string, size: ContainerSize, opts: { recent?: string[]; live?: string[] } = {}) {
  const isLive = (k: SuperContainer) => (opts.live ?? []).includes(k.id);
  const items = stageItems(cs, [], FLOAT, isLive);
  const before = planStage(items, FLOAT, stage, { recent: opts.recent });
  const cp = before.cards[id];
  const side: 'left' | 'right' = cp.rect.x + cp.rect.width / 2 < before.centre.x + before.centre.width / 2 ? 'left' : 'right';
  const at = { free: before.free, rect: cp.rect, side };
  const fits = fitsNow(items, FLOAT, stage, id, size, { recent: opts.recent }, at);
  const pos = anchoredPos(before.free, cp.rect, size, side);
  const written = cs.map((k) => (k.id === id ? { ...k, size, sizeBy: 'owner' as const, pos } : k));
  const after = planStage(stageItems(written, [], FLOAT, isLive), FLOAT, stage, { recent: [...(opts.recent ?? []).filter((x) => x !== id), id] });
  return { before, after, fits, cp, side };
}

describe('a card grows into the empty column beside the centre', () => {
  it('1440x900: the free column right of the centre takes 2x2 (the old check said no room)', () => {
    // A wide agenda he dropped right, a medium card and the card he grows under it, all his.
    const cs = [
      c('ag', 'agenda', { ref: 'agenda', size: 'wide', pos: { x: 0.998, y: 0.383 } }),
      c('c0', 'task', { pos: { x: 0.712, y: 0.530 }, size: 'medium' }),
      c('c1', 'task', { pos: { x: 0.714, y: 0.632 } }),
      c('c2', 'chat', { size: 'medium' }),
    ];
    const { before, after, fits, cp } = grow(cs, S1440, 'c1', 'large');
    const room = S1440.width - STAGE.MARGIN - (before.centre.x + before.centre.width + STAGE.GAP);
    expect(room).toBeGreaterThanOrEqual(344 - EPS);
    expect(fits).toBe(true);
    const d = after.cards.c1;
    expect(d.where).toBe('float');
    expect(d.size).toBe('large');
    // Grown from its inner top corner where he sees it; the centre chat unmoved.
    expect(d.rect.x).toBeCloseTo(cp.rect.x, 0);
    expect(d.rect.y).toBeCloseTo(cp.rect.y, 0);
    expect(after.centre).toEqual(before.centre);
    expectSound(after, '1440 c1');
  });

  it('1440x900: a card he placed at the top right grows though its side is too tall for a column', () => {
    const cs = [
      c('ag', 'agenda', { ref: 'agenda', size: 'large', pos: { x: 0.944, y: 0.739 } }),
      c('c0', 'task', { pos: { x: 0.769, y: 0.823 } }),
      c('c1', 'task', { size: 'medium' }),
      c('c2', 'task', { pos: { x: 0.827, y: 0.092 } }),
    ];
    const { after, fits, cp } = grow(cs, S1440, 'c2', 'large', { recent: ['c0', 'c2'], live: ['c0', 'c2'] });
    expect(fits).toBe(true);
    expect(after.cards.c2.size).toBe('large');
    expect(after.cards.c2.rect.y).toBeCloseTo(cp.rect.y, 0);
    expectSound(after, '1440 c2');
  });

  it('his window: his 2x2 agenda and a 3x2 picture under the card, a free 2x2 beside the centre (the old check said no room)', () => {
    const cs = [
      c('ag', 'agenda', { ref: 'agenda', size: 'large', sizeBy: 'owner', pos: { x: 0.911, y: 0.932 } }),
      c('chat', 'chat', { place: 'others' }),
      c('tA', 'task', { pos: { x: 0.003, y: 0.558 } }),
      c('p1', 'image', { size: 'wide', sizeBy: 'owner', pos: { x: 0.916, y: 0.886 } }),
      c('p2', 'image', { size: 'large', sizeBy: 'owner' }),
      c('wb', 'whiteboard'),
      c('tB', 'task', { pos: { x: 0.868, y: 0.633 } }),
    ];
    const { before, after, fits, cp } = grow(cs, OWNER, 'tB', 'large');
    const g: Rect = { x: cp.rect.x, y: cp.rect.y, width: 344, height: 344 };
    expect(Object.values(before.cards).some((d) => d.id !== 'tB' && d.where === 'float' && overlaps(g, d.rect, STAGE.GAP - 1))).toBe(false);
    expect(fits).toBe(true);
    expect(after.cards.tB).toMatchObject({ where: 'float', size: 'large' });
    expect(after.cards.tB.rect.x).toBeCloseTo(cp.rect.x, 0);
    expect(after.cards.tB.rect.y).toBeCloseTo(cp.rect.y, 0);
    expectSound(after, 'his window');
  });

  it('the owner\'s stage (his screenshot): the live job right of the centre grows 2x2 in place', () => {
    const cs = [
      c('agenda-1', 'agenda', { ref: 'agenda', pos: { x: 0, y: 0 }, size: 'large', sizeBy: 'owner' }),
      c('chat-a', 'chat', { pos: { x: 0.0755, y: 0.4526 } }),
      c('chat-b', 'chat', { pos: { x: 0.0779, y: 0.5873 } }),
      c('chat-o1', 'chat', { place: 'others' }),
      c('board', 'whiteboard', { pos: { x: 0.9365, y: 0.0844 }, sizeBy: 'owner' }),
      c('chat-o2', 'chat', { place: 'others' }),
      c('chat-o3', 'chat', { place: 'others' }),
      c('chat-d2', 'chat', { pos: { x: 0.882, y: 0.607 } }),
    ];
    const { before, after, fits, cp } = grow(cs, OWNER, 'chat-d2', 'large', { recent: ['agenda-1'], live: ['chat-d2'] });
    expect(cp.rect.x).toBeGreaterThan(before.centre.x + before.centre.width);
    expect(fits).toBe(true);
    expect(after.cards['chat-d2']).toMatchObject({ where: 'float', size: 'large' });
    expect(after.cards['chat-d2'].rect.y).toBeCloseTo(cp.rect.y, 0);
    expect(after.centre).toEqual(before.centre);
    // His agenda keeps its size and its spot top-left.
    expect(after.cards['agenda-1']).toMatchObject({ where: 'float', size: 'large' });
    expectSound(after, 'owner');
  });

  it('a size that truly cannot be drawn is still refused: 3x2 beside a centre already at its floor', () => {
    const cs = [
      c('pic', 'image', { size: 'large', sizeBy: 'owner', pos: { x: 0, y: 0.2 } }),
      c('a', 'task', { pos: { x: 0.9, y: 0.5 } }),
    ];
    const { before, fits } = grow(cs, S1440, 'a', 'wide');
    // 2x2 on the left, 3x2 on the right and the centre at its floor are wider than the stage.
    expect(2 * STAGE.MARGIN + 344 + 528 + 2 * STAGE.GAP + STAGE.CENTRE_MIN).toBeGreaterThan(before.width);
    expect(fits).toBe(false);
    expect(grow(cs, S1440, 'a', 'large').fits).toBe(true);
  });

  it('on any stage: a 2x2 whose rect is free beside the card it grows from is never refused, and is drawn sound', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const side = () => (rnd() < 0.5 ? rnd() * 0.3 : 0.7 + rnd() * 0.3);
    let tried = 0;
    for (let k = 0; k < 1500; k++) {
      const stage = [OWNER, { width: 1944, height: 1214 }, S1440][k % 3];
      const cs: SuperContainer[] = [];
      if (rnd() < 0.8) cs.push(c('ag', 'agenda', { ref: 'agenda', size: (['small', 'medium', 'large', 'wide'] as const)[Math.floor(rnd() * 4)], ...(rnd() < 0.7 ? { pos: { x: side(), y: rnd() } } : {}) }));
      const n = 3 + Math.floor(rnd() * 5);
      for (let i = 0; i < n; i++) cs.push(c(`c${i}`, rnd() < 0.6 ? 'chat' : 'task', { place: rnd() < 0.15 ? 'others' : 'float', ...(rnd() < 0.7 ? { pos: { x: side(), y: rnd() } } : {}), ...(rnd() < 0.2 ? { size: 'medium' as const } : {}) }));
      const live = cs.filter(() => rnd() < 0.3).map((x) => x.id);
      const recent = rnd() < 0.5 ? cs.filter((x) => x.pos && rnd() < 0.5).map((x) => x.id) : [];
      const p = planStage(stageItems(cs, [], FLOAT, (x) => live.includes(x.id)), FLOAT, stage, { recent });
      for (const x of cs) {
        const r = p.cards[x.id];
        if (x.kind === 'agenda' || x.size || !r || r.where !== 'float') continue;
        const right = r.rect.x + r.rect.width / 2 > p.centre.x + p.centre.width / 2;
        const g: Rect = { x: right ? r.rect.x : r.rect.x + r.rect.width - 344, y: r.rect.y, width: 344, height: 344 };
        if (g.x < STAGE.MARGIN - 1 || g.x + 344 > p.width - STAGE.MARGIN + 1 || g.y + 344 > p.height - STAGE.MARGIN + 1) continue;
        if (overlaps(g, p.centre, STAGE.GAP - 1) || Object.values(p.cards).some((d) => d.id !== x.id && d.where === 'float' && overlaps(g, d.rect, STAGE.GAP - 1))) continue;
        tried++;
        const { fits, after } = grow(cs, stage, x.id, 'large', { recent, live });
        expect(fits, `stage ${stage.width}: ${x.id} in ${JSON.stringify(cs)}`).toBe(true);
        expect(after.cards[x.id]).toMatchObject({ where: 'float', size: 'large' });
        expectSound(after, `stage ${stage.width} ${x.id}`);
      }
    }
    expect(tried).toBeGreaterThan(300);
  });

  it('review r1: setting his cards aside never sends a live job to Others (two 2x2 of his, six live chats, 1440x900)', () => {
    const cs = [
      c('o1', 'task', { size: 'large', sizeBy: 'owner', pos: { x: 0.95, y: 0.1 } }),
      c('o2', 'task', { size: 'large', sizeBy: 'owner', pos: { x: 0.95, y: 0.8 } }),
      ...['a', 'b', 'd', 'e', 'f', 'g'].map((id) => c(id, 'chat')),
    ];
    const live = ['a', 'b', 'd', 'e', 'f', 'g'];
    const p = planStage(stageItems(cs, [], FLOAT, (k) => live.includes(k.id)), FLOAT, S1440);
    for (const id of live) expect(p.cards[id].where, id).toBe('float');
    // His cards stay on his side of the centre.
    for (const id of ['o1', 'o2']) if (p.cards[id].where === 'float') expect(p.cards[id].rect.x).toBeGreaterThan(p.centre.x);
    expectSound(p, 'six live');
  });

  it('review r1: on a short stage his 2x2 is never drawn off the stage, and the check does not offer it', () => {
    const stage = { width: 1600, height: 380 };
    const cs = [c('a', 'task', { size: 'large', sizeBy: 'owner', pos: { x: 0.9, y: 0.2 } }), c('b', 'chat'), c('d', 'chat')];
    const p = planStage(stageItems(cs, [], FLOAT), FLOAT, stage);
    expectSound(p, 'short');
    const small = [c('a', 'task', { pos: { x: 0.9, y: 0.2 } }), c('b', 'chat'), c('d', 'chat')];
    const g = grow(small, stage, 'a', 'large');
    if (g.fits) expectSound(g.after, 'short grown');
  });
});
