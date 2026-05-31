import { useState, useEffect, useCallback } from 'react';
import { useVersionCheck } from '../../hooks/useVersionCheck';
import { MarkdownPreview } from '../core/MarkdownPreview';
import { useI18n } from '../../context/I18nContext';
import './UpdateBadge.css';

/**
 * UpdateBadge — simple update notification banner.
 *
 * Renders nothing when nudge is null (header layout unchanged).
 * When nudge is non-null, shows a banner with a toggle to reveal details.
 * Escape key closes the expanded view.
 * No focus trap — per pragmatist decision (simple banner, not a modal).
 */
export function UpdateBadge() {
  const { t } = useI18n();
  const { data } = useVersionCheck();
  const nudge = data?.nudge ?? null;
  const [expanded, setExpanded] = useState(false);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && expanded) {
        setExpanded(false);
      }
    },
    [expanded],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (!nudge) return null;

  return (
    <div className="update-badge">
      <button
        className="update-badge-trigger"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        title={t('update.title')}
      >
        <span className="update-badge-dot" />
        <span className="update-badge-label">{t('update.available')}</span>
      </button>
      {expanded && (
        <div className="update-badge-popover">
          <div className="update-badge-popover-header">
            <span className="update-badge-popover-title">{t('update.title')}</span>
            <button
              className="update-badge-dismiss"
              onClick={() => setExpanded(false)}
              title={t('update.dismiss')}
              aria-label={t('update.dismiss')}
            >
              ×
            </button>
          </div>
          <div className="update-badge-content">
            <MarkdownPreview content={nudge} />
          </div>
        </div>
      )}
    </div>
  );
}
