/**
 * Is this window SEEN, and is it the one in front? — the single answer every poll, every
 * endless animation and the presence report read (task: the desktop app stays light on an
 * 8GB MacBook Air).
 *
 * Three states, kept per window:
 *   - focused   visible and in front (the NSWindow is key, or the page has focus)
 *   - unfocused visible beside another app: status indicators keep moving, decorative motion
 *               stops, polls slow to ×4
 *   - hidden    minimised / occluded tab: every endless animation pauses and React Query
 *               skips interval fetches (its `focusManager` is driven from here)
 *
 * Sources. `visibilitychange` always. In the desktop app the shell's own focus event
 * (`getCurrentWindow().onFocusChanged`, seeded from `isFocused()`) is authoritative: a DOM
 * `blur` fires when focus moves into an iframe (an HTML view, a PDF), and the page's
 * `hasFocus()` was wrong for a window brought forward from the notch (see presence.ts). In a
 * browser, `focus` / `focusin` / `pointerdown` mark focused, and a `blur` counts only when
 * `document.hasFocus()` is still false on the next tick — so an iframe taking focus is not
 * "unfocused". The notch window (`?assistant=1`, a non-activating panel that is never key) and
 * the phone are focused whenever they are visible.
 *
 * Written onto <html> as `data-window-active` / `data-window-hidden`, which the CSS motion
 * contract in styles/global.css keys off.
 */
import { useSyncExternalStore } from 'react';
import { focusManager } from '@tanstack/react-query';
import { isPhoneSurface } from './phoneSurface';

export interface WindowActivity {
  /** The page can be seen (not minimised, not a hidden tab). */
  visible: boolean;
  /** Visible AND in front. Never true while hidden. */
  focused: boolean;
  /** `!visible`, spelled out for readers. */
  hidden: boolean;
}

/** What a listener is told beside the new and previous state. */
export interface WindowActivityChange {
  /** How long the window had been unfocused when it became focused again (0 otherwise). */
  unfocusedMs: number;
}

type Listener = (next: WindowActivity, prev: WindowActivity, change: WindowActivityChange) => void;

/** The native focus API this module needs from `@tauri-apps/api/window`. */
export interface NativeFocus {
  isFocused(): Promise<boolean>;
  onFocusChanged(cb: (e: { payload: boolean }) => void): Promise<() => void>;
}

/** Everything the module reads from its host, injectable so it runs under plain Node. */
export interface WindowActivityEnv {
  win: Pick<Window, 'addEventListener' | 'removeEventListener' | 'setTimeout'>;
  doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'hasFocus' | 'visibilityState'> & {
    documentElement?: { dataset: DOMStringMap };
  };
  /** The desktop app: native focus decides, DOM blur is ignored once it answers. */
  desktop: boolean;
  /** The notch window and the phone: focused whenever visible. */
  alwaysFocused: boolean;
  /** Loads the shell's focus API (desktop only); null/reject = fall back to the DOM. */
  nativeFocus?: () => Promise<NativeFocus | null>;
  now?: () => number;
}

/** Visible-but-unfocused polls run at this multiple of their base cadence. */
export const UNFOCUSED_POLL_FACTOR = 4;
/** Light mode doubles every cadence. */
export const LIGHT_POLL_FACTOR = 2;

let state: WindowActivity = { visible: true, focused: true, hidden: false };
let unfocusedAt: number | null = null;
let lightFactor = 1;
const listeners = new Set<Listener>();
let dispose: (() => void) | null = null;
let clock: () => number = () => Date.now();

export function getWindowActivity(): WindowActivity {
  return state;
}

