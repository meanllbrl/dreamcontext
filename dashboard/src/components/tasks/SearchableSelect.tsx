import { useEffect, useMemo, useRef, useState } from 'react';
import './SearchableSelect.css';

export interface SelectOption {
  value: string;
  label: string;
  /** Dim secondary text (e.g. the slug actually stored). */
  hint?: string;
}

interface SearchableSelectProps {
  value: string | null;
  options: SelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  /** null = cleared. */
  onChange: (value: string | null) => void;
  /** Offer "use the typed text" when it matches no option. */
  allowCustom?: boolean;
  clearLabel?: string;
}

/** Diacritic/Turkish-insensitive fold so "meh" matches "Mehmet Nuraydın". */
function fold(s: string): string {
  return s
    .replace(/ı/g, 'i').replace(/İ/g, 'i')
    .replace(/ş/g, 's').replace(/Ş/g, 's')
    .replace(/ğ/g, 'g').replace(/Ğ/g, 'g')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

export function SearchableSelect({
  value,
  options,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  onChange,
  allowCustom = false,
  clearLabel = 'None',
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = fold(query.trim());
    if (!q) return options;
    return options.filter(o => fold(o.label).includes(q) || fold(o.value).includes(q));
  }, [options, query]);

  const current = options.find(o => o.value === value);
  const customCandidate = allowCustom && query.trim() &&
    !options.some(o => o.value === query.trim());

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (v: string | null) => {
    onChange(v);
    setOpen(false);
    setQuery('');
  };

  return (
    <div className="ss-root" ref={rootRef}>
      <button
        type="button"
        className="ss-trigger"
        onClick={() => { setOpen(o => !o); setQuery(''); }}
      >
        <span className={current || value ? 'ss-value' : 'ss-placeholder'}>
          {current?.label ?? value ?? placeholder}
        </span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="ss-chevron">
          <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && (
        <div className="ss-pop">
          <input
            autoFocus
            className="ss-search"
            placeholder={searchPlaceholder}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (filtered.length > 0) pick(filtered[0].value);
                else if (customCandidate) pick(query.trim());
              }
            }}
          />
          <div className="ss-list">
            <button type="button" className="ss-item ss-item--clear" onClick={() => pick(null)}>
              {clearLabel}
            </button>
            {filtered.map(o => (
              <button
                type="button"
                key={o.value}
                className={`ss-item${o.value === value ? ' ss-item--active' : ''}`}
                onClick={() => pick(o.value)}
              >
                <span>{o.label}</span>
                {o.hint && <span className="ss-hint">{o.hint}</span>}
              </button>
            ))}
            {customCandidate && (
              <button type="button" className="ss-item" onClick={() => pick(query.trim())}>
                Use “{query.trim()}”
              </button>
            )}
            {filtered.length === 0 && !customCandidate && (
              <div className="ss-empty">No matches</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
