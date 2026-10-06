import { useEffect, type RefObject } from 'react';
import { viewportCoordsToSceneCoords } from '@excalidraw/excalidraw';
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { registerPinchTarget } from '../../lib/excalidrawPinch';
import { WHEEL_LATCH_CLASS, WHEEL_LATCH_MS } from './canvasGestures';

/**
 * What the canvas's wrapper listens for on its own (WhiteboardCanvas.tsx): the stuck "Click to
 * interact" hint, a pan that drifts onto a widget, and a pinch scoped to this board.
 */
export function useCanvasWrapEffects(
  wrapRef: RefObject<HTMLDivElement | null>,
  apiRef: RefObject<ExcalidrawImperativeAPI | null>,
): void {
  // ── "Click to interact" (A18): Excalidraw sets the hover state from the canvas's own
  // pointermove and clears it only on the next one, so a pointer that leaves a widget straight
  // off the canvas (onto the sidebar, a toolbar, the size control) left the hint up. Any move
  // over something that is not the canvas, or out of the wrapper, clears it here. So does a
  // move on the canvas off the hovered widget: Excalidraw clears it only when the pointer hits
  // another element, so straight onto empty canvas the hint stayed up.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const clearHover = () => {
      const api = apiRef.current;
      if (api?.getAppState().activeEmbeddable?.state !== 'hover') return;
      api.updateScene({ appState: { activeEmbeddable: null } });
    };
    const onMove = (e: PointerEvent) => {
      if ((e.target as HTMLElement | null)?.tagName !== 'CANVAS') { clearHover(); return; }
      const api = apiRef.current;
      const st = api?.getAppState();
      const hovered = st?.activeEmbeddable?.state === 'hover' ? st.activeEmbeddable.element : null;
      if (!api || !st || !hovered) return;
      const el = api.getSceneElements().find((x) => x.id === hovered.id) ?? hovered;
      const p = viewportCoordsToSceneCoords({ clientX: e.clientX, clientY: e.clientY }, st);
      if (p.x < el.x || p.x > el.x + el.width || p.y < el.y || p.y > el.y + el.height) clearHover();
    };
    wrap.addEventListener('pointerleave', clearHover);
    wrap.addEventListener('pointermove', onMove, true);
    return () => {
      wrap.removeEventListener('pointerleave', clearHover);
      wrap.removeEventListener('pointermove', onMove, true);
    };
  }, []);

  // ── A scroll that pans the board stays with the board. An active widget takes pointer
  // events, and over an HTML or web block the wheel lands in the iframe's own document, which
  // never hands it back: a pan that drifted onto one stopped dead. While a pan is running
  // (a wheel that hit the canvas, momentum included) widgets let the wheel through; the latch
  // drops once the wheel has been quiet for WHEEL_LATCH_MS.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let timer = 0;
    const onWheel = (e: WheelEvent) => {
      if (!wrap.classList.contains(WHEEL_LATCH_CLASS) && (e.target as HTMLElement | null)?.tagName !== 'CANVAS') return;
      wrap.classList.add(WHEEL_LATCH_CLASS);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => wrap.classList.remove(WHEEL_LATCH_CLASS), WHEEL_LATCH_MS);
    };
    wrap.addEventListener('wheel', onWheel, { capture: true, passive: true });
    return () => {
      wrap.removeEventListener('wheel', onWheel, { capture: true });
      window.clearTimeout(timer);
      wrap.classList.remove(WHEEL_LATCH_CLASS);
    };
  }, []);

  // ── pinch scoped to this board (see lib/excalidrawPinch.ts) ───────────────────────────────
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    return registerPinchTarget({
      el,
      getViewport: () => apiRef.current?.getAppState() ?? null,
      setViewport: (patch) => apiRef.current?.updateScene({
        appState: patch as unknown as Pick<AppState, 'scrollX' | 'scrollY' | 'zoom'>,
      }),
    });
  }, []);
}
