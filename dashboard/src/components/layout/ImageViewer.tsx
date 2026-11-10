import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../context/I18nContext';
import { usePanZoom, type View } from './usePanZoom';
import './ImageViewer.css';

interface Props {
  src: string;
  /** Accessible name and alt text — the thing the picture is OF, not "screenshot". */
  alt?: string;
  /** Optional line under the image (filename, figure caption). */
  caption?: ReactNode;
  /** Optional controls for the file BEHIND the picture — handing it to the OS, copying its
   *  path. A slot rather than built in, because this viewer also shows images that are only
   *  ever URLs (a page's own screenshots), and those have no file to act on. */
  actions?: ReactNode;
  /** Rendered in the stage INSTEAD of the picture when the bytes never arrive.
   *
   *  An `<img>` that fails renders the engine's broken-file glyph and says nothing — no
   *  status, no reason, no way forward — which for a viewer that covers the whole window is
   *  the emptiest screen the app can show. The caller knows what its own failures MEAN (a
   *  file outside the project needs consent; a deleted one is simply gone), so the message
   *  and any action belong to it; absent one, the viewer still says the picture didn't
   *  load rather than drawing a broken glyph. */
  fallback?: ReactNode;
  /** Several pictures: ← / → (and the side buttons) step through them. `pos` is "2 / 5". */
  step?: { onStep: (d: -1 | 1) => void; pos: string };
  onClose: () => void;
}

const FIT: View = { scale: 1, x: 0, y: 0 };
/** Past this you are reading interpolation, not the screenshot. */
const HARD_MAX = 8;
/** One press of ＋ / − / the keyboard. */
const STEP = 1.4;

