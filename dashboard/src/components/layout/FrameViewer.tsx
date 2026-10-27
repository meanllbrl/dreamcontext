import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../context/I18nContext';
import { useTheme } from '../../context/ThemeContext';
import { SANDBOX_ALLOW, buildSandboxSrcdoc } from '../../lib/sandboxHtml';
import {
  CHAT_HTML_KIT_CSS, CHAT_HTML_SANDBOX, HEIGHT_BRIDGE, HEIGHT_REQUEST_KEY, MAX_HTML_HEIGHT,
  readHeightMessage, resolveChatKitTokens,
} from '../sleepy/chat/chatHtmlKit';
import { useProjectHtml } from '../appLink/DocumentReader';
import { LINK_GUARD } from '../../lib/htmlLocalAssets';
import { fileNameOf } from '../appLink/viewerPaths';
import { WEB_WIDGET_SANDBOX } from '../whiteboard/widgets/WebWidget';
import { ZOOM_BRIDGE, readZoomMessage } from './frameZoomBridge';
import { gestureScale, usePanZoom, type Size, type View } from './usePanZoom';
import { DeviceSwitch } from './DeviceSwitch';
import { deviceFit, useWebDevice } from '../../lib/webDevice';
import './ImageViewer.css';
import './FrameViewer.css';

/** What the viewer shows: a project web page (`.html`, drawn in the chat's strict sandbox) or a
 *  page on the web or this computer (the web card's own frame and sandbox, already allowed). */
export type FrameSubject =
  | { kind: 'html'; path: string }
  | { kind: 'page'; href: string; title: string };

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
/** One press of ＋ / − / the keyboard. */
const STEP = 1.25;
const FOCUSABLE = 'button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

/**
 * A web page full screen, to be READ (owner 2026-10-22: "I cannot look at these closely"):
 * opened fitted to the screen's width, zoomed by pinch (two pointers, or the trackpad), ctrl/cmd
 * + wheel or + and −, scrolled by the wheel, panned by dragging. By default a shield over the
 * page takes every pointer, so a drag pans instead of selecting text; "Use the page" lifts it so
 * the page's own tabs and buttons work. A project page (and a page on this computer, through
 * its session proxy) carries a bridge that keeps the wheel and the pinch working there; a site
 * on the web cannot (the browser keeps another origin's page out of the app's reach), so there
 * the bar's − and ＋ zoom, and the hint says so.
 *
 * A page on the web or this computer can be laid out at a phone, tablet or desktop width
 * (lib/webDevice.ts), fitted to the screen; `deviceKey` (the Super card's id) shares the choice
 * with the card.
 *
 * Portalled to `<body>` like ImageViewer (a fixed child of a transformed card would be trapped in
 * it), and its stage is a pinch OWNER: a whiteboard mounted behind it never takes its pinch.
 */
