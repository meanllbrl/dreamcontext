import { useEffect, useMemo, useRef, useState } from 'react';
import { STATUS_COLOR } from './chrome';
import './DependencyPicker.css';

/**
 * Searchable multi-select for objective dependencies. Selected objectives show as
 * removable chips; the field opens a search popover listing every objective
 * (status dot + title + slug), filtered as you type, each toggle-selectable.
 * Diacritic/Turkish-insensitive search (mirrors the Tasks SearchableSelect fold).
 */

export interface DepOption {
  slug: string;
  title: string;
  status: string | null;
}

interface DependencyPickerProps {
  options: DepOption[];
  selected: string[];
  onChange: (slugs: string[]) => void;
}

// Diacritic/Turkish-insensitive fold. Code points are written escaped (not as
// literal bytes) so the compiled bundle stays ASCII-safe regardless of how it's
// served — mirrors the Tasks SearchableSelect fold.
function fold(s: string): string {
  // Turkish letters → ASCII, then combining marks (U+0300–U+036F) stripped after
  // NFD. Code points are referenced NUMERICALLY so the source stays pure ASCII —
  // a literal high-byte regex range can break a bundle not served as UTF-8.
  const tr: Record<number, string> = { 0x131: 'i', 0x130: 'i', 0x15f: 's', 0x15e: 's', 0x11f: 'g', 0x11e: 'g' };
  let mapped = '';
  for (const ch of s) mapped += tr[ch.codePointAt(0) ?? 0] ?? ch;
  let out = '';
  for (const ch of mapped.normalize('NFD')) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x0300 || cp > 0x036f) out += ch;
  }
  return out.toLowerCase();
}

export function DependencyPicker({ options, selected, onChange }: DependencyPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const bySlug = useMemo(() => new Map(options.map((o) => [o.slug, o])), [options]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey, true); };
  }, [open]);

  const filtered = useMemo(() => {
    const q = fold(query.trim());
    if (!q) return options;
    return options.filter((o) => fold(o.title).includes(q) || o.slug.includes(q));
  }, [options, query]);

  const toggle = (slug: string) => {
    onChange(selected.includes(slug) ? selected.filter((s) => s !== slug) : [...selected, slug]);
  };

  return (
    <div className="dep" ref={ref}>
      {selected.length > 0 && (
        <div className="dep-chips">
          {selected.map((slug) => {
            const o = bySlug.get(slug);
            return (
              <span className="dep-chip" key={slug} title={slug}>
                <span className="dep-chip-dot" style={{ background: STATUS_COLOR[o?.status ?? 'not_started'] }} />
                <span className="dep-chip-label">{o?.title ?? slug}</span>
                <span className="dep-chip-x" onClick={() => toggle(slug)} title="Remove">×</span>
              </span>
            );
          })}
        </div>
      )}

      <button type="button" className={`dep-trigger${open ? ' dep-trigger--open' : ''}`} onClick={() => setOpen((o) => !o)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <span className="dep-trigger-label">{selected.length ? 'Add another dependency…' : 'Search objectives to depend on…'}</span>
      </button>

      {open && (
        <div className="dep-pop">
          <input
            ref={inputRef}
            className="dep-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search objectives…"
            spellCheck={false}
          />
          <div className="dep-list bd-scroll">
            {filtered.length === 0 ? (
              <div className="dep-empty">{options.length === 0 ? 'No other objectives yet.' : 'No matches.'}</div>
            ) : (
              filtered.map((o) => {
                const on = selected.includes(o.slug);
                return (
                  <div className={`dep-row${on ? ' dep-row--on' : ''}`} key={o.slug} onClick={() => toggle(o.slug)}>
                    <span className={`dep-check${on ? ' dep-check--on' : ''}`}>{on ? '✓' : ''}</span>
                    <span className="dep-row-dot" style={{ background: STATUS_COLOR[o.status ?? 'not_started'] }} />
                    <span className="dep-row-title">{o.title}</span>
                    <span className="dep-row-slug">{o.slug}</span>
                  </div>
                );
              })
            )}
          </div>
          {selected.length > 0 && (
            <div className="dep-done-row">
              <button type="button" className="dep-done" onClick={() => setOpen(false)}>
                Done · {selected.length} selected
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
