/**
 * "Sleepy" — the notch quick-capture bar. This module owns its persisted config
 * and the Tauri plumbing (global hotkey registration + the notch window). Every
 * Tauri import is dynamic so the plain browser build never fails without a
 * desktop runtime (mirrors lib/desktop.ts).
 */
import { isDesktop } from './desktop';
import { api } from '../api/client';

/** localStorage key for the Sleepy config (exported so other windows can watch it). */
export const SLEEPY_CONFIG_KEY = 'sleepy:config:v1';
const CONFIG_KEY = SLEEPY_CONFIG_KEY;

/** Event names bridged to the Rust shell, which owns the non-activating notch
 *  panel (see desktop/src-tauri/src/lib.rs). The launcher window registers the
 *  OS-wide hotkey and emits `TOGGLE`; the capture page emits `HIDE` on Esc /
 *  click-away. Rust must own the window because only an NSPanel can float over
 *  the focused app and accept keystrokes without activating dreamcontext. */
const EVT_TOGGLE = 'sleepy:toggle';
const EVT_HIDE = 'sleepy:hide';
/** Mirrors the persisted `enabled` flag to Rust, which owns the notch perch +
 *  hover-to-open. Disabling Sleepy must close the notch entirely, not just unbind
 *  the hotkey — Rust shows/hides the perch in response. */
const EVT_ENABLED = 'sleepy:enabled';

export interface SleepyConfig {
  enabled: boolean;
  /** Tauri accelerator string, e.g. "Alt+Cmd+S". */
  hotkey: string;
}

export const DEFAULT_SLEEPY: SleepyConfig = { enabled: false, hotkey: 'Alt+Cmd+S' };

export function readSleepyConfig(): SleepyConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<SleepyConfig>;
      return {
        enabled: !!p.enabled,
        hotkey: typeof p.hotkey === 'string' && p.hotkey.trim() ? p.hotkey : DEFAULT_SLEEPY.hotkey,
      };
    }
  } catch {
    /* fall through to default */
  }
  return { ...DEFAULT_SLEEPY };
}

/** Write to localStorage only (in-launch state + cross-window 'storage' sync). */
function writeLocal(cfg: SleepyConfig): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  } catch {
    /* best-effort */
  }
}

/**
 * Persist the config: localStorage (live, this launch) + server-side
 * (~/.dreamcontext/sleepy.json, survives the per-launch port/origin change).
 */
export function writeSleepyConfig(cfg: SleepyConfig): void {
  writeLocal(cfg);
  void api.post('/launcher/sleepy-config', cfg).catch(() => {});
}

/**
 * Load the persisted config from the server and seed localStorage with it (each
 * launch starts on a fresh origin with empty localStorage). Falls back to the
 * local/default config if the server is unreachable. Call once on launcher mount.
 */
export async function initSleepyFromServer(): Promise<SleepyConfig> {
  try {
    const raw = await api.get<Partial<SleepyConfig>>('/launcher/sleepy-config');
    const cfg: SleepyConfig = {
      enabled: !!raw.enabled,
      hotkey: typeof raw.hotkey === 'string' && raw.hotkey.trim() ? raw.hotkey : DEFAULT_SLEEPY.hotkey,
    };
    writeLocal(cfg);
    return cfg;
  } catch {
    return readSleepyConfig();
  }
}

/**
 * Toggle the notch panel. We don't create the window here — the Rust shell owns
 * it (only an NSPanel can float over the focused app and take keystrokes without
 * activating dreamcontext). Emitting an event also means the hotkey works from
 * ANY app: the launcher webview stays alive in the background, the global
 * shortcut fires, and Rust shows/hides the panel over whatever is focused.
 */
export async function toggleSleepyWindow(): Promise<void> {
  if (!isDesktop()) return;
  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit(EVT_TOGGLE);
  } catch (err) {
    console.warn('[sleepy] toggle emit failed:', err);
  }
}

/** Hide the notch panel (order it out, keeping the webview warm for next time). */
export async function hideSleepyWindow(): Promise<void> {
  if (!isDesktop()) return;
  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit(EVT_HIDE);
  } catch {
    /* best-effort */
  }
}

/** Tell Rust the panel is engaged (focused/clicked) so the notch-hover watcher
 *  pins it open instead of auto-closing it when the cursor drifts away. */
