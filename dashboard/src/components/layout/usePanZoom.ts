import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

/**
 * Zoom and pan for a full-screen viewer, shared by the picture viewer (ImageViewer) and the page
 * viewer (FrameViewer): pinch (two pointers, or WebKit's trackpad `gesture*` events, which is how
 * the desktop app's WKWebView delivers a pinch), ctrl/cmd + wheel, the keyboard's + and −, and a
 * drag to pan.
 *
 * The content is drawn centred in the stage with `transform-origin: center`, translated by
 * (x, y) and scaled by `scale`; `content` is its size at scale 1. Pan never pulls it off its own
 * edges; content smaller than the stage stays centred on that axis.
 */
export interface View {
  scale: number;
  /** Pan in screen px, applied before the scale. */
  x: number;
  y: number;
}

export interface Size { w: number; h: number }

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The view with its pan held inside the content's own edges. */
export function clampPan(v: View, content: Size | null, stage: Size | null): View {
  if (!content || !stage) return v;
  const maxX = Math.max(0, (content.w * v.scale - stage.w) / 2);
  const maxY = Math.max(0, (content.h * v.scale - stage.h) / 2);
  return { scale: v.scale, x: clamp(v.x, -maxX, maxX), y: clamp(v.y, -maxY, maxY) };
}

/**
 * Zoom to `scale`, keeping the point (dx, dy) — measured from the stage's centre — where it is.
 * With `transform-origin: center`, a point `d` from the centre satisfies `d = k·(d − x) + x`, so
 * the new pan is `x' = d − k·(d − x)`.
 */
export function zoomAbout(v: View, scale: number, dx = 0, dy = 0): View {
  const k = scale / v.scale;
  return { scale, x: dx - k * (dx - v.x), y: dy - k * (dy - v.y) };
}

/** What one wheel event means. A trackpad pinch arrives as ctrl+wheel (cmd+wheel on a mouse
 *  with the key held): always a zoom. A plain wheel zooms a picture (`wheel: 'zoom'`, there is
 *  nothing else a scroll could mean) and scrolls a page (`wheel: 'pan'`). */
export function wheelAction(
  e: { deltaX: number; deltaY: number; ctrlKey: boolean; metaKey: boolean },
  mode: 'zoom' | 'pan',
): { kind: 'zoom'; factor: number } | { kind: 'pan'; dx: number; dy: number } {
  if (e.ctrlKey || e.metaKey) return { kind: 'zoom', factor: Math.exp(-e.deltaY * 0.01) };
  if (mode === 'zoom') return { kind: 'zoom', factor: Math.exp(-e.deltaY * 0.0025) };
  return { kind: 'pan', dx: -e.deltaX, dy: -e.deltaY };
}

/** A WebKit gesture's scale is relative to its start: the zoom it asks for, from the view's scale
 *  when the fingers came down. Anything not a finite positive number asks for nothing. */
export function gestureScale(startScale: number, eventScale: unknown): number | null {
  return typeof eventScale === 'number' && Number.isFinite(eventScale) && eventScale > 0 ? startScale * eventScale : null;
}

export interface PanZoomOptions {
  stageRef: RefObject<HTMLElement | null>;
  /** The content's size at scale 1, or null before it is known. */
  content: Size | null;
  stage: Size | null;
  minScale: number;
  maxScale: number;
  wheel: 'zoom' | 'pan';
  /** Where "fit" is: the view a new subject opens at and the 0 key returns to. */
  fit: View;
  /** Off (a failed picture): no wheel, no gestures, no drag. */
  enabled?: boolean;
}

/** Pointer travel under this is a click, not a drag. */
export const CLICK_SLOP = 4;

