/**
 * The hand-over choreography, pure (plan-r7 D18, owner decision 12: "flawless").
 *
 * Hand-over and take-back are ONE choreography, played forwards and backwards, ≈ 450 ms,
 * transform and opacity only, run with the Web Animations API (`element.animate()` and its
 * `finished` promise) by `SuperSurface.tsx`'s runner. This module owns the numbers and the
 * geometry so they are tested without a browser:
 *
 *  - FLIP: every first rect is measured in ONE batch before the DOM switches and every last
 *    rect in one batch after; each flight starts at the inverse transform and ends at identity.
 *  - STAND-INS, not stretched content: a flight moves a card-coloured stand-in (same radius and
 *    border, no text) from first to last; a 4–6× uneven scale of real content would stretch
 *    the text. The real container's content fades in (120 ms) as its flight lands.
 *  - Hand over: the active pane's stand-in shrinks into its container slot; every other adopted
 *    tab flies from its tab chip (30 ms stagger, 280 ms each, `cubic-bezier(0.2, 0, 0, 1)`); the
 *    tab strip leaves upward (200 ms); the centre grows in from the button (320 ms); the cape
 *    goes on once (400 ms, the mascot's own CSS entrance), started with the centre's grow-in so
 *    it ends inside the choreography: every flights plan is at least `centreDuration +
 *    contentFade` = 440 ms long, and nothing of the hand-over outlives its `finished`.
 *  - Take back: the exact reverse — every step's rects swapped and its timing mirrored.
 *  - Reduced motion and Light mode: a 120 ms crossfade, no flights, and no cape entrance (the
 *    cape is simply on).
 *
 * plan-r8 F8 adds ONE spring (≈ 380 ms, ≤ 3 % overshoot) as a CSS `linear()` easing, used by
 * the flights and by `planLayoutMotion`, the motion of every layout change on the stage (float
 * ↔ half ↔ present, a drop settling, to and from Others, a card opening or closing): a card
 * that only MOVES translates its real element; one that changes SIZE flies a stand-in while its
 * content fades in on landing; the centre only ever translates (§0 FE3).
 */

export interface Rect { x: number; y: number; width: number; height: number }

export const HANDOVER = {
  /** The choreography's nominal length. */
  total: 450,
  chipStagger: 30,
  chipDuration: 280,
  /** The pane that shrinks into its slot flies with the chips' clock (it is the first chip). */
  paneDuration: 280,
  /** Resolved at run time to the spring (`motionEasing()`), or its cubic-bezier fallback. */
  ease: 'spring',
  stripDuration: 200,
  /** How far the tab strip rises as it leaves. */
  stripLift: 12,
  centreDuration: 320,
  /** The cape-on entrance (SleepyMascot.css), from the choreography's first frame. */
  capeDuration: 400,
  /** A landed container's content fading in. */
  contentFade: 120,
  /** Reduced motion and Light mode. */
  crossfade: 120,
  /** Chips past this many land together with the last staggered one, so a hand-over of many
   *  chats stays near the nominal length. */
  maxStaggered: 5,
} as const;

/** The translate + scale (origin top-left) that draws a box laid out at `last` where `first` was. */
export interface FlipTransform { dx: number; dy: number; sx: number; sy: number }

export function flipTransform(first: Rect, last: Rect): FlipTransform {
  const sx = last.width > 0 ? first.width / last.width : 1;
  const sy = last.height > 0 ? first.height / last.height : 1;
  return { dx: first.x - last.x, dy: first.y - last.y, sx, sy };
}

/** Where `last` appears under `t` (origin at its own top-left): `applyFlip(last, flipTransform(first, last))` is `first`. */
export function applyFlip(last: Rect, t: FlipTransform): Rect {
  return { x: last.x + t.dx, y: last.y + t.dy, width: last.width * t.sx, height: last.height * t.sy };
}

export const IDENTITY = 'translate(0px, 0px) scale(1, 1)';

/** A CSS transform for a FLIP step. Rounded so a sub-pixel never reads as motion. */
export function transformOf(t: FlipTransform): string {
  const r = (n: number, p = 2) => Number(n.toFixed(p));
  return `translate(${r(t.dx)}px, ${r(t.dy)}px) scale(${r(t.sx, 4)}, ${r(t.sy, 4)})`;
}

