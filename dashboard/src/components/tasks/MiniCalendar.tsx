import { useState, useMemo } from 'react';
import './MiniCalendar.css';

interface MiniCalendarProps {
  dateField: 'created_at' | 'updated_at';
  dateFrom: string;
  dateTo: string;
  onDateFieldChange: (field: 'created_at' | 'updated_at') => void;
  onDateFromChange: (date: string) => void;
  onDateToChange: (date: string) => void;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function formatISO(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayStr(): string {
  return formatISO(new Date());
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return formatISO(d);
}

function startOfWeek(): string {
  const d = new Date();
  const day = d.getDay();
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  return formatISO(d);
}

function startOfMonth(): string {
  const d = new Date();
  d.setDate(1);
  return formatISO(d);
}

function startOfYear(): string {
  const d = new Date();
  d.setMonth(0, 1);
  return formatISO(d);
}

function formatDisplayDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface DatePreset {
  label: string;
  from: string;
  to: string;
}

function getPresets(): DatePreset[] {
  const t = todayStr();
  return [
    { label: 'Today', from: t, to: t },
    { label: 'Yesterday', from: daysAgo(1), to: daysAgo(1) },
    { label: 'This week', from: startOfWeek(), to: t },
    { label: 'Last 7 days', from: daysAgo(6), to: t },
    { label: 'This month', from: startOfMonth(), to: t },
    { label: 'Last 30 days', from: daysAgo(29), to: t },
    { label: 'This year', from: startOfYear(), to: t },
  ];
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DAY_NAMES = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

interface DayCell {
  date: string;
  day: number;
  isCurrentMonth: boolean;
}

export function MiniCalendar({
  dateField,
  dateFrom,
  dateTo,
  onDateFieldChange,
  onDateFromChange,
  onDateToChange,
}: MiniCalendarProps) {
  const now = new Date();
  const [viewYear, setViewYear] = useState(() => {
    if (dateFrom) return parseInt(dateFrom.slice(0, 4), 10);
    return now.getFullYear();
  });
  const [viewMonth, setViewMonth] = useState(() => {
    if (dateFrom) return parseInt(dateFrom.slice(5, 7), 10) - 1;
    return now.getMonth();
  });

  const presets = useMemo(getPresets, []);

  const days = useMemo<DayCell[]>(() => {
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const firstDay = new Date(viewYear, viewMonth, 1).getDay();
    const startOffset = firstDay === 0 ? 6 : firstDay - 1;

    const cells: DayCell[] = [];

    // Previous month padding
    const prevMonthDays = new Date(viewYear, viewMonth, 0).getDate();
    for (let i = startOffset - 1; i >= 0; i--) {
      const d = prevMonthDays - i;
      const m = viewMonth === 0 ? 11 : viewMonth - 1;
      const y = viewMonth === 0 ? viewYear - 1 : viewYear;
      cells.push({ date: formatISO(new Date(y, m, d)), day: d, isCurrentMonth: false });
    }

    // Current month
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ date: formatISO(new Date(viewYear, viewMonth, d)), day: d, isCurrentMonth: true });
    }

    // Next month padding (fill to 42 = 6 rows)
    const remaining = 42 - cells.length;
    for (let d = 1; d <= remaining; d++) {
      const m = viewMonth === 11 ? 0 : viewMonth + 1;
      const y = viewMonth === 11 ? viewYear + 1 : viewYear;
      cells.push({ date: formatISO(new Date(y, m, d)), day: d, isCurrentMonth: false });
    }

    return cells;
  }, [viewYear, viewMonth]);

  const handleDayClick = (dateStr: string) => {
    if (!dateFrom || (dateFrom && dateTo)) {
      // Start new selection
      onDateFromChange(dateStr);
      onDateToChange('');
    } else {
      // Complete the range
      if (dateStr < dateFrom) {
        onDateToChange(dateFrom);
        onDateFromChange(dateStr);
      } else if (dateStr === dateFrom) {
        // Same day = single-day range
        onDateToChange(dateStr);
      } else {
        onDateToChange(dateStr);
      }
    }
  };

