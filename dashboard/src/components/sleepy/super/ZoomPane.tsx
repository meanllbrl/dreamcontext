import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { readZoomMessage } from '../../layout/frameZoomBridge';
import { gestureScale, usePanZoom, type Size } from '../../layout/usePanZoom';

const MIN_SCALE = 1;
const MAX_SCALE = 5;
/** One press of ＋ / −. */
const STEP = 1.25;
const FIT = { scale: 1, x: 0, y: 0 };

/**
 * A card's view, zoomable IN PLACE (owner 2026-10-22: "in a presentation, with the pointer over
 * the photo, I should be able to zoom; right now I can't"). Side by side, presented, or on a
 * narrow sheet: a pinch (the trackpad's WebKit gesture, two pointers) or ctrl/cmd + wheel zooms
 * around the pointer, a drag pans once zoomed, a double click fits again. At the fitted scale a
 * plain wheel and every click stay the content's own (a page scrolls, a link opens).
 *
 * A project web page (the card's DocumentReader with its zoom bridge) posts its wheel, pinch and
 * double click from inside its frame; only messages from a frame INSIDE this pane are read. A
 * page from a server (`live`: a dev server, a site) cannot carry the bridge, so it gets the bar
 * (−, %, ＋, Fit) and Inspect, a shield over the page that takes the pinch and the drag while it
 * is on (the page takes no clicks meanwhile).
 *
 * The stage is a pinch OWNER (`data-pinch-owner`): a whiteboard mounted elsewhere on the stage
 * lets the gesture through to it instead of zooming its own board.
 */
export function ZoomPane({ children, live = false }: { children: ReactNode; live?: boolean }) {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stage, setStage] = useState<Size | null>(null);
  const [inspect, setInspect] = useState(false);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The content is the pane itself, scaled: at the fitted scale it is exactly the card's view.
  const content = useMemo(() => stage, [stage]);
  const pz = usePanZoom({ stageRef, content, stage, minScale: MIN_SCALE, maxScale: MAX_SCALE, wheel: 'pinch', fit: FIT });
  const { view, setView, zoomAround, applyWheel } = pz;
  const zoomed = view.scale > MIN_SCALE + 1e-3;
  const fit = useCallback(() => setView(FIT), [setView]);

  // A project page's bridge: its pinch and ctrl/cmd + wheel zoom, its double click fits. Its
  // plain wheel scrolls the page itself (never read here). Only frames inside this pane count.
  const gestureStart = useRef(1);
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const root = stageRef.current;
      if (!root || !event.source) return;
      const frame = [...root.querySelectorAll('iframe')].find((f) => f.contentWindow === event.source);
      if (!frame) return;
      const m = readZoomMessage(event.data);
      if (!m || m.kind === 'escape') return;
      // The frame's own coordinates, on the screen (its box is already scaled).
      const r = frame.getBoundingClientRect();
      const k = frame.offsetWidth > 0 ? r.width / frame.offsetWidth : 1;
      const cx = r.left + m.x * k;
      const cy = r.top + m.y * k;
      if (m.kind === 'dblclick') { if (viewRef.current.scale > MIN_SCALE + 1e-3) fit(); return; }
      if (m.kind === 'wheel') { if (m.ctrl) applyWheel({ deltaX: m.dx, deltaY: m.dy, ctrlKey: true, metaKey: false, clientX: cx, clientY: cy }); return; }
      if (m.phase === 'start') gestureStart.current = viewRef.current.scale;
      else if (m.phase === 'change') {
        const target = gestureScale(gestureStart.current, m.scale);
        if (target !== null) zoomAround(() => target, cx, cy);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [applyWheel, fit, zoomAround]);

  const percent = Math.round(view.scale * 100);
  return (
    <div
      ref={stageRef}
      className="super-zoom"
      data-testid="super-zoom"
      data-pinch-owner="true"
      data-scale={view.scale.toFixed(3)}
      data-zoomed={zoomed || undefined}
      data-inspect={inspect || undefined}
      data-grabbing={pz.grabbing || undefined}
      onDoubleClick={(e) => { if (zoomed && !(e.target as HTMLElement).closest('.super-zoom-bar')) fit(); }}
      {...(zoomed && !inspect ? pz.handlers : {})}
    >
      <div
        className="super-zoom-content"
        data-testid="super-zoom-content"
        style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})` }}
      >
        {children}
      </div>
      {inspect && <div className="super-zoom-shield" data-testid="super-zoom-shield" {...pz.handlers} />}
      {(zoomed || live) && (
        <div className="super-zoom-bar" role="toolbar" aria-label={t('super.zoom.label')} onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" className="super-zoom-btn" onClick={() => zoomAround((s) => s / STEP)} disabled={!zoomed}
            aria-label={t('super.zoom.out')} title={t('super.zoom.out')} data-testid="super-zoom-out">−</button>
          <span className="super-zoom-level" data-testid="super-zoom-level">{percent}%</span>
          <button type="button" className="super-zoom-btn" onClick={() => zoomAround((s) => s * STEP)} disabled={view.scale >= MAX_SCALE - 1e-6}
            aria-label={t('super.zoom.in')} title={t('super.zoom.in')} data-testid="super-zoom-in">＋</button>
          <button type="button" className="super-zoom-btn super-zoom-btn--text" onClick={fit} disabled={!zoomed}
            title={t('super.zoom.hint')} data-testid="super-zoom-fit">{t('super.zoom.fit')}</button>
          {live && (
            <button type="button" className="super-zoom-btn super-zoom-btn--text" aria-pressed={inspect} onClick={() => setInspect((v) => !v)}
              title={inspect ? t('super.zoom.clickHint') : t('super.zoom.inspectHint')} data-testid="super-zoom-inspect">
              {t('super.zoom.inspect')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
