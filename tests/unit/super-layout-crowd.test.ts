/**
 * A crowded stage keeps the chat's width (owner 2026-11-06 00:21, "bu size paylaşımı yine
 * saçmaladı, birden buna döndü"): with the agenda and a large web card beside eight live jobs, a
 * ninth used to open a THIRD column on one side. The centre stays in the middle, so the same width
 * came off the other side too and the chat lost 368 px (1713 x 990: 929 -> 561). His own drags
 * re-ran the same solve and the chat jumped between ~650 and ~1075 under his hand. AC9 of the
 * stage task (2026-10-29): no card pushes the chat.
 * Invariants across real window sizes, not pixels.
 */
import { describe, it, expect } from 'vitest';
import { STAGE, planStage, preferredCentre, stageItems, type Rect, type StagePlan } from '../../dashboard/src/components/sleepy/super/superLayout.js';
import type { SuperContainer, SuperView } from '../../dashboard/src/lib/superTypes.js';

const FLOAT: SuperView = { mode: 'float' };
const job = (i: number, extra: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id: `chat-j${i}`, kind: 'chat', ref: `j${i}`, shape: 'tall', place: 'float', ...extra });
const agenda = (extra: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id: 'agenda-1', kind: 'agenda', ref: 'agenda', shape: 'square', place: 'float', size: 'large', ...extra } as SuperContainer);
const web = (extra: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id: 'web-1', kind: 'web', ref: '_dream_context/tmp/super/page.html', shape: 'square', place: 'float', size: 'large', ...extra });
const done = (i: number): SuperContainer => ({ id: `chat-d${i}`, kind: 'chat', ref: `d${i}`, shape: 'tall', place: 'others' });

/** The owner's stage: the agenda first, the web card among the jobs, finished cards in Others. */
function record(live: number, over: { web?: Partial<SuperContainer>; job0?: Partial<SuperContainer> } = {}): SuperContainer[] {
  const jobs = Array.from({ length: live }, (_, i) => job(i, i === 0 ? over.job0 : undefined));
  return [agenda(), ...jobs.slice(0, 4), web(over.web), ...jobs.slice(4), done(1), done(2), done(3)];
}
const items = (cs: SuperContainer[]) => stageItems(cs, [], FLOAT, (c) => c.kind === 'chat' && c.place === 'float');

/** The stages a window leaves (the rail and the header off): 1440 x 900, ~1800 x 1080 (the
 *  owner's screenshots), 1800 x 1080 with the drawer closed. */
const STAGES = [
  { width: 1384, height: 814 },
  { width: 1700, height: 990 },
  { width: 1744, height: 990 },
];

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const floats = (p: StagePlan) => Object.values(p.cards).filter((c) => c.where === 'float');

function sound(p: StagePlan) {
  for (const c of floats(p)) {
    expect(c.rect.x).toBeGreaterThanOrEqual(-0.5);
    expect(c.rect.y).toBeGreaterThanOrEqual(-0.5);
    expect(c.rect.x + c.rect.width).toBeLessThanOrEqual(p.width + 0.5);
    expect(c.rect.y + c.rect.height).toBeLessThanOrEqual(p.height + 0.5);
    expect(overlaps(c.rect, p.centre), `${c.id} over the chat`).toBe(false);
    for (const d of floats(p)) if (c.id < d.id) expect(overlaps(c.rect, d.rect), `${c.id} over ${d.id}`).toBe(false);
  }
}

