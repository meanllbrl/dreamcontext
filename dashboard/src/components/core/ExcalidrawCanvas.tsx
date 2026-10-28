import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { registerPinchTarget, type BoardViewport, type PinchPatch } from '../../lib/excalidrawPinch';
import { FIT_MAX_SETTLE_FRAMES, planFit, type FitBox, type FitRecord } from '../../lib/boardFit';
import './ExcalidrawCanvas.css';

interface Props {
  elements: readonly unknown[];
  files: Record<string, unknown>;
  appState?: Record<string, unknown>;
  theme: 'light' | 'dark';
  /** A whiteboard's widgets (embeddables with a `dreamcontext://` link): who draws them and
   *  which links are widgets. Absent = a plain board, Excalidraw's own embed rules. */
  embeds?: {
    renderEmbeddable: (element: never, appState: never) => ReactNode;
    validateEmbeddable: (link: string) => boolean;
  };
}

type ExcalidrawAPI = {
  scrollToContent: (target?: unknown, opts?: unknown) => void;
  refresh?: () => void;
  getAppState?: () => BoardViewport & { width: number; height: number };
  updateScene?: (scene: { appState: PinchPatch | FitRecord }) => void;
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
export default function ExcalidrawCanvas({ elements, files, appState, theme, embeds }: Props) {
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
  //
  // Every fit goes through `planFit` (lib/boardFit.ts), one frame at a time: it waits until
  // the box has stopped moving (a Super stage card flies in under a scale transform, and
  // Excalidraw would keep the scaled size it measured mid-flight), skips a hidden box (another
  // page: a fit to 0x0 is the smallest zoom), and hands Excalidraw the settled box first when
  // its own record is stale — the board then fits the card it is really in.
  useEffect(() => {
    let raf = 0;
    let prev: FitBox | null = null;
    let frames = 0;
    let cancelled = false;
    const step = () => {
      raf = 0;
      if (cancelled) return;
      const api = apiRef.current;
      const box = wrapRef.current?.querySelector('.excalidraw') ?? wrapRef.current;
      if (!api || !box) {
        if (frames++ < FIT_MAX_SETTLE_FRAMES) raf = window.requestAnimationFrame(step);
        return;
      }
      const r = box.getBoundingClientRect();
      const now: FitBox = { width: r.width, height: r.height, left: r.left, top: r.top };
      const st = api.getAppState?.();
      const record = { width: st?.width ?? 0, height: st?.height ?? 0, offsetLeft: st?.offsetLeft ?? 0, offsetTop: st?.offsetTop ?? 0 };
      const plan = planFit(prev, now, record, frames);
      prev = now;
      frames += 1;
      if (plan.kind === 'hidden') return;
      if (plan.kind === 'settling') { raf = window.requestAnimationFrame(step); return; }
      try {
        if (plan.resize) {
          // Excalidraw reads its box from state; the new box lands on the next render, so the
          // fit itself runs a frame later, against it.
          api.updateScene?.({ appState: plan.resize });
          raf = window.requestAnimationFrame(step);
          return;
        }
        api.scrollToContent(undefined, { fitToContent: true, animate: false });
      } catch { /* api not ready yet */ }
    };
    const fit = () => {
      prev = null;
      frames = 0;
      if (!raf && !cancelled) raf = window.requestAnimationFrame(step);
    };
    const timers = [60, 250, 600].map((ms) => window.setTimeout(fit, ms));
    // First-ever load: the handwriting font arrives AFTER the 600ms timer, the
    // text bounding boxes grow, and the already-fitted board overflows its box
    // (seen as a cropped teaser in the on-load What's New popup). Re-fit once
    // all pending fonts settle; cancelled on unmount via the flag.
    document.fonts?.ready?.then(() => { if (!cancelled) fit(); });
    let ro: ResizeObserver | null = null;
    // Excalidraw corrects its own size later in some hosts (the on-load popup): the canvas
    // width/height attributes are written from appState, so watching them re-fits at exactly
    // the moment that correction lands. No loop: a fit changes zoom/scroll, and hands over a
    // box only when the record differs from it.
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
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      if (raf) window.cancelAnimationFrame(raf);
      ro?.disconnect();
      mo.disconnect();
    };
  }, []);

  // Scope WebKit's pinch to THIS board. Excalidraw 0.18 drives its Safari gesture handlers
  // from module-level state shared by every mounted editor, so without this a pinch anywhere
  // zooms every board on the page to the same scale — see excalidrawPinch.ts for the full
  // why. The API is read lazily inside the callbacks because `excalidrawAPI` lands after
  // this effect runs; the registration only needs the element, which is already mounted.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    return registerPinchTarget({
      el,
      getViewport: () => apiRef.current?.getAppState?.() ?? null,
      setViewport: (patch) => apiRef.current?.updateScene?.({ appState: patch }),
    });
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
        validateEmbeddable={embeds?.validateEmbeddable}
        renderEmbeddable={embeds?.renderEmbeddable as never}
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
