import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, snapZoom, stepZoom } from '../../../lib/zoom';

interface ZoomProps {
  zoom: number;
  onZoom: (level: number) => void;
}

/** The fine control itself: − value +, a slider in 5% steps, and "Actual size". The title bar's
 *  panel and Settings → General draw this same control on the same zoom. */
export function ZoomControl({ zoom, onZoom }: ZoomProps) {
  const { t } = useI18n();
  const pct = Math.round(zoom * 100);
  return (
    <div className="ns-zoom-control" data-no-drag>
      <div className="ns-zoom-row">
        <button type="button" className="ns-zoom-step" aria-label={t('shell.zoom.out')} disabled={zoom <= ZOOM_MIN} onClick={() => onZoom(stepZoom(zoom, -1))} data-testid="zoom-out">−</button>
        <span className="ns-zoom-pct" aria-live="polite">{pct}%</span>
        <button type="button" className="ns-zoom-step" aria-label={t('shell.zoom.in')} disabled={zoom >= ZOOM_MAX} onClick={() => onZoom(stepZoom(zoom, 1))} data-testid="zoom-in">+</button>
      </div>
      <input
        type="range"
        className="ns-zoom-slider"
        min={ZOOM_MIN}
        max={ZOOM_MAX}
        step={ZOOM_STEP}
        value={zoom}
        aria-label={t('shell.zoom')}
        aria-valuetext={`${pct}%`}
        onChange={(e) => onZoom(snapZoom(Number(e.target.value)))}
        data-testid="zoom-slider"
      />
      <button type="button" className="ns-zoom-reset" disabled={zoom === 1} onClick={() => onZoom(1)} data-testid="zoom-reset">
        {t('shell.zoom.reset')}
      </button>
    </div>
  );
}

/** The title bar's zoom: one magnifier icon (owner 2026-11-15, "zoom ikonu yap"); a click opens
 *  the fine control under it. The window's one zoom (`WindowChrome` owns it through `ChromeApi`). */
export function ZoomMenu({ zoom, onZoom }: ZoomProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', esc); };
  }, [open]);
  const pct = Math.round(zoom * 100);
  const label = `${t('shell.zoom')}: ${pct}%`;
  return (
    <div className="ns-zoom" ref={ref} data-no-drag data-testid="ns-zoom">
      <button
        type="button"
        className="ns-tb-btn"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-on={zoom !== 1 ? 'true' : undefined}
        onClick={() => setOpen((v) => !v)}
        data-testid="zoom-button"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" />
          <path d="m10.5 10.5 3.5 3.5M5 7h4M7 5v4" />
        </svg>
      </button>
      {open && (
        <div className="ns-zoom-panel" role="dialog" aria-label={t('shell.zoom')} data-testid="zoom-panel">
          <ZoomControl zoom={zoom} onZoom={onZoom} />
        </div>
      )}
    </div>
  );
}
