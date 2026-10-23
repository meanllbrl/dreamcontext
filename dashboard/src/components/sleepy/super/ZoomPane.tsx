import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { readZoomMessage } from '../../layout/frameZoomBridge';
import { gestureScale, usePanZoom, type Size } from '../../layout/usePanZoom';
import { useWebFrameControl, type WebFrameControl } from '../../../lib/webFrameControl';

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
 *
 * A live page with a `control` (owner 2026-10-22) also gets Reload and, once the page is served by
 * its session proxy, Clear cache (asked first in the bar itself: a browser confirm() does nothing
 * in the desktop app). On such a page Inspect PICKS instead of shielding: hover outlines an
 * element, a click adds it to the Super Agent's message, Esc leaves; the page's bridge posts its
 * pinch, so zooming still works. `interactive` false (the card floating, or parked off the stage
 * to keep its page alive): no bar, no gestures, the view fitted.
 */
export function ZoomPane({ children, live = false, interactive = true, control }: {
  children: ReactNode; live?: boolean; interactive?: boolean; control?: WebFrameControl;
}) {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stage, setStage] = useState<Size | null>(null);
  const [inspect, setInspect] = useState(false);
  const [askClear, setAskClear] = useState(false);
  // Focus follows the Clear question (its buttons replace the one that asked): Cancel when it
  // opens, back to "Clear cache" when it is cancelled, to Reload once cleared.
  const clearBtnRef = useRef<HTMLButtonElement | null>(null);
  const reloadBtnRef = useRef<HTMLButtonElement | null>(null);
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);
  const focusAfterAsk = useRef<'clear' | 'reload' | null>(null);
  useEffect(() => {
    if (askClear) { cancelBtnRef.current?.focus(); return; }
    const to = focusAfterAsk.current;
    focusAfterAsk.current = null;
    if (to === 'clear') clearBtnRef.current?.focus();
    else if (to === 'reload') reloadBtnRef.current?.focus();
  }, [askClear]);
  useWebFrameControl(control);
  // Inspect picks in a page that carries the bridge; anywhere else it is the zoom shield.
  const picker = !!control && control.bridged;

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

  // Off the owner's hands (floating, parked): fitted, Inspect and the Clear question gone.
  useEffect(() => {
    if (interactive) return;
    fit();
    setInspect(false);
    setAskClear(false);
  }, [interactive, fit]);
  // The page follows Inspect (and is told again after it reloads or navigates: a new document).
  useEffect(() => {
    if (!control) return undefined;
    control.setInspect(inspect && picker);
    return control.subscribe({
      change: () => { if (inspect && control.bridged) control.setInspect(true); },
      inspectOff: () => setInspect(false),
    });
  }, [control, inspect, picker]);
  useEffect(() => () => control?.setInspect(false), [control]);
  // Esc in the window (focus outside the page) leaves Inspect and the Clear question too.
  useEffect(() => {
    if (!inspect && !askClear) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (askClear) focusAfterAsk.current = 'clear';
      setInspect(false);
      setAskClear(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inspect, askClear]);

  // A project page's bridge: its pinch and ctrl/cmd + wheel zoom, its double click fits. Its
  // plain wheel scrolls the page itself (never read here). Only frames inside this pane count.
  const gestureStart = useRef(1);
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!interactive) return;
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
  }, [applyWheel, fit, zoomAround, interactive]);

  const percent = Math.round(view.scale * 100);
  const canClear = !!control?.canClear;
  return (
    <div
      ref={stageRef}
      className="super-zoom"
      data-testid="super-zoom"
      data-pinch-owner={interactive ? 'true' : undefined}
      data-scale={view.scale.toFixed(3)}
      data-zoomed={zoomed || undefined}
      data-inspect={inspect || undefined}
      data-picker={inspect && picker ? 'true' : undefined}
      data-grabbing={pz.grabbing || undefined}
      onDoubleClick={(e) => { if (interactive && zoomed && !(e.target as HTMLElement).closest('.super-zoom-bar')) fit(); }}
      {...(interactive && zoomed && !inspect ? pz.handlers : {})}
    >
      <div
        className="super-zoom-content"
        data-testid="super-zoom-content"
        style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})` }}
      >
        {children}
      </div>
      {interactive && inspect && !picker && <div className="super-zoom-shield" data-testid="super-zoom-shield" {...pz.handlers} />}
      {interactive && (zoomed || live) && (
        <div className="super-zoom-bar" role="toolbar" aria-label={t('super.zoom.label')} onPointerDown={(e) => e.stopPropagation()}>
          {askClear ? (
            <>
              <span className="super-zoom-ask" role="alert" data-testid="super-zoom-clear-ask">{t('super.zoom.clearAsk')}</span>
              <button type="button" className="super-zoom-btn super-zoom-btn--text super-zoom-btn--danger" data-testid="super-zoom-clear-yes"
                onClick={() => { focusAfterAsk.current = 'reload'; setAskClear(false); setInspect(false); control?.clear(); }}>{t('super.zoom.clearYes')}</button>
              <button ref={cancelBtnRef} type="button" className="super-zoom-btn super-zoom-btn--text" data-testid="super-zoom-clear-no"
                onClick={() => { focusAfterAsk.current = 'clear'; setAskClear(false); }}>{t('super.zoom.cancel')}</button>
            </>
          ) : (
            <>
              <button type="button" className="super-zoom-btn super-zoom-ctl" onClick={() => zoomAround((s) => s / STEP)} disabled={!zoomed}
                aria-label={t('super.zoom.out')} title={t('super.zoom.out')} data-testid="super-zoom-out">−</button>
              <span className="super-zoom-level super-zoom-ctl" data-testid="super-zoom-level">{percent}%</span>
              <button type="button" className="super-zoom-btn super-zoom-ctl" onClick={() => zoomAround((s) => s * STEP)} disabled={view.scale >= MAX_SCALE - 1e-6}
                aria-label={t('super.zoom.in')} title={t('super.zoom.in')} data-testid="super-zoom-in">＋</button>
              <button type="button" className="super-zoom-btn super-zoom-btn--text super-zoom-fit" onClick={fit} disabled={!zoomed}
                title={t('super.zoom.hint')} data-testid="super-zoom-fit">{t('super.zoom.fit')}</button>
              {live && control && (
                <button ref={reloadBtnRef} type="button" className="super-zoom-btn" onClick={() => control.reload()} disabled={!control.attached}
                  aria-label={t('super.zoom.reload')} title={t('super.zoom.reload')} data-testid="super-zoom-reload">↻</button>
              )}
              {live && control && canClear && (
                <button ref={clearBtnRef} type="button" className="super-zoom-btn super-zoom-btn--text" onClick={() => setAskClear(true)}
                  title={t('super.zoom.clearHint')} data-testid="super-zoom-clear">{t('super.zoom.clear')}</button>
              )}
              {live && (
                <button type="button" className="super-zoom-btn super-zoom-btn--text" aria-pressed={inspect} onClick={() => setInspect((v) => !v)}
                  title={inspect ? t('super.zoom.clickHint') : picker ? t('super.zoom.pickHint') : t('super.zoom.inspectHint')} data-testid="super-zoom-inspect">
                  {t('super.zoom.inspect')}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