export function FrameViewer({ subject, deviceKey, onClose }: { subject: FrameSubject; deviceKey?: string; onClose: () => void }) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [stage, setStage] = useState<Size | null>(null);
  const [pageHeight, setPageHeight] = useState<number | null>(null);
  const [interact, setInteract] = useState(false);
  const title = subject.kind === 'html' ? fileNameOf(subject.path) : subject.title;
  const [chosenDevice, setDevice] = useWebDevice(deviceKey ?? null);
  const device = subject.kind === 'page' ? chosenDevice : null;

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const body = document.body;
    const prev = body.style.overflow;
    body.style.overflow = 'hidden';
    return () => { body.style.overflow = prev; };
  }, []);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    rootRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, []);

  // The page is laid out at the screen's width and its own height (an html page reports it);
  // a page on the web fills the screen and scrolls itself. With a device: at its width, as tall
  // as the screen is in the device's px, fitted down to the screen.
  const devFit = deviceFit(device, stage);
  const fitScale = devFit?.scale ?? 1;
  const contentW = devFit?.w ?? stage?.w ?? 0;
  const contentH = stage ? (subject.kind === 'html' ? Math.max(stage.h, pageHeight ?? stage.h) : devFit?.h ?? stage.h) : 0;
  const content: Size | null = useMemo(() => (stage ? { w: contentW, h: contentH } : null), [stage, contentW, contentH]);
  /** Fitted: the whole width, the page's top at the top. */
  const fitView = useCallback((): View => ({
    scale: fitScale, x: 0, y: content && stage ? Math.max(0, (content.h * fitScale - stage.h) / 2) : 0,
  }), [content, stage, fitScale]);
  const pz = usePanZoom({
    stageRef, content, stage, minScale: Math.min(MIN_SCALE, fitScale), maxScale: MAX_SCALE, wheel: 'pan', fit: { scale: 1, x: 0, y: 0 },
  });
  const { view, setView, zoomAround, applyWheel } = pz;
  const fitRef = useRef(fitView);
  fitRef.current = fitView;
  const setRef = useRef(setView);
  setRef.current = setView;
  const fit = useCallback(() => setRef.current(fitRef.current()), []);
  // Open fitted, and again once the page has said how tall it is (its top stays in view).
  const fittedFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!stage) return;
    const key = `${subject.kind === 'html' ? subject.path : subject.href}|${pageHeight === null ? 'unknown' : 'known'}|${device ?? 'fill'}`;
    if (fittedFor.current === key) return;
    fittedFor.current = key;
    fit();
  }, [fit, pageHeight, stage, subject, device]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); onClose(); return; }
      if (e.key === 'Tab') {
        const root = rootRef.current;
        if (!root) return;
        e.stopImmediatePropagation();
        const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (!focusable.length) { e.preventDefault(); return; }
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
      else if (e.key === '0') { e.preventDefault(); fit(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [fit, onClose, zoomAround]);

  // The page's messages: its height, and (in Click mode) its wheel and pinch. Only from THIS
  // frame's window; anything else, or any other shape, is ignored.
  const gestureStart = useRef(1);
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const win = frameRef.current?.contentWindow;
      if (!win || event.source !== win) return;
      const h = readHeightMessage(event.data);
      if (h !== null) { setPageHeight(Math.min(MAX_HTML_HEIGHT, Math.max(1, h))); return; }
      const m = readZoomMessage(event.data);
      if (!m) return;
      if (m.kind === 'escape') { onClose(); return; }
      if (m.kind === 'dblclick') return;
      // The frame's coordinates, on the screen: its box is already transformed.
      const r = frameRef.current!.getBoundingClientRect();
      const s = viewRef.current.scale;
      const cx = r.left + m.x * s;
      const cy = r.top + m.y * s;
      if (m.kind === 'wheel') applyWheel({ deltaX: m.dx, deltaY: m.dy, ctrlKey: m.ctrl, metaKey: false, clientX: cx, clientY: cy });
      else if (m.phase === 'start') gestureStart.current = viewRef.current.scale;
      else if (m.phase === 'change') {
        const target = gestureScale(gestureStart.current, m.scale);
        if (target !== null) zoomAround(() => target, cx, cy);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [applyWheel, onClose, zoomAround]);

  const percent = Math.round(view.scale * 100);
  const wrapStyle = content ? {
    width: content.w,
    height: content.h,
    transform: `translate(-50%, -50%) translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`,
  } : undefined;

  let body: ReactNode;
  let note: ReactNode = null;
  if (subject.kind === 'html') {
    const page = <HtmlFrame path={subject.path} frameRef={frameRef} onHeightRequest={() => frameRef.current?.contentWindow?.postMessage({ [HEIGHT_REQUEST_KEY]: true }, '*')} />;
    body = page;
    if (pageHeight !== null && pageHeight >= MAX_HTML_HEIGHT) {
      note = <p className="frame-viewer-note" role="status">{t('frameViewer.cut')}</p>;
    }
  } else {
    body = (
      <iframe
        ref={frameRef}
        className="frame-viewer-frame"
        title={subject.title}
        src={subject.href}
        sandbox={WEB_WIDGET_SANDBOX}
        allow=""
        referrerPolicy="no-referrer"
      />
    );
  }

  return createPortal(
    <div ref={rootRef} className="image-viewer frame-viewer" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} data-testid="frame-viewer">
      <div
        ref={stageRef}
        className="frame-viewer-stage"
        data-pinch-owner="true"
        data-mode={interact ? 'click' : 'inspect'}
        data-grabbing={pz.grabbing || undefined}
        data-scale={view.scale.toFixed(3)}
      >
        <div className="frame-viewer-page" style={wrapStyle}>{body}</div>
        {!interact && <div className="frame-viewer-shield" data-testid="frame-viewer-shield" {...pz.handlers} />}
      </div>
      {note}
      <div className="image-viewer-foot">
        <div className="image-viewer-caption">{title}</div>
        <div className="image-viewer-bar">
          <button type="button" className="image-viewer-btn" onClick={() => zoomAround((s) => s / STEP)} disabled={view.scale <= Math.min(MIN_SCALE, fitScale) + 1e-6}
            aria-label={t('imageViewer.zoomOut')} title={t('imageViewer.zoomOut')} data-testid="frame-viewer-zoom-out">−</button>
          <span className="image-viewer-level frame-viewer-level" data-testid="frame-viewer-level">{percent}%</span>
          <button type="button" className="image-viewer-btn" onClick={() => zoomAround((s) => s * STEP)} disabled={view.scale >= MAX_SCALE - 1e-6}
            aria-label={t('imageViewer.zoomIn')} title={t('imageViewer.zoomIn')} data-testid="frame-viewer-zoom-in">＋</button>
          <button type="button" className="image-viewer-level" onClick={fit} title={t('imageViewer.fit')} data-testid="frame-viewer-fit">{t('frameViewer.fit')}</button>
          {subject.kind === 'page' && <DeviceSwitch device={device} onChange={setDevice} btnClass="image-viewer-btn" />}
          <button type="button" className="image-viewer-level" aria-pressed={interact} onClick={() => setInteract((v) => !v)}
            title={interact ? t('frameViewer.inspectHint') : t('frameViewer.usePageHint')} data-testid="frame-viewer-mode">
            {t('frameViewer.usePage')}
          </button>
        </div>
        <p className="image-viewer-hint" data-testid="frame-viewer-hint">
          {interact ? t(subject.kind === 'page' ? 'frameViewer.clickHintRemote' : 'frameViewer.clickHint') : t('frameViewer.hint')}
        </p>
      </div>
      <button type="button" className="image-viewer-close" onClick={onClose} aria-label={t('common.close')} title={t('common.close')} data-testid="frame-viewer-close">✕</button>
    </div>,
    document.body,
  );
}

