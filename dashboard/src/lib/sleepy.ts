/**
 * "Sleepy" — the notch quick-capture bar. This module owns its persisted config
 * and the Tauri plumbing (global hotkey registration + the notch window). Every
 * Tauri import is dynamic so the plain browser build never fails without a
 * desktop runtime (mirrors lib/desktop.ts).
 */
import { isDesktop } from './desktop';

const CONFIG_KEY = 'sleepy:config:v1';
const SLEEPY_LABEL = 'sleepy';
/** Width/height (logical px) of the notch bar window. */
const WIN_W = 620;
const WIN_H = 132;

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

export function writeSleepyConfig(cfg: SleepyConfig): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  } catch {
    /* best-effort */
  }
}

/** Top-center position (logical px) just under the menubar/notch. */
async function topCenter(width: number): Promise<{ x: number; y: number }> {
  try {
    const { currentMonitor } = await import('@tauri-apps/api/window');
    const mon = await currentMonitor();
    const scale = mon?.scaleFactor ?? 1;
    const logicalW = (mon?.size.width ?? 1440) / scale;
    return { x: Math.max(0, Math.round((logicalW - width) / 2)), y: 12 };
  } catch {
    return { x: 420, y: 12 };
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
