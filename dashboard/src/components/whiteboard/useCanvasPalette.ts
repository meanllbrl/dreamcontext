import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { getCommonBounds, viewportCoordsToSceneCoords } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';

/** Where the widget palette is open, in the canvas wrapper's pixel space, and the scene point
 *  a picked widget lands on. */
export interface PaletteState {
  left: number;
  top: number;
  scene: { x: number; y: number };
  /** The right-click that opened it, so "Canvas menu" can hand it back to Excalidraw. */
  origin?: { target: EventTarget; clientX: number; clientY: number };
}

const PALETTE_W = 280;
const PALETTE_H = 380;
const HIT_SLOP_PX = 4;

/**
 * The canvas's right-click (D8): on empty canvas our widget palette opens, on an element
 * Excalidraw's own menu; "Canvas menu" in the palette hands the click back to Excalidraw.
 * The "+ Add" button opens the palette at the board's centre.
 */
export function useCanvasPalette(
  wrapRef: RefObject<HTMLDivElement | null>,
  apiRef: RefObject<ExcalidrawImperativeAPI | null>,
) {
  const passThrough = useRef(false);
  const [palette, setPalette] = useState<PaletteState | null>(null);

  const sceneAt = useCallback((clientX: number, clientY: number) => {
    const api = apiRef.current;
    if (!api) return null;
    return viewportCoordsToSceneCoords({ clientX, clientY }, api.getAppState());
  }, []);

  const hitsElement = useCallback((clientX: number, clientY: number) => {
    const api = apiRef.current;
    const p = sceneAt(clientX, clientY);
    if (!api || !p) return true; // unsure: leave it to Excalidraw
    const slop = HIT_SLOP_PX / api.getAppState().zoom.value;
    return api.getSceneElements().some((el) => {
      const [x1, y1, x2, y2] = getCommonBounds([el]);
      return p.x >= x1 - slop && p.x <= x2 + slop && p.y >= y1 - slop && p.y <= y2 + slop;
    });
  }, [sceneAt]);

  const placePalette = useCallback((clientX: number, clientY: number) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return { left: 0, top: 0 };
    return {
      left: Math.max(0, Math.min(clientX - rect.left, rect.width - PALETTE_W)),
      top: Math.max(0, Math.min(clientY - rect.top, rect.height - PALETTE_H)),
    };
  }, []);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onContextMenu = (e: MouseEvent) => {
      if (passThrough.current) { passThrough.current = false; return; }
      const target = e.target as HTMLElement | null;
      if (!target || target.tagName !== 'CANVAS') return; // toolbars, menus, widgets: untouched
      if (hitsElement(e.clientX, e.clientY)) return; // Excalidraw's element menu
      const scene = sceneAt(e.clientX, e.clientY);
      if (!scene) return;
      e.preventDefault();
      e.stopPropagation();
      setPalette({
        ...placePalette(e.clientX, e.clientY),
        scene,
        origin: { target, clientX: e.clientX, clientY: e.clientY },
      });
    };
    wrap.addEventListener('contextmenu', onContextMenu, true);
    return () => wrap.removeEventListener('contextmenu', onContextMenu, true);
  }, [hitsElement, sceneAt, placePalette]);

  const openCanvasMenu = useCallback(() => {
    const origin = palette?.origin;
    setPalette(null);
    if (!origin) return;
    passThrough.current = true;
    origin.target.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2, clientX: origin.clientX, clientY: origin.clientY, view: window,
    }));
    passThrough.current = false;
  }, [palette]);

  const openPaletteFromButton = useCallback(() => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const scene = sceneAt(cx, cy);
    if (!scene) return;
    setPalette({ left: Math.max(0, rect.width - PALETTE_W - 16), top: 56, scene });
  }, [sceneAt]);

  return { palette, setPalette, openCanvasMenu, openPaletteFromButton };
}
