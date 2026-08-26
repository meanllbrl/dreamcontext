import { useEffect, useId, useMemo, useState } from 'react';
import type { PublicTweak } from '../../hooks/useLab';
import { useI18n } from '../../context/I18nContext';
import { humanizeTweakValue } from './tweakLabels';
import { FilterPopover } from '../tasks/FilterPopover';
import { pushOverlay, popOverlay } from '../../lib/overlayStack';
import { activeRange, formatISO, quickWindows, rangePresets, type QuickWindow } from './rangeModel';
import './RangeControl.css';

// The window MODEL (preset lists, active-window precedence, the URL codec, the
// quick windows) lives in rangeModel.ts and is re-exported here so the four
// mounting surfaces keep one import. See that file for why it is split out.
export {
  DEFAULT_RANGE_PRESETS,
  ENGINE_FALLBACK_RANGE,
  WINDOW_TWEAK_KEYS,
  activeRange,
  fallbackPreset,
  isRelativeRange,
  nonWindowTweaks,
  quickWindows,
  rangePresets,
  writeRangeParams,
  type ActiveRange,
  type QuickWindow,
} from './rangeModel';

/**
 * The date-range control every windowed insight gets — card toolbar, detail
 * panel, funnel overview and funnel detail all mount THIS.
 *
 * Every insight has a window: `resolveTweaks` derives one from the `range` enum,
 * from explicit `from`/`to` dates, or from a trailing default. The old UI only
 * offered what a manifest happened to declare, which is how "this funnel only
 * has last 7 days" happened. So the presets come from the manifest when its
 * author curated a list (their curation wins) and from the shared defaults when
 * it did not; custom from→to is offered unconditionally, because the engine has
 * always accepted it.
 *
 * The control never writes anything itself: `onApply` hands the tweak patch back
 * to the surface, which chains PATCH → sync (#235 — the data follows the
 * control). Preset and custom window are mutually exclusive; the ENGINE clears
 * the stale side (`writeInsightTweaks`), so this component only has to say which
 * one the user picked.
 */

type Lang = 'en' | 'tr';

/** Control chrome. Parametric/close to the component, same reasoning as
 *  tweakLabels.ts — the shared `t()` map cannot express these in context. */
const UI_TEXT: Record<Lang, Record<string, string>> = {
  en: {
    label: 'Date range',
    apply: 'Apply',
    clear: 'Clear',
    pickEnd: 'Pick the end date',
    from: 'From',
    to: 'To',
    customTitle: 'Custom range',
    quick: 'Quick pick',
    inverted: 'The start date is after the end date',
    prevYear: 'Previous year',
    nextYear: 'Next year',
    d14: 'Last 14 days',
    thisMonth: 'This month',
    lastMonth: 'Last month',
    ytd: 'Year to date',
  },
  tr: {
    label: 'Tarih aralığı',
    apply: 'Uygula',
    clear: 'Temizle',
    pickEnd: 'Bitiş tarihini seç',
    from: 'Başlangıç',
    to: 'Bitiş',
    customTitle: 'Özel aralık',
    quick: 'Hızlı seçim',
    inverted: 'Başlangıç tarihi bitişten sonra',
    prevYear: 'Önceki yıl',
    nextYear: 'Sonraki yıl',
    d14: 'Son 14 gün',
    thisMonth: 'Bu ay',
    lastMonth: 'Geçen ay',
    ytd: 'Yıl başından beri',
  },
};

function text(locale: string, key: string): string {
  const lang: Lang = locale.toLowerCase().startsWith('tr') ? 'tr' : 'en';
  return UI_TEXT[lang][key] ?? key;
}

function shortDate(value: string): string {
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const MONTH_FORMAT: Intl.DateTimeFormatOptions = { month: 'long', year: 'numeric' };
const DAY_NAMES = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

interface DayCell {
  date: string;
  day: number;
  isCurrentMonth: boolean;
}

function monthCells(year: number, month: number): DayCell[] {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay = new Date(year, month, 1).getDay();
  const startOffset = firstDay === 0 ? 6 : firstDay - 1; // weeks start Monday
  const cells: DayCell[] = [];

  const prevMonthDays = new Date(year, month, 0).getDate();
  for (let i = startOffset - 1; i >= 0; i--) {
    const d = prevMonthDays - i;
    const m = month === 0 ? 11 : month - 1;
    const y = month === 0 ? year - 1 : year;
    cells.push({ date: formatISO(new Date(y, m, d)), day: d, isCurrentMonth: false });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: formatISO(new Date(year, month, d)), day: d, isCurrentMonth: true });
  }
  for (let d = 1; cells.length < 42; d++) {
    const m = month === 11 ? 0 : month + 1;
    const y = month === 11 ? year + 1 : year;
    cells.push({ date: formatISO(new Date(y, m, d)), day: d, isCurrentMonth: false });
  }
  return cells;
}

/** Two-click from→to picker — the tasks board's MiniCalendar interaction, lab-scoped
 *  (MiniCalendar hard-codes a created/updated field toggle that means nothing here). */
