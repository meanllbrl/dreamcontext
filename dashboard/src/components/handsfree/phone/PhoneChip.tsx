import { useI18n } from '../../../context/I18nContext';
import { fill } from '../HandsfreeParts';
import { LiveBadge } from '../LiveBadge';
import { isHotState } from '../macContract';
import { usePhoneLink, type PhoneState } from './phoneState';

/** What the chip says: a low battery first (the Mac may sleep), then very hot (heavy steps run
 *  one at a time), then cooling down, then in the bag, then the battery. */
export function phoneChipView(s: PhoneState): { mac: 'low' | 'warm' | 'ok'; key: string; pct: number | null } {
  if (s.sleepAllowed) return { mac: 'low', key: 'handsfree.mac.chipLow', pct: null };
  if (isHotState(s.thermal.state)) return { mac: 'warm', key: 'handsfree.mac.chipHot', pct: null };
  if (s.thermal.slowed > 0) return { mac: 'warm', key: 'handsfree.mac.chipWarm', pct: null };
  if (s.bagMode) return { mac: 'ok', key: 'handsfree.mac.chipBag', pct: null };
  const pct = s.battery.percent;
  return pct !== null && !s.battery.charging ? { mac: 'ok', key: 'handsfree.mac.chipBattery', pct } : { mac: 'ok', key: 'handsfree.mac.chip', pct: null };
}

/**
 * The phone's "connected to your Mac" badge: the laptop's battery, a warning once it may sleep
 * again (battery floor), and "cooling down" while the Mac slows heavy work. Two channels that do
 * not share (orthogonal-encoding-channels): the dot's COLOUR is the Mac's state, the PULSE is the
 * link, on only while the last poll reached the Mac; a dropped link is a hollow, still dot and
 * says so. `quiet`: never pulse (beside an open chat's title). Renders null off the phone surface.
 */
export function PhoneChip({ quiet = false }: { quiet?: boolean }) {
  const { t } = useI18n();
  const { state: s, reachable } = usePhoneLink();
  if (!s) return null;
  const v = phoneChipView(s);
  const label = !reachable ? t('handsfree.mac.chipReaching') : v.pct !== null ? fill(t(v.key), { pct: v.pct }) : t(v.key);
  return <LiveBadge tone={v.mac} live={reachable} label={label} sr={reachable ? t('handsfree.mac.live') : undefined} quiet={quiet} testId="phone-live-badge" />;
}