/** A project page in the chat's strict sandbox (no network, no navigation), with the height
 *  bridge (its own height) and the zoom bridge (its wheel and pinch in Click mode). */
function HtmlFrame({ path, frameRef, onHeightRequest }: {
  path: string; frameRef: React.MutableRefObject<HTMLIFrameElement | null>; onHeightRequest: () => void;
}) {
  const { t } = useI18n();
  const { resolved: theme } = useTheme();
  const state = useProjectHtml(path);
  const [torn, setTorn] = useState(false);
  const loads = useRef(0);
  const html = state.html;
  const srcDoc = useMemo(
    () => (html === null ? null : buildSandboxSrcdoc({
      html, css: CHAT_HTML_KIT_CSS, tokens: resolveChatKitTokens(), scheme: theme, headScript: `${HEIGHT_BRIDGE}\n${LINK_GUARD}\n${ZOOM_BRIDGE}`,
    })),
    [html, theme],
  );
  useLayoutEffect(() => { loads.current = 0; }, [srcDoc]);
  if (state.loading) return <p className="frame-viewer-status">{t('viewer.loading')}</p>;
  if (state.error) {
    return <p className="frame-viewer-status" role="alert">{state.tooLarge ? t('frameViewer.tooLarge') : `${t('viewer.failed')} ${state.error}`}</p>;
  }
  if (torn) return <p className="frame-viewer-status" role="alert">{t('frameViewer.navigated')}</p>;
  return srcDoc === null ? null : (
    <iframe
      ref={frameRef}
      className="frame-viewer-frame"
      title={fileNameOf(path)}
      sandbox={CHAT_HTML_SANDBOX}
      allow={SANDBOX_ALLOW}
      srcDoc={srcDoc}
      onLoad={() => {
        loads.current += 1;
        // A second load of the same srcdoc is the page navigating itself away.
        if (loads.current >= 2) { setTorn(true); return; }
        onHeightRequest();
      }}
    />
  );
}
