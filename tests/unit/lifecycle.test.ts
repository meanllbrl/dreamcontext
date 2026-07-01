import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { startParentDeathWatch, trackChild, killTrackedChildren } from '../../src/server/lifecycle.js';

/**
 * The dashboard server must not outlive the desktop app. These tests pin the
 * parent-death watchdog (the root-cause fix for orphaned dashboard servers): it
 * fires `onParentGone` once the parent PID stops existing, but only when the server
 * was desktop-spawned, and never for a transient EPERM (parent exists, not ours).
 */
describe('startParentDeathWatch', () => {
  const ORIG = { ...process.env };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    process.env = { ...ORIG };
  });

  it('does nothing when not desktop-spawned (no DREAMCONTEXT_DESKTOP)', () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    process.env.DREAMCONTEXT_PARENT_PID = '4242';
    const onGone = vi.fn();
    const stop = startParentDeathWatch(onGone);
    expect(stop).toBeUndefined();
    vi.advanceTimersByTime(10_000);
    expect(onGone).not.toHaveBeenCalled();
  });

  it('does nothing when already orphaned (no explicit pid, ppid resolves to 1)', () => {
    process.env.DREAMCONTEXT_DESKTOP = '1';
    delete process.env.DREAMCONTEXT_PARENT_PID;
    const realPpid = Object.getOwnPropertyDescriptor(process, 'ppid');
    Object.defineProperty(process, 'ppid', { configurable: true, get: () => 1 });
    try {
      const stop = startParentDeathWatch(vi.fn());
      expect(stop).toBeUndefined();
    } finally {
      if (realPpid) Object.defineProperty(process, 'ppid', realPpid);
    }
  });

  it('starts a watch (returns a stop fn) for a valid desktop parent', () => {
    process.env.DREAMCONTEXT_DESKTOP = '1';
    process.env.DREAMCONTEXT_PARENT_PID = '4242';
    vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
    const stop = startParentDeathWatch(vi.fn());
    expect(typeof stop).toBe('function');
    stop?.();
  });

  it('fires onParentGone once the parent PID disappears (ESRCH)', () => {
    process.env.DREAMCONTEXT_DESKTOP = '1';
    process.env.DREAMCONTEXT_PARENT_PID = '4242';
    let parentAlive = true;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
      expect(pid).toBe(4242);
      expect(sig).toBe(0);
      if (!parentAlive) {
        const err = new Error('no such process') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    }) as typeof process.kill);

    const onGone = vi.fn();
    startParentDeathWatch(onGone);

    // Parent still alive across several polls → no fire.
    vi.advanceTimersByTime(6_000);
    expect(onGone).not.toHaveBeenCalled();

    // Parent dies → next poll fires exactly once, then the interval is cleared.
    parentAlive = false;
    vi.advanceTimersByTime(2_000);
    expect(onGone).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(onGone).toHaveBeenCalledTimes(1);
    killSpy.mockRestore();
  });

  it('does NOT fire on EPERM (parent exists but is not ours — PID reuse)', () => {
    process.env.DREAMCONTEXT_DESKTOP = '1';
    process.env.DREAMCONTEXT_PARENT_PID = '4242';
    vi.spyOn(process, 'kill').mockImplementation((() => {
      const err = new Error('operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    }) as typeof process.kill);

    const onGone = vi.fn();
    startParentDeathWatch(onGone);
    vi.advanceTimersByTime(10_000);
    expect(onGone).not.toHaveBeenCalled();
  });
});

/**
 * End-to-end against the real OS: watch a real process, SIGKILL it (so no cleanup
 * code runs — exactly the orphaning scenario), and confirm the watchdog fires.
 */
describe('startParentDeathWatch (real process)', () => {
  const ORIG = { ...process.env };
  afterEach(() => { process.env = { ...ORIG }; });

  it('fires when the watched process is killed', async () => {
    const { spawn } = await import('node:child_process');
    const dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await new Promise((r) => dummy.once('spawn', r));

    process.env.DREAMCONTEXT_DESKTOP = '1';
    process.env.DREAMCONTEXT_PARENT_PID = String(dummy.pid);

    const fired = new Promise<void>((resolve) => {
      const stop = startParentDeathWatch(() => { stop?.(); resolve(); });
      expect(stop).toBeTypeOf('function');
    });

    dummy.kill('SIGKILL'); // hard kill — no exit handler runs, just like a force-quit
    await fired; // resolves within ~2 polls or the test times out
  }, 8000);
});

describe('trackChild / killTrackedChildren', () => {
  afterEach(() => killTrackedChildren());

  it('kills every tracked child once, and unregister removes it', () => {
    const a = vi.fn();
    const b = vi.fn();
    trackChild(a);
    const untrackB = trackChild(b);
    untrackB();

    killTrackedChildren();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();

    // Set is cleared — a second sweep is a no-op.
    killTrackedChildren();
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('ignores a child that throws while being killed', () => {
    const boom = vi.fn(() => { throw new Error('already dead'); });
    const ok = vi.fn();
    trackChild(boom);
    trackChild(ok);
    expect(() => killTrackedChildren()).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
