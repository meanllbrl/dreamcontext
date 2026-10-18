/**
 * The motion clock: every ENDLESS CSS animation on this page moves 30 times a second instead
 * of on every display frame (task: durum animasyonları WindowServer'ı yormaz).
 *
 * Why a clock and not CSS. While any animation runs on the display link, macOS recomposites
 * the window on every frame, and WindowServer pays for it whatever the animation animates.
 * Measured on the owner's M1 Pro in a real WKWebView: nothing moving 11 %, the app's status
 * indicators at display rate 44 %, one ring + one dot still at display rate 44 % (one is as
 * expensive as all), the same indicators on CSS `steps(12)` 22-25 % (the display link keeps
 * running), the same indicators paused and stepped from a 12 fps timer 7-10 %. So the CSS stays
 * as it is (keyframes, durations, the motion contract's variables in styles/global.css) and
 * this module takes each endless animation off the display link when it starts: it pauses it
 * through the Web Animations API and sets its `currentTime` from one interval.
 *
 *   - Found by `animationstart` (capture, coalesced into one `document.getAnimations()` scan),
 *     plus one scan at install. Pseudo-element animations are in that list too.
 *   - Only endless ones (`iterations` Infinity, or a count past {@link ENDLESS_COUNT}): an
 *     entrance or a one-shot bounce runs at full rate and ends by itself.
 *   - Phase is kept: an animation's clock time is `now - (its currentTime when held)`, so a
 *     staggered row of dots stays staggered.
 *   - A cancelled animation (its `animation-name` went `none`: Light mode, an ambient one in an
 *     unfocused window, an element that unmounted) drops out; the interval stops when none is
 *     left, and is not running while the window is hidden (nothing moves there anyway).
 *   - Reduced motion makes every animation run once (styles/global.css), so nothing is held.
 */
import { getWindowActivity, onWindowActivity, type WindowActivity } from './windowActivity';

/** Frames per second for every endless animation. 12 was measured cheapest, but a turning ring
 *  jumped 30 degrees a frame and read as stuck (owner, 2026-10-18); 30 turns it 12 degrees a frame. */
export const MOTION_FPS = 30;
/** A finite count past this is endless in practice (the CSS motion guard uses the same line). */
export const ENDLESS_COUNT = 50;
/** After the window comes back, look for animations that started paused only this much later:
 *  the scan forces a style recalc, and the refetch the same change starts must go out first. */
export const RESCAN_DELAY_MS = 250;

/** What the clock needs from its host; injectable so it runs under plain Node in tests. */
export interface MotionClockEnv {
  doc: {
    addEventListener(type: 'animationstart', cb: () => void, capture: boolean): void;
    removeEventListener(type: 'animationstart', cb: () => void, capture: boolean): void;
    getAnimations(): Animation[];
    timeline: { currentTime: CSSNumberish | null } | null;
  };
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (id: ReturnType<typeof setInterval>) => void;
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
  queueMicrotask: (fn: () => void) => void;
  getActivity: () => WindowActivity;
  onActivity: (cb: (next: WindowActivity) => void) => () => void;
  /** The play-state CSS gives this animation right now (a held one ignores it otherwise). */
  playStateOf: (a: Animation) => 'running' | 'paused';
}

/** Each held animation and the timeline time its iteration 0 started at. */
const held = new Map<Animation, number>();
let env: MotionClockEnv | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let scanQueued = false;
let rescanTimer: ReturnType<typeof setTimeout> | null = null;
let dispose: (() => void) | null = null;

