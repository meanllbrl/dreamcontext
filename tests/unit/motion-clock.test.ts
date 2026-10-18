/**
 * lib/motionClock.ts: every endless CSS animation is taken off the render server and stepped from
 * one interval instead of running on the display link (task: durum animasyonları WindowServer'ı
 * yormaz, AC4).
 *
 * Driven with fake Animation objects and a fake document under plain Node: the clock only reads
 * `getAnimations()`, `animationstart`, the document timeline and each animation's timing, and
 * only writes `cancel()`, `play()`, `pause()` and `currentTime`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  initMotionClock,
  resetMotionClockForTests,
  heldAnimationCount,
  isEndless,
  MOTION_FPS,
  RESCAN_DELAY_MS,
  REHOLD_DELAY_MS,
  type MotionClockEnv,
} from '../../dashboard/src/lib/motionClock';
import type { WindowActivity } from '../../dashboard/src/lib/windowActivity';

interface FakeAnim {
  playState: 'running' | 'paused' | 'idle' | 'finished';
  currentTime: number | null;
  effect: { getComputedTiming: () => { iterations: number }; target?: object; pseudoElement?: string | null };
  animationName?: string;
  cancel: () => void;
  pause: () => void;
  play: () => void;
  writes: number[];
  /** Every call the clock made, in order; `|` marks where a task ended (see host().task). */
  ops: string[];
  /** The play-state CSS gives it (what `playStateOf` reads from the computed style). */
  cssState: 'running' | 'paused' | 'gone';
}

const log: FakeAnim[] = [];

/** A fake CSS animation. `css` = { target, name } makes it one of an element's CSS animations. */
function anim(iterations: number, currentTime = 0, css?: { target: object; name: string; pseudo?: string }): FakeAnim {
  let ct: number | null = currentTime;
  const a: FakeAnim = {
    playState: 'running',
    currentTime,
    effect: { getComputedTiming: () => ({ iterations }), target: css?.target, pseudoElement: css?.pseudo ?? null },
    animationName: css?.name,
    cancel() { a.ops.push('cancel'); a.playState = 'idle'; ct = null; },
    pause() { a.ops.push('pause'); a.playState = 'paused'; },
    // Web Animations: play() on an idle animation starts it from 0.
    play() { a.ops.push('play'); if (a.playState === 'idle') ct = 0; a.playState = 'running'; },
    writes: [],
    ops: [],
    cssState: 'running',
  };
  Object.defineProperty(a, 'currentTime', {
    get: () => ct,
    set: (v: number) => { ct = v; a.writes.push(v); a.ops.push(`time:${v}`); },
  });
  log.push(a);
  return a;
}

function host() {
  const doc = new EventTarget() as EventTarget & MotionClockEnv['doc'];
  let animations: FakeAnim[] = [];
  let t = 1000;
  Object.assign(doc, {
    // Like the real list: a cancelled (idle) animation is not in it.
    getAnimations: () => animations.filter((a) => a.playState !== 'idle') as unknown as Animation[],
    timeline: { get currentTime() { return t; } },
  });
  let intervalFn: (() => void) | null = null;
  let intervalMs = 0;
  let intervals = 0;
  const micro: Array<() => void> = [];
  const timeouts: Array<{ fn: () => void; ms: number }> = [];
  let activity: WindowActivity = { visible: true, focused: true, hidden: false };
  const activityListeners = new Set<(a: WindowActivity) => void>();
  /** Each timer callback is a task of its own: mark the boundary in every animation's ops. */
  const task = (fn: () => void) => () => { for (const a of log) a.ops.push('|'); fn(); };
  const env: Partial<MotionClockEnv> = {
    doc,
    setInterval: (fn, ms) => { intervalFn = task(fn); intervalMs = ms; intervals += 1; return 1 as unknown as ReturnType<typeof setInterval>; },
    clearInterval: () => { intervalFn = null; },
    queueMicrotask: (fn) => { micro.push(fn); },
    setTimeout: (fn, ms) => { timeouts.push({ fn: task(fn), ms }); return timeouts.length as unknown as ReturnType<typeof setTimeout>; },
    clearTimeout: () => { timeouts.length = 0; },
    getActivity: () => activity,
    onActivity: (cb) => { activityListeners.add(cb); return () => activityListeners.delete(cb); },
    playStateOf: (a) => (a as unknown as FakeAnim).cssState,
  };
  return {
    env,
    set animations(v: FakeAnim[]) { animations = v; },
    advance(ms: number) { t += ms; },
    tick() { intervalFn?.(); },
    get running() { return intervalFn !== null; },
    get intervalMs() { return intervalMs; },
    get intervals() { return intervals; },
    start() { doc.dispatchEvent(new Event('animationstart')); },
    flush() { while (micro.length) micro.shift()!(); },
    get queued() { return micro.length; },
    get timeouts() { return timeouts; },
    runTimeouts() { while (timeouts.length) timeouts.shift()!.fn(); },
    setHidden(hidden: boolean) {
      activity = { visible: !hidden, focused: !hidden, hidden };
      for (const l of activityListeners) l(activity);
    },
  };
}