/** The box a flight draws at progress `p` (0 = its start, 1 = its end), linear in rect space —
 *  what a reversed flight comes back to at `p = 0`. */
export function rectAt(from: Rect, to: Rect, p: number): Rect {
  const k = Math.min(1, Math.max(0, p));
  const mix = (a: number, b: number) => a + (b - a) * k;
  return { x: mix(from.x, to.x), y: mix(from.y, to.y), width: mix(from.width, to.width), height: mix(from.height, to.height) };
}

export type FlightRole = 'pane' | 'chip' | 'strip' | 'centre';

/** One thing that moves, as measured: where it was, where it lands. */
export interface FlightInput {
  key: string;
  role: FlightRole;
  first: Rect;
  last: Rect;
}

/** Only `transform` and `opacity` — the motion contract's composited pair. */
export interface MotionKeyframe { transform: string; opacity: number }

export interface FlightStep {
  key: string;
  role: FlightRole;
  /** The stand-in is laid out at this rect (in the flight layer's coordinates)… */
  box: Rect;
  /** …and animates through these frames. */
  keyframes: [MotionKeyframe, MotionKeyframe];
  delay: number;
  duration: number;
  easing: string;
  /** Where the flight starts and lands, in rect space (`rectAt(from, to, 0)` is `from`). */
  from: Rect;
  to: Rect;
}

export type FlightPlan =
  | { kind: 'flights'; direction: 'in' | 'out'; steps: FlightStep[]; total: number }
  | { kind: 'crossfade'; direction: 'in' | 'out'; duration: number; total: number };

/** The forward (hand-over) timing of every input: delay and duration. */
function forwardTiming(inputs: readonly FlightInput[]): Map<string, { delay: number; duration: number }> {
  const out = new Map<string, { delay: number; duration: number }>();
  let chip = 0;
  for (const f of inputs) {
    if (f.role === 'pane') out.set(f.key, { delay: 0, duration: HANDOVER.paneDuration });
    else if (f.role === 'chip') {
      const slot = Math.min(chip, HANDOVER.maxStaggered - 1);
      chip++;
      // The pane (when there is one) took slot 0's clock; chips stagger after it.
      out.set(f.key, { delay: (slot + (inputs.some((x) => x.role === 'pane') ? 1 : 0)) * HANDOVER.chipStagger, duration: HANDOVER.chipDuration });
    } else if (f.role === 'strip') out.set(f.key, { delay: 0, duration: HANDOVER.stripDuration });
    else out.set(f.key, { delay: 0, duration: HANDOVER.centreDuration });
  }
  return out;
}

function stripFrames(lifted: boolean): MotionKeyframe {
  return lifted
    ? { transform: `translate(0px, ${-HANDOVER.stripLift}px) scale(1, 1)`, opacity: 0 }
    : { transform: IDENTITY, opacity: 1 };
}

/**
 * The plan for one direction. `in` (hand over) moves each input from `first` to `last`;
 * `out` (take back) is the time-reversal of the same inputs measured the other way round —
 * pass the take-back's own measurements (first = the container, last = the chip) and it
 * mirrors the hand-over's clock, so the choreography plays backwards.
 */
