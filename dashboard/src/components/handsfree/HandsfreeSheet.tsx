import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../context/I18nContext';
import { MacPanel } from './MacPanel';
import '../sleepy/chat/ChatViews.css';

/** The hands-free sheet: Mac mode's panel (setup, start/stop, the phone link, devices) for the
 *  project on screen. */
export function HandsfreeSheet({ vault, onClose }: { vault: string; onClose: () => void }) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Portalled to <body>: the chrome bar is its own stacking context.
  return createPortal(
    <div className="hf-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        className="hf-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hf-sheet-title"
        tabIndex={-1}
        data-testid="hf-sheet"
      >
        <header className="hf-sheet-head">
          <h2 id="hf-sheet-title">{t('handsfree.sheet.title')}</h2>
          <button type="button" className="hf-icon-btn" onClick={onClose} aria-label={t('handsfree.close')}>✕</button>
        </header>
        <MacPanel vault={vault} onClose={onClose} />
      </div>
    </div>,
    document.body,
  );
}
