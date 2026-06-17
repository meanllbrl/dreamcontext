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

type ExcalidrawAPI = { scrollToContent: (target?: unknown, opts?: unknown) => void };

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
      try { apiRef.current?.scrollToContent(undefined, { fitToContent: true, animate: false }); }
      catch { /* api not ready yet */ }
    };
    const timers = [60, 250, 600].map((ms) => window.setTimeout(fit, ms));
    let ro: ResizeObserver | null = null;
    if (wrapRef.current) {
      ro = new ResizeObserver(() => fit());
      ro.observe(wrapRef.current);
    }
    return () => { timers.forEach(clearTimeout); ro?.disconnect(); };
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
