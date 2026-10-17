import { useCallback, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { isDesktop } from '../../lib/desktop';
import { HandsfreeSheet } from './HandsfreeSheet';
import { useMacStatus } from './macStore';
import './handsfree.css';

/**
 * The window chrome's hands-free button (desktop app only, for the project on screen): opens the
 * Mac mode sheet. While Mac mode is on it says so, with a dot on the icon.
 */
export function HandsfreeButton({ vault }: { vault: string }) {
  const { t } = useI18n();
  const mac = useMacStatus();
  const macOn = mac?.phase === 'on' || mac?.phase === 'starting' || mac?.phase === 'stopping';
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  if (!isDesktop() || !vault) return null;
  const label = macOn ? t('handsfree.mac.onPhone') : t('handsfree.button');

  return (
    <>
      <button
        type="button"
        className="hf-chrome-btn"
        data-phase={macOn ? 'mac' : 'home'}
        data-testid="hf-button"
        aria-haspopup="dialog"
        title={label}
        onClick={() => setOpen(true)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M4.5 12.5h7a3 3 0 0 0 .4-5.97A4 4 0 0 0 4.2 7.6 2.5 2.5 0 0 0 4.5 12.5z" />
          {macOn && <circle cx="12.5" cy="3.5" r="1.6" fill="currentColor" stroke="none" />}
        </svg>
        <span className="hf-chrome-label">{label}</span>
      </button>
      {open && <HandsfreeSheet vault={vault} onClose={close} />}
    </>
  );
}