function toMs(v: CSSNumberish | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function now(): number {
  return toMs(env?.doc.timeline?.currentTime) ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
}

export function isEndless(a: Animation): boolean {
  const iterations = a.effect?.getComputedTiming().iterations;
  return iterations === Infinity || (typeof iterations === 'number' && iterations > ENDLESS_COUNT);
}

/**
 * Take one animation off the display link. A CSS-paused one is held too: once CSS resumes it no
 * animationstart fires, and it would run at full rate from then on.
 */
function hold(a: Animation): void {
  if (held.has(a) || a.playState === 'idle' || a.playState === 'finished' || !isEndless(a)) return;
  const start = now() - (toMs(a.currentTime) ?? 0);
  a.pause();
  held.set(a, start);
}

function scan(): void {
  scanQueued = false;
  if (!env) return;
  for (const a of env.doc.getAnimations()) hold(a);
  sync();
}

function onAnimationStart(): void {
  if (scanQueued || !env) return;
  scanQueued = true;
  env.queueMicrotask(scan);
}

/**
 * One step: every held animation to its clock time; the cancelled ones drop out. `pause()` makes
 * an animation ignore its CSS `animation-play-state` from then on, so the clock follows it for
 * the CSS instead: a locally paused one (a marquee under the pointer, a picker row that lost the
 * highlight, a diagram scrolled away) holds its frame and later moves on from it. All reads come
 * before any write, so a tick costs one style flush, not one per animation.
 */
function tick(): void {
  if (!env) return;
  const t = now();
  const moving: Array<[Animation, number]> = [];
  for (const [a, start] of held) {
    if (a.playState === 'idle' || a.playState === 'finished') { held.delete(a); continue; }
    if (env.playStateOf(a) === 'paused') { held.set(a, t - (toMs(a.currentTime) ?? 0)); continue; }
    moving.push([a, start]);
  }
  for (const [a, start] of moving) a.currentTime = t - start;
  sync();
}

/** The interval runs exactly while something is held and the window can be seen. */
function sync(): void {
  if (!env) return;
  const want = held.size > 0 && !env.getActivity().hidden;
  if (want && timer === null) timer = env.setInterval(tick, 1000 / MOTION_FPS);
  if (!want && timer !== null) { env.clearInterval(timer); timer = null; }
}

/**
 * Start stepping this page's endless animations. Idempotent: a second call returns the first
 * one's disposer. Call once at boot, after `initWindowActivity`.
 */
export function initMotionClock(envIn?: Partial<MotionClockEnv>): () => void {
  if (dispose) return dispose;
  const resolved = resolveEnv(envIn);
  if (!resolved) return () => {};
  env = resolved;
  const e = resolved;
  e.doc.addEventListener('animationstart', onAnimationStart, true);
  // Back in view: step on from where each one stands (its start shifts by the time away, so
  // nothing jumps a whole hidden stretch ahead).
  let hiddenAt: number | null = null;
  const offActivity = e.onActivity((next) => {
    if (next.hidden && hiddenAt === null) hiddenAt = now();
    if (!next.hidden && hiddenAt !== null) {
      const away = now() - hiddenAt;
      hiddenAt = null;
      for (const [a, start] of held) held.set(a, start + away);
    }
    // An animation created while the window was hidden started PAUSED (the contract's
    // play-state) and fires no second animationstart when it resumes: look again, LATER. This
    // listener runs before the poll registry's, and a scan forces a whole-document style
    // recalc that would hold back the refetch this same change starts.
    sync();
    if (!next.hidden && rescanTimer === null) {
      rescanTimer = e.setTimeout(() => { rescanTimer = null; scan(); }, RESCAN_DELAY_MS);
    }
  });
  scan();
  dispose = () => {
    e.doc.removeEventListener('animationstart', onAnimationStart, true);
    offActivity();
    if (timer !== null) e.clearInterval(timer);
    timer = null;
    if (rescanTimer !== null) e.clearTimeout(rescanTimer);
    rescanTimer = null;
    // Hand every held animation back to the display link, where CSS alone drives it.
    for (const a of held.keys()) { try { a.play(); } catch { /* cancelled meanwhile */ } }
    held.clear();
    scanQueued = false;
    env = null;
    dispose = null;
  };
  return dispose;
}

function resolveEnv(envIn?: Partial<MotionClockEnv>): MotionClockEnv | null {
  const doc = envIn?.doc ?? (typeof document !== 'undefined' && typeof document.getAnimations === 'function' ? document : undefined);
  if (!doc) return null;
  return {
    doc,
    setInterval: envIn?.setInterval ?? ((fn, ms) => setInterval(fn, ms)),
    clearInterval: envIn?.clearInterval ?? ((id) => clearInterval(id)),
    setTimeout: envIn?.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)),
    clearTimeout: envIn?.clearTimeout ?? ((id) => clearTimeout(id)),
    queueMicrotask: envIn?.queueMicrotask ?? ((fn) => queueMicrotask(fn)),
    getActivity: envIn?.getActivity ?? getWindowActivity,
    onActivity: envIn?.onActivity ?? ((cb) => onWindowActivity((next) => cb(next))),
    playStateOf: envIn?.playStateOf ?? cssPlayState,
  };
}

/** The computed `animation-play-state` at this animation's position in its element's list. */
function cssPlayState(a: Animation): 'running' | 'paused' {
  const fx = a.effect as KeyframeEffect | null;
  const el = fx?.target;
  if (!el || typeof getComputedStyle !== 'function') return 'running';
  const cs = getComputedStyle(el, fx?.pseudoElement ?? null);
  const states = cs.animationPlayState.split(',').map((x) => x.trim());
  const name = (a as Animation & { animationName?: string }).animationName;
  const i = name ? Math.max(0, cs.animationName.split(',').map((x) => x.trim()).indexOf(name)) : 0;
  return states[i % states.length] === 'paused' ? 'paused' : 'running';
}

/** How many animations the clock is stepping right now (verify scripts and tests read it). */
export function heldAnimationCount(): number {
  return held.size;
}

/** Tests only. */
export function resetMotionClockForTests(): void {
  dispose?.();
  held.clear();
  timer = null;
  rescanTimer = null;
  scanQueued = false;
  env = null;
  dispose = null;
}