export function planFlights(
  inputs: readonly FlightInput[],
  opts: { direction: 'in' | 'out'; reduced: boolean; light: boolean },
): FlightPlan {
  if (opts.reduced || opts.light || inputs.length === 0) {
    return { kind: 'crossfade', direction: opts.direction, duration: HANDOVER.crossfade, total: HANDOVER.crossfade };
  }
  const timing = forwardTiming(inputs);
  const forwardEnd = Math.max(...inputs.map((f) => { const t = timing.get(f.key)!; return t.delay + t.duration; }));
  const steps: FlightStep[] = inputs.map((f) => {
    const t = timing.get(f.key)!;
    // Take-back plays the hand-over's clock backwards: what landed last leaves first.
    const delay = opts.direction === 'in' ? t.delay : forwardEnd - (t.delay + t.duration);
    if (f.role === 'strip') {
      // The strip leaves upward on hand-over and comes back down on take-back, in place.
      const leaving = opts.direction === 'in';
      return {
        key: f.key, role: f.role, box: f.first, delay, duration: t.duration, easing: HANDOVER.ease,
        keyframes: [stripFrames(!leaving), stripFrames(leaving)],
        from: f.first, to: f.first,
      };
    }
    // Laid out at the landing rect, started at the inverse transform, ending at identity.
    return {
      key: f.key, role: f.role, box: f.last, delay, duration: t.duration, easing: HANDOVER.ease,
      keyframes: [{ transform: transformOf(flipTransform(f.first, f.last)), opacity: 1 }, { transform: IDENTITY, opacity: 1 }],
      from: f.first, to: f.last,
    };
  });
  const flightsEnd = Math.max(...steps.map((s) => s.delay + s.duration));
  return { kind: 'flights', direction: opts.direction, steps, total: flightsEnd + HANDOVER.contentFade };
}

/** When each landing's content fade starts: at its flight's landing. */
export function landingAt(step: FlightStep): number {
  return step.delay + step.duration;
}

/** Every property a plan animates — the test that pins "only transform and opacity". */
export function animatedProperties(plan: FlightPlan): Set<string> {
  const props = new Set<string>(['opacity']);
  if (plan.kind === 'flights') for (const s of plan.steps) for (const k of s.keyframes) for (const p of Object.keys(k)) props.add(p);
  return props;
}

/** A rect relative to an origin (the flight layer's own top-left). */
export function relativeTo(r: Rect, origin: { x: number; y: number }): Rect {
  return { x: r.x - origin.x, y: r.y - origin.y, width: r.width, height: r.height };
}

/** A usable rect: something laid out and on screen (a garaged pane measures 0×0). */
export function isVisibleRect(r: Rect | null | undefined): r is Rect {
  return !!r && r.width > 0 && r.height > 0;
}

// ─── The spring (plan-r8 F8, §0 FE-minors) ─────────────────────────────────────

export const SPRING = {
  /** Damping ratio: overshoot e^(-πζ/√(1-ζ²)) ≈ 2.8 %. */
  zeta: 0.75,
  /** Settled to within 0.5 % at the end of the duration. */
  settle: 0.005,
  duration: 380,
  stops: 48,
} as const;

/** Where browsers reject `linear()` (older WebKit), the flights' old curve. */
export const SPRING_FALLBACK = 'cubic-bezier(0.2, 0, 0, 1)';

/** The spring's position at normalised time t (0..1): 0 at the start, exactly 1 at the end. */
export function springAt(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const { zeta } = SPRING;
  const decay = -Math.log(SPRING.settle);       // ζω, so e^(-ζω) = settle at t = 1
  const omega = decay / zeta;
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  const e = Math.exp(-decay * t);
  return 1 - e * (Math.cos(wd * t) + (decay / wd) * Math.sin(wd * t));
}

/** The spring as a CSS easing: `linear(0, …, 1)` with evenly spaced stops. */
export function springEasing(stops: number = SPRING.stops): string {
  const n = Math.max(2, stops);
  const vals: string[] = [];
  for (let i = 0; i < n; i++) vals.push(String(Number(springAt(i / (n - 1)).toFixed(4))));
  return `linear(${vals.join(', ')})`;
}

let easingMemo: string | null = null;

/** The easing every flight and layout motion uses: the spring where `linear()` parses. */
export function motionEasing(): string {
  if (easingMemo) return easingMemo;
  const spring = springEasing();
  let ok = false;
  try { ok = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('transition-timing-function', 'linear(0, 1)'); } catch { ok = false; }
  easingMemo = ok ? spring : SPRING_FALLBACK;
  return easingMemo;
}

// ─── Layout motion (plan-r8 F8, §0 FE2/FE3, round 2) ───────────────────────────

/** Where a stage key is drawn (`superLayout`'s CardWhere, plus the centre). */
export type StageWhere = 'centre' | 'float' | 'others' | 'half' | 'present' | 'sheet';

export interface StageBox { rect: Rect; where: StageWhere }

