import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { usePhoneState } from './phoneState';
import './phone.css';

const BACK_NOTICE_MS = 6000;

/**
 * While the laptop takes the project back (phase quiescing) the phone is blocked: new
 * messages are refused by the cloud anyway (423). If the laptop gives up, a short notice says
 * work can go on; once sealed, the page reloads so the server's sealed page shows.
 * No props; renders null unless the cloud's phone route answers (so never on the laptop).
 */
export function QuiesceOverlay() {
  const { t } = useI18n();
  const s = usePhoneState();
  const prev = useRef<string | null>(null);
  const [back, setBack] = useState(false);
  const phase = s?.phase ?? null;

  useEffect(() => {
    const was = prev.current;
    prev.current = phase;
    if (phase === 'sealed') {
      window.location.reload();
      return;
    }
    if (was === 'quiescing' && phase === 'active') {
      setBack(true);
      const timer = setTimeout(() => setBack(false), BACK_NOTICE_MS);
      return () => clearTimeout(timer);
    }
    if (phase === 'quiescing') setBack(false);
    return undefined;
  }, [phase]);

  if (phase === 'quiescing') {
    return (
      <div className="dc-hf-quiesce" role="alertdialog" aria-modal="true" aria-labelledby="dc-hf-quiesce-title" aria-describedby="dc-hf-quiesce-body">
        <div className="dc-hf-quiesce-card">
          <div className="dc-hf-quiesce-spinner" aria-hidden="true" />
          <h2 id="dc-hf-quiesce-title">{t('handsfree.phone.quiesceTitle')}</h2>
          <p id="dc-hf-quiesce-body">{t('handsfree.phone.quiesceBody')}</p>
        </div>
      </div>
    );
  }
  if (back && phase === 'active') {
    return <div className="dc-hf-back" role="status">{t('handsfree.phone.quiesceBack')}</div>;
  }
  return null;
}