export function usePanZoom({ stageRef, content, stage, minScale, maxScale, wheel, fit, enabled = true }: PanZoomOptions) {
  const [view, setViewState] = useState<View>(fit);
  const [grabbing, setGrabbing] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  // Where a trackpad pinch started (a ref: the listeners below are re-attached whenever the
  // content or stage changes, and a pinch must not lose its start in between).
  const gestureStart = useRef(1);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchDist = useRef<number | null>(null);
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const clampView = useCallback((v: View) => clampPan(v, content, stage), [content, stage]);
  const setView = useCallback((v: View) => setViewState(clampView(v)), [clampView]);

  /** Zoom to `next(scale)`, keeping what is under (clientX, clientY) pinned there (the centre
   *  when no point is given). */
  const zoomAround = useCallback((next: (s: number) => number, clientX?: number, clientY?: number) => {
    const el = stageRef.current;
    setViewState((v) => {
      const scale = clamp(next(v.scale), minScale, maxScale);
      if (scale === v.scale) return v;
      let dx = 0;
      let dy = 0;
      if (el && clientX !== undefined && clientY !== undefined) {
        const r = el.getBoundingClientRect();
        dx = clientX - (r.left + r.width / 2);
        dy = clientY - (r.top + r.height / 2);
      }
      return clampView(zoomAbout(v, scale, dx, dy));
    });
  }, [clampView, maxScale, minScale, stageRef]);

  const panBy = useCallback((dx: number, dy: number) => {
    if (!dx && !dy) return;
    setViewState((v) => clampView({ ...v, x: v.x + dx, y: v.y + dy }));
  }, [clampView]);

  /** One wheel event, the way this viewer reads it (shared with a frame's bridge). */
  const applyWheel = useCallback((e: { deltaX: number; deltaY: number; ctrlKey: boolean; metaKey: boolean; clientX?: number; clientY?: number }) => {
    const a = wheelAction(e, wheel);
    if (a.kind === 'zoom') zoomAround((s) => s * a.factor, e.clientX, e.clientY);
    else panBy(a.dx, a.dy);
  }, [panBy, wheel, zoomAround]);

  // React registers `wheel` PASSIVELY at the root, so preventDefault() from an onWheel prop is
  // ignored and the page behind would scroll. The WebKit gesture events are the desktop app's
  // trackpad pinch: handled here and STOPPED, so they never bubble to the document, where every
  // mounted Excalidraw editor listens (its board behind the viewer would zoom too). The STAGE
  // (this element, never the viewer's bar or close button) carries `data-pinch-owner`, which
  // tells the boards' capture-phase interceptor (lib/excalidrawPinch.ts) to let the gesture
  // through to here; a pinch over the controls keeps the interceptor's block-and-stop.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !enabled) return undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      applyWheel(e);
    };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      gestureStart.current = viewRef.current.scale;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const g = e as Event & { scale?: number; clientX?: number; clientY?: number };
      const target = gestureScale(gestureStart.current, g.scale);
      if (target !== null) zoomAround(() => target, g.clientX, g.clientY);
    };
    const onGestureEnd = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', onGestureStart);
    el.addEventListener('gesturechange', onGestureChange);
    el.addEventListener('gestureend', onGestureEnd);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGestureChange);
      el.removeEventListener('gestureend', onGestureEnd);
    };
  }, [applyWheel, enabled, stageRef, zoomAround]);

  const twoPointerSpan = () => {
    const [a, b] = [...pointers.current.values()];
    if (!a || !b) return null;
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      // A second finger turns the drag into a pinch; the drag's pan must not also apply or the
      // content lurches sideways as the gesture starts.
      pinchDist.current = twoPointerSpan()?.dist ?? null;
      press.current = null;
      setGrabbing(false);
      return;
    }
    if (pointers.current.size > 1) return;
    press.current = { x: e.clientX, y: e.clientY, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setGrabbing(true);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && pinchDist.current) {
      const span = twoPointerSpan();
      if (!span || span.dist <= 0) return;
      const k = span.dist / pinchDist.current;
      pinchDist.current = span.dist;
      if (Number.isFinite(k) && k > 0) zoomAround((s) => s * k, span.mx, span.my);
      return;
    }
    if (!press.current) return;
    if (Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > CLICK_SLOP) press.current.moved = true;
    panBy(e.clientX - prev.x, e.clientY - prev.y);
  };

  const endPointer = (e: ReactPointerEvent<HTMLElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchDist.current = null;
    if (pointers.current.size === 0) setGrabbing(false);
  };

  return {
    view, setView, zoomAround, panBy, applyWheel, grabbing,
    /** The press that ended was a drag (a click after it is not a click). */
    pressMoved: () => !!press.current?.moved,
    handlers: enabled
      ? { onPointerDown, onPointerMove, onPointerUp: endPointer, onPointerCancel: endPointer }
      : {},
  };
}