export const LAYOUT = {
  duration: SPRING.duration,
  contentFade: 120,
  enter: 220,
  exit: 180,
  crossfade: 120,
  /** A size change under this (relative) is a move: a drop's 2 % lift settles by scale. */
  sizeTolerance: 0.03,
} as const;

export type LayoutStepKind =
  /** The real card, translated (and a lift's scale settled) back to identity. */
  | 'move'
  /** A stand-in flies first → last; the real card's content fades in on landing. */
  | 'resize'
  /** A stand-in flies into the Others stack, fading out. */
  | 'toOthers'
  /** A stand-in flies out of the Others stack; the content fades in on landing. */
  | 'fromOthers'
  /** A new card: its real element fades in. */
  | 'enter'
  /** A closed card: a stand-in at its last place fades out. */
  | 'exit'
  /** The centre's content: translate only, never faded, never stood in (FE3). */
  | 'centre'
  /** The centre's frame (background, border, glow) gliding behind it when its width changes. */
  | 'centreFrame';

export interface LayoutStep {
  key: string;
  kind: LayoutStepKind;
  /** The box the animated element is laid out at (the real card's `last`, or a stand-in's box). */
  box: Rect;
  from: Rect;
  to: Rect;
  keyframes: [MotionKeyframe, MotionKeyframe];
  delay: number;
  duration: number;
  /** 'spring' resolves to `motionEasing()` at run time; tests read the token. */
  easing: 'spring' | 'linear';
  /** Laid out as a stand-in in the stage's layer (else it animates the real element). */
  standIn: boolean;
  /** The real element's content fades in from this time (a resize or a trip out of Others). */
  contentFadeAt?: number;
}

export type LayoutMotion =
  | { kind: 'spring'; steps: LayoutStep[]; total: number }
  | { kind: 'crossfade'; keys: string[]; duration: number; total: number }
  | { kind: 'none' };

const near = (a: number, b: number, tol = 0.5) => Math.abs(a - b) <= tol;
const sameRect = (a: Rect, b: Rect) => near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);
const sameSize = (a: Rect, b: Rect) =>
  b.width > 0 && b.height > 0 && Math.abs(a.width / b.width - 1) <= LAYOUT.sizeTolerance && Math.abs(a.height / b.height - 1) <= LAYOUT.sizeTolerance;
const onStage = (w: StageWhere | undefined) => !!w && w !== 'others';

/**
 * What every key does between two layouts. `before` holds the rects MEASURED in the snapshot
 * (a card mid-motion is where it really is; a card flying as a stand-in is the stand-in's
 * rect); `after` holds `planStage`'s rects. All rects in the same (stage) coordinates.
 */