function RangeCalendar({ from, to, onPick }: {
  from: string;
  to: string;
  onPick: (from: string, to: string) => void;
}) {
  const { locale } = useI18n();
  const seed = from && !Number.isNaN(Date.parse(`${from}T00:00:00`)) ? new Date(`${from}T00:00:00`) : new Date();
  const [viewYear, setViewYear] = useState(seed.getFullYear());
  const [viewMonth, setViewMonth] = useState(seed.getMonth());
  const cells = useMemo(() => monthCells(viewYear, viewMonth), [viewYear, viewMonth]);
  const today = formatISO(new Date());

  /** Walk the view by months. A year is ±12 — stepping twelve times to reach
   *  the same quarter last year is the whole reason this control felt slow. */
  const step = (deltaMonths: number) => {
    const next = new Date(viewYear, viewMonth + deltaMonths, 1);
    setViewYear(next.getFullYear());
    setViewMonth(next.getMonth());
  };

  const handleDay = (date: string) => {
    // No open start (or a complete range) → this click starts a new one.
    if (!from || (from && to)) onPick(date, '');
    else if (date < from) onPick(date, from);
    else onPick(from, date);
  };

  return (
    <div className="lab-range-cal">
      <div className="lab-range-cal-nav">
        <button type="button" className="lab-range-cal-navbtn" onClick={() => step(-12)} aria-label={text(locale, 'prevYear')} title={text(locale, 'prevYear')}>«</button>
        <button type="button" className="lab-range-cal-navbtn" onClick={() => step(-1)} aria-label="Previous month">‹</button>
        <span className="lab-range-cal-month">
          {new Date(viewYear, viewMonth, 1).toLocaleDateString(locale, MONTH_FORMAT)}
        </span>
        <button type="button" className="lab-range-cal-navbtn" onClick={() => step(1)} aria-label="Next month">›</button>
        <button type="button" className="lab-range-cal-navbtn" onClick={() => step(12)} aria-label={text(locale, 'nextYear')} title={text(locale, 'nextYear')}>»</button>
      </div>
      <div className="lab-range-cal-grid">
        {DAY_NAMES.map((d) => <div key={d} className="lab-range-cal-daylabel">{d}</div>)}
        {cells.map((cell) => {
          const isStart = cell.date === from;
          const isEnd = cell.date === to;
          const inRange = !!from && !!to && cell.date > from && cell.date < to;
          const classes = [
            'lab-range-cal-day',
            !cell.isCurrentMonth ? 'lab-range-cal-day--outside' : '',
            cell.date === today ? 'lab-range-cal-day--today' : '',
            isStart || isEnd ? 'lab-range-cal-day--selected' : '',
            isStart && to ? 'lab-range-cal-day--start' : '',
            isEnd && from ? 'lab-range-cal-day--end' : '',
            inRange ? 'lab-range-cal-day--in' : '',
          ].filter(Boolean).join(' ');
          return (
            <button type="button" key={cell.date} className={classes} onClick={() => handleDay(cell.date)}>
              {cell.day}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface RangeControlProps {
  /** The insight's public tweaks (declared knobs + current values). May be empty. */
  tweaks: PublicTweak[];
  /** Hands the tweak patch to the surface, which PATCHes then re-syncs (#235). */
  onApply: (values: Record<string, string>, label: string) => void;
  /** True while a save/sync is in flight. */
  disabled?: boolean;
  /** One chip that opens the whole control — for card headers. */
  compact?: boolean;
}

export function RangeControl({ tweaks, onApply, disabled = false, compact = false }: RangeControlProps) {
  const { locale } = useI18n();
  const presets = rangePresets(tweaks);
  const active = activeRange(tweaks);
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(active.kind === 'custom' ? active.from : '');
  const [draftTo, setDraftTo] = useState(active.kind === 'custom' ? active.to : '');
  const overlayId = `lab-range-control-${useId()}`;

  // While the popover is open it OWNS Escape: the detail panel's global capture
  // handler defers to whatever is topmost (overlayStack), so Esc dismisses the
  // picker instead of the whole panel the user is picking a range in.
  useEffect(() => {
    if (!open) return;
    pushOverlay(overlayId);
    return () => popOverlay(overlayId);
  }, [open, overlayId]);

  // Re-seed the draft from the stored window whenever the popover opens or the
  // insight's saved range changes — an opened picker must show what is applied
  // NOW, not what a previous render drafted.
  const activeKey = active.kind === 'custom' ? `${active.from}..${active.to}` : '';
  useEffect(() => {
    setDraftFrom(activeKey ? activeKey.split('..')[0] : '');
    setDraftTo(activeKey ? activeKey.split('..')[1] : '');
  }, [open, activeKey]);

  const close = () => setOpen(false);

  const applyPreset = (preset: string) => {
    close();
    onApply({ range: preset }, `${text(locale, 'label')} ${humanizeTweakValue(preset, locale)}`);
  };

  /** Both halves set and in order. The engine rejects an inverted window
   *  (`writeInsightTweaks`), so offering Apply on one would only produce a toast. */
  const inverted = !!draftFrom && !!draftTo && draftFrom > draftTo;
  const canApply = !!draftFrom && !!draftTo && !inverted;

  const applyCustom = () => {
    if (!canApply) return;
    close();
    onApply({ from: draftFrom, to: draftTo }, text(locale, 'customTitle'));
  };

  /** A quick window applies straight away — its whole point is one click. */
  const applyQuick = (q: QuickWindow) => {
    close();
    onApply({ from: q.from, to: q.to }, text(locale, q.key));
  };

  /** Clearing a custom window returns to the preset it was masking — writing
   *  `range` is what makes the engine drop `from`/`to`. */
  const clearCustom = () => {
    setDraftFrom('');
    setDraftTo('');
    close();
    const preset = active.kind === 'custom' ? active.masked : active.value;
    onApply({ range: preset }, `${text(locale, 'label')} ${humanizeTweakValue(preset, locale)}`);
  };

  const customLabel = active.kind === 'custom'
    ? `${shortDate(active.from)} → ${shortDate(active.to)}`
    : humanizeTweakValue('custom', locale);

  const activeLabel = active.kind === 'custom' ? customLabel : humanizeTweakValue(active.value, locale);

  const popover = (
    <div className="lab-range-pop">
      {compact && (
        <div className="lab-range-pop-presets">
          {presets.map((preset) => (
            <button
              type="button"
              key={preset}
              className={`lab-range-pill${active.kind === 'preset' && active.value === preset ? ' lab-range-pill--on' : ''}`}
              onClick={() => applyPreset(preset)}
              disabled={disabled}
              aria-pressed={active.kind === 'preset' && active.value === preset}
            >{humanizeTweakValue(preset, locale)}</button>
          ))}
        </div>
      )}
      <div className="lab-range-pop-title">{text(locale, 'quick')}</div>
      <div className="lab-range-pop-presets lab-range-pop-quick">
        {quickWindows(new Date()).map((q) => (
          <button
            type="button"
            key={q.key}
            className={`lab-range-pill${active.kind === 'custom' && active.from === q.from && active.to === q.to ? ' lab-range-pill--on' : ''}`}
            onClick={() => applyQuick(q)}
            disabled={disabled}
            title={`${q.from} → ${q.to}`}
          >{text(locale, q.key)}</button>
        ))}
      </div>
      <div className="lab-range-pop-title">{text(locale, 'customTitle')}</div>
      <RangeCalendar
        from={draftFrom}
        to={draftTo}
        onPick={(f, t) => { setDraftFrom(f); setDraftTo(t); }}
      />
      <div className="lab-range-pop-inputs">
        <label className="lab-range-input">
          <span>{text(locale, 'from')}</span>
          <input type="date" value={draftFrom} max={draftTo || undefined} onChange={(e) => setDraftFrom(e.target.value)} />
        </label>
        <label className="lab-range-input">
          <span>{text(locale, 'to')}</span>
          <input type="date" value={draftTo} min={draftFrom || undefined} onChange={(e) => setDraftTo(e.target.value)} />
        </label>
      </div>
      <div className="lab-range-pop-foot">
        <span className={`lab-range-pop-hint${inverted ? ' lab-range-pop-hint--bad' : ''}`}>
          {inverted ? text(locale, 'inverted') : draftFrom && !draftTo ? text(locale, 'pickEnd') : ''}
        </span>
        {active.kind === 'custom' && (
          <button type="button" className="lab-range-pop-clear" onClick={clearCustom} disabled={disabled}>
            {text(locale, 'clear')}
          </button>
        )}
        <button
          type="button"
          className="lab-range-pop-apply"
          onClick={applyCustom}
          disabled={disabled || !canApply}
        >{text(locale, 'apply')}</button>
      </div>
    </div>
  );

  const trigger = compact ? (
    <button
      type="button"
      className={`lab-range-chip${open ? ' lab-range-chip--open' : ''}`}
      onClick={() => setOpen((v) => !v)}
      disabled={disabled}
      aria-expanded={open}
      aria-haspopup="dialog"
      title={text(locale, 'label')}
    >
      <span aria-hidden>🗓</span>
      <span className="lab-range-chip-label">{activeLabel}</span>
    </button>
  ) : (
    <button
      type="button"
      className={`lab-range-pill${active.kind === 'custom' ? ' lab-range-pill--on' : ''}`}
      onClick={() => setOpen((v) => !v)}
      disabled={disabled}
      aria-expanded={open}
      aria-haspopup="dialog"
    >{customLabel}</button>
  );

  return (
    <div
      className={`lab-range${compact ? ' lab-range--compact' : ''}`}
      role="group"
      aria-label={text(locale, 'label')}
    >
      {!compact && presets.map((preset) => (
        <button
          type="button"
          key={preset}
          className={`lab-range-pill${active.kind === 'preset' && active.value === preset ? ' lab-range-pill--on' : ''}`}
          onClick={() => applyPreset(preset)}
          disabled={disabled}
          aria-pressed={active.kind === 'preset' && active.value === preset}
        >{humanizeTweakValue(preset, locale)}</button>
      ))}
      <FilterPopover trigger={trigger} content={popover} isOpen={open} onClose={close} align="right" width={compact ? 300 : 280} />
    </div>
  );
}
