import { useEffect, useId, useMemo, useState } from 'react';
import type { PublicTweak } from '../../hooks/useLab';
import { useI18n } from '../../context/I18nContext';
import { humanizeTweakValue } from './tweakLabels';
import { FilterPopover } from '../tasks/FilterPopover';
import { pushOverlay, popOverlay } from '../../lib/overlayStack';
import './RangeControl.css';

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

/** Presets offered when a manifest declares no `range` options of its own.
 *  MIRRORS `DEFAULT_RANGE_OPTIONS` in src/lib/lab/store.ts (unit-test guarded). */
export const DEFAULT_RANGE_PRESETS = [
  'last_7_days',
  'last_28_days',
  'last_30_days',
  'last_90_days',
  'last_1_year',
];

/** What `resolveTweaks` falls back to when nothing is set (DEFAULT_SPAN_DAYS). */
export const ENGINE_FALLBACK_RANGE = 'last_30_days';

/** The window keys this control owns — every other tweak stays with TweakEditor,
 *  so a surface never renders two competing date pickers. */
export const WINDOW_TWEAK_KEYS = ['range', 'from', 'to'];

/** The tweaks a generic tweak editor should still show next to a RangeControl. */
export function nonWindowTweaks(tweaks: PublicTweak[]): PublicTweak[] {
  return tweaks.filter((t) => !WINDOW_TWEAK_KEYS.includes(t.key));
}

/**
 * Mirror an applied window into the funnel pages' URL params, so a deep link
 * carries the window its author was looking at. Preset and custom are mutually
 * exclusive here for the same reason they are in the manifest: a leftover
 * `from`/`to` in the query would out-rank the `range` the link asks for.
 */
export function writeRangeParams(params: URLSearchParams, values: Record<string, string>): void {
  if (values.range) {
    params.set('range', values.range);
    params.delete('from');
    params.delete('to');
    return;
  }
  if (values.from) params.set('from', values.from);
  if (values.to) params.set('to', values.to);
  params.delete('range');
}

/** The relative-range grammar the engine parses (`parseRelativeRange`). */
const RELATIVE_RANGE_RE = /^last_(\d+)_(day|days|week|weeks|month|months|year|years)$/;

export function isRelativeRange(value: string): boolean {
  return RELATIVE_RANGE_RE.test((value ?? '').trim());
}

function tweakValue(tweaks: PublicTweak[], key: string): string {
  const t = tweaks.find((x) => x.key === key);
  return (t?.value ?? '').trim();
}

/** The preset list for these tweaks: the author's curated enum, else the defaults. */
export function rangePresets(tweaks: PublicTweak[]): string[] {
  const decl = tweaks.find((t) => t.key === 'range' && t.type === 'enum');
  const options = (decl?.options ?? []).filter((o) => o.trim() !== '');
  return options.length > 0 ? options : DEFAULT_RANGE_PRESETS;
}

export type ActiveRange =
  | { kind: 'preset'; value: string }
  | { kind: 'custom'; from: string; to: string };

/** Which window these tweaks currently describe — the same precedence
 *  `resolveTweaks` applies (explicit from/to beat the enum). */
export function activeRange(tweaks: PublicTweak[]): ActiveRange {
  const from = tweakValue(tweaks, 'from');
  const to = tweakValue(tweaks, 'to');
  if (from && to) return { kind: 'custom', from, to };
  const decl = tweaks.find((t) => t.key === 'range' && t.type === 'enum');
  const value = (decl?.value ?? decl?.default ?? '').trim();
  return { kind: 'preset', value: value || ENGINE_FALLBACK_RANGE };
}

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
  },
  tr: {
    label: 'Tarih aralığı',
    apply: 'Uygula',
    clear: 'Temizle',
    pickEnd: 'Bitiş tarihini seç',
    from: 'Başlangıç',
    to: 'Bitiş',
    customTitle: 'Özel aralık',
  },
};

function text(locale: string, key: string): string {
  const lang: Lang = locale.toLowerCase().startsWith('tr') ? 'tr' : 'en';
  return UI_TEXT[lang][key] ?? key;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local-calendar ISO date — never `toISOString()`, which shifts the day for
 *  anyone east/west of UTC and would apply a window they did not pick. */
function formatISO(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

  const step = (delta: number) => {
    const next = new Date(viewYear, viewMonth + delta, 1);
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
        <button type="button" className="lab-range-cal-navbtn" onClick={() => step(-1)} aria-label="Previous month">‹</button>
        <span className="lab-range-cal-month">
          {new Date(viewYear, viewMonth, 1).toLocaleDateString(locale, MONTH_FORMAT)}
        </span>
        <button type="button" className="lab-range-cal-navbtn" onClick={() => step(1)} aria-label="Next month">›</button>
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

  const applyCustom = () => {
    if (!draftFrom || !draftTo) return;
    close();
    onApply({ from: draftFrom, to: draftTo }, text(locale, 'customTitle'));
  };

  /** Clearing a custom window returns to the preset (the engine drops from/to). */
  const clearCustom = () => {
    setDraftFrom('');
    setDraftTo('');
    close();
    const preset = active.kind === 'preset' ? active.value : ENGINE_FALLBACK_RANGE;
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
        <span className="lab-range-pop-hint">
          {draftFrom && !draftTo ? text(locale, 'pickEnd') : ''}
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
          disabled={disabled || !draftFrom || !draftTo}
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
