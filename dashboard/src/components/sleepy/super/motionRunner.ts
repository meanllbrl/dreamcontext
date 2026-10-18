/**
 * The stage's motion, played with the Web Animations API (plan-r7 D18, plan-r8 F8 / §0 FE2-FE5).
 * `handoverMotion.ts` owns the numbers and the geometry; this file owns the DOM:
 *
 *  - `runFlights`: the hand-over and take-back flights — card-coloured stand-ins in the flight
 *    layer, the content fading in as each lands, a mid-flight press reversing it.
 *  - `runLayoutMotion`: every layout change on the stage — the real card translated for a move,
 *    a stand-in for a size change or a trip to and from Others, the centre only translated with
 *    its frame gliding behind it.
 *
 * Transform and opacity only; `will-change` only while something flies; every animation is
 * cancelled when its motion is over, so nothing runs past its `finished`.
 */
import {
  HANDOVER, IDENTITY, LAYOUT, SPRING_FALLBACK, flipTransform, landingAt, motionEasing, transformOf,
  type FlightPlan, type FlightStep, type LayoutMotion, type LayoutStep, type Rect,
} from './handoverMotion';

/**
 * `element.animate()` with the spring resolved, wrapped so a browser that rejects `linear()`
 * (or anything else in the timing) falls back to the cubic-bezier instead of throwing.
 */
export function animateSafe(el: Element, frames: Keyframe[], timing: KeyframeAnimationOptions): Animation | null {
  if (typeof (el as HTMLElement).animate !== 'function') return null;
  const easing = timing.easing === 'spring' ? motionEasing() : timing.easing;
  try {
    return (el as HTMLElement).animate(frames, { fill: 'both', ...timing, easing });
  } catch {
    try { return (el as HTMLElement).animate(frames, { fill: 'both', ...timing, easing: SPRING_FALLBACK }); } catch { return null; }
  }
}

const rectIn = (el: Element, origin: DOMRect): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: r.height };
};

function standIn(layer: HTMLElement, box: Rect, cls: string, key: string): HTMLElement {
  const el = document.createElement('div');
  el.className = cls;
  el.dataset.key = key;
  el.style.left = `${box.x}px`;
  el.style.top = `${box.y}px`;
  el.style.width = `${box.width}px`;
  el.style.height = `${box.height}px`;
  el.style.willChange = 'transform, opacity';
  layer.appendChild(el);
  return el;
}

// ─── The hand-over flights (D18) ────────────────────────────────────────────────

export interface FlightRun {
  /** Still playing (forwards or backwards). */
  readonly active: boolean;
  /** Playing backwards now (the button was pressed mid-flight). */
  readonly reversed: boolean;
  /** Reverse from the current state — never a jump. Pressing again plays forwards again. */
  reverse: () => void;
  /** Resolves when every animation is done in the current direction. */
  finished: Promise<'done' | 'reversed'>;
  /** Cancel every animation and remove the stand-ins (after the caller's DOM is in place). */
  cleanup: () => void;
}

interface Flight { el: HTMLElement; step: FlightStep; anim: Animation | null; landed: boolean }

/**
 * Play a plan. Every flight is a card-coloured STAND-IN in `layer`, laid out at its landing box
 * and animated from the inverse transform to identity. On landing the stand-in fades out while
 * `onLand` fades the real content in. `fadeIn` elements (the incoming view on take-back, or the
 * whole view in a crossfade) go from 0 to 1. Every animation runs with `fill: 'both'`, so a
 * reversal holds its first frame until the caller swaps the DOM back; `cleanup` cancels them
 * all, so nothing is left running once the choreography is over.
 *
 * A reversal never plays a spring backwards (§0 FE-minors): each stand-in starts a NEW spring
 * from where it really is now (its measured rect) back to its first rect; the fades, which are
 * linear, simply reverse.
 */
