import { useI18n } from '../../../context/I18nContext';
import { usePhoneState } from './phoneState';
import './phone.css';

/**
 * The phone's Mac chip: the laptop's battery, and a warning once it may sleep again (battery
 * floor). No props; renders null off the phone surface.
 */
export function PhoneChip() {
  const { t } = useI18n();
  const s = usePhoneState();
  if (!s) return null;
  const pct = s.battery.percent;
  const label = s.sleepAllowed ? t('handsfree.mac.chipLow') : pct !== null && !s.battery.charging ? t('handsfree.mac.chipBattery').replace('{pct}', String(pct)) : t('handsfree.mac.chip');
  return (
    <span className="dc-hf-chip" data-mac={s.sleepAllowed ? 'low' : 'ok'} role="status">
      <span className="dc-hf-chip-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