export function planLayoutMotion(
  before: ReadonlyMap<string, StageBox>,
  after: ReadonlyMap<string, StageBox>,
  opts: { reduced: boolean; light: boolean; othersRect: Rect },
): LayoutMotion {
  const keys = new Set([...before.keys(), ...after.keys()]);
  const changed: string[] = [];
  for (const k of keys) {
    const b = before.get(k);
    const a = after.get(k);
    if (b && a && b.where === a.where && sameRect(b.rect, a.rect)) continue;
    // Neither end on the stage (the centre counts as on it): an Others-to-Others change.
    if (!onStage(b?.where) && !onStage(a?.where)) continue;
    changed.push(k);
  }
  if (!changed.length) return { kind: 'none' };
  if (opts.reduced || opts.light) {
    // A 120 ms crossfade of what changed on the stage; the centre is never faded (it snaps).
    return { kind: 'crossfade', keys: changed.filter((k) => k !== 'centre' && onStage(after.get(k)?.where)), duration: LAYOUT.crossfade, total: LAYOUT.crossfade };
  }
  const steps: LayoutStep[] = [];
  const D = LAYOUT.duration;
  for (const k of changed) {
    const b = before.get(k);
    const a = after.get(k);
    if (k === 'centre' && b && a) {
      // Content: its final rect at once, translated from the old left/top.
      steps.push({
        key: k, kind: 'centre', box: a.rect, from: b.rect, to: a.rect, delay: 0, duration: D, easing: 'spring', standIn: false,
        keyframes: [{ transform: `translate(${(b.rect.x - a.rect.x).toFixed(2)}px, ${(b.rect.y - a.rect.y).toFixed(2)}px) scale(1, 1)`, opacity: 1 }, { transform: IDENTITY, opacity: 1 }],
      });
      if (!near(b.rect.width, a.rect.width) || !near(b.rect.height, a.rect.height)) {
        // Narrowing: the frame shrinks from the old rect. Widening: it starts at the new width on
        // the leading side (it moves with the content), so content never pokes out of it.
        const from = a.rect.width >= b.rect.width ? { x: b.rect.x, y: b.rect.y, width: a.rect.width, height: a.rect.height } : b.rect;
        steps.push({
          key: k, kind: 'centreFrame', box: a.rect, from, to: a.rect, delay: 0, duration: D, easing: 'spring', standIn: true,
          keyframes: [{ transform: transformOf(flipTransform(from, a.rect)), opacity: 1 }, { transform: IDENTITY, opacity: 1 }],
        });
      }
      continue;
    }
    const bOn = onStage(b?.where);
    const aOn = onStage(a?.where);
    if (bOn && aOn && b && a) {
      if (sameSize(b.rect, a.rect)) {
        steps.push({
          key: k, kind: 'move', box: a.rect, from: b.rect, to: a.rect, delay: 0, duration: D, easing: 'spring', standIn: false,
          keyframes: [{ transform: transformOf(flipTransform(b.rect, a.rect)), opacity: 1 }, { transform: IDENTITY, opacity: 1 }],
        });
      } else {
        steps.push({
          key: k, kind: 'resize', box: a.rect, from: b.rect, to: a.rect, delay: 0, duration: D, easing: 'spring', standIn: true,
          keyframes: [{ transform: transformOf(flipTransform(b.rect, a.rect)), opacity: 1 }, { transform: IDENTITY, opacity: 1 }],
          contentFadeAt: D,
        });
      }
    } else if (bOn && b && a?.where === 'others') {
      steps.push({
        key: k, kind: 'toOthers', box: opts.othersRect, from: b.rect, to: opts.othersRect, delay: 0, duration: D, easing: 'spring', standIn: true,
        keyframes: [{ transform: transformOf(flipTransform(b.rect, opts.othersRect)), opacity: 1 }, { transform: IDENTITY, opacity: 0 }],
      });
    } else if (aOn && a && b?.where === 'others') {
      steps.push({
        key: k, kind: 'fromOthers', box: a.rect, from: opts.othersRect, to: a.rect, delay: 0, duration: D, easing: 'spring', standIn: true,
        keyframes: [{ transform: transformOf(flipTransform(opts.othersRect, a.rect)), opacity: 0.4 }, { transform: IDENTITY, opacity: 1 }],
        contentFadeAt: D,
      });
    } else if (aOn && a && !b) {
      steps.push({
        key: k, kind: 'enter', box: a.rect, from: a.rect, to: a.rect, delay: 0, duration: LAYOUT.enter, easing: 'linear', standIn: false,
        keyframes: [{ transform: 'translate(0px, 8px) scale(1, 1)', opacity: 0 }, { transform: IDENTITY, opacity: 1 }],
      });
    } else if (bOn && b && !a) {
      steps.push({
        key: k, kind: 'exit', box: b.rect, from: b.rect, to: b.rect, delay: 0, duration: LAYOUT.exit, easing: 'linear', standIn: true,
        keyframes: [{ transform: IDENTITY, opacity: 1 }, { transform: 'translate(0px, 8px) scale(1, 1)', opacity: 0 }],
      });
    }
  }
  if (!steps.length) return { kind: 'none' };
  const total = Math.max(...steps.map((s) => s.delay + s.duration + (s.contentFadeAt !== undefined ? LAYOUT.contentFade : 0)));
  return { kind: 'spring', steps, total };
}

/** Every property a layout motion animates (only transform and opacity). */
export function layoutAnimatedProperties(m: LayoutMotion): Set<string> {
  const props = new Set<string>(['opacity']);
  if (m.kind === 'spring') for (const s of m.steps) for (const k of s.keyframes) for (const p of Object.keys(k)) props.add(p);
  return props;
}
