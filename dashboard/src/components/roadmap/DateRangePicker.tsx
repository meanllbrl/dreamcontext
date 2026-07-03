import { useEffect, useMemo, useRef, useState } from 'react';
import './DateRangePicker.css';

/**
 * A single control that picks a start→end date RANGE. Click the trigger to open a
 * month calendar; the first day-click sets the start, the second sets the end
 * (auto-swapped if you pick an earlier day), with a live hover preview of the
 * span. Mirrors the Tasks `MiniCalendar` range logic but is self-contained and
 * styled for the objective modal. Emits ISO `YYYY-MM-DD` strings (or null).
 */

interface DateRangePickerProps {
  start: string | null;
  end: string | null;
  onChange: (start: string | null, end: string | null) => void;
  placeholder?: string;
}

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayISO = () => iso(new Date());
function fmt(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function DateRangePicker({ start, end, onChange, placeholder = 'Set start & end dates' }: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const anchor = new Date((start || end || todayISO()) + 'T00:00:00');
  const [viewYear, setViewYear] = useState(anchor.getFullYear());
  const [viewMonth, setViewMonth] = useState(anchor.getMonth());
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey, true); };
  }, [open]);

  const cells = useMemo(() => {
    const first = new Date(viewYear, viewMonth, 1);
    const lead = (first.getDay() + 6) % 7; // Monday-first
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const out: { date: string; day: number; cur: boolean }[] = [];
    for (let i = lead - 1; i >= 0; i--) { const d = new Date(viewYear, viewMonth, -i); out.push({ date: iso(d), day: d.getDate(), cur: false }); }
    for (let d = 1; d <= daysInMonth; d++) out.push({ date: iso(new Date(viewYear, viewMonth, d)), day: d, cur: true });
    while (out.length < 42) { const d = new Date(viewYear, viewMonth, daysInMonth + (out.length - lead - daysInMonth) + 1); out.push({ date: iso(d), day: d.getDate(), cur: false }); }
    return out;
  }, [viewYear, viewMonth]);

  const picking = !!start && !end; // waiting for the end click
  const previewEnd = picking ? hover : end;

  const clickDay = (date: string) => {
    if (!start || (start && end)) {
      onChange(date, null); // start fresh
    } else if (date < start) {
      onChange(date, start); // picked earlier → swap
    } else {
      onChange(start, date);
      setOpen(false);
    }
  };

  const inRange = (date: string) => {
    const a = start, b = previewEnd;
    if (!a || !b) return false;
    const lo = a < b ? a : b, hi = a < b ? b : a;
    return date > lo && date < hi;
  };
  const isEnd = (date: string) => date === start || date === previewEnd;

  const shift = (delta: number) => {
    let m = viewMonth + delta, y = viewYear;
    if (m < 0) { m = 11; y -= 1; } else if (m > 11) { m = 0; y += 1; }
    setViewMonth(m); setViewYear(y);
  };

  const t = todayISO();
  const label = start && end ? `${fmt(start)} → ${fmt(end)}` : start ? `${fmt(start)} → …` : '';

  return (
    <div className="drp" ref={ref}>
      <button type="button" className={`drp-trigger${open ? ' drp-trigger--open' : ''}`} onClick={() => setOpen((o) => !o)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="5" width="16" height="16" rx="2" /><path d="M4 9h16M8 3v4M16 3v4" /></svg>
        <span className={label ? 'drp-label' : 'drp-placeholder'}>{label || placeholder}</span>
        {(start || end) && (
          <span className="drp-clear" onClick={(e) => { e.stopPropagation(); onChange(null, null); }} title="Clear dates">×</span>
        )}
      </button>

      {open && (
        <div className="drp-pop bd-pop">
          <div className="drp-nav">
            <button type="button" className="drp-nav-btn" onClick={() => shift(-1)} aria-label="Previous month">‹</button>
            <span className="drp-nav-title">{MONTHS[viewMonth]} {viewYear}</span>
            <button type="button" className="drp-nav-btn" onClick={() => shift(1)} aria-label="Next month">›</button>
          </div>
          <div className="drp-weekdays">{WEEKDAYS.map((w) => <span key={w}>{w}</span>)}</div>
          <div className="drp-grid" onMouseLeave={() => setHover(null)}>
            {cells.map((c) => {
              const classes = ['drp-day'];
              if (!c.cur) classes.push('drp-day--dim');
              if (c.date === t) classes.push('drp-day--today');
              if (inRange(c.date)) classes.push('drp-day--range');
              if (isEnd(c.date)) classes.push('drp-day--edge');
              return (
                <button
                  type="button"
                  key={c.date}
                  className={classes.join(' ')}
                  onClick={() => clickDay(c.date)}
                  onMouseEnter={() => setHover(c.date)}
                >{c.day}</button>
              );
            })}
          </div>
          <div className="drp-foot">
            <span className="drp-hint">{picking ? 'Pick the end date' : 'Pick the start date'}</span>
            {(start || end) && <button type="button" className="drp-foot-clear" onClick={() => { onChange(null, null); }}>Clear</button>}
          </div>
        </div>
      )}
    </div>
  );
}
