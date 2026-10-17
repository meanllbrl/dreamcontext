import { useI18n } from '../../../context/I18nContext';
import { usePhoneState, type PhoneState } from './phoneState';
import './phone.css';

/** What the chip says: a low battery first (the Mac may sleep), then cooling down, then the battery. */
export function phoneChipView(s: PhoneState): { mac: 'low' | 'warm' | 'ok'; key: string; pct: number | null } {
  if (s.sleepAllowed) return { mac: 'low', key: 'handsfree.mac.chipLow', pct: null };
  if (s.thermal.slowed > 0) return { mac: 'warm', key: 'handsfree.mac.chipWarm', pct: null };
  const pct = s.battery.percent;
  return pct !== null && !s.battery.charging ? { mac: 'ok', key: 'handsfree.mac.chipBattery', pct } : { mac: 'ok', key: 'handsfree.mac.chip', pct: null };
}

/**
 * The phone's Mac chip: the laptop's battery, a warning once it may sleep again (battery
 * floor), and "cooling down" while the Mac slows heavy work. No props; renders null off the
 * phone surface.
 */
export function PhoneChip() {
  const { t } = useI18n();
  const s = usePhoneState();
  if (!s) return null;
  const v = phoneChipView(s);
  const label = v.pct !== null ? t(v.key).replace('{pct}', String(v.pct)) : t(v.key);
  return (
    <span className="dc-hf-chip" data-mac={v.mac} role="status">
      <span className="dc-hf-chip-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
