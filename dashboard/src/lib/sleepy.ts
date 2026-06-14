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
const SLEEPY_LABEL = 'sleepy';
/** Width/height (logical px) of the notch bar window. Sized to fit the 200px notch
 *  panel + gap + the 360px capture bar at its tallest (multi-line textarea), with
 *  room for drop shadows. y stays 0 so the notch panel hangs flush from the top. */
const WIN_W = 420;
const WIN_H = 340;

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

/** Top-center position (logical px) just under the menubar/notch. */
async function topCenter(width: number): Promise<{ x: number; y: number }> {
  try {
    const { currentMonitor } = await import('@tauri-apps/api/window');
    const mon = await currentMonitor();
    const scale = mon?.scaleFactor ?? 1;
    const logicalW = (mon?.size.width ?? 1440) / scale;
    // y:0 so the black panel hangs flush from the top, merging with the notch.
    return { x: Math.max(0, Math.round((logicalW - width) / 2)), y: 0 };
  } catch {
    return { x: 420, y: 0 };
  }
}

/** Toggle the notch capture window: open it if closed, close it if open. */
export async function toggleSleepyWindow(): Promise<void> {
  if (!isDesktop()) return;
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const existing = await WebviewWindow.getByLabel(SLEEPY_LABEL);
  if (existing) {
    await existing.close();
    return;
  }
  const { x, y } = await topCenter(WIN_W);
  // Absolute same-origin URL → the real dashboard server, not Tauri's placeholder.
  const win = new WebviewWindow(SLEEPY_LABEL, {
    url: `${window.location.origin}/?capture=1`,
    width: WIN_W,
    height: WIN_H,
    x,
    y,
    decorations: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    shadow: false,
    focus: true,
    title: 'dreamcontext capture',
  });
  await new Promise<void>((res) => {
    win.once('tauri://created', () => res());
    win.once('tauri://error', () => res());
  });
}

export async function closeSleepyWindow(): Promise<void> {
  if (!isDesktop()) return;
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const w = await WebviewWindow.getByLabel(SLEEPY_LABEL);
  if (w) await w.close();
}

/** Close the window we're running in (used by the capture bar's Esc). Robust: it
 *  closes the current webview window directly rather than looking it up by label. */
export async function closeSelf(): Promise<void> {
  if (!isDesktop()) return;
  try {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    await getCurrentWebviewWindow().close();
  } catch {
    await closeSleepyWindow();
  }
}

/**
 * (Re)apply the global hotkey from config. Unregisters any prior binding first,
 * then registers the new one when enabled. The press toggles the notch window.
 * No-op (and never throws) outside the desktop app.
 */
export async function applySleepyHotkey(cfg: SleepyConfig): Promise<void> {
  if (!isDesktop()) return;
  try {
    const { register, unregisterAll } = await import('@tauri-apps/plugin-global-shortcut');
    await unregisterAll();
    if (!cfg.enabled || !cfg.hotkey.trim()) return;
    await register(cfg.hotkey, (event) => {
      // The handler fires on both press and release — act only on press.
      if (event.state === 'Pressed') void toggleSleepyWindow();
    });
  } catch (err) {
    console.warn('[sleepy] hotkey registration failed:', err);
  }
}
