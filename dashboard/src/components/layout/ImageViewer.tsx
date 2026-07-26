import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../context/I18nContext';
import './ImageViewer.css';

interface Props {
  src: string;
  /** Accessible name and alt text — the thing the picture is OF, not "screenshot". */
  alt?: string;
  /** Optional line under the image (filename, figure caption). */
  caption?: ReactNode;
  onClose: () => void;
}

interface View {
  /** 1 = fitted to the viewport. Multiplies whatever the browser's contain-fit did. */
  scale: number;
  /** Pan, in screen px, applied before the scale (so these stay screen-space). */
  x: number;
  y: number;
}

const FIT: View = { scale: 1, x: 0, y: 0 };
/** Past this you are reading interpolation, not the screenshot. */
const HARD_MAX = 8;
/** One press of ＋ / − / the keyboard. */
const STEP = 1.4;
/** Pointer travel under this is a click, not a drag — so a shaky click still closes. */
const CLICK_SLOP = 4;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const FOCUSABLE = 'button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

/**
 * A picture opened at full size: edge-to-edge over the whole window, zoomable to
 * the pixel, pannable while zoomed.
 *
 * It exists because a fit-to-viewport lightbox is not enough for the images this
 * app shows. A release screenshot or a board export is a 2500px-wide picture OF a
 * UI — scaled down to fit it is legible as a shape and illegible as text, which
 * is usually the exact thing the reader opened it to check. So `scale: 1` here
 * means "fits the screen" and every step above it is real detail: `1 / base` is
 * one image pixel per screen pixel, and the readout shows that ratio honestly.
 *
 * Portalled to `<body>` on purpose. It has to sit above the full-screen overlay
 * (z-index 1100) that the announcement reader already puts it inside, and a
 * `position: fixed` child would otherwise be captured by any transformed ancestor
 * between here and the root — which is how a lightbox ends up trapped inside the
 * pane that opened it.
 */