  const handlePresetClick = (preset: DatePreset) => {
    onDateFromChange(preset.from);
    onDateToChange(preset.to);
    const d = new Date(preset.from + 'T00:00:00');
    setViewYear(d.getFullYear());
    setViewMonth(d.getMonth());
  };

  const handleClear = () => {
    onDateFromChange('');
    onDateToChange('');
  };

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear(y => y - 1);
    } else {
      setViewMonth(m => m - 1);
    }
  };

  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear(y => y + 1);
    } else {
      setViewMonth(m => m + 1);
    }
  };

  const t = todayStr();
  const activePreset = presets.find(p => p.from === dateFrom && p.to === dateTo);

  return (
    <div className="mini-cal">
      {/* Date field toggle */}
      <div className="mini-cal-field-toggle">
        <button
          className={`mini-cal-field-btn ${dateField === 'updated_at' ? 'mini-cal-field-btn--active' : ''}`}
          onClick={() => onDateFieldChange('updated_at')}
        >
          Updated
        </button>
        <button
          className={`mini-cal-field-btn ${dateField === 'created_at' ? 'mini-cal-field-btn--active' : ''}`}
          onClick={() => onDateFieldChange('created_at')}
        >
          Created
        </button>
      </div>

      {/* Quick presets */}
      <div className="mini-cal-presets">
        {presets.map(preset => (
          <button
            key={preset.label}
            className={`mini-cal-preset ${activePreset?.label === preset.label ? 'mini-cal-preset--active' : ''}`}
            onClick={() => handlePresetClick(preset)}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="mini-cal-divider" />

      {/* Month navigation */}
      <div className="mini-cal-nav-row">
        <button className="mini-cal-nav-btn" onClick={prevMonth} aria-label="Previous month">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M8.5 3L4.5 7L8.5 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <span className="mini-cal-month-label">{MONTH_NAMES[viewMonth]} {viewYear}</span>
        <button className="mini-cal-nav-btn" onClick={nextMonth} aria-label="Next month">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M5.5 3L9.5 7L5.5 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>

      {/* Calendar grid */}
      <div className="mini-cal-grid">
        {DAY_NAMES.map(d => (
          <div key={d} className="mini-cal-day-label">{d}</div>
        ))}

        {days.map((cell, i) => {
          const isStart = cell.date === dateFrom;
          const isEnd = cell.date === dateTo;
          const inRange = dateFrom && dateTo && cell.date > dateFrom && cell.date < dateTo;
          const isSingle = isStart && !dateTo;
          const isSelected = isStart || isEnd;

          const classes = [
            'mini-cal-day',
            !cell.isCurrentMonth && 'mini-cal-day--outside',
            cell.date === t && 'mini-cal-day--today',
            isSelected && 'mini-cal-day--selected',
            isStart && dateTo && 'mini-cal-day--range-start',
            isEnd && dateFrom && 'mini-cal-day--range-end',
            inRange && 'mini-cal-day--in-range',
            isSingle && 'mini-cal-day--single',
          ].filter(Boolean).join(' ');

          return (
            <button key={i} className={classes} onClick={() => handleDayClick(cell.date)}>
              {cell.day}
            </button>
          );
        })}
      </div>

      {/* Selection footer */}
      {(dateFrom || dateTo) && (
        <div className="mini-cal-footer">
          <span className="mini-cal-range-text">
            {dateFrom && <span>{formatDisplayDate(dateFrom)}</span>}
            {dateFrom && dateTo && dateFrom !== dateTo && (
              <>
                <span className="mini-cal-arrow">&rarr;</span>
                <span>{formatDisplayDate(dateTo)}</span>
              </>
            )}
            {dateFrom && !dateTo && (
              <span className="mini-cal-hint">Pick end date</span>
            )}
          </span>
          <button className="mini-cal-clear-btn" onClick={handleClear}>Clear</button>
        </div>
      )}
    </div>
  );
}