describe('motion clock', () => {
  beforeEach(() => { resetMotionClockForTests(); log.length = 0; });

  it('runs at 15-20 fps: a ring that does not read as stuck, WindowServer under 20 %', () => {
    // Real app, owner's M1 Pro: 15 fps 14-15 %, 20 fps 18-22 %, 30 fps 25-31 %; 12 read as stuck.
    expect(MOTION_FPS).toBeGreaterThanOrEqual(15);
    expect(MOTION_FPS).toBeLessThanOrEqual(20);
  });

  it('holds every endless animation already running at install, and leaves finite ones alone', () => {
    const h = host();
    const ring = anim(Infinity, 250);
    const entrance = anim(1, 100);
    const huge = anim(9999);
    h.animations = [ring, entrance, huge];
    initMotionClock(h.env);
    h.runTimeouts();
    expect(ring.playState).toBe('paused');
    expect(huge.playState).toBe('paused');
    expect(entrance.playState).toBe('running');
    expect(entrance.ops).not.toContain('cancel');
    expect(heldAnimationCount()).toBe(2);
    expect(h.running).toBe(true);
    expect(h.intervalMs).toBeCloseTo(1000 / MOTION_FPS);
  });

  it('takes a running animation off the render server first, and pauses it only in a later task', () => {
    // Paused where it runs, an animation keeps WindowServer compositing every display frame;
    // cancelled and re-played in one task, both land in one commit and nothing changes.
    const h = host();
    const ring = anim(Infinity, 250);
    h.animations = [ring];
    initMotionClock(h.env);
    expect(ring.ops).toEqual(['cancel']);
    expect(ring.playState).toBe('idle');
    expect(heldAnimationCount()).toBe(0);
    expect(h.running).toBe(false);
    expect(h.timeouts.map((t) => t.ms)).toEqual([REHOLD_DELAY_MS]);
    h.runTimeouts();
    expect(ring.ops).toEqual(['cancel', '|', 'play', 'pause', 'time:250']);
    expect(heldAnimationCount()).toBe(1);
    expect(h.running).toBe(true);
  });

  it('one wait for a whole burst: every animation cancelled in it comes back in one later task', () => {
    const h = host();
    const a = anim(Infinity);
    const b = anim(Infinity, 300);
    h.animations = [a, b];
    initMotionClock(h.env);
    expect(h.timeouts).toHaveLength(1);
    h.runTimeouts();
    expect(heldAnimationCount()).toBe(2);
  });

  it('steps each held animation along the timeline, keeping its phase', () => {
    const h = host();
    const a = anim(Infinity, 0);
    const b = anim(Infinity, 300); // a staggered sibling, 300 ms ahead
    h.animations = [a, b];
    initMotionClock(h.env);
    h.runTimeouts();
    h.advance(83);
    h.tick();
    h.advance(83);
    h.tick();
    expect(a.writes).toEqual([0, 83, 166]);
    expect(b.writes).toEqual([300, 383, 466]);
    // Still paused between steps: nothing runs on the display link.
    expect(a.playState).toBe('paused');
  });

  it('keeps time through the wait: the first step after it lands where the animation would be', () => {
    const h = host();
    const a = anim(Infinity, 100);
    h.animations = [a];
    initMotionClock(h.env);
    h.advance(REHOLD_DELAY_MS);
    h.runTimeouts();
    h.advance(10);
    h.tick();
    expect(a.writes).toEqual([100, 100 + REHOLD_DELAY_MS + 10]);
  });

  it('finds an animation that starts later through one coalesced scan per burst of animationstart', () => {
    const h = host();
    h.animations = [];
    initMotionClock(h.env);
    expect(h.running).toBe(false);
    const dot = anim(Infinity);
    h.animations = [dot];
    h.start();
    h.start();
    h.start();
    expect(h.queued).toBe(1);
    h.flush();
    expect(dot.playState).toBe('idle');
    h.runTimeouts();
    expect(dot.playState).toBe('paused');
    expect(h.running).toBe(true);
    // Its replay fires animationstart again: the scan finds it held and leaves it alone.
    h.start();
    h.flush();
    expect(dot.ops.filter((o) => o === 'cancel')).toHaveLength(1);
  });

  it('one CSS dropped during the wait stays cancelled: re-played, nothing could stop it', () => {
    const h = host();
    const ring = anim(Infinity, 0, { target: {}, name: 'projectTabRing' });
    h.animations = [ring];
    initMotionClock(h.env);
    ring.cssState = 'gone'; // the work ended: its name left the element
    h.runTimeouts();
    expect(ring.playState).toBe('idle');
    expect(ring.ops).not.toContain('play');
    expect(heldAnimationCount()).toBe(0);
    expect(h.running).toBe(false);
  });

  it('one CSS replaced during the wait stays cancelled, and the new one is held instead', () => {
    // The name went and came back (or the element was hidden and shown again) inside the wait:
    // CSS made a new animation and let go of the cancelled one.
    const h = host();
    const el = {};
    const old = anim(Infinity, 0, { target: el, name: 'agentDotPulse' });
    h.animations = [old];
    initMotionClock(h.env);
    const fresh = anim(Infinity, 0, { target: el, name: 'agentDotPulse' });
    h.animations = [old, fresh]; // its animationstart has not reached the clock yet
    h.runTimeouts();
    expect(old.playState).toBe('idle');
    expect(old.ops).not.toContain('play');
    h.start();
    h.flush();
    h.runTimeouts();
    expect(fresh.playState).toBe('paused');
    expect(heldAnimationCount()).toBe(1);
  });

  it('a newer animation of the same element and name retires an older one the clock still holds', () => {
    const h = host();
    const el = {};
    const stale = anim(Infinity, 0, { target: el, name: 'projectTabRing', pseudo: '::before' });
    const other = anim(Infinity, 0, { target: el, name: 'projectTabRingClosed', pseudo: '::after' });
    h.animations = [stale, other];
    initMotionClock(h.env);
    h.runTimeouts();
    expect(heldAnimationCount()).toBe(2);
    const fresh = anim(Infinity, 0, { target: el, name: 'projectTabRing', pseudo: '::before' });
    h.animations = [stale, other, fresh];
    h.start();
    h.flush();
    expect(stale.playState).toBe('idle');
    expect(other.playState).toBe('paused'); // another name on the same element: untouched
    h.runTimeouts();
    expect(fresh.playState).toBe('paused');
    expect(heldAnimationCount()).toBe(2);
  });

  it('a held animation CSS no longer gives is cancelled at the next step', () => {
    const h = host();
    const a = anim(Infinity);
    h.animations = [a];
    initMotionClock(h.env);
    h.runTimeouts();
    a.cssState = 'gone';
    h.advance(33);
    h.tick();
    expect(a.playState).toBe('idle');
    expect(a.writes).toEqual([0]); // no step written to it
    expect(heldAnimationCount()).toBe(0);
    expect(h.running).toBe(false);
  });

  it('drops a cancelled animation and stops the interval when nothing is left', () => {
    const h = host();
    const a = anim(Infinity);
    h.animations = [a];
    initMotionClock(h.env);
    h.runTimeouts();
    a.playState = 'idle'; // animation-name went none (Light mode, unmount)
    h.tick();
    expect(heldAnimationCount()).toBe(0);
    expect(h.running).toBe(false);
  });

  it('does not tick while the window is hidden, and resumes from where each animation stood', () => {
    const h = host();
    const a = anim(Infinity, 0);
    h.animations = [a];
    initMotionClock(h.env);
    h.runTimeouts();
    h.advance(100);
    h.tick();
    h.setHidden(true);
    expect(h.running).toBe(false);
    h.advance(60_000);
    h.setHidden(false);
    expect(h.running).toBe(true);
    h.advance(50);
    h.tick();
    expect(a.writes).toEqual([0, 100, 150]);
  });

  it('holds an animation that started paused while hidden, once the window is visible again', () => {
    const h = host();
    h.animations = [];
    initMotionClock(h.env);
    h.setHidden(true);
    const late = anim(Infinity);
    late.playState = 'paused'; // created while hidden: the contract's play-state paused it,
    late.cssState = 'paused';  // and no animationstart reached the clock for it
    h.animations = [late];
    late.playState = 'running'; // visible: CSS resumes it, and no animationstart fires now either
    late.cssState = 'running';
    h.setHidden(false);
    // Not inside the visibility change itself (its style flush would hold back the refetch)...
    expect(heldAnimationCount()).toBe(0);
    expect(h.timeouts.map((t) => t.ms)).toEqual([RESCAN_DELAY_MS]);
    // ...but a moment later.
    h.runTimeouts();
    expect(late.playState).toBe('paused');
    expect(heldAnimationCount()).toBe(1);
    expect(h.running).toBe(true);
  });

  it('holds a CSS-paused endless animation too, and moves it once CSS resumes it', () => {
    const h = host();
    const diagram = anim(Infinity, 40);
    diagram.playState = 'paused'; // e.g. a diagram scrolled away: `--dc-motion-play: paused` locally
    diagram.cssState = 'paused';
    h.animations = [diagram];
    initMotionClock(h.env);
    h.runTimeouts();
    expect(heldAnimationCount()).toBe(1);
    h.advance(83);
    h.tick();
    expect(diagram.writes).toEqual([40]); // still paused by CSS: it holds its frame
    diagram.cssState = 'running'; // scrolled back into view: no animationstart fires
    h.advance(83);
    h.tick();
    expect(diagram.writes).toEqual([40, 123]); // moves on from 40, never on the display link
    expect(diagram.playState).toBe('paused');
  });

  it('a held animation paused locally by CSS holds its frame, then moves on from it', () => {
    const h = host();
    const marquee = anim(Infinity, 0);
    h.animations = [marquee];
    initMotionClock(h.env);
    h.runTimeouts();
    h.advance(100);
    h.tick();
    marquee.cssState = 'paused'; // pointer over the marquee
    h.advance(5_000);
    h.tick();
    h.advance(5_000);
    h.tick();
    expect(marquee.writes).toEqual([0, 100]);
    marquee.cssState = 'running'; // pointer gone
    h.advance(50);
    h.tick();
    expect(marquee.writes).toEqual([0, 100, 150]);
  });

  it('dispose hands every held animation back to the display link', () => {
    const h = host();
    const a = anim(Infinity);
    h.animations = [a];
    const dispose = initMotionClock(h.env);
    h.runTimeouts();
    expect(initMotionClock(h.env)).toBe(dispose);
    dispose();
    expect(a.playState).toBe('running');
    expect(h.running).toBe(false);
    expect(heldAnimationCount()).toBe(0);
  });

  it('dispose during the wait hands the cancelled ones back too, and nothing is held after', () => {
    const h = host();
    const a = anim(Infinity);
    h.animations = [a];
    const dispose = initMotionClock(h.env);
    dispose();
    expect(a.playState).toBe('running');
    expect(h.timeouts).toHaveLength(0);
    expect(heldAnimationCount()).toBe(0);
  });

  it('isEndless: Infinity and huge counts, never a one-shot', () => {
    expect(isEndless(anim(Infinity) as unknown as Animation)).toBe(true);
    expect(isEndless(anim(51) as unknown as Animation)).toBe(true);
    expect(isEndless(anim(3) as unknown as Animation)).toBe(false);
  });
});
