/**
 * The WebGL budget (AC10, task "the desktop app stays light on an 8GB MacBook Air"): with 4
 * terminal panes at most 2 live contexts, also after toggling a setting; a parked terminal holds
 * none after 2 s; Light mode → 0; a terminal that lost its context stays on DOM; nothing before
 * settings and Light mode are known; a quick re-show waits 300 ms before reloading.
 *
 * The rule (`decideWebgl`) is pure; the runtime (`createWebglBudget`) is driven with a fake
 * clock, fake timers and injected setting / Light-mode sources — no xterm, no GPU.
 */
import { describe, it, expect } from 'vitest';
import {
  decideWebgl, createWebglBudget, MAX_WEBGL_TERMINALS, WEBGL_HIDE_GRACE_MS, WEBGL_RESHOW_DELAY_MS,
  type WebglTermState, type WebglGlobalState, type WebglBudgetDeps,
} from '../../dashboard/src/components/sleepy/webglBudget.js';
import type { AgentRenderer } from '../../dashboard/src/lib/agentSettings.js';

const READY: WebglGlobalState = { ready: true, light: false, renderer: 'webgl' };

function term(id: string, over: Partial<WebglTermState> = {}): WebglTermState {
  return { id, visible: true, visibleSince: 0, lastVisibleAt: 0, webgl: false, lost: false, droppedAt: null, ...over };
}

describe('decideWebgl (pure)', () => {
  it('gives nothing before settings and Light mode are known', () => {
    expect(decideWebgl({ ...READY, ready: false }, [term('a')], 0).on.size).toBe(0);
  });

  it('gives nothing in Light mode or with the DOM renderer', () => {
    expect(decideWebgl({ ...READY, light: true }, [term('a')], 0).on.size).toBe(0);
    expect(decideWebgl({ ...READY, renderer: 'dom' }, [term('a')], 0).on.size).toBe(0);
  });

  it('caps live contexts at 2 across 4 visible panes, keeping the ones that already hold one', () => {
    const terms = [term('a', { visibleSince: 4 }), term('b', { webgl: true, visibleSince: 1 }), term('c', { visibleSince: 3 }), term('d', { webgl: true, visibleSince: 2 })];
    const d = decideWebgl(READY, terms, 10);
    expect(MAX_WEBGL_TERMINALS).toBe(2);
    expect([...d.on].sort()).toEqual(['b', 'd']);
  });

  it('prefers the most recently shown when none holds a context', () => {
    const terms = [term('a', { visibleSince: 1 }), term('b', { visibleSince: 3 }), term('c', { visibleSince: 2 })];
    expect([...decideWebgl(READY, terms, 10).on].sort()).toEqual(['b', 'c']);
  });

  it('never gives a context to a terminal that lost one', () => {
    expect(decideWebgl(READY, [term('a', { lost: true })], 0).on.size).toBe(0);
  });

  it('keeps a context through the 2 s grace after a pane leaves the screen, then releases it', () => {
    const t = term('a', { visible: false, webgl: true, lastVisibleAt: 1000 });
    const during = decideWebgl(READY, [t], 1000 + WEBGL_HIDE_GRACE_MS - 1);
    expect(during.on.has('a')).toBe(true);
    expect(during.recheckAt).toBe(1000 + WEBGL_HIDE_GRACE_MS);
    expect(decideWebgl(READY, [t], 1000 + WEBGL_HIDE_GRACE_MS).on.size).toBe(0);
  });

  it('never gives a context to an off-screen terminal', () => {
    expect(decideWebgl(READY, [term('a', { visible: false, lastVisibleAt: 0 })], 1).on.size).toBe(0);
  });

  it('a re-show within 5 s of a release waits 300 ms', () => {
    const t = term('a', { droppedAt: 1000, visibleSince: 2000 });
    const early = decideWebgl(READY, [t], 2000 + WEBGL_RESHOW_DELAY_MS - 1);
    expect(early.on.size).toBe(0);
    expect(early.recheckAt).toBe(2000 + WEBGL_RESHOW_DELAY_MS);
    expect(decideWebgl(READY, [t], 2000 + WEBGL_RESHOW_DELAY_MS).on.has('a')).toBe(true);
    // A re-show long after the release reloads at once.
    expect(decideWebgl(READY, [term('b', { droppedAt: 0, visibleSince: 9000 })], 9000).on.has('b')).toBe(true);
  });
});

/** A fake world for the runtime: clock, timers, setting, Light mode, readiness. */
function world() {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let seq = 0;
  let renderer: AgentRenderer = 'webgl';
  let light = false;
  const rendererCbs = new Set<() => void>();
  const lightCbs = new Set<() => void>();
  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => { resolveReady = r; });
  const deps: WebglBudgetDeps = {
    now: () => now,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (t) => { timers.delete(t as number); },
    ready,
    renderer: () => renderer,
    onRenderer: (cb) => { rendererCbs.add(cb); return () => rendererCbs.delete(cb); },
    light: () => light,
    onLight: (cb) => { lightCbs.add(cb); return () => lightCbs.delete(cb); },
  };
  return {
    deps,
    async makeReady() { resolveReady(); await ready; await Promise.resolve(); },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) { timers.delete(id); t.fn(); }
      }
    },
    setRenderer(r: AgentRenderer) { renderer = r; for (const cb of rendererCbs) cb(); },
    setLight(v: boolean) { light = v; for (const cb of lightCbs) cb(); },
  };
}