export function runFlights(
  layer: HTMLElement,
  plan: FlightPlan,
  opts: { onLand?: (step: FlightStep) => Animation | null | undefined; fadeIn?: readonly (HTMLElement | null | undefined)[] } = {},
): FlightRun {
  const anims: Animation[] = [];
  const fades: Animation[] = [];
  const standins: HTMLElement[] = [];
  const flights: Flight[] = [];
  let reversed = false;
  let active = true;
  let gen = 0;
  let resolve: (v: 'done' | 'reversed') => void = () => {};
  const finished = new Promise<'done' | 'reversed'>((r) => { resolve = r; });
  const animate = (el: Element, frames: Keyframe[], timing: KeyframeAnimationOptions, fade = false): Animation | null => {
    const a = animateSafe(el, frames, timing);
    if (a) { anims.push(a); if (fade) fades.push(a); }
    return a;
  };
  const fadeTargets = (opts.fadeIn ?? []).filter((x): x is HTMLElement => !!x);
  const drop = (a: Animation) => {
    for (const list of [anims, fades]) { const i = list.indexOf(a); if (i >= 0) list.splice(i, 1); }
  };

  const land = (f: Flight) => {
    if (reversed || f.landed) return;
    f.landed = true;
    f.el.style.willChange = '';
    // A strip stand-in already faded with its own frames.
    if (f.step.role !== 'strip') animate(f.el, [{ opacity: 1 }, { opacity: 0 }], { duration: HANDOVER.contentFade, easing: 'linear' }, true);
    const content = opts.onLand?.(f.step);
    if (content) { anims.push(content); fades.push(content); }
  };

  if (plan.kind === 'crossfade') {
    for (const el of fadeTargets) animate(el, [{ opacity: 0 }, { opacity: 1 }], { duration: plan.duration, easing: 'linear' }, true);
  } else {
    for (const step of plan.steps) {
      const el = document.createElement('div');
      el.className = 'super-standin';
      el.dataset.role = step.role;
      el.style.left = `${step.box.x}px`;
      el.style.top = `${step.box.y}px`;
      el.style.width = `${step.box.width}px`;
      el.style.height = `${step.box.height}px`;
      el.style.willChange = 'transform';
      layer.appendChild(el);
      standins.push(el);
      const f: Flight = { el, step, anim: null, landed: false };
      flights.push(f);
      // The strip's lift is a fade with a nudge: it reverses like a fade.
      f.anim = animate(el, step.keyframes as unknown as Keyframe[], { duration: step.duration, delay: step.delay, easing: step.easing }, step.role === 'strip');
      if (f.anim) f.anim.finished.then(() => land(f), () => undefined);
      else land(f);
    }
    if (fadeTargets.length) {
      // The incoming view appears from the first landing to the end: never under a stand-in
      // still in mid-air, never a beat after the last one lands.
      const first = Math.min(...plan.steps.map(landingAt));
      const at = plan.total > 0 ? Math.min(0.95, Math.max(0, first / plan.total)) : 0;
      for (const el of fadeTargets) {
        animate(el, [{ opacity: 0, offset: 0 }, { opacity: 0, offset: at }, { opacity: 1, offset: 1 }], { duration: plan.total, easing: 'linear' }, true);
      }
    }
  }

  // The cape going on is part of the choreography (D18): its CSS entrance (mounted in this same
  // commit) joins the set `finished` waits for, so it can never outlive the choreography's end
  // — even a short plan — and a mid-flight reversal takes the cape back off with everything else.
  for (const cape of Array.from(document.querySelectorAll('.smascot-cape-entering .smascot-cape'))) {
    const own = typeof (cape as Element).getAnimations === 'function' ? (cape as Element).getAnimations() : [];
    for (const a of own) if ((a as CSSAnimation).animationName === 'smascot-cape-on' && a.playState !== 'finished') { anims.push(a); fades.push(a); }
  }

  const settle = (mine: number) => {
    void (async () => {
      for (;;) {
        const snapshot = [...anims];
        await Promise.all(snapshot.map((a) => a.finished.then(() => undefined, () => undefined)));
        if (mine !== gen) return;
        if (anims.every((a) => snapshot.includes(a))) break;
      }
      active = false;
      resolve(reversed ? 'reversed' : 'done');
    })();
  };
  settle(gen);

  return {
    get active() { return active; },
    get reversed() { return reversed; },
    reverse: () => {
      if (!active) return;
      reversed = !reversed;
      gen++;
      const origin = layer.getBoundingClientRect();
      for (const f of flights) {
        if (f.step.role === 'strip') continue;
        // Where the stand-in really is now (its running transform included).
        const now = rectIn(f.el, origin);
        // A cancelled animation gets a NEW `finished` promise that never settles: it leaves the
        // set `finished` waits on, or a reversal would never end.
        if (f.anim) { drop(f.anim); try { f.anim.cancel(); } catch { /* already gone */ } }
        const target = reversed ? f.step.keyframes[0].transform : IDENTITY;
        // Transform only: the stand-in's own fade (a later animation) keeps its opacity.
        f.anim = animate(f.el, [{ transform: transformOf(flipTransform(now, f.step.box)) }, { transform: target }], { duration: f.step.duration, easing: f.step.easing });
        f.el.style.willChange = 'transform';
        if (!reversed && f.anim) f.anim.finished.then(() => land(f), () => undefined);
      }
      for (const a of fades) { try { a.reverse(); } catch { /* already gone */ } }
      settle(gen);
    },
    finished,
    cleanup: () => {
      for (const a of anims) { try { a.cancel(); } catch { /* already gone */ } }
      for (const el of standins) el.remove();
      anims.length = 0;
      fades.length = 0;
      standins.length = 0;
    },
  };
}

// ─── Layout motion (F8, FE2, FE3, round 2) ─────────────────────────────────────

