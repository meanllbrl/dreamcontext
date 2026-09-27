/**
 * `dreamcontext assistant tile` — place project windows side by side, in rows, or in a grid
 * on the monitor the notch is on. ONLY dreamcontext's own windows (no Accessibility, no
 * other apps). Each project gets its OWN window: a project that lives as a chip in a shared
 * window is opened in a window of its own rather than moving that window, which may hold
 * other projects the owner did not ask to rearrange.
 */
import { openVaultWindow, vaultWindowLabel } from '../../lib/desktop';
import { findWindowForVault } from '../../lib/windowRegistry';

export type TileLayout = 'columns' | 'rows' | 'grid';

export interface Rect { x: number; y: number; width: number; height: number }

/** Gap between tiled windows, logical px. */
const GAP = 8;

/**
 * Pure geometry: `n` rects filling `area` (logical px). `columns` = side by side, `rows` =
 * stacked, `grid` = the squarest grid that fits (`cols = ceil(sqrt(n))`), last row stretched.
 */
export function tileRects(n: number, layout: TileLayout, area: Rect, gap: number = GAP): Rect[] {
  if (n <= 0) return [];
  let cols: number;
  let rows: number;
  if (layout === 'columns') { cols = n; rows = 1; }
  else if (layout === 'rows') { cols = 1; rows = n; }
  else { cols = Math.ceil(Math.sqrt(n)); rows = Math.ceil(n / cols); }
  const out: Rect[] = [];
  const h = (area.height - gap * (rows - 1)) / rows;
  for (let r = 0; r < rows; r++) {
    const inRow = Math.min(cols, n - r * cols);
    const w = (area.width - gap * (inRow - 1)) / inRow;
    for (let c = 0; c < inRow; c++) {
      out.push({
        x: Math.round(area.x + c * (w + gap)),
        y: Math.round(area.y + r * (h + gap)),
        width: Math.floor(w),
        height: Math.floor(h),
      });
    }
  }
  return out;
}

type Out = { ok: true; result?: unknown } | { ok: false; error: string };

export async function tileWindows(vaults: string[], layout: TileLayout): Promise<Out> {
  if (vaults.length === 0) return { ok: false, error: 'name at least one project' };
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const { currentMonitor, LogicalPosition, LogicalSize } = await import('@tauri-apps/api/window');
    const mon = await currentMonitor();
    if (!mon) return { ok: false, error: 'no monitor to tile on' };
    const s = mon.scaleFactor;
    const area: Rect = {
      x: mon.workArea.position.x / s,
      y: mon.workArea.position.y / s,
      width: mon.workArea.size.width / s,
      height: mon.workArea.size.height / s,
    };
    const rects = tileRects(vaults.length, layout, area);
    const placed: Array<{ vault: string } & Rect> = [];
    for (let i = 0; i < vaults.length; i++) {
      const vault = vaults[i];
      const own = vaultWindowLabel(vault);
      // A window already dedicated to this project is reused; anything else gets its own.
      const live = findWindowForVault(vault);
      const label = live === own ? own : (await openVaultWindow(vault), own);
      const win = await WebviewWindow.getByLabel(label);
      if (!win) return { ok: false, error: `could not find the ${vault} window` };
      const r = rects[i];
      await win.unminimize().catch(() => { /* not minimized */ });
      await win.setPosition(new LogicalPosition(r.x, r.y));
      await win.setSize(new LogicalSize(r.width, r.height));
      placed.push({ vault, ...r });
    }
    return { ok: true, result: { layout, placed } };
  } catch (err) {
    return { ok: false, error: `could not tile: ${err instanceof Error ? err.message : String(err)}` };
  }
}