/** A terminal stand-in: counts its live context. */
function host(id: string, opts: { gpuRefuses?: boolean } = {}) {
  const h = {
    id,
    live: false,
    loads: 0,
    setWebgl(on: boolean): boolean {
      if (on) {
        if (opts.gpuRefuses) return false;
        if (!h.live) h.loads++;
        h.live = true;
      } else {
        h.live = false;
      }
      return h.live;
    },
  };
  return h;
}

describe('createWebglBudget (runtime)', () => {
  it('opens every terminal on DOM until settings and Light mode are known', async () => {
    const w = world();
    const b = createWebglBudget(w.deps);
    const a = host('a');
    b.register(a);
    expect(a.live).toBe(false);
    await w.makeReady();
    expect(a.live).toBe(true);
  });

  it('a saved Light mode at boot: no terminal ever opens on WebGL', async () => {
    const w = world();
    w.setLight(true);
    const b = createWebglBudget(w.deps);
    const a = host('a');
    b.register(a);
    await w.makeReady();
    expect(a.loads).toBe(0);
    expect(b.liveCount()).toBe(0);
  });

  it('4 panes → at most 2 live contexts, also after toggling a setting', async () => {
    const w = world();
    const b = createWebglBudget(w.deps);
    await w.makeReady();
    const hosts = ['a', 'b', 'c', 'd'].map((id) => host(id));
    for (const h of hosts) { b.register(h); w.advance(1); }
    expect(b.liveCount()).toBe(2);
    expect(hosts.filter((h) => h.live)).toHaveLength(2);
    w.setRenderer('dom');
    expect(b.liveCount()).toBe(0);
    w.setRenderer('webgl');
    expect(b.liveCount()).toBe(2);
    expect(hosts.filter((h) => h.live)).toHaveLength(2);
  });

  it('Light mode turned on releases every context', async () => {
    const w = world();
    const b = createWebglBudget(w.deps);
    await w.makeReady();
    const a = host('a');
    b.register(a);
    expect(a.live).toBe(true);
    w.setLight(true);
    expect(a.live).toBe(false);
    expect(b.liveCount()).toBe(0);
  });

  it('a parked terminal holds no context after 2 s; shown again before that, it keeps it', async () => {
    const w = world();
    const b = createWebglBudget(w.deps);
    await w.makeReady();
    const a = host('a');
    const ha = b.register(a);
    ha.setVisible(false);
    w.advance(WEBGL_HIDE_GRACE_MS - 500);
    ha.setVisible(true);
    w.advance(WEBGL_HIDE_GRACE_MS);
    expect(a.live).toBe(true);
    expect(a.loads).toBe(1);
    ha.setVisible(false);
    w.advance(WEBGL_HIDE_GRACE_MS);
    expect(a.live).toBe(false);
  });

  it('a re-show soon after a release reloads only after 300 ms', async () => {
    const w = world();
    const b = createWebglBudget(w.deps);
    await w.makeReady();
    const a = host('a');
    const ha = b.register(a);
    ha.setVisible(false);
    w.advance(WEBGL_HIDE_GRACE_MS);
    expect(a.live).toBe(false);
    ha.setVisible(true);
    expect(a.live).toBe(false);
    w.advance(WEBGL_RESHOW_DELAY_MS);
    expect(a.live).toBe(true);
  });

  it('a pane that becomes visible takes over from one that left the screen', async () => {
    const w = world();
    const b = createWebglBudget(w.deps);
    await w.makeReady();
    const [a, c, d] = [host('a'), host('c'), host('d')];
    const ha = b.register(a); w.advance(1);
    b.register(c); w.advance(1);
    const hd = b.register(d, false);
    expect(d.live).toBe(false);
    ha.setVisible(false);
    hd.setVisible(true);
    expect(a.live).toBe(false);
    expect(d.live).toBe(true);
    expect(b.liveCount()).toBe(2);
  });

  it('a terminal that lost its context stays on DOM for life', async () => {
    const w = world();
    const b = createWebglBudget(w.deps);
    await w.makeReady();
    const a = host('a');
    const ha = b.register(a);
    a.live = false;
    ha.markLost();
    w.setRenderer('dom');
    w.setRenderer('webgl');
    ha.setVisible(false);
    ha.setVisible(true);
    w.advance(10_000);
    expect(a.live).toBe(false);
    expect(a.loads).toBe(1);
  });

  it('a GPU that refuses a context is not asked again', async () => {
    const w = world();
    const b = createWebglBudget(w.deps);
    await w.makeReady();
    const a = host('a', { gpuRefuses: true });
    let asks = 0;
    const counting = { id: 'a', setWebgl: (on: boolean) => { if (on) asks++; return a.setWebgl(on); } };
    b.register(counting);
    w.setRenderer('dom');
    w.setRenderer('webgl');
    expect(asks).toBe(1);
  });

  it('unregistering frees the slot for another terminal', async () => {
    const w = world();
    const b = createWebglBudget(w.deps);
    await w.makeReady();
    const [a, c, d] = [host('a'), host('c'), host('d')];
    const ha = b.register(a); w.advance(1);
    b.register(c); w.advance(1);
    b.register(d);
    expect(d.live).toBe(false);
    ha.unregister();
    expect(d.live).toBe(true);
    expect(b.liveCount()).toBe(2);
  });
});