export function ImageViewer({ src, alt = '', caption, onClose }: Props) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [stage, setStage] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<View>(FIT);
  const [grabbing, setGrabbing] = useState(false);

  // Live pointers, for drag (one) and pinch (two). Refs, not state: these change
  // on every pointermove and none of them belong in the render output.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchDist = useRef<number | null>(null);
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  // A new image is a new subject — never inherit the previous one's zoom or pan.
  useEffect(() => {
    setView(FIT);
    setNatural(null);
  }, [src]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Lock the page behind the viewer. Nested under FullscreenOverlay's own lock is
  // fine: effect cleanup runs child-first, so this restores the overlay's `hidden`
  // and the overlay then restores the page's original value.
  useEffect(() => {
    const body = document.body;
    const prev = body.style.overflow;
    body.style.overflow = 'hidden';
    return () => { body.style.overflow = prev; };
  }, []);

  // The viewer is portalled OUT of the reader's FullscreenOverlay, so that
  // overlay's focus trap would read the viewer's buttons as "focus escaped" and
  // yank focus back into the story behind. Take focus on open and give it back on
  // close; the Tab handling below keeps it here in between.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    rootRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, []);

  // `base` is the scale the browser ALREADY applied to contain the image in the
  // stage (via max-width/height: 100%). Everything below is expressed against it,
  // which is what makes `1 / base` mean "actual pixels" and the readout truthful.
  const base = natural && stage && natural.w > 0 && natural.h > 0
    ? Math.min(1, stage.w / natural.w, stage.h / natural.h)
    : 1;
  const actual = clamp(1 / base, 1, HARD_MAX);
  // An image small enough to already fit natively still gets room to magnify —
  // otherwise `actual === 1` would leave the zoom controls permanently dead.
  const maxScale = clamp(Math.max(actual, 3), 1, HARD_MAX);

  /** Pan can never pull the image off its own edges; below fit it stays centred. */
  const clampView = useCallback((v: View): View => {
    if (!natural || !stage) return v;
    const w = natural.w * base * v.scale;
    const h = natural.h * base * v.scale;
    const maxX = Math.max(0, (w - stage.w) / 2);
    const maxY = Math.max(0, (h - stage.h) / 2);
    return { scale: v.scale, x: clamp(v.x, -maxX, maxX), y: clamp(v.y, -maxY, maxY) };
  }, [natural, stage, base]);

  /**
   * Zoom, keeping whatever sits under (clientX, clientY) pinned there — the thing
   * you point at is the thing you wanted a closer look at. With `transform-origin:
   * center`, a point `d` from the stage centre satisfies `d = k·(d − x) + x`, so
   * the new pan is `x' = d − k·(d − x)`. Omit the point to zoom about the centre.
   */
  const zoomAround = useCallback((next: (s: number) => number, clientX?: number, clientY?: number) => {
    const el = stageRef.current;
    setView((v) => {
      const scale = clamp(next(v.scale), 1, maxScale);
      if (scale === v.scale) return v;
      let dx = 0;
      let dy = 0;
      if (el && clientX !== undefined && clientY !== undefined) {
        const r = el.getBoundingClientRect();
        dx = clientX - (r.left + r.width / 2);
        dy = clientY - (r.top + r.height / 2);
      }
      const k = scale / v.scale;
      return clampView({ scale, x: dx - k * (dx - v.x), y: dy - k * (dy - v.y) });
    });
  }, [clampView, maxScale]);

  // React registers `wheel` PASSIVELY at the root, so preventDefault() from an
  // onWheel prop is ignored and the page behind would scroll while you zoom.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // A trackpad pinch arrives as ctrl+wheel (steeper per-tick); a plain wheel
      // zooms too, because in a viewer that fills the screen there is nothing
      // else a scroll could mean.
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025));
      zoomAround((s) => s * factor, e.clientX, e.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAround]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // The viewer is the topmost layer: swallow Esc so the reader underneath
        // doesn't close on the same press and take the whole story with it.
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        // Same swallow, same reason: the overlay underneath must not get a say in
        // where Tab goes while the viewer is the thing on screen.
        const root = rootRef.current;
        if (!root) return;
        e.stopImmediatePropagation();
        const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (focusable.length === 0) { e.preventDefault(); return; }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (!active || !root.contains(active)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
        else if (e.shiftKey && (active === first || active === root)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
        return;
      }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomAround((s) => s * STEP); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomAround((s) => s / STEP); }
      else if (e.key === '0') { e.preventDefault(); setView(FIT); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, zoomAround]);

  const twoPointerSpan = () => {
    const [a, b] = [...pointers.current.values()];
    if (!a || !b) return null;
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      // A second finger turns the drag into a pinch; the drag's pan must not also
      // apply or the image lurches sideways as the gesture starts.
      pinchDist.current = twoPointerSpan()?.dist ?? null;
      press.current = null;
      setGrabbing(false);
      return;
    }
    if (pointers.current.size > 1) return;
    press.current = { x: e.clientX, y: e.clientY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
    setGrabbing(true);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
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
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    if (Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > CLICK_SLOP) {
      press.current.moved = true;
    }
    if (dx || dy) setView((v) => clampView({ ...v, x: v.x + dx, y: v.y + dy }));
  };

  const endPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchDist.current = null;
    if (pointers.current.size === 0) setGrabbing(false);
  };

  /**
   * Backdrop click closes; a click that panned does not, and neither does a click
   * on the picture. Hit-tested against the image's box rather than `e.target`,
   * because the stage takes pointer capture during a drag and browsers disagree
   * about what a click's target is once capture has been involved.
   */
  const onStageClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (press.current?.moved) return;
    const r = imgRef.current?.getBoundingClientRect();
    if (r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return;
    onClose();
  };

  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (view.scale > 1.01) setView(FIT);
    else zoomAround(() => (actual > 1.01 ? actual : maxScale), e.clientX, e.clientY);
  };

  const zoomed = view.scale > 1.01;
  const percent = Math.round(base * view.scale * 100);

  return createPortal(
    <div
      ref={rootRef}
      className="image-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={alt || t('imageViewer.label')}
      tabIndex={-1}
    >
      <div
        ref={stageRef}
        className="image-viewer-stage"
        data-zoomed={zoomed || undefined}
        data-grabbing={(grabbing && zoomed) || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onClick={onStageClick}
        onDoubleClick={onDoubleClick}
      >
        <img
          ref={imgRef}
          className="image-viewer-img"
          src={src}
          alt={alt}
          draggable={false}
          style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})` }}
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        />
      </div>

      <div className="image-viewer-foot">
        {caption && <div className="image-viewer-caption">{caption}</div>}
        <div className="image-viewer-bar">
          <button
            type="button"
            className="image-viewer-btn"
            onClick={() => zoomAround((s) => s / STEP)}
            disabled={view.scale <= 1}
            aria-label={t('imageViewer.zoomOut')}
            title={t('imageViewer.zoomOut')}
          >
            −
          </button>
          <button
            type="button"
            className="image-viewer-level"
            onClick={() => (zoomed ? setView(FIT) : zoomAround(() => (actual > 1.01 ? actual : maxScale)))}
            title={zoomed ? t('imageViewer.fit') : t('imageViewer.actual')}
          >
            {percent}%
          </button>
          <button
            type="button"
            className="image-viewer-btn"
            onClick={() => zoomAround((s) => s * STEP)}
            disabled={view.scale >= maxScale}
            aria-label={t('imageViewer.zoomIn')}
            title={t('imageViewer.zoomIn')}
          >
            ＋
          </button>
        </div>
        {/* Only while fitted: once you have zoomed you have already discovered the
            gestures, and the hint is then just text over the thing you came to read. */}
        {!zoomed && <p className="image-viewer-hint">{t('imageViewer.hint')}</p>}
      </div>

      <button
        type="button"
        className="image-viewer-close"
        onClick={onClose}
        aria-label={t('common.close')}
        title={t('common.close')}
      >
        ✕
      </button>
    </div>,
    document.body,
  );
}
