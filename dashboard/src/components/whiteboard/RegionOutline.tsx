/**
 * The empty region the owner dragged out (plan r4 Decision 12), and the area a quick edit is
 * drawing in: an overlay over the canvas, never a board element, so it is never saved and leaves
 * no history entry. Scene coordinates mapped through the live viewport (it follows pan and zoom).
 */
import { useEffect, useRef } from 'react';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { dragOutcome, type Region } from './quickEditLogic';

export interface CanvasView { scrollX: number; scrollY: number; zoom: number }

export function RegionOutline({ box, view, label, running }: { box: Region; view: CanvasView; label: string; running: boolean }) {
  const [x, y, w, h] = box;
  const style = {
    left: (x + view.scrollX) * view.zoom,
    top: (y + view.scrollY) * view.zoom,
    width: w * view.zoom,
    height: h * view.zoom,
  };
  return (
    <div
      className={running ? 'wb-region wb-region--running' : 'wb-region'}
      style={style}
      data-testid="board-region"
      data-running={running ? 'true' : undefined}
      aria-hidden
    >
      <span className="wb-region-tag">{label}</span>
    </div>
  );
}

/**
 * Region capture: a pointer gesture with the selection tool that ends with nothing selected
 * becomes the region (≥ 24×24 screen px); a plain click clears it; Escape on the canvas clears
 * it. The selection after the up is read once Excalidraw has settled it (the next task).
 */
export function useRegionCapture(
  apiRef: { current: ExcalidrawImperativeAPI | null },
  ready: ExcalidrawImperativeAPI | null,
  onRegion: ((r: Region | null) => void) | undefined,
  hasRegion: boolean,
): void {
  const onRegionRef = useRef(onRegion);
  onRegionRef.current = onRegion;
  useEffect(() => {
    if (!ready || !onRegionRef.current) return undefined;
    const off = ready.onPointerUp((tool, pds) => {
      const origin = { x: pds.origin.x, y: pds.origin.y };
      const end = { x: pds.lastCoords.x, y: pds.lastCoords.y };
      const hitElement = !!(pds as unknown as { hit?: { element?: unknown } }).hit?.element;
      setTimeout(() => {
        const api = apiRef.current;
        if (!api) return;
        const st = api.getAppState();
        const selectedCount = Object.values(st.selectedElementIds).filter(Boolean).length;
        const out = dragOutcome({ origin, end, zoom: st.zoom.value, tool: tool.type, selectedCount, hitElement });
        if (out.kind === 'region') onRegionRef.current?.(out.region);
        else if (out.kind === 'click') onRegionRef.current?.(null);
      }, 0);
    });
    return off;
  }, [ready, apiRef]);

  useEffect(() => {
    if (!hasRegion) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
      onRegionRef.current?.(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasRegion]);
}
