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
  if (s.mac) {
    // Mac mode: the laptop's battery, and a warning once it may sleep again (battery floor).
    const pct = s.mac.battery.percent;
    const label = s.mac.sleepAllowed ? t('handsfree.mac.chipLow') : pct !== null && !s.mac.battery.charging ? t('handsfree.mac.chipBattery').replace('{pct}', String(pct)) : t('handsfree.mac.chip');
    return (
      <span className="dc-hf-chip" data-phase="active" data-mac={s.mac.sleepAllowed ? 'low' : 'ok'} role="status">
        <span className="dc-hf-chip-dot" aria-hidden="true" />
        {label}
      </span>
    );
  }
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
