import { useI18n } from '../../../context/I18nContext';
import { usePhoneState } from './phoneState';
import './phone.css';

/**
 * The phone's "you are on the cloud machine" chip, with the time the cloud plans to sleep.
 * No props; renders null unless the cloud's phone route answers (so never on the laptop).
 * Mounting it also registers the offline service worker once that route has answered 200.
 */
export function CloudChip() {
  const { t } = useI18n();
  const s = usePhoneState();
  if (!s || s.phase === 'sealed') return null;
  let label = t('handsfree.phone.chip');
  const at = s.phase === 'active' && s.stopAt ? new Date(s.stopAt) : null;
  if (at && !Number.isNaN(at.getTime())) {
    const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    label = t('handsfree.phone.chipSleeps').replace('{time}', time);
  }
  return (
    <span className="dc-hf-chip" data-phase={s.phase} role="status">
      <span className="dc-hf-chip-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
