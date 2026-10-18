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
 * Pausing alone is not enough, see {@link hold}: an animation that already ran is taken off the
 * render server first, and only then paused.
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
/** How long a cancelled animation waits before it is held: the cancel must reach the render
 *  server in a rendering update of its own first. A timer, because requestAnimationFrame does not
 *  run in a hidden window. 50 ms is the gap that was measured to work. */
export const REHOLD_DELAY_MS = 50;

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
  /** The play-state CSS gives this animation right now (a held one ignores it otherwise);
   *  `gone` once CSS no longer gives it at all (its name left the element's list, or the
   *  element left the document). */
  playStateOf: (a: Animation) => 'running' | 'paused' | 'gone';
}

/** Each held animation and the timeline time its iteration 0 started at. */
const held = new Map<Animation, number>();
/** Cancelled by {@link hold}, waiting for {@link rehold}: start as in `held`, and the phase. */
const waiting = new Map<Animation, { start: number; phase: number }>();
let env: MotionClockEnv | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let scanQueued = false;
let rescanTimer: ReturnType<typeof setTimeout> | null = null;
let reholdTimer: ReturnType<typeof setTimeout> | null = null;
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

/** Which CSS animation this is: its element, pseudo-element and name (null when unknown). */
function keyOf(a: Animation): string | null {
  const fx = a.effect as KeyframeEffect | null;
  const name = (a as Animation & { animationName?: string }).animationName;
  if (!fx?.target || !name) return null;
  let id = targetIds.get(fx.target);
  if (id === undefined) { id = nextTargetId++; targetIds.set(fx.target, id); }
  return `${id}${fx.pseudoElement ?? ''}|${name}`;
}
const targetIds = new WeakMap<Element, number>();
let nextTargetId = 0;

/**
 * Take one animation off the display link. It cannot simply be paused where it runs: by the time
 * `animationstart` fires it is already running on the render server, and an animation paused
 * there keeps WindowServer compositing the window on every display frame, frozen or not
 * (measured on the owner's M1 Pro: four rings paused in place 54 %, the same rings cancelled and
 * held 50 ms later 1.7 %; the real app 48.9 % against 7.1 %). Cancelling and re-playing it in
 * one task does nothing either (53.4 %): both land in the same commit. So it is cancelled now
 * and played and paused at its phase in a later task ({@link rehold}); meanwhile the element
 * shows its base style, its resting look. A cancelled CSS animation still belongs to its CSS:
 * removing its name or its element later cancels it as before. A CSS-paused one is held too:
 * once CSS resumes it no animationstart fires, and it would run at full rate from then on.
 */
function hold(a: Animation): void {
  if (held.has(a) || waiting.has(a) || a.playState === 'idle' || a.playState === 'finished' || !isEndless(a)) return;
  // CSS makes a second animation for the same element and name only after it dropped the first:
  // an older one with this key is one CSS can no longer stop (see rehold), so it goes.
  const key = keyOf(a);
  if (key !== null) {
    for (const old of held.keys()) if (keyOf(old) === key) { held.delete(old); old.cancel(); }
    for (const old of waiting.keys()) if (keyOf(old) === key) waiting.delete(old);
  }
  const phase = toMs(a.currentTime) ?? 0;
  waiting.set(a, { start: now() - phase, phase });
  a.cancel();
  if (reholdTimer === null && env) reholdTimer = env.setTimeout(rehold, REHOLD_DELAY_MS);
}

/**
 * Hold what {@link hold} cancelled: each one played, paused and put back at its phase, after a
 * rendering update took it off the render server. One its CSS dropped meanwhile stays cancelled:
 * its name left the element (Light mode, the work ended), its element left, or CSS already made
 * a new animation in its place (the name went and came back, or the element was hidden and shown
 * again). Re-played, it would be an animation no CSS can stop, a ring turning after the work
 * ended. All reads come before the writes.
 */
function rehold(): void {
  reholdTimer = null;
  if (!env) return;
  const e = env;
  const batch = [...waiting];
  waiting.clear();
  const taken = new Set<string>();
  for (const other of e.doc.getAnimations()) { const k = keyOf(other); if (k !== null) taken.add(k); }
  const back = batch.filter(([a]) => {
    const k = keyOf(a);
    return !(k !== null && taken.has(k)) && e.playStateOf(a) !== 'gone';
  });
  for (const [a, { start, phase }] of back) {
    try { a.play(); a.pause(); a.currentTime = phase; } catch { continue; }
    held.set(a, start);
  }
  sync();
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
 * highlight, a diagram scrolled away) holds its frame and later moves on from it. One CSS no
 * longer gives at all is cancelled: CSS has cancelled it already, unless CSS had let go of it
 * before (see {@link rehold}). All reads come before any write, so a tick costs one style flush,
 * not one per animation.
 */
function tick(): void {
  if (!env) return;
  const t = now();
  const moving: Array<[Animation, number]> = [];
  const gone: Animation[] = [];
  for (const [a, start] of held) {
    if (a.playState === 'idle' || a.playState === 'finished') { held.delete(a); continue; }
    const css = env.playStateOf(a);
    if (css === 'gone') { held.delete(a); gone.push(a); continue; }
    if (css === 'paused') { held.set(a, t - (toMs(a.currentTime) ?? 0)); continue; }
    moving.push([a, start]);
  }
  for (const [a, start] of moving) a.currentTime = t - start;
  for (const a of gone) a.cancel();
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
      for (const w of waiting.values()) w.start += away;
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
    if (reholdTimer !== null) e.clearTimeout(reholdTimer);
    reholdTimer = null;
    // Hand every held animation back to the display link, where CSS alone drives it.
    for (const a of [...held.keys(), ...waiting.keys()]) { try { a.play(); } catch { /* cancelled meanwhile */ } }
    held.clear();
    waiting.clear();
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

/** The computed `animation-play-state` at this animation's position in its element's list, or
 *  `gone` when the element left the document or its list no longer names this animation. */
function cssPlayState(a: Animation): 'running' | 'paused' | 'gone' {
  const fx = a.effect as KeyframeEffect | null;
  const el = fx?.target;
  if (!el || typeof getComputedStyle !== 'function') return 'running';
  if (!el.isConnected) return 'gone';
  const cs = getComputedStyle(el, fx?.pseudoElement ?? null);
  const states = cs.animationPlayState.split(',').map((x) => x.trim());
  const name = (a as Animation & { animationName?: string }).animationName;
  let i = 0;
  if (name) {
    i = cs.animationName.split(',').map((x) => x.trim().replace(/^(["'])(.*)\1$/, '$2')).indexOf(name);
    if (i < 0) return 'gone';
  }
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
  waiting.clear();
  timer = null;
  rescanTimer = null;
  reholdTimer = null;
  scanQueued = false;
  env = null;
  dispose = null;
}