export async function markSleepyCommitted(): Promise<void> {
  if (!isDesktop()) return;
  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit('sleepy:committed');
  } catch {
    /* best-effort */
  }
}

/** Dismiss Sleepy (used by the capture bar's Esc + click-away). Hides rather than
 *  closes so the panel reopens instantly — and, being a non-activating panel,
 *  dismissing never surfaces the dreamcontext main window. */
export async function closeSelf(): Promise<void> {
  await hideSleepyWindow();
}

/**
 * Subscribe to the capture window's focus changes. `cb(focused)` fires on each
 * change: `true` when it becomes the key window, `false` when it loses focus
 * (the user clicked another app/window). The capture bar uses this to dismiss
 * itself the moment focus leaves — so closing yields to whatever the user
 * clicked, never surfacing the dreamcontext main window. Returns an unsubscribe
 * fn; a no-op outside the desktop app.
 */
export async function onSleepyFocusChange(cb: (focused: boolean) => void): Promise<() => void> {
  if (!isDesktop()) return () => {};
  try {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const w = getCurrentWebviewWindow();
    return await w.onFocusChanged(({ payload: focused }) => cb(focused));
  } catch {
    return () => {};
  }
}

/**
 * Subscribe to the Rust-emitted `sleepy:shown` event, fired every time the panel
 * is shown (hotkey, hover, or toggle). The capture bar uses it to replay its
 * "drop out of the notch" open animation on each summon, since the webview is
 * reused (hidden/shown) rather than recreated. Returns an unsubscribe fn.
 */
export async function onSleepyShown(cb: () => void): Promise<() => void> {
  if (!isDesktop()) return () => {};
  try {
    const { listen } = await import('@tauri-apps/api/event');
    return await listen('sleepy:shown', () => cb());
  } catch {
    return () => {};
  }
}

/**
 * macOS-reserved single-Cmd combos the focused app swallows BEFORE a global
 * shortcut can see them — the #1 reason "the hotkey doesn't work when another app
 * is focused". `Cmd+H` (hide), `Cmd+Q` (quit), `Cmd+W`, `Cmd+M`, `Cmd+Tab`,
 * `Cmd+Space` (Spotlight), `Cmd+,`. We refuse to bind these and fall back to the
 * default so Sleepy actually opens from anywhere.
 */
const RESERVED_HOTKEYS = new Set([
  'cmd+h',
  'cmd+q',
  'cmd+w',
  'cmd+m',
  'cmd+tab',
  'cmd+space',
  'cmd+,',
  'cmd+comma',
]);

/** True if `hotkey` is a macOS-reserved combo a focused app will intercept. */
export function isReservedHotkey(hotkey: string): boolean {
  return RESERVED_HOTKEYS.has(hotkey.trim().toLowerCase().replace(/\s+/g, ''));
}

/**
 * (Re)apply the global hotkey from config. Unregisters any prior binding first,
 * then registers the new one when enabled. The press toggles the notch panel.
 * Reserved single-Cmd combos are rejected in favor of the default so the shortcut
 * still fires from other apps. No-op (and never throws) outside the desktop app.
 */
export async function applySleepyHotkey(cfg: SleepyConfig): Promise<void> {
  if (!isDesktop()) return;
  // Mirror the enabled flag to Rust so disabling Sleepy closes the notch (perch +
  // hover-to-open), not just the hotkey. Called on every config apply (mount,
  // cross-window storage sync, Settings change), so the notch always tracks state.
  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit(EVT_ENABLED, cfg.enabled);
  } catch (err) {
    console.warn('[sleepy] enabled emit failed:', err);
  }
  try {
    const { register, unregisterAll } = await import('@tauri-apps/plugin-global-shortcut');
    await unregisterAll();
    if (!cfg.enabled || !cfg.hotkey.trim()) return;
    // A reserved combo would be eaten by the focused app — bind the default instead.
    const hotkey = isReservedHotkey(cfg.hotkey) ? DEFAULT_SLEEPY.hotkey : cfg.hotkey;
    if (hotkey !== cfg.hotkey) {
      console.warn(`[sleepy] "${cfg.hotkey}" is macOS-reserved; using "${hotkey}" so it works from any app.`);
    }
    await register(hotkey, (event) => {
      // The handler fires on both press and release — act only on press.
      if (event.state === 'Pressed') void toggleSleepyWindow();
    });
  } catch (err) {
    console.warn('[sleepy] hotkey registration failed:', err);
  }
}