export interface LayoutRun {
  finished: Promise<void>;
  /** Cancel everything now: stand-ins gone, every card at its final rect. */
  cancel: () => void;
  /** The stand-in flying for a key right now, if any (an interrupted motion starts there). */
  standInRect: (key: string, origin: DOMRect) => Rect | null;
}

/**
 * Play a layout motion on the stage. `elFor(key)` is the real element (`'centre'` = the
 * centre's frame); `layer` sits above the cards, `under` below the centre (its frame glides
 * there). Rects are stage coordinates; both layers are positioned at the stage's origin.
 */
export function runLayoutMotion(
  motion: LayoutMotion,
  dom: { layer: HTMLElement; under: HTMLElement; elFor: (key: string) => HTMLElement | null },
): LayoutRun {
  const anims: Animation[] = [];
  const standins = new Map<string, HTMLElement>();
  /** Leaving stand-ins (to Others, closed): visual only, they finish their trip even when the
   *  next layout change cancels this run, and remove themselves (no card snaps out of sight). */
  const ghosts = new Set<Animation>();
  const touched: HTMLElement[] = [];
  let gliding: HTMLElement | null = null;
  const run = (el: Element, frames: Keyframe[], timing: KeyframeAnimationOptions) => {
    const a = animateSafe(el, frames, timing);
    if (a) anims.push(a);
    return a;
  };

  if (motion.kind === 'crossfade') {
    for (const k of motion.keys) {
      const el = dom.elFor(k);
      if (el) run(el, [{ opacity: 0 }, { opacity: 1 }], { duration: motion.duration, easing: 'linear' });
    }
  } else if (motion.kind === 'spring') {
    for (const s of motion.steps) playStep(s);
  }

  function playStep(s: LayoutStep) {
    const timing = { duration: s.duration, delay: s.delay, easing: s.easing };
    if (s.kind === 'centreFrame') {
      const el = standIn(dom.under, s.box, 'super-standin super-standin--frame', s.key);
      standins.set(`${s.key}:frame`, el);
      run(el, s.keyframes as unknown as Keyframe[], timing);
      // The real frame hides ONLY its background, border and glow while the stand-in glides.
      gliding = dom.elFor('centre');
      gliding?.setAttribute('data-gliding', 'true');
      return;
    }
    if (s.standIn && (s.kind === 'toOthers' || s.kind === 'exit')) {
      const el = standIn(dom.layer, s.box, 'super-standin super-standin--card super-standin--leaving', s.key);
      const a = run(el, s.keyframes as unknown as Keyframe[], timing);
      if (!a) { el.remove(); return; }
      ghosts.add(a);
      a.finished.then(() => { a.cancel(); el.remove(); }, () => el.remove());
      return;
    }
    if (s.standIn) {
      const el = standIn(dom.layer, s.box, 'super-standin super-standin--card', s.key);
      standins.set(s.key, el);
      run(el, s.keyframes as unknown as Keyframe[], timing);
      const real = s.kind === 'resize' || s.kind === 'fromOthers' ? dom.elFor(s.key) : null;
      if (real && s.contentFadeAt !== undefined) {
        // Hidden while its stand-in flies; its content fades in as the stand-in lands.
        const total = s.contentFadeAt + LAYOUT.contentFade;
        run(real, [{ opacity: 0, offset: 0 }, { opacity: 0, offset: s.contentFadeAt / total }, { opacity: 1, offset: 1 }], { duration: total, easing: 'linear' });
        // …and the stand-in fades out over the same 120 ms.
        run(el, [{ opacity: 1, offset: 0 }, { opacity: 1, offset: s.contentFadeAt / total }, { opacity: 0, offset: 1 }], { duration: total, easing: 'linear' });
      }
      return;
    }
    const el = dom.elFor(s.key);
    if (!el) return;
    el.style.willChange = 'transform';
    touched.push(el);
    run(el, s.keyframes as unknown as Keyframe[], timing);
  }

  let cancelled = false;
  const clear = () => {
    for (const el of standins.values()) el.remove();
    standins.clear();
    for (const el of touched) el.style.willChange = '';
    touched.length = 0;
    gliding?.removeAttribute('data-gliding');
    gliding = null;
  };
  const finished = (async () => {
    await Promise.all(anims.map((a) => a.finished.then(() => undefined, () => undefined)));
    if (cancelled) return;
    // Nothing runs past `finished`: the fills go, the real cards stand on their own rects.
    for (const a of anims) { try { a.cancel(); } catch { /* gone */ } }
    clear();
  })();
  return {
    finished,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      for (const a of anims) { if (!ghosts.has(a)) { try { a.cancel(); } catch { /* gone */ } } }
      clear();
    },
    standInRect: (key, origin) => {
      const el = standins.get(key);
      return el && el.isConnected ? rectIn(el, origin) : null;
    },
  };
}

/** Is reduced motion asked for? (Checked at the moment a motion starts.) */
export function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}
