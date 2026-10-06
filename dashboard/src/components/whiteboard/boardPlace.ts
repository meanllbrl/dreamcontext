/**
 * Where the owner was on the Whiteboard page, remembered per machine so leaving the page and
 * coming back opens exactly there (owner, 2026-10-05): the board, each board's viewport (scroll
 * and zoom), and whether the board's agent panel was open.
 *
 * localStorage, per project (vault); never the synced board file, since a viewport is one
 * person's, not the team's. Every read is checked and a bad value reads as "nothing saved".
 *
 * No React, no CSS: root vitest imports this file.
 */

export interface BoardViewport {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

const lastBoardKey = (vault: string) => `dc.wbLastBoard.${vault}`;
const viewportKey = (vault: string, board: string) => `dc.wbViewport.${vault}.${board}`;
const panelKey = (vault: string) => `dc.wbAgentPanel.${vault}`;

const BOARD_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* best-effort: the page opens on the default */ }
}

/** The board open when the owner last left the page, or null. */
export function readLastBoard(vault: string): string | null {
  const v = read(lastBoardKey(vault));
  return v && BOARD_SLUG_RE.test(v) ? v : null;
}

export function writeLastBoard(vault: string, board: string): void {
  if (BOARD_SLUG_RE.test(board)) write(lastBoardKey(vault), board);
}

/** A viewport is usable when every number is finite and the zoom is in Excalidraw's range. */
export function parseViewport(raw: unknown): BoardViewport | null {
  if (!raw || typeof raw !== 'object') return null;
  const { scrollX, scrollY, zoom } = raw as Record<string, unknown>;
  if (typeof scrollX !== 'number' || typeof scrollY !== 'number' || typeof zoom !== 'number') return null;
  if (![scrollX, scrollY, zoom].every(Number.isFinite) || zoom < 0.1 || zoom > 30) return null;
  return { scrollX, scrollY, zoom };
}

export function readViewport(vault: string, board: string): BoardViewport | null {
  const raw = read(viewportKey(vault, board));
  if (!raw) return null;
  try { return parseViewport(JSON.parse(raw)); } catch { return null; }
}

export function writeViewport(vault: string, board: string, vp: BoardViewport): void {
  const ok = parseViewport(vp);
  if (ok) write(viewportKey(vault, board), JSON.stringify(ok));
}

/** An element's box on the scene, as Excalidraw stores it (a line's width can be negative). */
export interface SceneBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Whether a saved viewport still shows any of the board: the CLI, an agent or another window
 * may have moved everything since, and a restored view onto empty canvas is worse than the fit.
 * A board with nothing on it counts as shown (there is nothing to fit to).
 */
export function viewportShowsAny(vp: BoardViewport, width: number, height: number, boxes: readonly SceneBox[]): boolean {
  if (boxes.length === 0) return true;
  if (!(width > 0 && height > 0)) return true;
  const left = -vp.scrollX;
  const top = -vp.scrollY;
  const right = left + width / vp.zoom;
  const bottom = top + height / vp.zoom;
  return boxes.some((b) => {
    const x1 = Math.min(b.x, b.x + b.width);
    const y1 = Math.min(b.y, b.y + b.height);
    const x2 = Math.max(b.x, b.x + b.width);
    const y2 = Math.max(b.y, b.y + b.height);
    return x2 >= left && x1 <= right && y2 >= top && y1 <= bottom;
  });
}

/** Whether the agent panel was open (default closed). */
export function readPanelOpen(vault: string): boolean {
  return read(panelKey(vault)) === '1';
}

export function writePanelOpen(vault: string, open: boolean): void {
  write(panelKey(vault), open ? '1' : '0');
}
