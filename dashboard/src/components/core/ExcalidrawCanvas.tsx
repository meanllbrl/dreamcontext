import { useEffect, useMemo, useRef } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import './ExcalidrawCanvas.css';

interface Props {
  elements: readonly unknown[];
  files: Record<string, unknown>;
  appState?: Record<string, unknown>;
  theme: 'light' | 'dark';
}

type ExcalidrawAPI = {
  scrollToContent: (target?: unknown, opts?: unknown) => void;
  refresh?: () => void;
};

/**
 * Read-only Excalidraw board rendered with the real (canvas) editor in view mode.
 *
 * Why the canvas component instead of a static exported SVG: a large board exports
 * to a multi-thousand-pixel SVG that WebKit/WKWebView (the desktop app's engine)
 * rasterizes once and samples down — so it looks soft, and worse as you zoom in.
 * Excalidraw's canvas re-draws the scene at the current zoom every frame, so text
 * and screenshots stay crisp at ANY zoom. It also gives native pan/zoom (wheel =
 * pan, pinch / ctrl+wheel = zoom) and manages its own viewport, so panning never
 * re-renders React or reloads the board.
 *
 * Lazy-loaded (heavy bundle + its CSS) — only pulled in when a board is opened.
 */
export default function ExcalidrawCanvas({ elements, files, appState, theme }: Props) {
  const apiRef = useRef<ExcalidrawAPI | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // initialData is read once on mount; the parent re-mounts (via `key`) when the
  // board changes, so this never needs to react to prop changes after mount.
  const initialData = useMemo(
    () => ({
      elements,
      files,
      appState: { ...(appState ?? {}), viewBackgroundColor: 'transparent' },
      scrollToContent: true,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Center + fit the board to the viewport. `scrollToContent` in initialData runs
  // before the (flex) pane reaches its final size, so the board can land
  // off-center on first paint — re-fit once the API is ready, again as the layout
  // settles, and on every container resize (e.g. entering full-screen).
  useEffect(() => {
    const fit = () => {
      try {
        // Re-measure the container offsets first: Excalidraw samples them at
        // mount, and a host positioned with a transform (the What's New modal
        // is translate(-50%,-50%)-centered) settles AFTER that sample — the
        // stale offsets skew scrollToContent's centering, cropping the board.
        apiRef.current?.refresh?.();
        apiRef.current?.scrollToContent(undefined, { fitToContent: true, animate: false });
      } catch { /* api not ready yet */ }
    };
    const timers = [60, 250, 600].map((ms) => window.setTimeout(fit, ms));
    // First-ever load: the handwriting font arrives AFTER the 600ms timer, the
    // text bounding boxes grow, and the already-fitted board overflows its box
    // (seen as a cropped teaser in the on-load What's New popup). Re-fit once
    // all pending fonts settle; cancelled on unmount via the flag.
    let cancelled = false;
    document.fonts?.ready?.then(() => { if (!cancelled) fit(); });
    let ro: ResizeObserver | null = null;
    // scrollToContent computes against Excalidraw's INTERNAL appState.width/height,
    // not the DOM box. When the board mounts inside a container Excalidraw
    // mis-measures on first paint (the on-load popup), every timer fit above uses
    // the stale dimensions; Excalidraw later corrects itself — resizing the canvas
    // element but keeping the (now wrong) zoom/scroll. The canvas width/height
    // attributes are written from appState, so watching them re-fits at exactly
    // the moment the internal correction lands. No loop: fit changes zoom/scroll
    // only, never the canvas size.
    // Guarded by the actual dims: React re-renders re-set the attributes with
    // IDENTICAL values (still a mutation), and an unguarded fit() here would
    // re-render again — an infinite mutation loop that never lets the page
    // settle. Only a real size change may re-fit.
    let lastDims = '';
    const mo = new MutationObserver(() => {
      const dims = Array.from(wrapRef.current?.querySelectorAll('canvas') ?? [])
        .map((c) => `${c.width}x${c.height}`)
        .join(',');
      if (dims === lastDims) return;
      lastDims = dims;
      fit();
    });
    if (wrapRef.current) {
      ro = new ResizeObserver(() => fit());
      ro.observe(wrapRef.current);
      mo.observe(wrapRef.current, { subtree: true, attributes: true, attributeFilter: ['width', 'height'] });
    }
    return () => { cancelled = true; timers.forEach(clearTimeout); ro?.disconnect(); mo.disconnect(); };
  }, []);

  return (
    <div ref={wrapRef} className="excalidraw-canvas-wrap">
      <Excalidraw
        excalidrawAPI={(api) => {
          apiRef.current = api as unknown as ExcalidrawAPI;
          try { (api as unknown as ExcalidrawAPI).scrollToContent(undefined, { fitToContent: true, animate: false }); }
          catch { /* noop */ }
        }}
        initialData={initialData as never}
        viewModeEnabled
        theme={theme}
        UIOptions={{
          canvasActions: {
            changeViewBackgroundColor: false,
            clearCanvas: false,
            export: false,
            loadScene: false,
            saveToActiveFile: false,
            saveAsImage: false,
            toggleTheme: false,
          },
        }}
      />
    </div>
  );
}
