/**
 * Every EXPLICIT per-query poll runs through `pollMs` (task: the desktop app stays light on an
 * 8GB MacBook Air — AC6, plan lane P1/P2).
 *
 * The instance default interval is windowActivity's own (window-activity.test.ts). What is
 * pinned here is the rest: the intervals a call site sets itself (capabilities, session-stats,
 * goal/council live, the phone's lists, the inbox window, …) are FUNCTIONS of the window's
 * activity, so they slow ×4 while the window is visible but unfocused, stop while it is hidden,
 * and come back to the focused cadence the moment it is in front again.
 *
 * Two halves: a source scan of the owned call sites (no numeric interval left outside
 * `pollMs`), and the cadence itself, driven like window-activity.test.ts — a `QueryObserver` per
 * query (what `useQuery` mounts) on a registered instance client, no React renderer.
 *
 * `window` is defined BEFORE React Query loads: query-core decides `isServer` at import time.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

(globalThis as { window?: unknown }).window ??= new EventTarget();

const { QueryObserver } = await import('../../dashboard/node_modules/@tanstack/query-core/build/modern/index.js');
const wa = await import('../../dashboard/src/lib/windowActivity.js');
const iq = await import('../../dashboard/src/lib/instanceQueryClient.js');

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

// ─── The call sites ──────────────────────────────────────────────────────────────

const HOOKS = readdirSync(join(ROOT, 'dashboard/src/hooks'))
  .filter((f) => /\.tsx?$/.test(f))
  .map((f) => `dashboard/src/hooks/${f}`);
const SITES = [
  ...HOOKS,
  'dashboard/src/components/appLink/InboxWindow.tsx',
  'dashboard/src/components/sleepy/PhoneChatList.tsx',
  'dashboard/src/components/sleepy/PhoneChatStack.tsx',
];

/** Every `refetchInterval:` property value in a file, comments skipped. A value runs until the
 *  next property at the same (or a shallower) indentation. */
function intervals(src: string): string[] {
  const lines = src.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)refetchInterval:/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const body = [lines[i].trim()];
    for (let j = i + 1; j < lines.length; j++) {
      const next = /^(\s*)(\S)/.exec(lines[j]);
      if (next && next[1].length <= indent && /^\s*([A-Za-z]+:|\}|\))/.test(lines[j])) break;
      body.push(lines[j].trim());
    }
    out.push(body.join(' '));
  }
  return out;
}

