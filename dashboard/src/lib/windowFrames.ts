/**
 * Move and resize windows in ONE step (desktop/src-tauri/src/frames.rs `set_frames`).
 *
 * `setSize` + `setPosition` are two IPCs that AppKit paints separately, so every move showed
 * an old-position/new-size frame in between. `set_frames` sets every window's whole frame at
 * once — inside one eased animation group when `animateMs > 0`, so tiled windows move
 * together — and applies a min-size PRESET only after the frame has landed. It always
 * resolves (a hard deadline on the Rust side), and it is all-or-nothing on labels.
 */

/** A min-size preset, never dimensions: the Rust side owns the numbers. Omitted = keep. */
export type MinPreset = 'window-seat' | 'clear';

/** One window's target frame: logical px, top-left origin (Tauri's LogicalPosition coords). */
export interface FrameItem {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  min?: MinPreset;
}

/** How long a window move animates: 200ms, or none at all under prefers-reduced-motion. */
export function frameMotionMs(): number {
  try {
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return 0;
  } catch { /* no matchMedia — animate */ }
  return 200;
}

/**
 * Land every item's frame, animated over `animateMs` (0 = one atomic frame).
 *
 * Falls back to `setPosition` + `setSize` per window ONLY when the command itself is
 * unavailable or rejected (the browser preview, a window without the grant) — i.e. only
 * where the Rust side never ran, which is also why re-applying every item is safe. The
 * fallback sets no min size: there is no set-min-size grant, and nothing native to size.
 */
export async function setFrames(items: FrameItem[], animateMs: number): Promise<void> {
  if (items.length === 0) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_frames', { items, animateMs });
    return;
  } catch { /* fall through: no command here */ }
  const { Window, LogicalPosition, LogicalSize } = await import('@tauri-apps/api/window');
  await Promise.all(items.map(async (it) => {
    const win = await Window.getByLabel(it.label);
    if (!win) throw new Error(`no window "${it.label}"`);
    await win.setPosition(new LogicalPosition(it.x, it.y));
    await win.setSize(new LogicalSize(it.width, it.height));
  }));
}