/** Follow every change of this window's activity. Returns the unsubscribe. */
export function onWindowActivity(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function subscribeStore(cb: () => void): () => void {
  return onWindowActivity(() => cb());
}

/** React view of {@link getWindowActivity}. */
export function useWindowActivity(): WindowActivity {
  return useSyncExternalStore(subscribeStore, getWindowActivity, getWindowActivity);
}

/**
 * The cadence a poll should run at right now: its base while focused, ×4 while visible but
 * unfocused, its base while hidden (React Query skips interval fetches then, because its
 * `focusManager` follows visibility), and ×2 on top while Light mode is effective. NEVER
 * `false`: an interval that is switched off does not come back by itself.
 */
export function pollMs(baseMs: number): number {
  const f = state.focused || state.hidden ? 1 : UNFOCUSED_POLL_FACTOR;
  return baseMs * f * lightFactor;
}

/** Light mode tells the cadence about itself (lightMode.ts; kept here to avoid an import cycle). */
export function setLightPollFactor(on: boolean): void {
  lightFactor = on ? LIGHT_POLL_FACTOR : 1;
}

function writeDataset(env: WindowActivityEnv, a: WindowActivity): void {
  const ds = env.doc.documentElement?.dataset;
  if (!ds) return;
  ds.windowActive = a.focused ? 'true' : 'false';
  ds.windowHidden = a.hidden ? 'true' : 'false';
}

function readVisible(env: WindowActivityEnv): boolean {
  try { return env.doc.visibilityState !== 'hidden'; } catch { return true; }
}

function readHasFocus(env: WindowActivityEnv): boolean {
  try { return env.doc.hasFocus(); } catch { return true; }
}

/**
 * Start following this window. Idempotent: a second call returns the first one's disposer.
 * Call once at boot, before the first QueryClient polls.
 */
export function initWindowActivity(envIn?: Partial<WindowActivityEnv>): () => void {
  if (dispose) return dispose;
  const env = resolveEnv(envIn);
  if (!env) return () => {};
  clock = env.now ?? (() => Date.now());

  let visible = readVisible(env);
  let focusedRaw = env.alwaysFocused ? true : readHasFocus(env);
  /** Native focus has answered: DOM focus events stop counting. */
  let native = false;
  let gone = false;
  let offNative: (() => void) | null = null;
  let focusNotify: ((focused: boolean) => void) | null = null;

  const apply = () => {
    const next: WindowActivity = {
      visible,
      focused: visible && (env.alwaysFocused || focusedRaw),
      hidden: !visible,
    };
    const prev = state;
    if (next.visible === prev.visible && next.focused === prev.focused) return;
    let unfocusedMs = 0;
    if (!next.focused && prev.focused) unfocusedAt = clock();
    if (next.focused && !prev.focused) {
      unfocusedMs = unfocusedAt === null ? 0 : clock() - unfocusedAt;
      unfocusedAt = null;
    }
    state = next;
    writeDataset(env, next);
    if (next.visible !== prev.visible) focusNotify?.(next.visible);
    for (const l of [...listeners]) {
      try { l(next, prev, { unfocusedMs }); } catch (err) { console.warn('[window-activity] listener failed:', err); }
    }
  };

  const onVisibility = () => { visible = readVisible(env); apply(); };
  const onDomFocus = () => {
    if (native || env.alwaysFocused) return;
    focusedRaw = true;
    apply();
  };
  const onDomBlur = () => {
    if (native || env.alwaysFocused) return;
    // Focus moving INTO an iframe blurs the window but the document still has focus on the
    // next tick; only a real departure leaves `hasFocus()` false.
    env.win.setTimeout(() => {
      if (native || gone) return;
      if (!readHasFocus(env)) { focusedRaw = false; apply(); }
    }, 0);
  };

  env.doc.addEventListener('visibilitychange', onVisibility);
  env.win.addEventListener('focus', onDomFocus);
  env.doc.addEventListener('focusin', onDomFocus);
  env.win.addEventListener('pointerdown', onDomFocus);
  env.win.addEventListener('blur', onDomBlur);

  // React Query pauses interval fetches and focus refetches through its `focusManager`; drive
  // it from HERE so visibility has one source (its default listener is replaced, not doubled).
  focusManager.setEventListener((handle) => {
    focusNotify = handle;
    handle(visible);
    return () => { if (focusNotify === handle) focusNotify = null; };
  });

  // Seed the first state (the store starts as "focused, visible").
  state = { visible: true, focused: true, hidden: false };
  apply();
  writeDataset(env, state);

  if (env.desktop && !env.alwaysFocused && env.nativeFocus) {
    void (async () => {
      try {
        const api = await env.nativeFocus!();
        if (!api || gone) return;
        const off = await api.onFocusChanged(({ payload }) => {
          native = true;
          focusedRaw = !!payload;
          apply();
        });
        if (gone) { off(); return; }
        offNative = off;
        const now = await api.isFocused();
        if (gone) return;
        native = true;
        focusedRaw = !!now;
        apply();
      } catch { /* an older shell or no ACL: the DOM's own focus answers */ }
    })();
  }

  dispose = () => {
    gone = true;
    offNative?.();
    env.doc.removeEventListener('visibilitychange', onVisibility);
    env.win.removeEventListener('focus', onDomFocus);
    env.doc.removeEventListener('focusin', onDomFocus);
    env.win.removeEventListener('pointerdown', onDomFocus);
    env.win.removeEventListener('blur', onDomBlur);
    dispose = null;
  };
  return dispose;
}

function resolveEnv(envIn?: Partial<WindowActivityEnv>): WindowActivityEnv | null {
  const win = envIn?.win ?? (typeof window !== 'undefined' ? window : undefined);
  const doc = envIn?.doc ?? (typeof document !== 'undefined' ? document : undefined);
  if (!win || !doc) return null;
  const desktop = envIn?.desktop ?? isDesktopWindow();
  return {
    win,
    doc,
    desktop,
    alwaysFocused: envIn?.alwaysFocused ?? isAlwaysFocusedWindow(),
    nativeFocus: envIn?.nativeFocus ?? (desktop ? loadNativeFocus : undefined),
    now: envIn?.now,
  };
}

function isDesktopWindow(): boolean {
  try { return !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__; } catch { return false; }
}

/** The notch (`?assistant=1`) is never key; the phone has no other app beside it. */
function isAlwaysFocusedWindow(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get('assistant') === '1') return true;
    return isPhoneSurface();
  } catch { return false; }
}

async function loadNativeFocus(): Promise<NativeFocus | null> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

/** Tests only: forget every listener and return to "focused, visible". */
export function resetWindowActivityForTests(): void {
  dispose?.();
  dispose = null;
  listeners.clear();
  state = { visible: true, focused: true, hidden: false };
  unfocusedAt = null;
  lightFactor = 1;
  clock = () => Date.now();
}
