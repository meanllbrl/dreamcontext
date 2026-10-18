/**
 * The hand-over choreography (plan-r7 D18, AC13): the numbers and the geometry, measured in a
 * browser by the lead's scripts/verify/super-agent.mjs, pinned here first.
 *
 *  - FLIP: a stand-in laid out at its LAST rect, started at the inverse transform, draws its
 *    FIRST rect; it ends at identity.
 *  - The timings: 30 ms chip stagger, 280 ms each, on the spring (plan-r8 F8: a CSS `linear()`
 *    easing, cubic-bezier(0.2, 0, 0, 1) where `linear()` is rejected); strip 200 ms; centre
 *    320 ms; ≈ 450 ms in all.
 *  - Layout motion (plan-r8 F8, §0 FE2/FE3): a move translates the real card, a size change or a
 *    trip to/from Others flies a stand-in, the centre only translates (never faded).
 *  - Take-back is the exact reverse: the same clock mirrored.
 *  - A reversed flight lands back on its start rects.
 *  - Reduced motion and Light mode: a 120 ms crossfade, no flights.
 *  - Only transform and opacity are animated.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HANDOVER, IDENTITY, LAYOUT, SPRING, SPRING_FALLBACK, animatedProperties, applyFlip, flipTransform, isVisibleRect,
  landingAt, layoutAnimatedProperties, planFlights, planLayoutMotion, rectAt, relativeTo, springAt, springEasing,
  transformOf, type FlightInput, type Rect, type StageBox,
} from '../../dashboard/src/components/sleepy/super/handoverMotion.js';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

const pane = r(0, 40, 900, 700);
const chipA = r(120, 4, 140, 28);
const chipB = r(270, 4, 140, 28);
const slotP = r(40, 120, 280, 160);
const slotA = r(40, 300, 280, 160);
const slotB = r(1200, 120, 280, 160);
const strip = r(40, 0, 900, 36);
const button = r(1300, 4, 180, 28);
const centre = r(340, 120, 840, 640);

const handOverInputs: FlightInput[] = [
  { key: 'child:p', role: 'pane', first: pane, last: slotP },
  { key: 'child:a', role: 'chip', first: chipA, last: slotA },
  { key: 'child:b', role: 'chip', first: chipB, last: slotB },
  { key: 'strip', role: 'strip', first: strip, last: strip },
  { key: 'centre', role: 'centre', first: button, last: centre },
];

describe('FLIP math', () => {
  it('the inverse transform draws the last rect exactly where the first one was', () => {
    for (const [first, last] of [[pane, slotP], [chipA, slotA], [button, centre], [centre, button]] as const) {
      const back = applyFlip(last, flipTransform(first, last));
      expect(back.x).toBeCloseTo(first.x, 6);
      expect(back.y).toBeCloseTo(first.y, 6);
      expect(back.width).toBeCloseTo(first.width, 6);
      expect(back.height).toBeCloseTo(first.height, 6);
    }
  });

  it('a zero-size landing never divides by zero', () => {
    expect(flipTransform(chipA, r(0, 0, 0, 0))).toMatchObject({ sx: 1, sy: 1 });
  });

  it('every flight ends at identity, starting from a translate + scale string', () => {
    const plan = planFlights(handOverInputs, { direction: 'in', reduced: false, light: false });
    if (plan.kind !== 'flights') throw new Error('expected flights');
    for (const s of plan.steps.filter((x) => x.role !== 'strip')) {
      expect(s.keyframes[1].transform).toBe(IDENTITY);
      expect(s.keyframes[0].transform).toBe(transformOf(flipTransform(s.from, s.to)));
      expect(s.box).toEqual(s.to);
    }
  });

  it('rects are taken relative to the flight layer; a garaged (0×0) rect is not a flight', () => {
    expect(relativeTo(r(110, 60, 10, 10), { x: 100, y: 50 })).toEqual(r(10, 10, 10, 10));
    expect(isVisibleRect(r(0, 0, 0, 0))).toBe(false);
    expect(isVisibleRect(null)).toBe(false);
    expect(isVisibleRect(slotA)).toBe(true);
  });
});

describe('hand over: the timings', () => {
  const plan = planFlights(handOverInputs, { direction: 'in', reduced: false, light: false });
  if (plan.kind !== 'flights') throw new Error('expected flights');
  const step = (key: string) => plan.steps.find((s) => s.key === key)!;

  it('the pane shrinks first; the chips follow 30 ms apart, 280 ms each, on the spring', () => {
    expect(step('child:p')).toMatchObject({ delay: 0, duration: 280, easing: 'spring' });
    expect(step('child:a')).toMatchObject({ delay: 30, duration: 280 });
    expect(step('child:b')).toMatchObject({ delay: 60, duration: 280 });
  });

  it('the strip leaves upward in 200 ms (opacity and a lift); the centre grows from the button in 320 ms', () => {
    expect(step('strip')).toMatchObject({ delay: 0, duration: 200 });
    expect(step('strip').keyframes[0]).toMatchObject({ opacity: 1, transform: IDENTITY });
    expect(step('strip').keyframes[1].opacity).toBe(0);
    expect(step('strip').keyframes[1].transform).toContain(`-${HANDOVER.stripLift}px`);
    expect(step('centre')).toMatchObject({ delay: 0, duration: 320, from: button, to: centre });
  });

  it('is ≈ 450 ms in all, content fade included', () => {
    expect(plan.total).toBeGreaterThanOrEqual(400);
    expect(plan.total).toBeLessThanOrEqual(560);
  });

  it('many chats stay near the nominal length: the stagger stops after five', () => {
    const many: FlightInput[] = Array.from({ length: 12 }, (_, i) => ({ key: `child:${i}`, role: 'chip', first: chipA, last: slotA }));
    const p = planFlights(many, { direction: 'in', reduced: false, light: false });
    if (p.kind !== 'flights') throw new Error('expected flights');
    expect(Math.max(...p.steps.map(landingAt))).toBe((HANDOVER.maxStaggered - 1) * HANDOVER.chipStagger + HANDOVER.chipDuration);
  });

  it('animates only transform and opacity', () => {
    expect([...animatedProperties(plan)].sort()).toEqual(['opacity', 'transform']);
  });
});

describe('take back: the exact reverse', () => {
  // Measured the other way round: first = the container, last = the chip.
  const back: FlightInput[] = handOverInputs.map((f) => (f.role === 'strip' ? f : { ...f, first: f.last, last: f.first }));
  const fwd = planFlights(handOverInputs, { direction: 'in', reduced: false, light: false });
  const rev = planFlights(back, { direction: 'out', reduced: false, light: false });
  if (fwd.kind !== 'flights' || rev.kind !== 'flights') throw new Error('expected flights');
  const end = Math.max(...fwd.steps.map((s) => s.delay + s.duration));

  it('every step plays the hand-over\'s clock backwards: what landed last leaves first', () => {
    for (const s of rev.steps) {
      const f = fwd.steps.find((x) => x.key === s.key)!;
      expect(s.duration).toBe(f.duration);
      expect(s.delay).toBe(end - (f.delay + f.duration));
    }
  });

  it('every flight goes the other way, and the strip comes back down', () => {
    for (const s of rev.steps.filter((x) => x.role !== 'strip')) {
      const f = fwd.steps.find((x) => x.key === s.key)!;
      expect(s.from).toEqual(f.to);
      expect(s.to).toEqual(f.from);
    }
    const strip = rev.steps.find((s) => s.role === 'strip')!;
    expect(strip.keyframes[0].opacity).toBe(0);
    expect(strip.keyframes[1]).toMatchObject({ opacity: 1, transform: IDENTITY });
  });
});

describe('pressed mid-flight: the reversal lands on the start rects', () => {
  it('a flight at any progress, played back to 0, is at its first rect', () => {
    const plan = planFlights(handOverInputs, { direction: 'in', reduced: false, light: false });
    if (plan.kind !== 'flights') throw new Error('expected flights');
    for (const s of plan.steps) {
      if (s.role !== 'strip') expect(rectAt(s.from, s.to, 0.4)).not.toEqual(s.from);
      expect(rectAt(s.from, s.to, 0)).toEqual(handOverInputs.find((f) => f.key === s.key)!.first);
      expect(rectAt(s.from, s.to, 1)).toEqual(s.role === 'strip' ? s.from : handOverInputs.find((f) => f.key === s.key)!.last);
    }
  });

  it('the runner reverses a stand-in with a NEW spring from where it is, the fades with reverse(), and holds the first frame (fill both)', () => {
    const src = readFileSync(join(ROOT, 'dashboard/src/components/sleepy/super/motionRunner.ts'), 'utf-8');
    const runner = src.slice(src.indexOf('export function runFlights'), src.indexOf('// ─── Layout motion'));
    const reverse = runner.slice(runner.indexOf('reverse: () =>'), runner.indexOf('finished,\n'));
    // A spring is never played backwards (§0 FE-minors): measured rect → its first transform.
    expect(reverse).toMatch(/const now = rectIn\(f\.el, origin\)/);
    expect(reverse).toMatch(/flipTransform\(now, f\.step\.box\)/);
    expect(reverse).not.toMatch(/f\.anim\??\.reverse\(\)/);
    expect(reverse).toMatch(/for \(const a of fades\) \{ try \{ a\.reverse\(\)/);
    // A cancelled animation's NEW `finished` never settles: it leaves the wait set, and the
    // settle loop compares membership (a reversal used to hang with its stand-ins on screen).
    expect(reverse).toMatch(/if \(f\.anim\) \{ drop\(f\.anim\); try \{ f\.anim\.cancel\(\); \}/);
    expect(runner).toMatch(/if \(anims\.every\(\(a\) => snapshot\.includes\(a\)\)\) break;/);
    expect(src).toMatch(/fill: 'both'/);
    // will-change only while flying: set on the stand-in, cleared on landing.
    expect(runner).toMatch(/willChange = 'transform'/);
    expect(runner).toMatch(/willChange = ''/);
    // Nothing left running: cleanup cancels every animation and removes every stand-in.
    expect(runner).toMatch(/a\.cancel\(\)/);
    expect(runner).toMatch(/el\.remove\(\)/);
  });
});

describe('the cape goes on inside the choreography (D18, AC13)', () => {
  const src = readFileSync(join(ROOT, 'dashboard/src/components/sleepy/super/SuperSurface.tsx'), 'utf-8');
  const runnerSrc = readFileSync(join(ROOT, 'dashboard/src/components/sleepy/super/motionRunner.ts'), 'utf-8');
  const css = readFileSync(join(ROOT, 'dashboard/src/components/sleepy/SleepyMascot.css'), 'utf-8');

  it('the CSS entrance is HANDOVER.capeDuration long', () => {
    expect(css).toMatch(new RegExp(`animation: smascot-cape-on ${HANDOVER.capeDuration}ms`));
  });

  it('started on the first frame, it ends before any hand-over that has a centre', () => {
    // The shortest flights plan with the centre: the centre alone.
    const centreOnly = planFlights([{ key: 'centre', role: 'centre', first: button, last: centre }], { direction: 'in', reduced: false, light: false });
    expect(centreOnly.total).toBeGreaterThanOrEqual(HANDOVER.capeDuration);
    expect(planFlights(handOverInputs, { direction: 'in', reduced: false, light: false }).total).toBeGreaterThanOrEqual(HANDOVER.capeDuration);
  });

  it('the face mounts with the surface, not when the centre lands', () => {
    const centreHead = src.slice(src.indexOf('className="super-centre-head"'), src.indexOf('className="super-centre-name"'));
    expect(centreHead).toMatch(/<SleepyMascot [^>]*mode="super" capeOn=\{capeOn\} \/>/);
    expect(centreHead).not.toMatch(/pending\.has\('centre'\)/);
  });

  it('the runner\'s `finished` waits for the cape too, so it never outlives the choreography', () => {
    const runner = runnerSrc.slice(runnerSrc.indexOf('export function runFlights'));
    const capeJoin = runner.slice(runner.indexOf(".smascot-cape-entering .smascot-cape"), runner.indexOf('const settle'));
    expect(capeJoin).toMatch(/animationName === 'smascot-cape-on'/);
    expect(capeJoin).toMatch(/anims\.push\(a\)/);
  });
});

describe('reduced motion and Light mode', () => {
  it('a 120 ms crossfade, no flights', () => {
    for (const opts of [{ reduced: true, light: false }, { reduced: false, light: true }]) {
      const plan = planFlights(handOverInputs, { direction: 'in', ...opts });
      expect(plan).toEqual({ kind: 'crossfade', direction: 'in', duration: 120, total: 120 });
    }
  });

  it('nothing measured is a crossfade too (never a broken flight)', () => {
    expect(planFlights([], { direction: 'out', reduced: false, light: false }).kind).toBe('crossfade');
  });
});

describe('layout runs: a card on its way to Others finishes the trip', () => {
  it('leaving stand-ins are ghosts: a cancel by the next layout change leaves them flying, they remove themselves', () => {
    const src = readFileSync(join(ROOT, 'dashboard/src/components/sleepy/super/motionRunner.ts'), 'utf-8');
    const layout = src.slice(src.indexOf('export function runLayoutMotion'));
    expect(layout).toMatch(/if \(s\.standIn && \(s\.kind === 'toOthers' \|\| s\.kind === 'exit'\)\) \{/);
    expect(layout).toMatch(/ghosts\.add\(a\);\n\s*a\.finished\.then\(\(\) => \{ a\.cancel\(\); el\.remove\(\); \}, \(\) => el\.remove\(\)\);/);
    expect(layout).toMatch(/for \(const a of anims\) \{ if \(!ghosts\.has\(a\)\) \{ try \{ a\.cancel\(\); \}/);
  });
});

describe('the spring (plan-r8 F8, §0 FE-minors)', () => {
  const easing = springEasing();
  const stops = easing.slice('linear('.length, -1).split(', ').map(Number);

  it('is a CSS linear() with at least 40 stops that parses', () => {
    expect(stops.length).toBeGreaterThanOrEqual(40);
    expect(easing).toMatch(/^linear\(([-0-9.]+, )+1\)$/);
    expect(stops.every(Number.isFinite)).toBe(true);
  });

  it('starts at 0 and ends at exactly 1', () => {
    expect(stops[0]).toBe(0);
    expect(stops[stops.length - 1]).toBe(1);
    expect(springAt(0)).toBe(0);
    expect(springAt(1)).toBe(1);
  });

  it('overshoots by at most 3 % and is monotone after its peak', () => {
    const peak = Math.max(...stops);
    expect(peak).toBeLessThanOrEqual(1.03);
    expect(peak).toBeGreaterThan(1);
    const at = stops.indexOf(peak);
    for (let i = 1; i < at; i++) expect(stops[i]).toBeGreaterThanOrEqual(stops[i - 1]);
    for (let i = at + 1; i < stops.length; i++) expect(stops[i]).toBeLessThanOrEqual(stops[i - 1] + 1e-9);
  });

  it('runs about 380 ms, with the cubic-bezier fallback where linear() is rejected', () => {
    expect(SPRING.duration).toBeGreaterThanOrEqual(340);
    expect(SPRING.duration).toBeLessThanOrEqual(420);
    expect(SPRING_FALLBACK).toBe('cubic-bezier(0.2, 0, 0, 1)');
    const runner = readFileSync(join(ROOT, 'dashboard/src/components/sleepy/super/motionRunner.ts'), 'utf-8');
    const safe = runner.slice(runner.indexOf('export function animateSafe'), runner.indexOf('const rectIn'));
    expect(safe).toMatch(/try \{/);
    expect(safe).toMatch(/easing: SPRING_FALLBACK/);
  });
});

describe('layout motion (plan-r8 F8, §0 FE2/FE3)', () => {
  const others = r(1700, 950, 148, 40);
  const box = (rect: Rect, where: StageBox['where']): StageBox => ({ rect, where });
  const plan = (before: [string, StageBox][], after: [string, StageBox][], o: { reduced?: boolean; light?: boolean } = {}) =>
    planLayoutMotion(new Map(before), new Map(after), { reduced: !!o.reduced, light: !!o.light, othersRect: others });
  const centreA = r(530, 64, 860, 892);
  const card = r(260, 64, 232, 412);

  it('nothing changed: no motion', () => {
    expect(plan([['centre', box(centreA, 'centre')], ['a', box(card, 'float')]], [['centre', box(centreA, 'centre')], ['a', box(card, 'float')]]).kind).toBe('none');
  });

  it('a card that only moves translates the REAL card, no scale', () => {
    const m = plan([['a', box(card, 'float')]], [['a', box({ ...card, x: 40, y: 300 }, 'float')]]);
    if (m.kind !== 'spring') throw new Error('expected spring');
    expect(m.steps).toHaveLength(1);
    expect(m.steps[0]).toMatchObject({ kind: 'move', standIn: false, easing: 'spring', duration: LAYOUT.duration });
    expect(m.steps[0].keyframes[0].transform).toBe(transformOf(flipTransform(card, { ...card, x: 40, y: 300 })));
    expect(m.steps[0].keyframes[0].transform).toContain('scale(1, 1)');
    expect(m.steps[0].keyframes[1].transform).toBe(IDENTITY);
  });

  it('a size change (to half) flies a stand-in and fades the content in on landing', () => {
    const half = r(980, 64, 916, 892);
    const m = plan([['a', box(card, 'float')]], [['a', box(half, 'half')]]);
    if (m.kind !== 'spring') throw new Error('expected spring');
    expect(m.steps[0]).toMatchObject({ kind: 'resize', standIn: true, box: half, contentFadeAt: LAYOUT.duration });
    expect(m.total).toBe(LAYOUT.duration + LAYOUT.contentFade);
  });

  it('to Others shrinks a stand-in into the stack and fades it; from Others is the reverse', () => {
    const to = plan([['a', box(card, 'float')]], [['a', box(others, 'others')]]);
    if (to.kind !== 'spring') throw new Error('expected spring');
    expect(to.steps[0]).toMatchObject({ kind: 'toOthers', standIn: true, to: others });
    expect(to.steps[0].keyframes[1].opacity).toBe(0);
    const from = plan([['a', box(others, 'others')]], [['a', box(card, 'float')]]);
    if (from.kind !== 'spring') throw new Error('expected spring');
    expect(from.steps[0]).toMatchObject({ kind: 'fromOthers', standIn: true, from: others, contentFadeAt: LAYOUT.duration });
  });

  it('an Others-to-Others change does not move anything', () => {
    expect(plan([['a', box(others, 'others')]], [['a', box(others, 'others')], ['b', box(others, 'others')]]).kind).toBe('none');
  });

  it('the centre only translates, never stood in for, never faded; its frame glides behind when its width steps', () => {
    const narrower = r(600, 64, 720, 892);
    const m = plan([['centre', box(centreA, 'centre')]], [['centre', box(narrower, 'centre')]]);
    if (m.kind !== 'spring') throw new Error('expected spring');
    const content = m.steps.find((s) => s.kind === 'centre')!;
    expect(content.standIn).toBe(false);
    expect(content.keyframes[0].transform).toMatch(/^translate\(-70\.00px, 0\.00px\) scale\(1, 1\)$/);
    for (const k of content.keyframes) expect(k.opacity).toBe(1);
    const frame = m.steps.find((s) => s.kind === 'centreFrame')!;
    expect(frame.standIn).toBe(true);
    expect(frame.from).toEqual(centreA);
    // Widening: the frame starts at the NEW width on the leading side.
    const w = plan([['centre', box(narrower, 'centre')]], [['centre', box(centreA, 'centre')]]);
    if (w.kind !== 'spring') throw new Error('expected spring');
    expect(w.steps.find((s) => s.kind === 'centreFrame')!.from).toEqual({ x: narrower.x, y: narrower.y, width: centreA.width, height: centreA.height });
  });

  it('starts from a mid-flight rect (an interrupted motion begins where the card really is)', () => {
    const mid = { ...card, x: card.x + 37.5, y: card.y - 12.25 };
    const target = { ...card, x: 40 };
    const m = plan([['a', box(mid, 'float')]], [['a', box(target, 'float')]]);
    if (m.kind !== 'spring') throw new Error('expected spring');
    expect(m.steps[0].from).toEqual(mid);
    expect(applyFlip(target, flipTransform(mid, target))).toEqual(mid);
  });

  it('reduced motion and Light mode: a crossfade of the cards that changed, never the centre', () => {
    for (const o of [{ reduced: true }, { light: true }]) {
      const m = plan(
        [['centre', box(centreA, 'centre')], ['a', box(card, 'float')]],
        [['centre', box(r(600, 64, 720, 892), 'centre')], ['a', box({ ...card, x: 40 }, 'float')]],
        o,
      );
      expect(m).toEqual({ kind: 'crossfade', keys: ['a'], duration: LAYOUT.crossfade, total: LAYOUT.crossfade });
    }
  });

  it('animates only transform and opacity', () => {
    const m = plan(
      [['centre', box(centreA, 'centre')], ['a', box(card, 'float')], ['b', box(card, 'float')], ['c', box(others, 'others')]],
      [['centre', box(r(600, 64, 720, 892), 'centre')], ['a', box(r(980, 64, 916, 892), 'half')], ['b', box(others, 'others')], ['c', box(card, 'float')]],
    );
    expect([...layoutAnimatedProperties(m)].sort()).toEqual(['opacity', 'transform']);
  });
});
