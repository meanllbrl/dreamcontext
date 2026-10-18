/**
 * The WebGL budget — the ONLY path by which a terminal gets a WebGL renderer (task: the desktop
 * app stays light on an 8GB MacBook Air).
 *
 * Every xterm used to load its own WebGL addon on open and keep it for life, parked panes
 * included: one GPU context and glyph atlas per terminal, which on an 8 GB Air is tile memory
 * WebKit no longer has (the black squares). Now a terminal ASKS, and this module decides who
 * holds a context:
 *   - nothing before the saved settings and Light mode are known (`agentSettingsReady`,
 *     `lightModeReady`) — so a relaunch with DOM or Light mode saved never opens on WebGL first;
 *   - nothing while Light mode is on or the renderer setting is `dom`;
 *   - never again for a terminal that lost its context (WKWebView reclaims them under memory
 *     pressure — reloading would loop);
 *   - a terminal out of sight for 2 s lets go; seen again within 5 s of that, it waits 300 ms
 *     before reloading (a quick flick between panes does not churn contexts);
 *   - at most {@link MAX_WEBGL_TERMINALS} at once: on-screen first, then the ones already
 *     holding a context, then the most recently seen.
 *
 * {@link decideWebgl} is the whole rule, pure. {@link createWebglBudget} is the small runtime
 * around it (settings and Light-mode listeners, one timer); {@link webglBudget} is the app's.
 */
import { agentSettingsReady, onAgentSettings, readAgentSettings, type AgentRenderer } from '../../lib/agentSettings';
import { isLightMode, lightModeReady, onLightMode } from '../../lib/lightMode';

/** Live WebGL contexts across every terminal of this window. */
export const MAX_WEBGL_TERMINALS = 2;
/** Out of sight this long → the context is released. */
export const WEBGL_HIDE_GRACE_MS = 2_000;
/** Shown again within this long of a release → wait {@link WEBGL_RESHOW_DELAY_MS} first. */
export const WEBGL_RESHOW_WINDOW_MS = 5_000;
export const WEBGL_RESHOW_DELAY_MS = 300;

/** What the budget knows about one terminal. Times are `now()` milliseconds. */
export interface WebglTermState {
  id: string;
  /** On screen (its container intersects the viewport). */
  visible: boolean;
  /** When it last became visible. */
  visibleSince: number;
  /** When it was last seen on screen (set when it goes out of sight). */
  lastVisibleAt: number;
  /** Holds a WebGL context right now. */
  webgl: boolean;
  /** Lost a context (or could not get one): DOM for the rest of its life. */
  lost: boolean;
  /** When the budget last took its context away, or null. */
  droppedAt: number | null;
}

export interface WebglGlobalState {
  /** Settings and Light mode are both known. */
  ready: boolean;
  light: boolean;
  renderer: AgentRenderer;
}

export interface WebglDecision {
  /** The terminals that should hold a context. */
  on: Set<string>;
  /** When the answer may change by time alone (a grace or a re-show delay ends), or null. */
  recheckAt: number | null;
}

/** The rule, pure. */
export function decideWebgl(g: WebglGlobalState, terms: readonly WebglTermState[], now: number): WebglDecision {
  const on = new Set<string>();
  if (!g.ready || g.light || g.renderer !== 'webgl') return { on, recheckAt: null };
  let recheckAt: number | null = null;
  const later = (t: number) => { recheckAt = recheckAt === null ? t : Math.min(recheckAt, t); };

  const eligible: WebglTermState[] = [];
  for (const t of terms) {
    if (t.lost) continue;
    if (t.visible) {
      const reshown = t.droppedAt !== null && t.visibleSince - t.droppedAt < WEBGL_RESHOW_WINDOW_MS;
      if (!t.webgl && reshown && now - t.visibleSince < WEBGL_RESHOW_DELAY_MS) {
        later(t.visibleSince + WEBGL_RESHOW_DELAY_MS);
        continue;
      }
      eligible.push(t);
    } else if (t.webgl && now - t.lastVisibleAt < WEBGL_HIDE_GRACE_MS) {
      // Just went out of sight: keeps its context through the grace, never gains one.
      eligible.push(t);
      later(t.lastVisibleAt + WEBGL_HIDE_GRACE_MS);
    }
  }
  eligible.sort((a, b) =>
    Number(b.visible) - Number(a.visible)
    || Number(b.webgl) - Number(a.webgl)
    || (b.visible ? b.visibleSince : b.lastVisibleAt) - (a.visible ? a.visibleSince : a.lastVisibleAt));
  for (const t of eligible.slice(0, MAX_WEBGL_TERMINALS)) on.add(t.id);
  return { on, recheckAt };
}