/** A ＋ or − drawn in the panel icon set's hand (24 grid, 1.75 stroke), not a text glyph. */
function ToolGlyph({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}

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
 * (z-index 1100) a surface may already put it inside, and a
 * `position: fixed` child would otherwise be captured by any transformed ancestor
 * between here and the root — which is how a lightbox ends up trapped inside the
 * pane that opened it.
 */
export function ImageViewer({ src, alt = '', caption, actions, fallback, step, onClose }: Props) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const failRef = useRef<HTMLDivElement | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  /** The bytes never arrived. A `src` change clears it — which is also how a caller RETRIES
   *  (see `Lightbox`: granting access re-requests the same file under a new URL). */
  const [failed, setFailed] = useState(false);
  const [stage, setStage] = useState<{ w: number; h: number } | null>(null);
  const footRef = useRef<HTMLDivElement | null>(null);
  /** The toolbar's height: the stage (and so the picture, fitted or zoomed) ends where it starts.
   *  Measured, not assumed, because the phone adds the home-indicator inset under it. */
  const [footH, setFootH] = useState(0);
  // A new image is a new subject — never inherit the previous one's zoom or pan.
  useEffect(() => {
    setNatural(null);
    setFailed(false);
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

  useLayoutEffect(() => {
    const el = footRef.current;
    if (!el) return;
    const measure = () => setFootH(el.offsetHeight);
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
  // Pan can never pull the image off its own edges; below fit it stays centred.
  const content = useMemo(() => (natural ? { w: natural.w * base, h: natural.h * base } : null), [natural, base]);
  // Pinch (two pointers or the trackpad's gesture events), wheel, drag: usePanZoom. A plain
  // wheel zooms too, because in a viewer that fills the screen there is nothing else a scroll
  // could mean.
  const pz = usePanZoom({ stageRef, content, stage, minScale: 1, maxScale, wheel: 'zoom', fit: FIT, enabled: !failed });
  const { view, setView, zoomAround } = pz;
  // A new image opens fitted (the hook's setter changes with the stage; the reset follows `src` only).
  const fitRef = useRef(setView);
  fitRef.current = setView;
  useEffect(() => { fitRef.current(FIT); }, [src]);

  const stepRef = useRef(step);
  stepRef.current = step;
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
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && stepRef.current) {
        e.preventDefault();
        stepRef.current.onStep(e.key === 'ArrowLeft' ? -1 : 1);
      } else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomAround((s) => s * STEP); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomAround((s) => s / STEP); }
      else if (e.key === '0') { e.preventDefault(); setView(FIT); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, zoomAround]);

  /**
   * Backdrop click closes; a click that panned does not, and neither does a click
   * on the picture. Hit-tested against the image's box rather than `e.target`,
   * because the stage takes pointer capture during a drag and browsers disagree
   * about what a click's target is once capture has been involved.
   */
  const onStageClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (pz.pressMoved()) return;
    const r = (imgRef.current ?? failRef.current)?.getBoundingClientRect();
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
        data-pinch-owner="true"
        style={{ bottom: footH }}
        data-zoomed={zoomed || undefined}
        data-grabbing={(pz.grabbing && zoomed) || undefined}
        data-failed={failed || undefined}
        // Nothing to pan or pinch once the picture is gone — and leaving the drag on would
        // put the stage's pointer CAPTURE between a click and the fallback's own button,
        // which is exactly the case the click hit-test below already calls unreliable.
        {...pz.handlers}
        onClick={onStageClick}
        onDoubleClick={failed ? undefined : onDoubleClick}
      >
        {failed ? (
          <div ref={failRef} className="image-viewer-fallback" role="status">
            {fallback ?? <p>{t('imageViewer.failed')}</p>}
          </div>
        ) : (
          <img
            ref={imgRef}
            className="image-viewer-img"
            src={src}
            alt={alt}
            draggable={false}
            style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})` }}
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            // The only thing an `<img>` ever says about a failure. Everything the user then
            // needs — why, and what to do — comes from `fallback`.
            onError={() => setFailed(true)}
          />
        )}
      </div>

      {/* ONE solid row under the picture, never over it: file name on the left, the file's
          own actions and the zoom group on the right. The stage ends at its top edge. */}
      <div ref={footRef} className="image-viewer-toolbar" role="toolbar" aria-label={t('imageViewer.label')}>
        <div className="image-viewer-toolbar-name" title={typeof caption === 'string' ? caption : undefined}>{caption}</div>
        <div className="image-viewer-toolbar-tools">
          {actions}
          {actions && !failed && <span className="image-viewer-toolbar-divider" aria-hidden="true" />}
          {!failed && (
            <div className="image-viewer-zoom">
              <button
                type="button"
                className="viewer-tool"
                onClick={() => zoomAround((s) => s / STEP)}
                disabled={view.scale <= 1}
                aria-label={t('imageViewer.zoomOut')}
                title={t('imageViewer.zoomOut')}
              >
                <ToolGlyph d="M6 12h12" />
              </button>
              <button
                type="button"
                className="viewer-tool viewer-tool--level"
                onClick={() => (zoomed ? setView(FIT) : zoomAround(() => (actual > 1.01 ? actual : maxScale)))}
                // The gesture hint lives here now: one tooltip instead of a line over the picture.
                title={`${zoomed ? t('imageViewer.fit') : t('imageViewer.actual')} · ${t('imageViewer.hint')}`}
              >
                {percent}%
              </button>
              <button
                type="button"
                className="viewer-tool"
                onClick={() => zoomAround((s) => s * STEP)}
                disabled={view.scale >= maxScale}
                aria-label={t('imageViewer.zoomIn')}
                title={t('imageViewer.zoomIn')}
              >
                <ToolGlyph d="M6 12h12M12 6v12" />
              </button>
            </div>
          )}
        </div>
      </div>

      {step && (
        <>
          <button type="button" className="image-viewer-btn image-viewer-step image-viewer-step--prev" onClick={() => step.onStep(-1)}
            aria-label={t('imageViewer.prev')} title={t('imageViewer.prev')}>‹</button>
          <button type="button" className="image-viewer-btn image-viewer-step image-viewer-step--next" onClick={() => step.onStep(1)}
            aria-label={t('imageViewer.next')} title={t('imageViewer.next')}>›</button>
          <span className="image-viewer-pos" aria-live="polite">{step.pos}</span>
        </>
      )}
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