describe('explicit refetchIntervals (source scan)', () => {
  it('every one is `false` or goes through pollMs — no bare number left', () => {
    let seen = 0;
    for (const rel of SITES) {
      for (const v of intervals(read(rel))) {
        seen++;
        if (/^refetchInterval: false,$/.test(v)) continue;
        expect(v, `${rel}: ${v}`).toMatch(/pollMs\(/);
        expect(v, `${rel}: ${v}`).not.toMatch(/^refetchInterval:\s*[\d_]+\s*,/);
        expect(v, `${rel}: ${v}`).not.toMatch(/\?\s*[\d_]+\s*:\s*false/);
        expect(v, `${rel}: ${v}`).not.toMatch(/^refetchInterval:\s*[A-Z_]+\s*,/);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(25);
  });

  it('goal-live and council-live poll at 2 s only while a run is live or the pane\'s turn runs, still behind the phone gate', () => {
    const src = read('dashboard/src/hooks/useAgentCapabilities.ts');
    for (const route of ['goal-live', 'council-live']) {
      expect(src).toMatch(new RegExp(
        `refetchInterval: enabled && phoneAllows\\('GET', '/api/agent/${route}'\\)\\s*\\? \\(q\\) => pollMs\\(q\\.state\\.data\\?\\.active \\|\\| busy \\? 2_000 : 15_000\\)\\s*: false,`,
      ));
    }
    // A run starts from a turn in the chat pane and stamps its file partway in: the pane's
    // busy flag is what brings the panel up within 2 s instead of the idle 15 s tick.
    const pane = read('dashboard/src/components/sleepy/ChatPane.tsx');
    expect(pane).toMatch(/useAgentGoalLive\(session\.claudeId, live, live && session\.busy\)/);
    expect(pane).toMatch(/<CouncilLivePanel claudeId=\{session\.claudeId\} enabled=\{live\} busy=\{live && session\.busy\}/);
  });

  it('the upgrade badge polls only while an upgrade runs, and skips its tick while the window is hidden', () => {
    const src = read('dashboard/src/components/layout/UpdateBadge.tsx');
    const start = src.slice(src.indexOf('const startPolling'), src.indexOf('}, [api, applyStatus, stopPolling]);'));
    expect(start).toMatch(/setInterval\(\(\) => \{\s*(\/\/[^\n]*\n\s*)*if \(getWindowActivity\(\)\.hidden\) return;/);
  });
});

// ─── The cadence ─────────────────────────────────────────────────────────────────

type QC = ReturnType<typeof iq.createInstanceQueryClient>;

function fakeHost() {
  let has = true;
  const win = Object.assign(new EventTarget(), { setTimeout: ((fn: () => void, ms?: number) => setTimeout(fn, ms)) as typeof setTimeout });
  const doc = Object.assign(new EventTarget(), {
    visibilityState: 'visible' as 'visible' | 'hidden',
    hasFocus: () => has,
    documentElement: { dataset: {} as Record<string, string> },
  });
  wa.initWindowActivity({ win: win as never, doc: doc as never, desktop: false, alwaysFocused: false });
  return {
    blur: () => { has = false; win.dispatchEvent(new Event('blur')); },
    focus: () => { has = true; win.dispatchEvent(new Event('focus')); },
    hide: () => { doc.visibilityState = 'hidden'; has = false; doc.dispatchEvent(new Event('visibilitychange')); },
    show: () => { doc.visibilityState = 'visible'; has = true; doc.dispatchEvent(new Event('visibilitychange')); },
  };
}

/** The window's client, as App boot registers it: always active. */
function windowClient(): QC {
  const qc = iq.createInstanceQueryClient();
  qc.mount();
  iq.registerInstanceClient(qc);
  return qc;
}

/** What `useQuery` mounts for a call site with an explicit interval. Counts the fetches. */
function observe(qc: QC, key: string, refetchInterval: unknown, fn: (n: number) => unknown = (n) => n) {
  const calls = { n: 0 };
  const obs = new QueryObserver(qc as never, {
    queryKey: [key],
    queryFn: async () => { calls.n += 1; return fn(calls.n); },
    staleTime: 0,
    refetchInterval,
  } as never);
  const unsub = obs.subscribe(() => {});
  return { calls, unsub };
}

const flush = async (ms = 0) => { await vi.advanceTimersByTimeAsync(ms); };

beforeEach(() => {
  vi.useFakeTimers();
  wa.resetWindowActivityForTests();
  iq.resetInstanceRegistryForTests();
});
afterEach(() => {
  wa.resetWindowActivityForTests();
  vi.useRealTimers();
});

describe('explicit intervals follow the window', () => {
  it('a visible-but-unfocused window polls at ≤ 30 % of the focused rate (×4 slower)', async () => {
    const host = fakeHost();
    const qc = windowClient();
    const q = observe(qc, 'session-stats', () => wa.pollMs(5_000));
    await flush(10);
    const f0 = q.calls.n;
    await flush(60_000);
    const focusedPerMin = q.calls.n - f0;
    host.blur(); await flush(1);
    const u0 = q.calls.n;
    await flush(120_000);
    const unfocusedPerMin = (q.calls.n - u0) / 2;
    expect(focusedPerMin).toBeGreaterThanOrEqual(11);
    expect(unfocusedPerMin).toBeLessThanOrEqual(focusedPerMin * 0.3);
  });

  it('a hidden window makes 0 polling requests over 2 min', async () => {
    const host = fakeHost();
    const qc = windowClient();
    const a = observe(qc, 'capabilities', () => wa.pollMs(30_000));
    const b = observe(qc, 'goal-live', (query: { state: { data?: { active?: boolean } } }) => wa.pollMs(query.state.data?.active ? 2_000 : 15_000), () => ({ active: true }));
    await flush(10);
    host.hide();
    const a0 = a.calls.n;
    const b0 = b.calls.n;
    await flush(120_000);
    expect(a.calls.n).toBe(a0);
    expect(b.calls.n).toBe(b0);
  });

  it('hidden → visible: the interval re-arms at the focused cadence', async () => {
    const host = fakeHost();
    const qc = windowClient();
    const q = observe(qc, 'accounts', () => wa.pollMs(30_000));
    await flush(10);
    host.hide();
    await flush(120_000);
    const h0 = q.calls.n;
    host.show();
    await flush(1_000);
    // The query went stale while hidden: it is read again within 1 s of showing, not at the
    // next tick of whatever interval was armed before (end review, 2026-10-18: the old
    // assertion alone passed with the refetch-on-show removed).
    expect(q.calls.n).toBeGreaterThanOrEqual(h0 + 1);
    const s0 = q.calls.n;
    await flush(90_000);
    expect(q.calls.n - s0).toBeGreaterThanOrEqual(3);
  });

  it('refocus re-arms: after a short blur the next poll comes within the FOCUSED interval, not ×4', async () => {
    const host = fakeHost();
    const qc = windowClient();
    const q = observe(qc, 'session-facts', () => wa.pollMs(15_000));
    await flush(10);
    // Blur just before the 15 s tick: the ×4 interval is armed (by the blur's own re-arm, or
    // without it by the tick that then runs unfocused) and the next poll is ~75 s away. Only
    // the re-arm on FOCUS brings it back inside 15 s; the end review (2026-10-18) found the old
    // timeline passed with the re-arm deleted.
    await flush(14_800);
    host.blur(); await flush(400);
    await flush(4_000);               // under the 10 s refocus refetch: only the re-arm runs
    host.focus();
    const r0 = q.calls.n;
    await flush(15_500);
    expect(q.calls.n).toBeGreaterThanOrEqual(r0 + 1);
    const r1 = q.calls.n;
    await flush(45_000);
    expect(q.calls.n - r1).toBeGreaterThanOrEqual(3);
  });

  it('goal/council live: 2 s while a run is active, the slow cadence once it is not', async () => {
    fakeHost();
    const qc = windowClient();
    let active = true;
    const q = observe(
      qc, 'council-live',
      (query: { state: { data?: { active?: boolean } } }) => wa.pollMs(query.state.data?.active ? 2_000 : 15_000),
      () => ({ active }),
    );
    await flush(10);
    const a0 = q.calls.n;
    await flush(10_000);
    expect(q.calls.n - a0).toBeGreaterThanOrEqual(4);
    active = false;
    await flush(2_500);              // the fetch that reads `active: false`
    const i0 = q.calls.n;
    await flush(30_000);
    expect(q.calls.n - i0).toBeLessThanOrEqual(2);
  });

  it('Light mode doubles an explicit interval', async () => {
    fakeHost();
    const qc = windowClient();
    const q = observe(qc, 'task-progress', () => wa.pollMs(4_000));
    await flush(10);
    const n0 = q.calls.n;
    await flush(40_000);
    const normal = q.calls.n - n0;
    wa.setLightPollFactor(true);
    await flush(4_100);              // the running timer ends; the next one is computed light
    const l0 = q.calls.n;
    await flush(40_000);
    const light = q.calls.n - l0;
    expect(normal).toBeGreaterThanOrEqual(9);
    expect(light).toBeLessThanOrEqual(Math.ceil(normal / 2) + 1);
  });
});