/** What a terminal hands the budget: its id, and the switch. `setWebgl(true)` returns whether
 *  a context is now held (false = the GPU refused; the terminal stays on DOM for life). */
export interface WebglHost {
  id: string;
  setWebgl: (on: boolean) => boolean;
}

/** A registered terminal's side of the budget. */
export interface WebglHandle {
  setVisible: (visible: boolean) => void;
  /** The context was lost: DOM for the rest of this terminal's life. */
  markLost: () => void;
  /** The terminal is gone. Does not call `setWebgl` (the terminal disposes its own addon). */
  unregister: () => void;
}

export interface WebglBudgetDeps {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
  /** Resolves once settings and Light mode are both known. */
  ready: Promise<unknown>;
  renderer: () => AgentRenderer;
  onRenderer: (cb: () => void) => () => void;
  light: () => boolean;
  onLight: (cb: () => void) => () => void;
}

export interface WebglBudget {
  register: (host: WebglHost, visible?: boolean) => WebglHandle;
  /** How many terminals hold a context (for tests and the idle-load harness). */
  liveCount: () => number;
  dispose: () => void;
}

export function createWebglBudget(deps: WebglBudgetDeps): WebglBudget {
  const terms = new Map<string, { host: WebglHost; s: WebglTermState }>();
  let ready = false;
  let timer: unknown = null;
  let gone = false;

  const reconcile = () => {
    if (gone) return;
    if (timer !== null) { deps.clearTimer(timer); timer = null; }
    const now = deps.now();
    const g: WebglGlobalState = { ready, light: deps.light(), renderer: deps.renderer() };
    const d = decideWebgl(g, [...terms.values()].map((t) => t.s), now);
    // Release first, then load, so the cap holds at every step.
    for (const { host, s } of terms.values()) {
      if (s.webgl && !d.on.has(s.id)) {
        try { host.setWebgl(false); } catch { /* context mid-teardown */ }
        s.webgl = false;
        s.droppedAt = now;
      }
    }
    for (const { host, s } of terms.values()) {
      if (!s.webgl && d.on.has(s.id)) {
        let got = false;
        try { got = host.setWebgl(true); } catch { got = false; }
        s.webgl = got;
        if (!got) s.lost = true;
      }
    }
    if (d.recheckAt !== null) timer = deps.setTimer(reconcile, Math.max(0, d.recheckAt - now));
  };

  void deps.ready.then(() => { ready = true; reconcile(); }, () => { ready = true; reconcile(); });
  const offRenderer = deps.onRenderer(reconcile);
  const offLight = deps.onLight(reconcile);

  return {
    register(host, visible = true) {
      const now = deps.now();
      const s: WebglTermState = {
        id: host.id, visible, visibleSince: now, lastVisibleAt: now, webgl: false, lost: false, droppedAt: null,
      };
      const entry = { host, s };
      terms.set(host.id, entry);
      reconcile();
      return {
        setVisible(v) {
          if (terms.get(host.id) !== entry || v === s.visible) return;
          const t = deps.now();
          if (v) s.visibleSince = t;
          else s.lastVisibleAt = t;
          s.visible = v;
          reconcile();
        },
        markLost() {
          if (terms.get(host.id) !== entry) return;
          s.lost = true;
          s.webgl = false;
          reconcile();
        },
        unregister() {
          if (terms.get(host.id) !== entry) return;
          terms.delete(host.id);
          reconcile();
        },
      };
    },
    liveCount: () => [...terms.values()].filter((t) => t.s.webgl).length,
    dispose() {
      gone = true;
      if (timer !== null) deps.clearTimer(timer);
      timer = null;
      offRenderer();
      offLight();
      terms.clear();
    },
  };
}

let shared: WebglBudget | null = null;

/** This window's budget, created on first use. */
export function webglBudget(): WebglBudget {
  if (shared) return shared;
  shared = createWebglBudget({
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    // Read at first use, not import: both are reassigned by their modules' test resets.
    ready: Promise.all([agentSettingsReady, lightModeReady]),
    renderer: () => readAgentSettings().renderer,
    onRenderer: (cb) => onAgentSettings(cb),
    light: isLightMode,
    onLight: (cb) => onLightMode(cb),
  });
  return shared;
}
