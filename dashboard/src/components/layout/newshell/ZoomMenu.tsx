import { useI18n } from '../../../context/I18nContext';

interface ZoomMenuProps {
  zoom: number;
  levels: readonly number[];
  onZoom: (level: number) => void;
}

/** The title bar's zoom: − 100% +, the percentage resetting to actual size. The window's one
 *  zoom (`WindowChrome` owns it through `ChromeApi`). */
export function ZoomMenu({ zoom, levels, onZoom }: ZoomMenuProps) {
  const { t } = useI18n();
  const i = levels.indexOf(zoom);
  return (
    <div className="ns-zoom" role="group" aria-label={t('shell.zoom')} data-no-drag data-testid="ns-zoom">
      <button type="button" aria-label="Zoom out" disabled={i <= 0} onClick={() => onZoom(levels[i - 1])}>−</button>
      <button type="button" className="ns-zoom-value" title={t('shell.zoom.reset')} onClick={() => onZoom(1)}>
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" aria-label="Zoom in" disabled={i < 0 || i >= levels.length - 1} onClick={() => onZoom(levels[i + 1])}>+</button>
    </div>
  );
}
