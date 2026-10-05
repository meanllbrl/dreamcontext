import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { isDesktop } from '../../lib/desktop';
import { focusHandsfreeBanner, onHandsfreeEvent, OPEN_SHEET, useHandsfree } from './handsfreeStore';
import { HandsfreeSheet } from './HandsfreeSheet';
import { handsfreeVisible } from './handsfreeReveal';
import './handsfree.css';

/**
 * The window chrome's hands-free button (desktop app only, for the project on screen). Home:
 * opens the go sheet. Away or on the way: the banner already carries every action, so the
 * button brings it forward instead of a second, competing surface. Also the sheet's host for
 * `openHandsfreeSheet()` (the banner's "Show link").
 */
export function HandsfreeButton({ vault }: { vault: string }) {
  const { t } = useI18n();
  const { status, unavailable, job } = useHandsfree();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => onHandsfreeEvent(OPEN_SHEET, () => setOpen(true)), []);

  if (!isDesktop() || unavailable || !vault || !handsfreeVisible(status)) return null;
  const phase = status?.phase ?? 'home';
  const goRunning = job?.kind === 'go' && job.status === 'running';
  const label = phase === 'home' && !goRunning ? t('handsfree.button') : t(`handsfree.phase.${phase}`);

  return (
    <>
      <button
        type="button"
        className="hf-chrome-btn"
        data-phase={phase}
        data-testid="hf-button"
        aria-haspopup="dialog"
        title={label}
        onClick={() => {
          if (phase === 'home' || goRunning) setOpen(true);
          else focusHandsfreeBanner();
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M4.5 12.5h7a3 3 0 0 0 .4-5.97A4 4 0 0 0 4.2 7.6 2.5 2.5 0 0 0 4.5 12.5z" />
          {phase !== 'home' && <circle cx="12.5" cy="3.5" r="1.6" fill="currentColor" stroke="none" />}
        </svg>
        <span className="hf-chrome-label">{label}</span>
      </button>
      {open && <HandsfreeSheet vault={vault} onClose={close} />}
    </>
  );
}
