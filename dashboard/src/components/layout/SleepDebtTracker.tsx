import { useI18n } from '../../context/I18nContext';
import { useSleep, getSleepLevelKey, getSleepMood, SLEEP_DEBT_MAX } from '../../hooks/useSleep';
import { SleepyMascot } from '../sleepy/SleepyMascot';
import './SleepDebtTracker.css';

interface SleepDebtTrackerProps {
  /** Jump to the full Sleep page when the tracker is clicked. */
  onOpen?: () => void;
}

/**
 * Header companion: a live sleep-debt readout that pairs a linear progress bar
 * (debt climbing toward the "Must Sleep" ceiling) with the animated Sleepy face,
 * whose mood mirrors the same debt — wide awake while fresh, lids dropping as it
 * builds, fully asleep once a consolidation is overdue. Debt polls with every
 * other active query (15s interval), so the bar and face track sleep in near
 * real time. Click to open the full Sleep page.
 */
export function SleepDebtTracker({ onOpen }: SleepDebtTrackerProps) {
  const { t } = useI18n();
  const { data: sleep } = useSleep();

  // Nothing to show until the first fetch resolves — keep the header quiet.
  if (!sleep) return null;

  const debt = Math.max(0, sleep.debt);
  const levelKey = getSleepLevelKey(debt);
  const mood = getSleepMood(debt);
  const pct = Math.min(100, (debt / SLEEP_DEBT_MAX) * 100);
  const level = t(`sleep.${levelKey}`);

  const Wrapper = onOpen ? 'button' : 'div';

  return (
    <Wrapper
      className={`sleep-tracker sleep-tracker--${levelKey}`}
      data-no-drag
      onClick={onOpen}
      title={`${level} · ${debt}/${SLEEP_DEBT_MAX} ${t('sleep.debt')}`}
      aria-label={`${t('sleep.level')}: ${level}. ${t('sleep.debt')} ${debt} / ${SLEEP_DEBT_MAX}.`}
      {...(onOpen ? { type: 'button' as const } : {})}
    >
      <span className="sleep-tracker-face" aria-hidden>
        <SleepyMascot mood={mood} size={30} compact />
      </span>

      <span className="sleep-tracker-body">
        <span className="sleep-tracker-top">
          <span className="sleep-tracker-level">{level}</span>
          <span className="sleep-tracker-count">
            {debt}<span className="sleep-tracker-count-max">/{SLEEP_DEBT_MAX}</span>
          </span>
        </span>
        <span className="sleep-tracker-bar" aria-hidden>
          <span className="sleep-tracker-fill" style={{ width: `${pct}%` }} />
        </span>
      </span>
    </Wrapper>
  );
}