describe('a card more never narrows the chat (owner 2026-11-06)', () => {
  for (const s of STAGES) {
    it(`8 -> 9 -> 12 live jobs beside the agenda and a large web card at ${s.width}x${s.height}`, () => {
      const base = planStage(items(record(8)), FLOAT, s);
      for (let n = 8; n <= 12; n++) {
        const p = planStage(items(record(n)), FLOAT, s);
        expect(p.centre.width, `${n} live jobs`).toBeCloseTo(base.centre.width, 6);
        // In the middle.
        expect(Math.abs(p.centre.x - (p.width - p.centre.x - p.centre.width))).toBeLessThanOrEqual(1);
        // Every live job stays in sight: on the stage (cards squeeze or cross sides first), else
        // in the "more" pill beside Others, never lost in the Others stack.
        for (let i = 0; i < n; i++) {
          const id = `chat-j${i}`;
          expect(p.cards[id]?.where === 'float' || !!p.more?.ids.includes(id), `${id} with ${n} jobs`).toBe(true);
          expect(p.others, `${id} with ${n} jobs`).not.toContain(id);
        }
        if (p.more) for (const c of floats(p)) expect(overlaps(c.rect, p.more.rect), `${c.id} over the more pill`).toBe(false);
        sound(p);
      }
    });
  }

  it('the exact screenshot (1713 x 990, nine jobs): the chat keeps ~930 px, not 561', () => {
    const p = planStage(items(record(9)), FLOAT, { width: 1713, height: 990 });
    expect(p.centre.width).toBeGreaterThan(900);
    // No side grew a third column for it.
    expect(p.unit.left).toBeLessThanOrEqual(2 * STAGE.TILE + STAGE.GAP);
    expect(p.unit.right).toBeLessThanOrEqual(2 * STAGE.TILE + STAGE.GAP);
  });

  it('a third column still opens where it costs the chat nothing (a 2560 stage)', () => {
    const s = { width: 2560, height: 990 };
    const p = planStage(items(record(12)), FLOAT, s);
    expect(p.centre.width).toBeCloseTo(preferredCentre(s.width), 6);
    expect(Math.max(p.unit.left, p.unit.right)).toBeGreaterThan(2 * STAGE.TILE + STAGE.GAP);
    for (let i = 0; i < 12; i++) expect(p.cards[`chat-j${i}`]?.where).toBe('float');
    expect(p.more).toBeUndefined();
    sound(p);
  });
});

describe('what the owner placed and sized stays put as more cards open', () => {
  for (const s of STAGES) {
    it(`his dropped job and his sized web card keep their place and size at ${s.width}x${s.height}`, () => {
      // He dropped a job top-left and grew the web card where he put it (left side, under it).
      const over = { job0: { pos: { x: 0, y: 0 } }, web: { pos: { x: 0, y: 0.45 }, size: 'large' as const, sizeBy: 'owner' as const } };
      const first = planStage(items(record(8, over)), FLOAT, s);
      const pinnedJob = first.cards['chat-j0'];
      const pinnedWeb = first.cards['web-1'];
      expect(pinnedJob.owner).toBe(true);
      expect(pinnedWeb.owner).toBe(true);
      for (let n = 9; n <= 12; n++) {
        const p = planStage(items(record(n, over)), FLOAT, s);
        expect(p.centre.width, `${n} jobs`).toBeCloseTo(first.centre.width, 6);
        expect(p.cards['chat-j0'].rect, `his job with ${n}`).toEqual(pinnedJob.rect);
        expect(p.cards['web-1'].rect, `his web card with ${n}`).toEqual(pinnedWeb.rect);
        expect(p.cards['web-1'].size).toBe(pinnedWeb.size);
        sound(p);
      }
    });
  }
});

describe('the agenda\'s width never pays for jobs (the real app at 1800 x 1080, 2026-11-06)', () => {
  // The verify's stage: with fourteen jobs the agenda's 2-tile allowance opened a second column on
  // each side while the agenda itself was drawn 1 tile wide; the chat lost 17 px. And at nine, the
  // plan that leaned for the agenda lost to a centred, narrower one over a single job.
  const STAGES_AG = [{ width: 1744, height: 994 }, { width: 1700, height: 990 }, { width: 1384, height: 814 }];
  for (const s of STAGES_AG) {
    for (const dropped of [false, true]) {
      it(`4 -> 16 jobs beside a large agenda at ${s.width}x${s.height}${dropped ? ', one job dropped by the owner' : ''}: the chat never narrows`, () => {
        let last = Infinity;
        for (let n = 4; n <= 16; n++) {
          const cs = [agenda(), ...Array.from({ length: n }, (_, i) => job(i, dropped && i === 0 ? { pos: { x: 0, y: 0 } } : {})), done(1), done(2)];
          const p = planStage(items(cs), FLOAT, s);
          expect(p.centre.width, `${n} jobs`).toBeGreaterThanOrEqual(Math.min(last, preferredCentre(s.width)) - 1e-6);
          last = p.centre.width;
          for (let i = 0; i < n; i++) expect(p.others, `chat-j${i} with ${n}`).not.toContain(`chat-j${i}`);
          sound(p);
        }
      });
    }
  }
});

