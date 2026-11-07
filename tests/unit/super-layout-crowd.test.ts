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
import { STAGE, findFree, planStage, preferredCentre, stageItems, type Rect, type StagePlan } from '../../dashboard/src/components/sleepy/super/superLayout.js';
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
        // The stage's width (owner 2026-11-06), and where it stood: no job moves it.
        expect(p.centre.width, `${n} live jobs`).toBeCloseTo(preferredCentre(s.width), 6);
        expect(p.centre.x, `${n} live jobs`).toBeCloseTo(base.centre.x, 6);
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

const isLive = (c: SuperContainer) => c.kind === 'chat' && c.place === 'float';
/** The record with the web card at index `webAt` among the jobs. */
const at = (live: number, webAt: number) => {
  const jobs = Array.from({ length: live }, (_, i) => job(i));
  return [agenda(), ...jobs.slice(0, webAt), web(), ...jobs.slice(webAt), done(1), done(2), done(3)];
};

describe('the end review\'s cases (r1)', () => {
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

describe('the owner\'s order (2026-11-06): the chat stays, his size is kept, extra jobs go to the pill', () => {
  for (const s of [{ width: 1384, height: 814 }, { width: 1700, height: 990 }, { width: 1744, height: 994 }]) {
    for (const size of ['large', 'medium'] as const) {
      it(`${s.width}: an agenda he sized ${size}, 4 -> 16 jobs: the chat never narrows and the agenda keeps his size`, () => {
        let last = 0;
        for (let n = 4; n <= 16; n++) {
          const cs = [agenda({ size, sizeBy: 'owner' }), ...Array.from({ length: n }, (_, i) => job(i))];
          const p = planStage(items(cs), FLOAT, s);
          expect(p.centre.width, `${n} jobs`).toBeGreaterThanOrEqual(last - 1e-6);
          last = p.centre.width;
          expect(p.cards['agenda-1'].size, `${n} jobs`).toBe(size);
          for (let i = 0; i < n; i++) expect(p.others, `${n} jobs`).not.toContain(`chat-j${i}`);
          sound(p);
        }
      });
    }
  }
});

describe('re-check r4', () => {
  it('a job opening while the owner holds a card never sends the held card to Others', () => {
    const job0 = { pos: { x: 0.05, y: 0.5 }, size: 'medium', sizeBy: 'owner' } as Partial<SuperContainer>;
    for (const s of [...STAGES, { width: 1713, height: 990 }]) {
      for (const leanRight of [false, true]) {
        for (let n = 6; n <= 11; n++) {
          const before = planStage(items(record(n, { job0 })), FLOAT, s, { leanRight });
          for (const pick of Object.keys(before.cards).filter((id) => before.cards[id].where === 'float')) {
            const rect = before.cards[pick].rect;
            const held = planStage(items(record(n + 1, { job0 })), FLOAT, s, { leanRight, dragging: { id: pick, rect } });
            const label = `${s.width} lean=${leanRight} ${n}->${n + 1} jobs, ${pick} held`;
            expect(held.cards[pick]?.where, label).toBe('float');
            expect(held.cards[pick]?.rect, label).toEqual(rect);
            expect(held.others, label).not.toContain(pick);
            // The chat is the plan the stage draws without the hold.
            expect(held.centre, label).toEqual(planStage(items(record(n + 1, { job0 })), FLOAT, s, { leanRight }).centre);
          }
        }
      }
    }
  });

  it('the agenda drawn a size smaller keeps the chat flat at 8 -> 12 jobs (1712-1780 x 814, web card on its side)', () => {
    for (let w = 1712; w <= 1780; w += 4) {
      const s = { width: w, height: 814 };
      const base = planStage(stageItems(at(8, 3), [], FLOAT, isLive), FLOAT, s).centre.width;
      for (let n = 9; n <= 12; n++) {
        expect(planStage(stageItems(at(n, 3), [], FLOAT, isLive), FLOAT, s).centre.width, `${w} ${n} jobs`).toBeCloseTo(base, 6);
      }
    }
  });
});

describe('the chat\'s width comes from the stage alone (owner 2026-11-06)', () => {
  it('two columns a side on his 1800 window, its share with three columns on a 1440 one', () => {
    expect(preferredCentre(1744)).toBeCloseTo(960, 6);
    expect(preferredCentre(1700)).toBeCloseTo(916, 6);
    expect(preferredCentre(1384)).toBeCloseTo(0.56 * 1384, 6);
    // Never narrower on a wider stage, past the four-column step.
    for (let w = 1700; w <= 2400; w += 10) expect(preferredCentre(w + 10)).toBeGreaterThanOrEqual(preferredCentre(w));
  });

  it('jobs opening, his agenda size, a dropped job, the web card and the drawer never change it, nor where it stands', () => {
    for (const w of [1384, 1440, 1600, 1700, 1744, 1800]) {
      for (const h of [814, 990]) {
        for (const ag of [{}, { sizeBy: 'owner' as const }, { size: 'medium' as const, sizeBy: 'owner' as const }]) {
          for (const drop of [false, true]) {
            for (const lean of [false, true]) {
              let x: number | null = null;
              for (let n = 4; n <= 14; n++) {
                const jobs = Array.from({ length: n }, (_, i) => job(i, i === 0 && drop ? { pos: { x: 0.95, y: 0.5 } } : {}));
                const cs = [agenda(ag), ...jobs.slice(0, 3), web(), ...jobs.slice(3), done(1)];
                const p = planStage(items(cs), FLOAT, { width: w, height: h }, { leanRight: lean });
                const label = `${w}x${h} ${JSON.stringify(ag)} drop=${drop} lean=${lean} ${n} jobs`;
                expect(p.centre.width, label).toBeCloseTo(preferredCentre(w), 6);
                if (x !== null) expect(p.centre.x, label).toBeCloseTo(x, 6);
                x = p.centre.x;
                if (ag.sizeBy) expect(p.cards['agenda-1'].size, label).toBe(ag.size ?? 'large');
                for (let i = 0; i < n; i++) expect(p.others, label).not.toContain(`chat-j${i}`);
                sound(p);
              }
            }
          }
        }
      }
    }
  });
});

describe('end review of 32c18385: a live job never lands in Others nor waits while a tile is free', () => {
  const S = { width: 1384, height: 814 };
  const sizedWeb = web({ pos: { x: 0, y: 0 }, size: 'large', sizeBy: 'owner' });

  it('agenda minimised, finished cards in Others, his web card top-left, six jobs: the extra job waits in a pill after the agenda pill, never in Others', () => {
    const cs = [agenda({ min: true } as Partial<SuperContainer>), sizedWeb, ...Array.from({ length: 6 }, (_, i) => job(i)), done(1), done(2), done(3)];
    const p = planStage(items(cs), FLOAT, S, { agendaPill: 'agenda-1' });
    for (let i = 0; i < 6; i++) {
      const id = `chat-j${i}`;
      expect(p.others, id).not.toContain(id);
      expect(p.cards[id]?.where === 'float' || !!p.more?.ids.includes(id), id).toBe(true);
    }
    expect(p.more?.ids.length ?? 0).toBeGreaterThan(0);
    expect(overlaps(p.more!.rect, p.othersRect), 'pill over Others').toBe(false);
    expect(overlaps(p.more!.rect, p.agendaPill), 'pill over the agenda pill').toBe(false);
    expect(overlaps(p.more!.rect, p.centre), 'pill under the chat').toBe(false);
    for (const c of floats(p)) expect(overlaps(c.rect, p.more!.rect), `${c.id} over the pill`).toBe(false);
    sound(p);
  });

  it('a sized block cutting a row of small cards: the job takes the free tile, the pill stays empty', () => {
    const cs = [agenda(), job(0), job(1), sizedWeb, job(2), job(3)];
    const p = planStage(items(cs), FLOAT, S);
    expect(p.more?.ids ?? []).toEqual([]);
    for (let i = 0; i < 4; i++) expect(p.cards[`chat-j${i}`]?.where, `chat-j${i}`).toBe('float');
    sound(p);
  });

  it('whenever a job waits in the pill, no tile is free on the stage', () => {
    for (const s of [S, { width: 1500, height: 870 }, { width: 1744, height: 990 }]) {
      for (const at of [0, 2, 4]) {
        for (let n = 4; n <= 12; n++) {
          const jobs = Array.from({ length: n }, (_, i) => job(i));
          const p = planStage(items([agenda(), ...jobs.slice(0, at), sizedWeb, ...jobs.slice(at)]), FLOAT, s);
          if (!p.more?.ids.length) continue;
          const blocks = [p.centre, p.more.rect, p.othersRect, ...floats(p).map((c) => c.rect)];
          expect(findFree({ x: 0, y: 0, width: STAGE.TILE, height: STAGE.TILE }, p.free, blocks), `${s.width}x${s.height} at=${at} ${n} jobs`).toBeNull();
        }
      }
    }
  });
});
