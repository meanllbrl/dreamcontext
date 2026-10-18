/**
 * lib/motionClock.ts: every endless CSS animation is stepped at 12 fps from one interval instead
 * of running on the display link (task: durum animasyonları WindowServer'ı yormaz, AC4).
 *
 * Driven with fake Animation objects and a fake document under plain Node: the clock only reads
 * `getAnimations()`, `animationstart`, the document timeline and each animation's timing, and
 * only writes `pause()`, `currentTime` and (on dispose) `play()`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  initMotionClock,
  resetMotionClockForTests,
  heldAnimationCount,
  isEndless,
  MOTION_FPS,
  RESCAN_DELAY_MS,
  type MotionClockEnv,
} from '../../dashboard/src/lib/motionClock';
import type { WindowActivity } from '../../dashboard/src/lib/windowActivity';

interface FakeAnim {
  playState: 'running' | 'paused' | 'idle' | 'finished';
  currentTime: number | null;
  effect: { getComputedTiming: () => { iterations: number } };
  pause: () => void;
  play: () => void;
  writes: number[];
  /** The play-state CSS gives it (what `playStateOf` reads from the computed style). */
  cssState: 'running' | 'paused';
}

function anim(iterations: number, currentTime = 0): FakeAnim {
  const a: FakeAnim = {
    playState: 'running',
    currentTime,
    effect: { getComputedTiming: () => ({ iterations }) },
    pause() { a.playState = 'paused'; },
    play() { a.playState = 'running'; },
    writes: [],
    cssState: 'running',
  };
  let ct = currentTime;
  Object.defineProperty(a, 'currentTime', {
    get: () => ct,
    set: (v: number) => { ct = v; a.writes.push(v); },
  });
  return a;
}

function host() {
  const doc = new EventTarget() as EventTarget & MotionClockEnv['doc'];
  let animations: FakeAnim[] = [];
  let t = 1000;
  Object.assign(doc, {
    getAnimations: () => animations as unknown as Animation[],
    timeline: { get currentTime() { return t; } },
  });
  let intervalFn: (() => void) | null = null;
  let intervalMs = 0;
  let intervals = 0;
  const micro: Array<() => void> = [];
  const timeouts: Array<{ fn: () => void; ms: number }> = [];
  let activity: WindowActivity = { visible: true, focused: true, hidden: false };
  const activityListeners = new Set<(a: WindowActivity) => void>();
  const env: Partial<MotionClockEnv> = {
    doc,
    setInterval: (fn, ms) => { intervalFn = fn; intervalMs = ms; intervals += 1; return 1 as unknown as ReturnType<typeof setInterval>; },
    clearInterval: () => { intervalFn = null; },
    queueMicrotask: (fn) => { micro.push(fn); },
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length as unknown as ReturnType<typeof setTimeout>; },
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
  beforeEach(() => resetMotionClockForTests());

  it('runs at 24-30 fps: smooth enough for a turning ring, far below the display link', () => {
    expect(MOTION_FPS).toBeGreaterThanOrEqual(24);
    expect(MOTION_FPS).toBeLessThanOrEqual(30);
  });

  it('holds every endless animation already running at install, and leaves finite ones alone', () => {
    const h = host();
    const ring = anim(Infinity, 250);
    const entrance = anim(1, 100);
    const huge = anim(9999);
    h.animations = [ring, entrance, huge];
    initMotionClock(h.env);
    expect(ring.playState).toBe('paused');
    expect(huge.playState).toBe('paused');
    expect(entrance.playState).toBe('running');
    expect(heldAnimationCount()).toBe(2);
    expect(h.running).toBe(true);
    expect(h.intervalMs).toBeCloseTo(1000 / MOTION_FPS);
  });

  it('steps each held animation along the timeline, keeping its phase', () => {
    const h = host();
    const a = anim(Infinity, 0);
    const b = anim(Infinity, 300); // a staggered sibling, 300 ms ahead
    h.animations = [a, b];
    initMotionClock(h.env);
    h.advance(83);
    h.tick();
    h.advance(83);
    h.tick();
    expect(a.writes).toEqual([83, 166]);
    expect(b.writes).toEqual([383, 466]);
    // Still paused between steps: nothing runs on the display link.
    expect(a.playState).toBe('paused');
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
    expect(dot.playState).toBe('paused');
    expect(h.running).toBe(true);
  });

  it('drops a cancelled animation and stops the interval when nothing is left', () => {
    const h = host();
    const a = anim(Infinity);
    h.animations = [a];
    initMotionClock(h.env);
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
    h.advance(100);
    h.tick();
    h.setHidden(true);
    expect(h.running).toBe(false);
    h.advance(60_000);
    h.setHidden(false);
    expect(h.running).toBe(true);
    h.advance(50);
    h.tick();
    expect(a.writes).toEqual([100, 150]);
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
    expect(heldAnimationCount()).toBe(1);
    h.advance(83);
    h.tick();
    expect(diagram.writes).toEqual([]); // still paused by CSS: it holds its frame
    diagram.cssState = 'running'; // scrolled back into view: no animationstart fires
    h.advance(83);
    h.tick();
    expect(diagram.writes).toEqual([123]); // moves on from 40, never on the display link
    expect(diagram.playState).toBe('paused');
  });

  it('a held animation paused locally by CSS holds its frame, then moves on from it', () => {
    const h = host();
    const marquee = anim(Infinity, 0);
    h.animations = [marquee];
    initMotionClock(h.env);
    h.advance(100);
    h.tick();
    marquee.cssState = 'paused'; // pointer over the marquee
    h.advance(5_000);
    h.tick();
    h.advance(5_000);
    h.tick();
    expect(marquee.writes).toEqual([100]);
    marquee.cssState = 'running'; // pointer gone
    h.advance(50);
    h.tick();
    expect(marquee.writes).toEqual([100, 150]);
  });

  it('dispose hands every held animation back to the display link', () => {
    const h = host();
    const a = anim(Infinity);
    h.animations = [a];
    const dispose = initMotionClock(h.env);
    expect(initMotionClock(h.env)).toBe(dispose);
    dispose();
    expect(a.playState).toBe('running');
    expect(h.running).toBe(false);
    expect(heldAnimationCount()).toBe(0);
  });

  it('isEndless: Infinity and huge counts, never a one-shot', () => {
    expect(isEndless(anim(Infinity) as unknown as Animation)).toBe(true);
    expect(isEndless(anim(51) as unknown as Animation)).toBe(true);
    expect(isEndless(anim(3) as unknown as Animation)).toBe(false);
  });
});