describe('the end review\'s cases (r1)', () => {
  const isLive = (c: SuperContainer) => c.kind === 'chat' && c.place === 'float';
  const at = (live: number, webAt: number) => {
    const jobs = Array.from({ length: live }, (_, i) => job(i));
    return [agenda(), ...jobs.slice(0, webAt), web(), ...jobs.slice(webAt), done(1), done(2), done(3)];
  };
  for (const s of [{ width: 1713, height: 990 }, { width: 1744, height: 994 }, { width: 1384, height: 814 }]) {
    for (const webAt of [3, 4]) {
      for (const leanRight of [false, true]) {
        it(`${s.width}: web card ${webAt === 3 ? 'on the agenda\'s side' : 'across'}${leanRight ? ', drawer open' : ''}: the chat never drops below its width at four jobs, no live job lost`, () => {
          const floor = planStage(stageItems(at(4, webAt), [], FLOAT, isLive), FLOAT, s, { leanRight: false }).centre.width;
          for (let n = 4; n <= 16; n++) {
            const p = planStage(stageItems(at(n, webAt), [], FLOAT, isLive), FLOAT, s, { leanRight });
            expect(p.centre.width, `${n} jobs`).toBeGreaterThanOrEqual(floor - 1e-6);
            for (let i = 0; i < n; i++) expect(p.others, `${n} jobs`).not.toContain(`chat-j${i}`);
            // A live job waits in the pill only once no picture or finished card floats.
            if (p.more?.ids.length) expect(p.cards['web-1']?.where, `${n} jobs: the web card floats while a job waits`).not.toBe('float');
            sound(p);
          }
        });
      }
    }
  }

  it('picking any card up changes nothing on the stage, the chat included (re-check r2: 1700-1780, web card on the agenda\'s side, drawer open)', () => {
    for (const s of [...STAGES, { width: 1713, height: 990 }, { width: 1760, height: 990 }, { width: 1780, height: 990 }]) {
      for (const webAt of [3, 4]) {
        for (const leanRight of [false, true]) {
          for (let n = 8; n <= 12; n++) {
            const its = stageItems(at(n, webAt), [], FLOAT, isLive);
            const still = planStage(its, FLOAT, s, { leanRight });
            for (const pick of Object.keys(still.cards).filter((id) => still.cards[id].where === 'float')) {
              const held = planStage(its, FLOAT, s, { leanRight, dragging: { id: pick, rect: still.cards[pick].rect } });
              const label = `${s.width} web@${webAt} lean=${leanRight} ${n} jobs, ${pick} held`;
              expect(held.centre, label).toEqual(still.centre);
              for (const id of Object.keys(still.cards)) {
                if (id === pick) continue;
                expect(held.cards[id]?.where, `${label}: ${id}`).toBe(still.cards[id].where);
                expect(held.cards[id]?.rect, `${label}: ${id}`).toEqual(still.cards[id].rect);
              }
            }
          }
        }
      }
    }
  });

  it('with a terminal docked, a live job with no room waits in the pill, never in Others, and the dock ends before it', () => {
    const p = planStage(items(record(12)), FLOAT, { width: 1384, height: 814 }, { terminals: 1 });
    for (let i = 0; i < 12; i++) expect(p.others).not.toContain(`chat-j${i}`);
    expect(p.more?.ids.length ?? 0).toBeGreaterThan(0);
    expect(overlaps(p.more!.rect, p.othersRect)).toBe(false);
    expect(p.dock.x + p.dock.width).toBeLessThanOrEqual(p.more!.rect.x - STAGE.GAP + 0.5);
  });

  it('a live group with no room stays in Others (where the window draws it), never in the pill', () => {
    const cs = record(12);
    const groups = [{ id: 'grp-a', name: 'Pair', cards: ['chat-j10', 'chat-j11'], place: 'float' }] as unknown as Parameters<typeof stageItems>[1];
    const p = planStage(stageItems(cs, groups, FLOAT, (c) => c.kind === 'chat' && c.place === 'float'), FLOAT, { width: 1384, height: 814 });
    expect(p.more?.ids ?? []).not.toContain('grp-a');
    expect(p.cards['grp-a']?.where === 'float' || p.others.includes('grp-a')).toBe(true);
  });
});
