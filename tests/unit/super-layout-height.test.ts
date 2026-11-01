/**
 * The floating chat uses the stage's height at ANY proportion (owner 2026-11-01, a 1108x932
 * window: 60 px of nothing above the chat). A band stands only for what it holds; a pill with no
 * room beside the chat moves to the chat's head and never takes height.
 */
import { describe, expect, it } from 'vitest';
import { STAGE, planStage, type StageItem, type StagePlan } from '../../dashboard/src/components/sleepy/super/superLayout.js';

const FLOAT = { mode: 'float' as const };
const card = (id: string, extra: Partial<StageItem> = {}): StageItem => ({ id, kind: 'task', ref: id, place: 'float', shape: 'square', ...extra } as StageItem);
const away = (id: string) => card(id, { place: 'others' });
const { MARGIN: M, BAND } = STAGE;

/** The stage each window leaves in the shell (measured in Chromium, 2026-11-01), and the same
 *  proportions a sidebar wider: tall-narrow, short-wide and ordinary. */
const STAGES = [
  [742, 858], [854, 918], [814, 926], [774, 636], [914, 646], [1074, 826], [1554, 1006], [2194, 1366],
  [660, 1000], [1039, 500], [1040, 500], [1041, 1400], [3000, 700],
].map(([width, height]) => ({ width, height }));

const label = (s: { width: number; height: number }) => `${s.width}x${s.height}`;
const gaps = (p: StagePlan) => ({ top: p.centre.y, bottom: p.height - p.centre.y - p.centre.height });
const hits = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('a bare stage: the chat, Others and the agenda pill', () => {
  for (const s of STAGES) for (const lean of [false, true]) {
    it(`${label(s)}${lean ? ' leaning' : ''}: margin to margin, and no pill over the chat`, () => {
      const p = planStage([away('a'), away('b'), away('c')], FLOAT, s, { agendaPill: 'ag', leanRight: lean });
      expect(gaps(p), label(s)).toEqual({ top: M, bottom: M });
      expect(p.others).toHaveLength(3);
      if (!p.othersInHead) expect(hits(p.othersRect, p.centre), 'Others').toBe(false);
      if (!p.agendaInHead) expect(hits(p.agendaPill, p.centre), 'agenda').toBe(false);
    });
  }

  for (const s of STAGES) for (const lean of [false, true]) {
    it(`${label(s)}${lean ? ' leaning' : ''}: the minimised agenda alone leaves no band either`, () => {
      const p = planStage([], FLOAT, s, { agendaPill: 'ag', leanRight: lean });
      expect(gaps(p), label(s)).toEqual({ top: M, bottom: M });
      if (!p.agendaInHead) expect(hits(p.agendaPill, p.centre), 'agenda').toBe(false);
    });
  }

  it('a narrow stage has no side room: both corners go to the head, the sides stay the margin', () => {
    const p = planStage([away('a')], FLOAT, { width: 854, height: 918 }, { agendaPill: 'ag' });
    expect(p.narrow).toBe(true);
    expect(p.phone).toBe(false);
    expect([p.othersInHead, p.agendaInHead]).toEqual([true, true]);
    expect(p.centre).toEqual({ x: M, y: M, width: 854 - 2 * M, height: 918 - 2 * M });
  });

  it('a wide stage keeps its pills beside the chat', () => {
    const p = planStage([away('a')], FLOAT, { width: 2194, height: 1366 }, { agendaPill: 'ag' });
    expect([p.othersInHead, p.agendaInHead]).toEqual([false, false]);
    expect(p.othersRect.x).toBeGreaterThanOrEqual(p.centre.x + p.centre.width + STAGE.GAP);
  });

  it('a chat leaning right keeps its height: Others goes to the head, the drop corner stays beside it', () => {
    const p = planStage([card('tile'), away('a')], FLOAT, { width: 1074, height: 826 }, { agendaPill: 'ag', leanRight: true });
    expect(p.height - p.centre.y - p.centre.height).toBe(M);
    expect(p.centre.x).toBeGreaterThan(p.width - p.centre.x - p.centre.width);
    expect(p.othersInHead).toBe(true);
    expect(p.othersZone.width).toBeGreaterThan(0);
    expect(p.othersZone.x).toBeGreaterThanOrEqual(p.centre.x + p.centre.width);
  });
});

describe('a band stands only for what it holds', () => {
  for (const s of STAGES) {
    it(`${label(s)}: the queue pill takes the top alone`, () => {
      const g = gaps(planStage([away('a')], FLOAT, s, { queueUp: true }));
      expect(g).toEqual({ top: M + BAND, bottom: M });
    });
    it(`${label(s)}: the terminals' dock takes the bottom alone, Others stays in it`, () => {
      const p = planStage([away('a')], FLOAT, s, { terminals: 1 });
      expect(gaps(p)).toEqual({ top: M, bottom: M + BAND });
      expect(p.othersInHead).toBe(false);
      expect(p.othersRect.y).toBeGreaterThanOrEqual(p.centre.y + p.centre.height);
    });
    it(`${label(s)}: an empty stage's hint takes the bottom alone`, () => {
      const p = planStage([], FLOAT, s);
      expect(gaps(p)).toEqual({ top: M, bottom: M + BAND });
      expect(p.dock.y).toBeGreaterThanOrEqual(p.centre.y + p.centre.height);
    });
  }
});

describe('what is not the bare stage keeps its layout', () => {
  it('a phone-width stage is still the chat edge to edge', () => {
    const p = planStage([away('a')], FLOAT, { width: 390, height: 757 });
    expect(p.phone).toBe(true);
    expect(p.centre).toEqual({ x: 0, y: 0, width: 390, height: 757 });
    expect([p.othersInHead, p.agendaInHead]).toEqual([true, true]);
  });

  it('a sheet over a narrow stage keeps both bands: its exits live there', () => {
    const p = planStage([card('a')], { mode: 'half', card: 'a' }, { width: 854, height: 918 });
    expect(gaps(p)).toEqual({ top: M + BAND, bottom: M + BAND });
    expect(p.othersInHead).toBe(false);
  });

  it('side by side and a presentation on a wide stage keep their bands', () => {
    const half = planStage([card('a')], { mode: 'half', card: 'a' }, { width: 1554, height: 1006 });
    expect(half.centre.y).toBe(M + BAND);
    const pres = planStage([card('a'), card('b')], { mode: 'present', cards: ['a', 'b'] }, { width: 1554, height: 1006 });
    expect(pres.centre.y).toBe(M + BAND);
    expect(pres.othersInHead).toBe(false);
  });

  it('side cards do not move: only the chat takes the height', () => {
    const cs = [card('a'), card('b'), card('c')];
    const p = planStage(cs, FLOAT, { width: 1554, height: 1006 });
    expect(gaps(p)).toEqual({ top: M, bottom: M });
    for (const c of ['a', 'b', 'c']) expect(p.cards[c].where).toBe('float');
  });
});
