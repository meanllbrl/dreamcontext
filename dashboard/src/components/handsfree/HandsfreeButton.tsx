import { useCallback, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { isDesktop } from '../../lib/desktop';
import { HandsfreeMark } from '../brand/HandsfreeMark';
import { HandsfreeSheet } from './HandsfreeSheet';
import { macModeOffered } from './macContract';
import { useMacStatus } from './macStore';
import './handsfree.css';

/**
 * The window chrome's hands-free button (desktop app only, for the project on screen): opens the
 * Mac mode sheet, on a machine the server says can run it (macOS). Its icon is the hands-free mark (the gem with two sound waves), never the retired
 * cloud mode's cloud. While Mac mode is on it says so, with a dot on the mark.
 */
export function HandsfreeButton({ vault }: { vault: string }) {
  const { t } = useI18n();
  const mac = useMacStatus();
  const macOn = mac?.phase === 'on' || mac?.phase === 'starting' || mac?.phase === 'stopping';
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  // Mac mode runs on macOS only; the server says whether this machine is one.
  if (!isDesktop() || !vault || !macModeOffered(mac)) return null;
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
        <span className="hf-chrome-icon" aria-hidden>
          <HandsfreeMark height={16} />
          {macOn && <span className="hf-chrome-dot" data-testid="hf-button-dot" />}
        </span>
        <span className="hf-chrome-label">{label}</span>
      </button>
      {open && <HandsfreeSheet vault={vault} onClose={close} />}
    </>
  );
}
