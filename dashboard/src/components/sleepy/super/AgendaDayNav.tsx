import { useI18n } from '../../../context/I18nContext';
import { dayNoon, shiftDay } from './agendaGroups';

/** `‹ 14 Nov ›` at every size (owner 14 Nov: the date strip becomes arrows); the arrows browse
 *  days, past and coming. `long`: "14 November". */
export function AgendaDayNav({ day, onDay, locale, long }: {
  day: string;
  onDay: (day: string) => void;
  locale: string;
  long?: boolean;
}) {
  const { t } = useI18n();
  const label = new Intl.DateTimeFormat(locale, { day: 'numeric', month: long ? 'long' : 'short' }).format(dayNoon(day));
  return (
    <span className="agenda-daynav">
      <button type="button" className="agenda-arrow" data-testid="super-agenda-day-prev" aria-label={t('super.agenda.prevDay')} title={t('super.agenda.prevDay')} onClick={() => onDay(shiftDay(day, -1))}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden><path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <span className="agenda-day" data-testid="super-agenda-day" data-day={day}>{label}</span>
      <button type="button" className="agenda-arrow" data-testid="super-agenda-day-next" aria-label={t('super.agenda.nextDay')} title={t('super.agenda.nextDay')} onClick={() => onDay(shiftDay(day, 1))}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden><path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
    </span>
  );
}

/** The full view's 7-day strip (only there): the week around the day shown; every day is a button. */
export function AgendaWeekStrip({ day, today, onDay, locale }: { day: string; today: string; onDay: (day: string) => void; locale: string }) {
  const { t } = useI18n();
  const [y, m, d] = day.split('-').map(Number);
  const dow = (new Date(y, m - 1, d, 12).getDay() + 6) % 7; // Monday first
  const days = Array.from({ length: 7 }, (_, i) => shiftDay(day, i - dow));
  const wd = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  return (
    <div className="agenda-week" role="group" aria-label={t('super.agenda.label')}>
      <button type="button" className="agenda-arrow" data-testid="super-agenda-week-prev" aria-label={t('super.agenda.prevDay')} onClick={() => onDay(shiftDay(day, -7))}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden><path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {days.map((k) => (
        <button
          key={k}
          type="button"
          className="agenda-week-day"
          data-testid="super-agenda-week-day"
          data-day={k}
          data-on={k === day ? 'true' : undefined}
          data-today={k === today ? 'true' : undefined}
          aria-pressed={k === day}
          onClick={() => onDay(k)}
        >
          <span className="agenda-week-wd">{wd.format(dayNoon(k))}</span>
          <span className="agenda-week-n">{Number(k.slice(8))}</span>
        </button>
      ))}
      <button type="button" className="agenda-arrow" data-testid="super-agenda-week-next" aria-label={t('super.agenda.nextDay')} onClick={() => onDay(shiftDay(day, 7))}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden><path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
    </div>
  );
}
